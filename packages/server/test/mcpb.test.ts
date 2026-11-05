/**
 * T-036: the .mcpb manifest and bundled server. Runs the real bundle over stdio with an empty
 * home directory, so it can't reach a broker (never evidence of real connectivity).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SERVER_VERSION } from '../src/mcp/server.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'mcpb/manifest.json'), 'utf8'));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'sn-mcpb-')));
const out = join(work, 'out');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'build.mjs')], {
    env: { ...process.env, OUT_DIR: out },
    stdio: 'pipe',
  });
}, 60_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('manifest', () => {
  it('passes the official validator', () => {
    const bin = join(root, '../../node_modules/.bin/mcpb');
    const text = execFileSync(bin, ['validate', join(root, 'mcpb/manifest.json')], {
      encoding: 'utf8',
    });
    expect(text).toMatch(/valid/i);
  });

  it('asks for no secrets, and its settings can only shape responses', () => {
    const config = Object.values(manifest.user_config) as { sensitive?: boolean; type: string }[];
    for (const c of config) {
      expect(c.sensitive).toBeUndefined();
      expect(c.type).toBe('number');
    }
    const env = Object.keys(manifest.server.mcp_config.env).sort();
    expect(env).toEqual([
      'SN_MCP_CLIENT_NAME',
      'SN_MCP_FIELD_PREVIEW_CHARS',
      'SN_MCP_MAX_RESPONSE_CHARS',
      'SN_MCP_PAGE_SIZE',
      'SN_MCP_RESPONSE_CHARS',
    ]);
  });

  it('its defaults match the server, and blank settings fall back safely', () => {
    const d = loadConfig({});
    const u = manifest.user_config;
    expect(u.response_chars.default).toBe(d.responseChars);
    expect(u.max_response_chars.default).toBe(d.maxResponseChars);
    expect(u.page_size.default).toBe(d.pageSize);
    expect(u.field_preview_chars.default).toBe(d.fieldPreviewChars);
    // A host that leaves a placeholder unfilled can't change anything.
    const unfilled = loadConfig({
      SN_MCP_RESPONSE_CHARS: '${user_config.response_chars}',
      SN_MCP_PAGE_SIZE: '',
    });
    expect(unfilled.responseChars).toBe(d.responseChars);
    expect(unfilled.pageSize).toBe(d.pageSize);
    expect(manifest.version).toBe(SERVER_VERSION);
  });
});

describe('T-035: .mcp.json.example', () => {
  it('registers the built server under the placeholder path', () => {
    const repo = join(root, '../..');
    const example = JSON.parse(readFileSync(join(repo, '.mcp.json.example'), 'utf8'));
    const entry = example.mcpServers['sn-mcp'];
    expect(entry.command).toBe('node');
    expect(entry.args).toHaveLength(1);
    const path = (entry.args[0] as string).replace('/ABSOLUTE/PATH/TO/AssistMe', repo);
    expect(statSync(path).isFile()).toBe(true);
    expect(Object.keys(entry.env)).toEqual(['SN_MCP_CLIENT_NAME']);
  });
});

describe('bundle', () => {
  it('is one file that runs standalone and lists the same tools as the manifest', async () => {
    const entry = join(out, manifest.server.entry_point);
    expect(statSync(entry).size).toBeGreaterThan(10_000);
    const home = join(work, 'home');
    const client = new Client({ name: 'mcpb-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        cwd: work, // nothing to resolve node_modules from
        env: { PATH: process.env.PATH ?? '', HOME: home },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      manifest.tools.map((t: { name: string }) => t.name).sort(),
    );
    const r = await client.callTool({ name: 'list_instances', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('BRIDGE_UNAVAILABLE');
    await client.close();
  }, 30_000);
});
