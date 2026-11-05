/**
 * T-034: live tool acceptance. Real MCP stdio client → real MCP server → real broker → real
 * extension → a real ServiceNow instance, through the real approval flow.
 *
 *   npm run e2e:live -- --instance dev [--dry-run]
 *
 * Only reads. Requests a scope you approve in the extension popup, releases it at the end. Saves
 * shapes, counts and sizes (no record content) to docs/evidence/T-034/results.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { type Call, type Result, runScenarios } from './scenarios.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const { values } = parseArgs({
  options: {
    instance: { type: 'string', default: 'dev' },
    'dry-run': { type: 'boolean', default: false },
    /** Comma-separated parts of scenario names; saves to results-partial.json, not results.json. */
    only: { type: 'string' },
  },
});
const alias = values.instance as string;

const client = new Client({ name: 'sn-mcp-e2e-live', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve(ROOT, 'packages/server/dist/bin/mcp-server.js')],
    env: { ...(process.env as Record<string, string>), SN_MCP_CLIENT_NAME: 'e2e:live' },
  }),
);

const call: Call = async (tool, args) => {
  const r = await client.callTool({ name: tool, arguments: args }, { timeout: 300_000 });
  const text = (r.content as { text: string }[])[0]?.text ?? '{}';
  try {
    return JSON.parse(text) as Result;
  } catch {
    return { ok: false, error: { code: 'INVALID_INPUT', message: text.slice(0, 300) } };
  }
};

const exitWith = async (code: number): Promise<never> => {
  await client.close();
  process.exit(code);
};

const { tools } = await client.listTools();
const payload = Buffer.byteLength(JSON.stringify({ tools }));
console.log(`Connected. ${tools.length} tools, tools/list ${payload} bytes.`);

const list = await call('list_instances', {});
if (!list.ok) {
  console.error(`list_instances failed: ${list.error.code}: ${list.error.message}`);
  await exitWith(1);
}
const inst = list.data.instances.find((i: { alias: string }) => i.alias === alias);
console.log(
  `Registered: ${list.data.instances.map((i: { alias: string; connection: string }) => `${i.alias} (${i.connection})`).join(', ') || 'none'}`,
);
if (!inst) {
  console.error(`No instance "${alias}" is registered in the extension.`);
  await exitWith(1);
}
if (values['dry-run']) {
  console.log('Dry run: wiring is fine. No scope requested and nothing read from ServiceNow.');
  await exitWith(0);
}

const req = await call('request_scope', { instance: alias, purpose: 'T-034 live tool acceptance' });
if (!req.ok) {
  console.error(`request_scope failed: ${req.error.code}: ${req.error.message}`);
  await exitWith(1);
}
console.log(`\n>>> Approve this code in the sn-mcp extension popup: ${req.data.approval_code}\n`);

let scope: string | undefined;
const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
while (!scope && Date.now() < deadline) {
  const c = await call('claim_scope', { request_id: req.data.request_id });
  if (c.ok && c.data.status === 'approved') scope = c.data.scope_id;
  else if (!c.ok || c.data.status !== 'pending') {
    console.error(`Not approved: ${c.ok ? c.data.status : c.error.code}`);
    await exitWith(1);
  } else await new Promise((f) => setTimeout(f, 2000));
}
if (!scope) {
  console.error('Timed out waiting for approval.');
  await exitWith(1);
}

const started = new Date().toISOString();
const results = await runScenarios(call, scope as string, (line) => console.log(line), values.only);
const released = await call('release_scope', { scope_id: scope });

const counts = { pass: 0, fail: 0, skip: 0 };
for (const r of results) counts[r.status]++;
const file = resolve(ROOT, `docs/evidence/T-034/results${values.only ? '-partial' : ''}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify(
    {
      note: 'Live run against a real instance. Shapes, counts and sizes only; no record content.',
      started,
      finished: new Date().toISOString(),
      instance: alias,
      env: inst.env,
      tools: tools.length,
      tools_list_bytes: payload,
      released: released.ok && released.data.released,
      counts,
      results,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `\n${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped. Saved ${file}`,
);
await exitWith(counts.fail > 0 ? 1 : 0);
