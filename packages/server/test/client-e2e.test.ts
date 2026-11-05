/**
 * T-043 end to end, one process per client, as the desktop apps run it: the BUILT server over real
 * STDIO, started from the exact values given to the user, against the real broker and the REAL
 * extension authorization code. Only ServiceNow and the popup click are stubbed, so this is a mock:
 * not evidence of real connectivity (test/e2e/chatgpt-client.ts is the live run).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { handleForward } from '../../extension/src/background/authz.js';
import { type GrantStorage, Grants } from '../../extension/src/background/grants.js';
import type { InstanceEntry } from '../../extension/src/background/registry.js';
import {
  CHATGPT_DESKTOP_LABEL,
  chatGptDesktopConfig,
  MISTRAL_VIBE_LABEL,
  mistralVibeConfig,
  renderConfigToml,
  renderStdioForm,
  renderVibeConfigToml,
} from '../src/install/client-config.js';
import { INSTRUCTIONS } from '../src/mcp/server.js';
import { currentUid } from '../src/native-host/auth.js';
import { Broker } from '../src/native-host/broker.js';
import { MemoryLogger } from '../src/native-host/logger.js';
import { answerMetadata } from './fake-sn.js';
import { MockExtension, makeTempDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const REGISTRY: InstanceEntry[] = [
  { alias: 'alpha', host: 'alpha.service-now.com', label: 'A', env: 'dev', addedAt: 'x' },
];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const t = makeTempDir();
  cleanups.push(t.cleanup);
  const ext = new MockExtension();
  const broker = new Broker({
    dir: t.dir,
    uid: currentUid(),
    extIn: ext.extIn,
    extOut: ext.extOut,
    logger: new MemoryLogger(),
  });
  let stored: unknown;
  const storage: GrantStorage = {
    load: async () => structuredClone(stored),
    save: async (s) => {
      stored = structuredClone(s);
    },
  };
  const grants = new Grants(storage, {
    now: () => Date.now(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    sha256Hex: async (s) => createHash('sha256').update(s).digest('hex'),
  });
  const reads: string[] = [];
  const deps = {
    grants,
    registry: async () => REGISTRY,
    hasPermission: async () => true,
    execute: async (host: string, op: unknown) => {
      const m = answerMetadata(op);
      if (m) return m;
      if (((op as { offset?: number }).offset ?? 0) > 0) {
        return { ok: true as const, status: 200, body: [], bytes: 2 };
      }
      reads.push(host);
      return {
        ok: true as const,
        status: 200,
        body: [{ sys_id: 'a'.repeat(32), number: 'TASK0001' }],
        totalCount: 1,
        bytes: 50,
      };
    },
  };
  ext.extOut.on('data', () => {
    for (;;) {
      const i = ext.reader.received.findIndex((m) => m.kind === 'forward');
      if (i < 0) break;
      const f = ext.reader.received.splice(i, 1)[0];
      void handleForward(f, deps).then((r) => {
        if (r) ext.send(r);
      });
    }
  });
  await broker.start();
  cleanups.push(() => broker.stop('test end'));

  /** A client process started the way the app starts it. */
  async function startClient(env: Record<string, string>) {
    const c = chatGptDesktopConfig(ROOT);
    const client = new Client({ name: 'client-e2e', version: '0' });
    const transport = new StdioClientTransport({
      command: c.command,
      args: c.args,
      cwd: c.cwd,
      env: { ...(process.env as Record<string, string>), ...env, SN_MCP_RUNTIME_DIR: t.dir },
    });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
    };
    return { client, call };
  }

  return { startClient, grants, reads };
}

const chatgptEnv = chatGptDesktopConfig(ROOT).env;
const claudeEnv = { SN_MCP_CLIENT_NAME: 'Claude Desktop' };
const READ = { table: 'task', fields: ['number'] };

describe('T-043 ChatGPT Desktop as a local STDIO client', () => {
  it('discovers every tool, the same as Claude, all marked read-only', async () => {
    const s = await setup();
    const chatgpt = await s.startClient(chatgptEnv);
    const claude = await s.startClient(claudeEnv);
    const a = (await chatgpt.client.listTools()).tools;
    const b = (await claude.client.listTools()).tools;
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages/server/mcpb/manifest.json'), 'utf8'),
    ) as { tools: { name: string }[] };
    const names = manifest.tools.map((t) => t.name).sort();
    expect(a.map((t) => t.name).sort()).toEqual(names);
    expect(b).toEqual(a);
    for (const t of a) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  }, 30_000);

  it('reaches the broker, and the popup shows which client is asking', async () => {
    const s = await setup();
    const chatgpt = await s.startClient(chatgptEnv);
    const list = await chatgpt.call('list_instances');
    expect(list.ok).toBe(true);
    expect(list.data.instances.map((i: { alias: string }) => i.alias)).toEqual(['alpha']);
    await chatgpt.call('request_scope', { instances: ['alpha'], purpose: 'e2e' });
    const { pending } = await s.grants.snapshot();
    expect(pending[0]?.clientLabel.name).toBe(CHATGPT_DESKTOP_LABEL);
  }, 30_000);

  it('access approved for one client never works for another', async () => {
    const s = await setup();
    const chatgpt = await s.startClient(chatgptEnv);
    const claude = await s.startClient(claudeEnv);

    // Nothing is readable, by anyone, before the user approves.
    const req = await chatgpt.call('request_scope', { instances: ['alpha'], purpose: 'e2e' });
    const requestId = req.data.request_id as string;
    expect((await chatgpt.call('claim_scope', { request_id: requestId })).data.status).toBe(
      'pending',
    );
    expect((await s.grants.approve(requestId, REGISTRY)).ok).toBe(true);

    // The other client can't pick up this approval, and trying doesn't spend it.
    const stolen = await claude.call('claim_scope', { request_id: requestId });
    expect(stolen.data.status).toBe('expired'); // looks the same as a request that doesn't exist
    expect(stolen.data.scope_id).toBeUndefined();

    const claim = await chatgpt.call('claim_scope', { request_id: requestId });
    expect(claim.data.status).toBe('approved');
    const scope = claim.data.scope_id as string;
    expect((await chatgpt.call('query_records', { scope_id: scope, ...READ })).ok).toBe(true);
    const readsBefore = s.reads.length;
    expect(readsBefore).toBeGreaterThan(0);

    // Nor can it use the scope itself, even with the right id.
    const refused = await claude.call('query_records', { scope_id: scope, ...READ });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe('SCOPE_UNKNOWN');
    expect(s.reads.length).toBe(readsBefore);
    expect((await claude.call('release_scope', { scope_id: scope })).data?.released).not.toBe(true);
    expect((await chatgpt.call('query_records', { scope_id: scope, ...READ })).ok).toBe(true);

    // The other client needs its own approval, and each ends independently.
    const own = await claude.call('request_scope', { instances: ['alpha'], purpose: 'e2e' });
    await s.grants.approve(own.data.request_id, REGISTRY);
    const ownClaim = await claude.call('claim_scope', { request_id: own.data.request_id });
    expect(ownClaim.data.scope_id).not.toBe(scope);
    await chatgpt.call('release_scope', { scope_id: scope });
    expect((await chatgpt.call('query_records', { scope_id: scope, ...READ })).ok).toBe(false);
    const stillOpen = await claude.call('query_records', {
      scope_id: ownClaim.data.scope_id,
      ...READ,
    });
    expect(stillOpen.ok).toBe(true);
  }, 30_000);
});

describe('T-043 registration values', () => {
  it('are absolute, name the built server, and need nothing from PATH', () => {
    const c = chatGptDesktopConfig('/Users/me/AssistMe', '/opt/node/bin/node', 'darwin');
    expect(c.command).toBe('/opt/node/bin/node');
    expect(c.args).toEqual(['/Users/me/AssistMe/packages/server/dist/bin/mcp-server.js']);
    expect(c.env).toEqual({ SN_MCP_CLIENT_NAME: 'ChatGPT Desktop' });
    expect(c.cwd).toBe('/Users/me/AssistMe');
    expect(renderStdioForm(c)).toContain('Type:                  STDIO');
  });

  it('use Windows paths on Windows, and escape them in TOML', () => {
    const c = chatGptDesktopConfig(
      'C:\\Users\\me\\AssistMe',
      'C:\\Program Files\\nodejs\\node.exe',
      'win32',
    );
    expect(c.args).toEqual(['C:\\Users\\me\\AssistMe\\packages\\server\\dist\\bin\\mcp-server.js']);
    const toml = renderConfigToml(c);
    expect(toml).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(toml).toContain('[mcp_servers.sn-mcp.env]\nSN_MCP_CLIENT_NAME = "ChatGPT Desktop"');
  });
});

describe('T-046 Mistral Vibe registration values', () => {
  const c = mistralVibeConfig('/Users/my name/AssistMe', '/opt/my tools/node', 'darwin');
  const toml = renderVibeConfigToml(c);

  it('are the same server, with its own label', () => {
    expect(c.args).toEqual(chatGptDesktopConfig('/Users/my name/AssistMe', 'x', 'darwin').args);
    expect(c.env).toEqual({ SN_MCP_CLIENT_NAME: MISTRAL_VIBE_LABEL });
  });

  it('use the schema Vibe reads: an array of tables, with the transport named', () => {
    expect(toml.startsWith('[[mcp_servers]]\nname = "sn-mcp"\ntransport = "stdio"\n')).toBe(true);
    expect(toml).toContain('tool_timeout_sec = 360');
    expect(toml).toContain('[mcp_servers.env]\nSN_MCP_CLIENT_NAME = "Mistral Vibe"');
  });

  it('write the command as an array, because Vibe splits a string on spaces', () => {
    expect(toml).toContain('command = ["/opt/my tools/node"]');
  });

  it('carry the server instructions, which Vibe does not pass to its model by itself', () => {
    const line = toml.split('\n').find((l) => l.startsWith('prompt = ')) ?? '';
    expect(JSON.parse(line.slice('prompt = '.length))).toBe(INSTRUCTIONS);
  });
});
