/**
 * T-012 end-to-end: MCP client ↔ MCP server ↔ real broker ↔ fake extension that runs the REAL
 * extension authorization code (`authz.ts` + `grants.ts`). Only ServiceNow is stubbed (fixed
 * fake rows), so this is a mock — not evidence of real connectivity.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { handleForward } from '../../extension/src/background/authz.js';
import { type GrantStorage, Grants } from '../../extension/src/background/grants.js';
import type { InstanceEntry } from '../../extension/src/background/registry.js';
import { BridgeClient } from '../src/bridge/client.js';
import { createMcpServer } from '../src/mcp/server.js';
import { Broker } from '../src/native-host/broker.js';
import { MemoryLogger } from '../src/native-host/logger.js';
import { answerMetadata } from './fake-sn.js';
import { LABEL, MockExtension, makeTempDir } from './helpers.js';

const uid = process.getuid?.() as number;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const REGISTRY: InstanceEntry[] = [
  { alias: 'alpha', host: 'alpha.service-now.com', label: 'A', env: 'dev', addedAt: 'x' },
  { alias: 'beta', host: 'beta.service-now.com', label: 'B', env: 'test', addedAt: 'x' },
  { alias: 'gamma', host: 'gamma.service-now.com', label: 'C', env: 'dev', addedAt: 'x' },
];

/** Fake extension: real authz + grants, stubbed ServiceNow. */
function realAuthzExtension(ext: MockExtension) {
  let data: unknown;
  const storage: GrantStorage = {
    load: async () => structuredClone(data),
    save: async (s) => {
      data = structuredClone(s);
    },
  };
  const grants = new Grants(storage, {
    now: () => Date.now(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    sha256Hex: async (s) => createHash('sha256').update(s).digest('hex'),
  });
  const fetched: string[] = [];
  const deps = {
    grants,
    registry: async () => REGISTRY,
    hasPermission: async () => true,
    execute: async (host: string, op: unknown) => {
      const m = answerMetadata(op);
      if (m) return m;
      fetched.push(host);
      const table = (op as { table?: string }).table;
      return {
        ok: true as const,
        status: 200,
        body:
          table === 'u_api_config'
            ? [
                {
                  sys_id: 'b'.repeat(32),
                  u_label: 'Payments',
                  u_auth: 'hunter2',
                  u_endpoint: 'https://x',
                },
              ]
            : [{ sys_id: 'a'.repeat(32), number: `INC-${host.split('.')[0]}` }],
        totalCount: 1,
        bytes: 50,
      };
    },
  };
  ext.extOut.on('data', () => {
    for (;;) {
      const idx = ext.reader.received.findIndex((m) => m.kind === 'forward');
      if (idx < 0) break;
      const f = ext.reader.received.splice(idx, 1)[0];
      void handleForward(f, deps).then((resp) => {
        if (resp) ext.send(resp);
      });
    }
  });
  return { grants, fetched };
}

async function setup() {
  const t = makeTempDir();
  cleanups.push(t.cleanup);
  const ext = new MockExtension();
  const broker = new Broker({
    dir: t.dir,
    uid,
    extIn: ext.extIn,
    extOut: ext.extOut,
    logger: new MemoryLogger(),
  });
  const fake = realAuthzExtension(ext);
  await broker.start();
  cleanups.push(() => broker.stop('test end'));

  const outputs: { tool: string; text: string }[] = [];
  async function connect(label = LABEL) {
    const bridge = new BridgeClient({ dir: t.dir, label });
    const server = createMcpServer(bridge);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'vitest', version: '0' });
    await client.connect(ct);
    cleanups.push(async () => {
      await client.close();
      await server.close();
      bridge.close();
    });
    const fn = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]?.text ?? '';
      outputs.push({ tool: name, text });
      let body: Record<string, any>;
      try {
        body = JSON.parse(text);
      } catch {
        body = { text };
      }
      return { isError: r.isError === true, body };
    };
    return Object.assign(fn, { bridge });
  }

  /** request → user approves (popup action, done directly on the real Grants) → claim. */
  async function scopeFor(call: Awaited<ReturnType<typeof connect>>, instances: string[]) {
    const req = await call('request_scope', { instances, purpose: 'e2e' });
    expect(req.isError).toBe(false);
    const ap = await fake.grants.approve(req.body.data.request_id, REGISTRY);
    expect(ap.ok).toBe(true);
    const claim = await call('claim_scope', { request_id: req.body.data.request_id });
    expect(claim.body.data.status).toBe('approved');
    return claim.body.data.scope_id as string;
  }

  return { connect, scopeFor, outputs, ...fake };
}

describe('T-012 scope enforcement end to end (real authz.ts)', () => {
  it('AC3: a scope for alpha cannot read beta; a compare scope covers only its pair', async () => {
    const s = await setup();
    const call = await s.connect();
    const alpha = await s.scopeFor(call, ['alpha']);

    const okA = await call('query_records', { scope_id: alpha, table: 'incident' });
    expect(okA.body).toMatchObject({
      ok: true,
      data: { records: [{ number: 'INC-alpha' }] },
      provenance: { instance: 'alpha', env: 'dev', host: 'alpha.service-now.com' },
    });
    // Explicit other instance: refused (locally and, with an unknown-to-server scope, by authz).
    const toB = await call('query_records', {
      scope_id: alpha,
      instance: 'beta',
      table: 'incident',
    });
    expect(toB.body.error.code).toBe('INSTANCE_NOT_IN_SCOPE');
    // A second MCP process (new client key) doesn't know the scope locally, so it forwards
    // with instance beta; the extension's real authz refuses it.
    const other = await s.connect({ name: 'other', pid: 2 });
    const viaOther = await other('query_records', {
      scope_id: alpha,
      instance: 'beta',
      table: 'incident',
    });
    expect(viaOther.body.error.code).toBe('SCOPE_UNKNOWN');
    expect(s.fetched).toEqual(['alpha.service-now.com']);

    const pair = await s.scopeFor(call, ['alpha', 'beta']);
    expect(
      (await call('query_records', { scope_id: pair, table: 'incident' })).body.error.code,
    ).toBe('INVALID_INPUT');
    expect(
      (await call('query_records', { scope_id: pair, instance: 'beta', table: 'incident' })).body
        .data.records[0].number,
    ).toBe('INC-beta');
    expect(
      (await call('query_records', { scope_id: pair, instance: 'gamma', table: 'incident' })).body
        .error.code,
    ).toBe('INSTANCE_NOT_IN_SCOPE');
    expect(s.fetched).toEqual(['alpha.service-now.com', 'beta.service-now.com']);
  });

  it('AC3 (authz itself): the extension refuses a scope used for another instance, with no server-side help', async () => {
    const s = await setup();
    const call = await s.connect();
    const alpha = await s.scopeFor(call, ['alpha']);
    // Same client key (same bridge), bypassing the MCP server's local ScopeStore entirely.
    const op = {
      kind: 'table.list',
      table: 'incident',
      limit: 1,
      offset: 0,
      displayValue: 'false',
      noCount: true,
    } as const;
    const toBeta = await call.bridge.request({
      kind: 'sn.op',
      scopeId: alpha,
      instance: 'beta',
      op,
    });
    expect(toBeta).toMatchObject({ ok: false, error: { code: 'INSTANCE_NOT_IN_SCOPE' } });
    const toAlpha = await call.bridge.request({
      kind: 'sn.op',
      scopeId: alpha,
      instance: 'alpha',
      op,
    });
    expect(toAlpha).toMatchObject({ ok: true, result: { instance: 'alpha' } });
    // A different process (different client key) can't use the same scope id at all.
    const fresh = await s.connect();
    const r = await fresh('query_records', {
      scope_id: alpha,
      instance: 'alpha',
      table: 'incident',
    });
    expect(r.body.error.code).toBe('SCOPE_UNKNOWN');
    expect(s.fetched).toEqual(['alpha.service-now.com']);
  });

  it('AC2: no default scope — missing, blank or malformed scope_id always errors', async () => {
    const s = await setup();
    const call = await s.connect();
    await s.scopeFor(call, ['alpha']); // even with an active scope in this process
    for (const args of [{}, { scope_id: '' }, { scope_id: '   ' }]) {
      const r = await call('query_records', { table: 'incident', ...args });
      expect(r.body.error.code).toBe('SCOPE_REQUIRED');
    }
    for (const scope_id of ['alpha', 'scp_short', `scp_${'x'.repeat(22)}`]) {
      const r = await call('query_records', { scope_id, instance: 'alpha', table: 'incident' });
      expect(r.isError).toBe(true);
      expect(['SCOPE_UNKNOWN', 'SCOPE_REQUIRED']).toContain(r.body.error.code);
    }
    expect((await call('release_scope', {})).body.error.code).toBe('SCOPE_REQUIRED');
    expect(s.fetched).toEqual([]);
  });

  it('AC4: release_scope invalidates immediately (also for the extension)', async () => {
    const s = await setup();
    const call = await s.connect();
    const alpha = await s.scopeFor(call, ['alpha']);
    expect((await call('query_records', { scope_id: alpha, table: 'incident' })).body.ok).toBe(
      true,
    );
    const rel = await call('release_scope', { scope_id: alpha });
    expect(rel.body).toMatchObject({ ok: true, data: { released: true } });
    // Without instance: unknown locally now.
    expect(
      (await call('query_records', { scope_id: alpha, table: 'incident' })).body.error.code,
    ).toBe('SCOPE_UNKNOWN');
    // With instance: forwarded, and the extension refuses it.
    expect(
      (await call('query_records', { scope_id: alpha, instance: 'alpha', table: 'incident' })).body
        .error.code,
    ).toBe('SCOPE_UNKNOWN');
    expect((await s.grants.snapshot()).grants).toEqual([]);
    expect((await call('release_scope', { scope_id: alpha })).body.data.released).toBe(false);
    expect(s.fetched).toHaveLength(1);
  });

  it('AC1: no tool output contains a scope id except the claim_scope result', async () => {
    const s = await setup();
    const call = await s.connect();
    await call('list_instances');
    const a = await s.scopeFor(call, ['alpha']);
    const p = await s.scopeFor(call, ['alpha', 'beta']);
    await call('list_instances');
    await call('query_records', { scope_id: a, table: 'incident' });
    await call('query_records', { scope_id: p, instance: 'beta', table: 'incident' });
    await call('query_records', { scope_id: a, instance: 'beta', table: 'incident' });
    await call('release_scope', { scope_id: a });
    await call('query_records', { scope_id: a, table: 'incident' });
    await call('list_instances');
    const claims = s.outputs.filter((o) => o.tool === 'claim_scope');
    expect(claims.every((o) => /scp_[A-Za-z0-9_-]{22}/.test(o.text))).toBe(true);
    for (const o of s.outputs.filter((x) => x.tool !== 'claim_scope')) {
      expect(o.text, o.tool).not.toMatch(/scp_[A-Za-z0-9_-]{6,}/);
      expect(o.text).not.toContain(a.slice(4));
      expect(o.text).not.toContain(p.slice(4));
    }
  });

  it('T-009/T-016: two conversations in one server process keep separate scopes', async () => {
    const s = await setup();
    const conv = await s.connect(); // one MCP server process (Claude Desktop), shared
    const a = await s.scopeFor(conv, ['alpha']); // conversation A's scope
    const b = await s.scopeFor(conv, ['beta']); // conversation B's scope
    expect(a).not.toBe(b);
    const read = (scope_id: string, instance?: string) =>
      conv('query_records', { scope_id, table: 'incident', ...(instance ? { instance } : {}) });
    expect((await read(a)).body.data.records[0].number).toBe('INC-alpha');
    expect((await read(b)).body.data.records[0].number).toBe('INC-beta');
    // Each scope works only for its own instance.
    expect((await read(a, 'beta')).body.error.code).toBe('INSTANCE_NOT_IN_SCOPE');
    expect((await read(b, 'alpha')).body.error.code).toBe('INSTANCE_NOT_IN_SCOPE');
    // Releasing A does not affect B.
    expect((await conv('release_scope', { scope_id: a })).body.data.released).toBe(true);
    expect((await read(a, 'alpha')).body.error.code).toBe('SCOPE_UNKNOWN');
    expect((await read(b)).body.data.records[0].number).toBe('INC-beta');
    expect(s.fetched).toEqual([
      'alpha.service-now.com',
      'beta.service-now.com',
      'beta.service-now.com',
    ]);
  });

  it('T-018: an unknown field is rejected before any data read; the default projection only uses existing fields', async () => {
    const s = await setup();
    const call = await s.connect();
    const alpha = await s.scopeFor(call, ['alpha']);
    const bad = await call('query_records', {
      scope_id: alpha,
      table: 'incident',
      fields: ['number', 'nmber'],
    });
    expect(bad.body.error).toMatchObject({
      code: 'INVALID_FIELD',
      hint: expect.stringContaining('number'),
    });
    const badTable = await call('query_records', { scope_id: alpha, table: 'incidnt' });
    expect(badTable.body.error).toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('incident'),
    });
    expect(s.fetched).toEqual([]); // no data read happened
    const good = await call('query_records', { scope_id: alpha, table: 'incident' });
    expect(good.body.ok).toBe(true);
    expect(s.fetched).toEqual(['alpha.service-now.com']);
  });

  it('T-020: credential tables are refused and password fields never reach Claude', async () => {
    const s = await setup();
    const call = await s.connect();
    const alpha = await s.scopeFor(call, ['alpha']);
    const denied = await call('query_records', { scope_id: alpha, table: 'discovery_credentials' });
    expect(denied.body.error.code).toBe('TABLE_DENIED');
    const viaWalk = await call('query_records', {
      scope_id: alpha,
      table: 'incident',
      fields: ['u_cred_ref.name'],
    });
    expect(viaWalk.body.error.code).toBe('TABLE_DENIED');
    expect(s.fetched).toEqual([]);
    // No default-projection field exists on u_api_config → all fields come back, minus secrets.
    const all = await call('query_records', { scope_id: alpha, table: 'u_api_config' });
    expect(all.body.data.records).toEqual([
      { sys_id: 'b'.repeat(32), u_label: 'Payments', u_endpoint: 'https://x' },
    ]);
    expect(all.body.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fields', reason: 'sensitive', fields: ['u_auth'] }),
      ]),
    );
    expect(JSON.stringify(all.body)).not.toContain('hunter2');
  });

  it('list_instances reports connector-level access without ids', async () => {
    const s = await setup();
    const call = await s.connect();
    await s.scopeFor(call, ['beta']);
    const list = await call('list_instances');
    expect(list.body.data.instances).toEqual([
      expect.objectContaining({
        alias: 'alpha',
        connector_access: { pending_request: false, active_access: false },
      }),
      expect.objectContaining({
        alias: 'beta',
        policy: 'test',
        connector_access: { pending_request: false, active_access: true },
      }),
      expect.objectContaining({ alias: 'gamma' }),
    ]);
    expect(list.body.data.note).toMatch(/shared by every conversation/);
  });

  it('request_scope validates instance/instances and maps unknown aliases', async () => {
    const s = await setup();
    const call = await s.connect();
    expect((await call('request_scope', { purpose: 'x' })).body.error.code).toBe('INVALID_INPUT');
    expect(
      (await call('request_scope', { instance: 'alpha', instances: ['beta'], purpose: 'x' })).body
        .error.code,
    ).toBe('INVALID_INPUT');
    expect(
      (await call('request_scope', { instances: ['alpha', 'alpha'], purpose: 'x' })).body.error
        .code,
    ).toBe('INVALID_INPUT');
    await call('list_instances'); // fills the registry hint cache
    const unknown = await call('request_scope', { instance: 'delta', purpose: 'x' });
    expect(unknown.body.error).toMatchObject({
      code: 'INSTANCE_NOT_REGISTERED',
      hint: 'Registered aliases: alpha, beta, gamma.',
    });
    const compare = await call('request_scope', { instances: ['alpha', 'gamma'], purpose: 'x' });
    expect(compare.body.data).toMatchObject({ mode: 'compare', status: 'pending' });
  });

  it('locally expired scopes fail fast with SCOPE_EXPIRED and are forgotten', async () => {
    const s = await setup();
    const call = await s.connect();
    const req = await call('request_scope', { instance: 'alpha', purpose: 'x' });
    await s.grants.approve(req.body.data.request_id, REGISTRY, { ttlMinutes: 1 });
    const claim = await call('claim_scope', { request_id: req.body.data.request_id });
    const id = claim.body.data.scope_id as string;
    expect((await call('query_records', { scope_id: id, table: 'incident' })).body.ok).toBe(true);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      const r = await call('query_records', { scope_id: id, table: 'incident' });
      expect(r.body.error.code).toBe('SCOPE_EXPIRED');
      // Forgotten: the next call without instance is SCOPE_UNKNOWN locally.
      expect(
        (await call('query_records', { scope_id: id, table: 'incident' })).body.error.code,
      ).toBe('SCOPE_UNKNOWN');
    } finally {
      Date.now = realNow;
    }
    expect(s.fetched).toHaveLength(1);
  });
});
