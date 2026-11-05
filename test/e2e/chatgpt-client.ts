/**
 * T-043 live run: the engine inside ChatGPT Desktop → the built MCP server over STDIO → the real
 * broker → the real extension → a real instance, through the real approval flow.
 *
 *   npm run e2e:chatgpt -- --discovery-only
 *   npm run e2e:chatgpt -- --instance dev469966
 *
 * It uses a throwaway CODEX_HOME holding the exact values given to the user, so it never reads or
 * changes the app's own settings or sign-in. No model is involved: tools are called through the
 * engine's own `mcpServer/tool/call`. It doesn't drive the app's window.
 *
 * Another client, labelled "Claude Code" and started from the same build, tries to use the access.
 * Only the user approves, in the popup. Reads one count; saves no record content.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const ENGINE =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

const { values } = parseArgs({
  options: {
    instance: { type: 'string' },
    'discovery-only': { type: 'boolean', default: false },
    engine: { type: 'string', default: process.env.SN_MCP_CHATGPT_ENGINE ?? ENGINE },
    out: { type: 'string', default: 'results.json' },
  },
});
const engine = values.engine as string;
if (!existsSync(engine)) {
  console.error(`ChatGPT's engine isn't at ${engine}. Pass --engine with its path.`);
  process.exit(1);
}
if (!values['discovery-only'] && !values.instance) {
  console.error('Pass --instance <alias>, or --discovery-only.');
  process.exit(1);
}

const url = (p: string) => pathToFileURL(join(ROOT, p)).href;
const { chatGptDesktopConfig, renderConfigToml, renderStdioForm } = await import(
  url('packages/server/dist/install/client-config.js')
);
const config = chatGptDesktopConfig(ROOT);
const home = mkdtempSync(join(tmpdir(), 'sn-mcp-chatgpt-'));
writeFileSync(join(home, 'config.toml'), renderConfigToml(config));
console.log(`Registration under test:\n${renderStdioForm(config)}\n`);

interface Rpc {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

function startEngine() {
  const child: ChildProcess = spawn(engine, ['app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  let seq = 0;
  const waiting = new Map<number, (m: Rpc) => void>();
  child.stdout?.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Rpc;
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      }
    }
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((ok, fail) => {
      const id = ++seq;
      const timer = setTimeout(() => fail(new Error(`${method}: no answer`)), 400_000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) fail(new Error(`${method}: ${m.error.message}`));
        else ok(m.result);
      });
      child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  return {
    child,
    rpc,
    notify: (method: string) => child.stdin?.write(`${JSON.stringify({ method })}\n`),
  };
}

const results: Record<string, unknown> = {
  at: new Date().toISOString(),
  engine_is_the_one_inside_the_app: engine === ENGINE,
  mock: false,
};
const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`,
  );
};

const { child, rpc, notify } = startEngine();
const other = new Client({ name: 'sn-mcp-isolation-check', version: '0' });
let exitCode = 1;
try {
  const init = await rpc('initialize', {
    clientInfo: { name: 'sn-mcp-e2e', version: '0' },
    capabilities: { experimentalApi: true },
  });
  notify('initialized');
  results.engine = init.userAgent;

  const startThread = async () =>
    (await rpc('thread/start', { ephemeral: true })).thread.id as string;
  const threadA = await startThread();

  // Tool discovery, as the app does it.
  const status = await rpc('mcpServerStatus/list', { threadId: threadA, serverName: config.name });
  const server = status.data.find((s: { name: string }) => s.name === config.name);
  const tools = Object.values(server?.tools ?? {}) as {
    name: string;
    annotations?: { readOnlyHint?: boolean };
  }[];
  const { readFileSync } = await import('node:fs');
  const expected = (
    JSON.parse(readFileSync(join(ROOT, 'packages/server/mcpb/manifest.json'), 'utf8')) as {
      tools: { name: string }[];
    }
  ).tools.map((t) => t.name);
  check(
    'tool discovery: every tool, in the engine inside ChatGPT Desktop',
    expected.every((n) => tools.some((t) => t.name === n)) && tools.length === expected.length,
    { tools: tools.length, server_version: server?.serverInfo?.version },
  );
  check(
    'every tool is marked read-only',
    tools.every((t) => t.annotations?.readOnlyHint === true),
  );

  const callIn = async (threadId: string, tool: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('mcpServer/tool/call', {
      threadId,
      server: config.name,
      tool,
      arguments: args,
    });
    return JSON.parse(r.content?.[0]?.text ?? '{}');
  };

  // Broker connectivity.
  const list = await callIn(threadA, 'list_instances');
  check(
    'broker connectivity: list_instances answers through the real extension',
    list.ok === true,
    {
      code: list.error?.code,
      instances: list.data?.instances?.length,
    },
  );

  if (values['discovery-only']) {
    exitCode = checks.every((c) => c.pass) ? 0 : 1;
  } else {
    const alias = values.instance as string;
    await other.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), SN_MCP_CLIENT_NAME: 'Claude Code' },
      }),
    );
    const callOther = async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await other.callTool({ name: tool, arguments: args });
      return JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
    };
    const count = { table: 'sys_user', group_by: [] as string[] };

    const req = await callIn(threadA, 'request_scope', {
      instances: [alias],
      purpose: 'T-043 live check: ChatGPT Desktop client',
    });
    if (!req.ok) throw new Error(`request_scope: ${req.error?.code}`);
    const requestId = req.data.request_id as string;
    console.log(
      `\n>>> In the sn-mcp popup, approve the request from "ChatGPT Desktop".\n>>> APPROVAL CODE: ${req.data.approval_code}\n`,
    );

    // Each round the other client tries first, so it would win any race for the approval.
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
    let scope: string | undefined;
    let stolen = false;
    while (!scope && Date.now() < deadline) {
      const theirs = await callOther('claim_scope', { request_id: requestId });
      if (theirs.data?.scope_id) stolen = true;
      const mine = await callIn(threadA, 'claim_scope', { request_id: requestId });
      if (mine.data?.status === 'denied') throw new Error('The request was denied in the popup.');
      if (mine.data?.scope_id) scope = mine.data.scope_id;
      else await new Promise((r) => setTimeout(r, 2000));
    }
    if (!scope) throw new Error('Not approved in time.');
    check('the other client could not pick up the approval', !stolen);

    const mine = await callIn(threadA, 'aggregate_records', { scope_id: scope, ...count });
    check('ChatGPT reads the instance with its approved access', mine.ok === true, {
      code: mine.error?.code,
      complete: mine.complete,
    });

    const refused = await callOther('aggregate_records', { scope_id: scope, ...count });
    check(
      'the other client, given the same scope id, is refused',
      refused.ok === false && refused.error?.code === 'SCOPE_UNKNOWN',
      { code: refused.error?.code },
    );

    // Recorded rather than required: it decides how often the user is asked to approve.
    const threadB = await startThread();
    const inB = await callIn(threadB, 'aggregate_records', { scope_id: scope, ...count });
    results.second_conversation_shares_access = inB.ok === true;
    results.second_conversation_code = inB.error?.code ?? 'ok';
    console.log(
      `INFO  a second conversation with the same scope id: ${inB.error?.code ?? 'allowed'}`,
    );

    const released = await callIn(threadA, 'release_scope', { scope_id: scope });
    const after = await callIn(threadA, 'aggregate_records', { scope_id: scope, ...count });
    check('after release the access is gone', released.ok === true && after.ok === false, {
      code: after.error?.code,
    });
    exitCode = checks.every((c) => c.pass) ? 0 : 1;
  }
} catch (e) {
  console.error(`Stopped: ${(e as Error).message}`);
  checks.push({ name: 'run finished', pass: false, detail: (e as Error).message });
} finally {
  results.checks = checks;
  results.passed = exitCode === 0;
  const dir = join(ROOT, 'docs/evidence/T-043');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, values.out as string), `${JSON.stringify(results, null, 2)}\n`);
  await other.close().catch(() => {});
  child.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(exitCode === 0 ? '\nAll checks passed.' : '\nSome checks failed.');
process.exit(exitCode);
