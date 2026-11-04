/**
 * T-014 (server side): fault injection across broker restarts, MCP restarts and in-flight
 * failures, with a fake extension running the REAL extension authz/grants. ServiceNow is
 * stubbed (mock; not evidence of real connectivity).
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
import { LABEL, MockExtension, makeTempDir } from './helpers.js';

const uid = process.getuid?.() as number;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const REGISTRY: InstanceEntry[] = [
  { alias: 'alpha', host: 'alpha.service-now.com', label: '', env: 'dev', addedAt: 'x' },
];
const SECRET = 'tok-SECRET-0123456789abcdef0123456789abcdef';

/** The extension's state that outlives broker restarts (grants live in storage.session). */
function extensionState() {
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
  return {
    grants,
    executions: 0,
    /** When set, the next execution waits for this promise (an operation "in flight"). */
    gate: undefined as Promise<void> | undefined,
  };
}

/** Attaches the extension to one broker connection (Chrome's port to one host process). */
function attach(ext: MockExtension, st: ReturnType<typeof extensionState>) {
  const deps = {
    grants: st.grants,
    registry: async () => REGISTRY,
    hasPermission: async () => true,
    execute: async () => {
      st.executions++;
      const gate = st.gate;
      st.gate = undefined;
      if (gate) await gate;
      return {
        ok: true as const,
        status: 200,
        body: [{ n: st.executions }],
        totalCount: 1,
        bytes: 9,
      };
    },
  };
  ext.extOut.on('data', () => {
    for (;;) {
      const idx = ext.reader.received.findIndex((m) => m.kind === 'forward');
      if (idx < 0) break;
      const f = ext.reader.received.splice(idx, 1)[0];
      void handleForward(f, deps).then((r) => {
        if (r) ext.send(r);
      });
    }
  });
}

async function startBroker(dir: string, st: ReturnType<typeof extensionState>) {
  const ext = new MockExtension();
  const logger = new MemoryLogger();
  const broker = new Broker({ dir, uid, extIn: ext.extIn, extOut: ext.extOut, logger });
  attach(ext, st);
  await broker.start();
  cleanups.push(() => broker.stop('test end'));
  return { broker, ext, logger };
}

async function mcp(dir: string) {
  const bridge = new BridgeClient({ dir, label: LABEL });
  const server = createMcpServer(bridge);
  const [ct, stt] = InMemoryTransport.createLinkedPair();
  await server.connect(stt);
  const client = new Client({ name: 'vitest', version: '0' });
  await client.connect(ct);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    bridge.close();
  });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
  };
}

async function scope(call: Awaited<ReturnType<typeof mcp>>, st: ReturnType<typeof extensionState>) {
  const req = await call('request_scope', { instance: 'alpha', purpose: 'p' });
  await st.grants.approve(req.data.request_id, REGISTRY);
  return (await call('claim_scope', { request_id: req.data.request_id })).data.scope_id as string;
}

describe('T-014 bridge resilience', () => {
  it('broker restart mid-request: BRIDGE_UNAVAILABLE, executed once, never replayed; same scope works on the new broker', async () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    const st = extensionState();
    const b1 = await startBroker(t.dir, st);
    const call = await mcp(t.dir);
    const id = await scope(call, st);

    let release: () => void = () => {};
    st.gate = new Promise<void>((r) => {
      release = r;
    });
    const inflight = call('query_records', { scope_id: id, table: 'incident' });
    for (let i = 0; i < 50 && st.executions === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(st.executions).toBe(1);
    await b1.broker.stop('killed');
    expect((await inflight).error.code).toBe('BRIDGE_UNAVAILABLE');

    // Chrome reconnects: a new host process (new key, new id prefix).
    const b2 = await startBroker(t.dir, st);
    release(); // the old operation finishes; its answer goes nowhere (old streams are closed)
    await new Promise((r) => setTimeout(r, 50));
    const again = await call('query_records', { scope_id: id, table: 'incident' });
    expect(again).toMatchObject({ ok: true, data: { records: [{ n: 2 }] } });
    expect(st.executions).toBe(2); // the failed call was never replayed
    expect(b2.logger.lines.join('\n')).not.toContain(id);
  });

  it('a late answer carrying a previous broker’s id is ignored by the new broker', async () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    const st = extensionState();
    const b1 = await startBroker(t.dir, st);
    const call1 = await mcp(t.dir);
    await call1('list_instances');
    const firstId = b1.logger.lines.find((l) => l.includes('request.forwarded'));
    expect(firstId).toBeDefined();
    await b1.broker.stop('restart');

    // New broker with a stalled extension (requests stay pending).
    const ext = new MockExtension();
    const logger = new MemoryLogger();
    const b2 = new Broker({ dir: t.dir, uid, extIn: ext.extIn, extOut: ext.extOut, logger });
    await b2.start();
    cleanups.push(() => b2.stop('end'));
    const call2 = await mcp(t.dir);
    const pending = call2('list_instances');
    const fwd = (await ext.next('forward')) as { request: { id: string } };
    expect(fwd.request.id).toMatch(/^b[A-Za-z0-9_-]{8}_1$/);
    // What a stale answer from broker 1's era would look like: same sequence number, other prefix.
    const staleId = `bZZZZZZZZ_1`;
    ext.send({
      v: 1,
      kind: 'response',
      id: staleId,
      ok: true,
      result: { type: 'registry.get', instances: [] },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(logger.lines.some((l) => l.includes('ext.unknown_response'))).toBe(true);
    // The real answer still reaches the waiting client.
    ext.send({
      v: 1,
      kind: 'response',
      id: fwd.request.id,
      ok: true,
      result: {
        type: 'registry.get',
        instances: [
          {
            alias: 'alpha',
            label: '',
            host: 'alpha.service-now.com',
            env: 'dev',
            connection: 'unknown',
            thisClient: { pendingRequest: false, activeGrant: false },
          },
        ],
      },
    });
    expect((await pending).data.instances.map((i: { alias: string }) => i.alias)).toEqual([
      'alpha',
    ]);
  });

  it('broker id prefixes differ per process', async () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ext = new MockExtension();
      const b = new Broker({
        dir: t.dir,
        uid,
        extIn: ext.extIn,
        extOut: ext.extOut,
        logger: new MemoryLogger(),
      });
      await b.start();
      const call = await mcp(t.dir);
      call('list_instances').catch(() => undefined); // left pending; closed at cleanup
      ids.push(((await ext.next('forward')) as { request: { id: string } }).request.id);
      await b.stop('next');
    }
    expect(new Set(ids.map((x) => x.split('_')[0])).size).toBe(3);
  });

  it('MCP restart: the old scope is unusable from the new process', async () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    const st = extensionState();
    await startBroker(t.dir, st);
    const first = await mcp(t.dir);
    const id = await scope(first, st);
    expect((await first('query_records', { scope_id: id, table: 'incident' })).ok).toBe(true);
    const restarted = await mcp(t.dir); // new process → new client key
    const r = await restarted('query_records', {
      scope_id: id,
      instance: 'alpha',
      table: 'incident',
    });
    expect(r.error.code).toBe('SCOPE_UNKNOWN');
    expect(st.executions).toBe(1);
  });

  it('error paths log metadata only (no message bodies, no secrets)', async () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    const ext = new MockExtension();
    const logger = new MemoryLogger();
    const b = new Broker({ dir: t.dir, uid, extIn: ext.extIn, extOut: ext.extOut, logger });
    await b.start();
    cleanups.push(() => b.stop('end'));
    const call = await mcp(t.dir);
    const p = call('list_instances');
    const fwd = (await ext.next('forward')) as { request: { id: string } };
    ext.send({
      v: 1,
      kind: 'response',
      id: fwd.request.id,
      ok: false,
      error: { code: 'SN_API_ERROR', message: `boom ${SECRET}` },
    });
    await p;
    ext.send({
      v: 1,
      kind: 'response',
      id: 'bnope_9',
      ok: false,
      error: { code: 'TIMEOUT', message: SECRET },
    });
    ext.send({ v: 1, kind: 'garbage', payload: SECRET });
    await new Promise((r) => setTimeout(r, 50));
    const log = logger.lines.join('\n');
    expect(log).toContain('SN_API_ERROR');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('boom');
  });
});
