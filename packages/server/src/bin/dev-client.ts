#!/usr/bin/env node
/**
 * Developer test client (T-007): authenticates to the local broker like the MCP server will,
 * then runs registry.get → scope.request → (user approves in the popup) → scope.claim →
 * sn.op table.list (limit 1) → a negative check with an unknown scope → scope.release.
 *
 *   npm run dev-client -w @sn-mcp/server -- [--instance dev] [--table incident]
 *
 * Prints status codes, counts and the first record's number only — not record contents.
 */
import { randomBytes } from 'node:crypto';
import { type BrokerToClient, PROTOCOL_VERSION } from '@sn-mcp/shared';
import { connectToBroker } from '../bridge/handshake.js';
import { defaultRuntimeDir } from '../native-host/socket-guard.js';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const instance = opt('--instance', 'dev');
const table = opt('--table', 'incident');
const v = PROTOCOL_VERSION;

const conn = await connectToBroker(defaultRuntimeDir(), {
  clientKey: randomBytes(16),
  label: { name: 'sn-mcp dev-client', pid: process.pid, cwd: process.cwd() },
});
console.log(`Authenticated to the broker (client ${conn.keyId.slice(0, 8)}…).`);

const waiting = new Map<string, (m: BrokerToClient) => void>();
conn.onMessage((m) => {
  if (m.kind === 'response') {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  }
});
let seq = 0;
function call(
  request: Record<string, unknown>,
): Promise<Extract<BrokerToClient, { kind: 'response' }>> {
  const id = `d${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no response to ${String(request.kind)}`)),
      60_000,
    );
    waiting.set(id, (m) => {
      clearTimeout(timer);
      resolve(m as Extract<BrokerToClient, { kind: 'response' }>);
    });
    conn.send({ v, id, ...request });
  });
}
const fail = (what: string, r: unknown) => {
  console.error(`${what} failed:`, JSON.stringify(r));
  conn.close();
  process.exit(1);
};

const reg = await call({ kind: 'registry.get' });
if (!reg.ok || reg.result.type !== 'registry.get') fail('registry.get', reg);
else
  console.log(
    `Registered instances: ${reg.result.instances.map((i) => `${i.alias} (${i.env}, ${i.host})`).join(', ') || 'none'}`,
  );

const req = await call({
  kind: 'scope.request',
  instances: [instance],
  mode: 'single',
  purpose: `dev-client test: ${table} limit 1`,
});
if (!req.ok || req.result.type !== 'scope.request') fail('scope.request', req);
else {
  const code = req.result.approvalCode;
  console.log(
    `\n>>> Approve code ${code.slice(0, 4)}-${code.slice(4)} in the sn-mcp extension popup (expires in ${req.result.expiresInSeconds} s).\n`,
  );
  const requestId = req.result.requestId;
  let scopeId: string | undefined;
  const deadline = Date.now() + req.result.expiresInSeconds * 1000;
  while (!scopeId && Date.now() < deadline) {
    const c = await call({ kind: 'scope.claim', requestId });
    if (!c.ok || c.result.type !== 'scope.claim') fail('scope.claim', c);
    else if (c.result.status === 'approved' && c.result.scopeId) {
      scopeId = c.result.scopeId;
      console.log(
        `Approved. Scope for ${c.result.instances?.join(', ')} until ${c.result.expiresAt}.`,
      );
    } else if (c.result.status !== 'pending') fail(`claim (${c.result.status})`, c);
    else await new Promise((r) => setTimeout(r, 2000));
  }
  if (!scopeId) fail('approval', 'timed out');

  const again = await call({ kind: 'scope.claim', requestId });
  console.log(
    `Second claim of the same request: ${again.ok && again.result.type === 'scope.claim' ? again.result.status : 'error'} (expected: claimed, no scope)`,
  );

  const op = {
    kind: 'table.list',
    table,
    limit: 1,
    offset: 0,
    displayValue: 'false',
    noCount: false,
    fields: ['sys_id', 'number'],
  };
  const t0 = Date.now();
  const res = await call({ kind: 'sn.op', scopeId, instance, op });
  if (!res.ok || res.result.type !== 'sn.op') fail('sn.op', res);
  else {
    const body = res.result.body as { number?: string }[] | null;
    console.log(
      `sn.op table.list ${table} limit 1 → HTTP ${res.result.status} from ${res.result.host} [${res.result.env}] in ${Date.now() - t0} ms; ` +
        `rows=${Array.isArray(body) ? body.length : 'n/a'}, totalCount=${res.result.totalCount ?? 'n/a'}, first=${Array.isArray(body) ? (body[0]?.number ?? '-') : '-'}, bytes=${res.result.bytes}`,
    );
  }

  const bogus = await call({
    kind: 'sn.op',
    scopeId: `scp_${randomBytes(16).toString('base64url')}`,
    instance,
    op,
  });
  console.log(
    `sn.op with an unknown scope → ${bogus.ok ? 'UNEXPECTED SUCCESS' : bogus.error.code} (expected: SCOPE_UNKNOWN)`,
  );

  const rel = await call({ kind: 'scope.release', scopeId });
  console.log(
    `scope.release → released=${rel.ok && rel.result.type === 'scope.release' ? rel.result.released : 'error'}`,
  );
  const after = await call({ kind: 'sn.op', scopeId, instance, op });
  console.log(
    `sn.op after release → ${after.ok ? 'UNEXPECTED SUCCESS' : after.error.code} (expected: SCOPE_UNKNOWN)`,
  );
}
conn.close();
