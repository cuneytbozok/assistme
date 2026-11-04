/**
 * T-014 (extension side): heartbeat timeout, stale responses after reconnect, redaction on
 * error paths, and grant persistence across extension reload vs Chrome restart. Mocks only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { type GrantStorage, Grants } from '../src/background/grants.js';
import { BridgePort, type BridgeState, type PortLike } from '../src/background/port.js';
import type { InstanceEntry } from '../src/background/registry.js';

const TOKEN = 'tok-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

function fakePort() {
  const posted: unknown[] = [];
  const msg: ((m: unknown) => void)[] = [];
  const disc: (() => void)[] = [];
  let disconnected = 0;
  const port: PortLike = {
    postMessage: (m) => posted.push(m),
    disconnect: () => {
      disconnected++;
    },
    onMessage: { addListener: (cb) => msg.push(cb) },
    onDisconnect: { addListener: (cb) => disc.push(cb) },
  };
  return {
    port,
    posted,
    disconnected: () => disconnected,
    emit: (m: unknown) => {
      for (const cb of msg) cb(m);
    },
    drop: () => {
      for (const cb of disc) cb();
    },
  };
}

function harness() {
  const clock = { t: 0 };
  const timeouts: { fn: () => void; ms: number }[] = [];
  const intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const ports: ReturnType<typeof fakePort>[] = [];
  const states: BridgeState[] = [];
  const delivered: { m: unknown; gen: number }[] = [];
  const port = new BridgePort({
    connect: () => {
      const p = fakePort();
      ports.push(p);
      return p.port;
    },
    lastError: () => 'Native host has exited.',
    onMessage: (m, gen) => delivered.push({ m, gen }),
    onReady: () => {},
    onState: (s) => states.push(s),
    secrets: () => [TOKEN],
    setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    now: () => clock.t,
  });
  /** Advances time and runs the live heartbeat interval once per elapsed interval. */
  const tick = (ms: number) => {
    for (let left = ms; left > 0; left -= HEARTBEAT_INTERVAL_MS) {
      clock.t += Math.min(HEARTBEAT_INTERVAL_MS, left);
      for (const i of intervals.filter((x) => !x.cleared)) i.fn();
    }
  };
  return { port, ports, states, delivered, timeouts, tick, clock };
}

const forward = (id: string) => ({
  v: 1,
  kind: 'forward',
  client: { keyId: 'a'.repeat(64), label: { name: 'c', pid: 1 } },
  request: { v: 1, kind: 'registry.get', id },
});
const response = (id: string, extra: Record<string, unknown> = {}) => ({
  v: 1 as const,
  kind: 'response' as const,
  id,
  ok: true as const,
  result: { type: 'scope.release' as const, released: true },
  ...extra,
});

describe('heartbeat timeout', () => {
  it('a host that stops answering is dropped and reconnected', () => {
    const h = harness();
    h.port.start();
    const first = h.ports[0];
    first?.emit({ v: 1, kind: 'broker.status', state: 'ready' });
    // Pongs keep it alive.
    for (let i = 0; i < 5; i++) {
      h.tick(HEARTBEAT_INTERVAL_MS);
      first?.emit({ v: 1, kind: 'pong', id: `hb${i + 1}` });
    }
    expect(first?.disconnected()).toBe(0);
    // Silence: dropped once the timeout passes.
    h.tick(HEARTBEAT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS);
    expect(first?.disconnected()).toBe(1);
    expect(h.states.at(-1)).toMatchObject({ state: 'disconnected', reason: 'heartbeat timeout' });
    h.timeouts.shift()?.fn();
    expect(h.ports).toHaveLength(2); // reconnected
    // A late message from the dropped connection is ignored.
    first?.emit(forward('bOLD_1'));
    expect(h.delivered).toHaveLength(0);
  });
});

describe('stale responses after a reconnect (no replay, no misdelivery)', () => {
  it('a response is sent only on the connection its request arrived on', () => {
    const h = harness();
    h.port.start();
    h.ports[0]?.emit(forward('bAAA_1'));
    const gen1 = h.delivered[0]?.gen as number;
    h.ports[0]?.drop(); // broker restarts while the operation is still running
    h.timeouts.shift()?.fn();
    h.ports[1]?.emit({ v: 1, kind: 'broker.status', state: 'ready' });
    h.ports[1]?.emit(forward('bBBB_1'));
    const gen2 = h.delivered[1]?.gen as number;
    expect(gen2).not.toBe(gen1);

    // The old operation finishes now: its answer must not reach the new broker.
    expect(h.port.respond(response('bAAA_1'), gen1)).toBe(false);
    expect(h.port.droppedStale).toBe(1);
    expect(h.ports[1]?.posted).toEqual([]);
    expect(h.port.respond(response('bBBB_1'), gen2)).toBe(true);
    expect(h.ports[1]?.posted).toEqual([response('bBBB_1')]);
  });
});

describe('redaction on error paths', () => {
  it('an error response containing a session token is withheld and replaced', () => {
    const h = harness();
    h.port.start();
    h.ports[0]?.emit(forward('bX_1'));
    const gen = h.delivered[0]?.gen as number;
    const leaky = {
      v: 1 as const,
      kind: 'response' as const,
      id: 'bX_1',
      ok: false as const,
      error: { code: 'SN_API_ERROR' as const, message: `invalid token ${TOKEN}` },
    };
    expect(h.port.respond(leaky, gen)).toBe(true);
    const posted = h.ports[0]?.posted ?? [];
    expect(JSON.stringify(posted)).not.toContain(TOKEN);
    expect(posted).toEqual([
      expect.objectContaining({
        id: 'bX_1',
        ok: false,
        error: expect.objectContaining({ message: 'The response was withheld by the extension.' }),
      }),
    ]);
    expect(h.port.blockedSends).toBe(1);
  });
});

describe('grants across extension reload and Chrome restart', () => {
  const REG: InstanceEntry[] = [
    { alias: 'dev', host: 'dev.service-now.com', label: '', env: 'dev', addedAt: 'x' },
  ];
  const deps = {
    now: () => Date.parse('2026-11-04T12:00:00Z'),
    randomBytes: (n: number) => new Uint8Array(randomBytes(n)),
    sha256Hex: async (s: string) => createHash('sha256').update(s).digest('hex'),
  };
  function sessionStorage() {
    const area: { data?: unknown } = {};
    const storage: GrantStorage = {
      load: async () => structuredClone(area.data),
      save: async (s) => {
        area.data = structuredClone(s);
      },
    };
    return { area, storage };
  }
  async function grant(g: Grants) {
    const client = { keyId: 'a'.repeat(64), label: { name: 'c', pid: 1 } };
    const r = await g.createRequest(
      client,
      { instances: ['dev'], mode: 'single', purpose: 'p' },
      REG,
    );
    if (!r.ok) throw new Error(r.message);
    await g.approve(r.value.requestId, REG);
    const c = await g.claim(client.keyId, r.value.requestId);
    if (!c.ok || c.value.status !== 'approved') throw new Error('claim');
    return c.value.scopeId;
  }

  it('extension reload: storage.session survives, so the scope still works', async () => {
    const { storage } = sessionStorage();
    const scopeId = await grant(new Grants(storage, deps));
    const reloaded = new Grants(storage, deps); // new service worker, same session storage
    expect(await reloaded.authorize('a'.repeat(64), scopeId, 'dev')).toMatchObject({ ok: true });
  });

  it('Chrome restart: storage.session is cleared, so the scope is unknown', async () => {
    const { area, storage } = sessionStorage();
    const scopeId = await grant(new Grants(storage, deps));
    area.data = undefined; // Chrome clears chrome.storage.session on restart
    const fresh = new Grants(storage, deps);
    expect(await fresh.authorize('a'.repeat(64), scopeId, 'dev')).toMatchObject({
      ok: false,
      code: 'SCOPE_UNKNOWN',
    });
  });
});
