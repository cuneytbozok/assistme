/**
 * T-013: session lifecycle and connection status. Stubbed fetch, tabs and permissions (mocks;
 * not evidence of ServiceNow connectivity — the live logged-out check is in T-015).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleForward } from '../src/background/authz.js';
import { type ExecResult, Executor, type TokenProvider } from '../src/background/executor.js';
import { type GrantStorage, Grants } from '../src/background/grants.js';
import type { InstanceEntry } from '../src/background/registry.js';
import { describeState, EXPIRED_REPROBE_MS, SessionTracker } from '../src/background/session.js';

const listOp = {
  kind: 'table.list',
  table: 'incident',
  limit: 1,
  offset: 0,
  displayValue: 'false',
  noCount: true,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Per-host tokens as they would be read from that host's tab. */
function tabTokens(initial: Record<string, string | undefined>) {
  const tab = { ...initial };
  const cache = new Map<string, string>();
  const t: TokenProvider & { tab: typeof tab; cleared: string[]; reads: string[] } = {
    tab,
    cleared: [],
    reads: [],
    async get(host, opts = {}) {
      if (!opts.refresh && cache.has(host)) return cache.get(host);
      t.reads.push(host);
      const v = tab[host];
      if (v) cache.set(host, v);
      else cache.delete(host);
      return v;
    },
    clear(host) {
      t.cleared.push(host);
      cache.delete(host);
    },
  };
  return t;
}

/** Fake ServiceNow: a host accepts exactly its current valid token. */
function fakeServiceNow(valid: Record<string, string | undefined>) {
  const calls: { host: string; token: string | null }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get('X-UserToken');
    calls.push({ host: url.host, token });
    if (token && token === valid[url.host]) return json(200, { result: [{ ok: url.host }] });
    return json(401, { error: { message: 'User is not authenticated' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, valid };
}

describe('AC1: expired session → SESSION_EXPIRED for that instance only', () => {
  it('clears only that token and never retries elsewhere', async () => {
    const sn = fakeServiceNow({ 'a.service-now.com': 'tokA', 'b.service-now.com': 'tokB' });
    const tokens = tabTokens({ 'a.service-now.com': 'tokA', 'b.service-now.com': 'tokB' });
    const ex = new Executor({ fetch: sn.fetch, tokens });
    expect((await ex.run('a.service-now.com', listOp)).ok).toBe(true);
    expect((await ex.run('b.service-now.com', listOp)).ok).toBe(true);

    sn.valid['a.service-now.com'] = undefined; // A logged out (tab still shows the old token)
    sn.calls.length = 0;
    const r = await ex.run('a.service-now.com', listOp);
    expect(r).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(sn.calls.map((c) => c.host)).toEqual(['a.service-now.com', 'a.service-now.com']);
    expect(tokens.cleared).toEqual(['a.service-now.com']);
    // B is unaffected and still uses its cached token (no re-read).
    const readsBefore = tokens.reads.length;
    expect((await ex.run('b.service-now.com', listOp)).ok).toBe(true);
    expect(tokens.reads.length).toBe(readsBefore);
  });
});

describe('AC2: after re-login the next request succeeds without a new grant', () => {
  it('stale cached token → 401 → token re-read → 200, same scope', async () => {
    const host = 'a.service-now.com';
    const registry: InstanceEntry[] = [{ alias: 'a', host, label: '', env: 'dev', addedAt: 'x' }];
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
    const sn = fakeServiceNow({ [host]: 'old' });
    const tokens = tabTokens({ [host]: 'old' });
    const ex = new Executor({ fetch: sn.fetch, tokens });
    const tracker = new SessionTracker({
      hasPermission: async () => true,
      hasTab: async () => true,
      probe: (h) => ex.run(h, { kind: 'probe' }),
      now: () => Date.now(),
    });
    const deps = {
      grants,
      registry: async () => registry,
      hasPermission: async () => true,
      execute: async (h: string, op: unknown) => {
        const r = await ex.run(h, op);
        tracker.record(h, r);
        return r;
      },
    };
    const client = { keyId: 'a'.repeat(64), label: { name: 't', pid: 1 } };
    const fwd = (request: Record<string, unknown>) => ({
      v: 1,
      kind: 'forward',
      client,
      request: { v: 1, ...request },
    });
    const req = (await handleForward(
      fwd({ kind: 'scope.request', id: 'r1', instances: ['a'], mode: 'single', purpose: 'p' }),
      deps,
    )) as { result: { requestId: string } };
    await grants.approve(req.result.requestId, registry);
    const claim = (await handleForward(
      fwd({ kind: 'scope.claim', id: 'r2', requestId: req.result.requestId }),
      deps,
    )) as { result: { scopeId: string } };
    const op = (id: string) =>
      handleForward(
        fwd({ kind: 'sn.op', id, scopeId: claim.result.scopeId, instance: 'a', op: listOp }),
        deps,
      );

    expect(await op('o1')).toMatchObject({ ok: true });
    sn.valid[host] = undefined; // session ends
    expect(await op('o2')).toMatchObject({ ok: false, error: { code: 'SESSION_EXPIRED' } });
    expect(await tracker.status(host)).toBe('session_expired');

    // User signs in again: new session, new token in the tab.
    sn.valid[host] = 'new';
    tokens.tab[host] = 'new';
    expect(await op('o3')).toMatchObject({ ok: true, result: { instance: 'a' } });
    expect(await tracker.status(host)).toBe('connected');
    expect((await grants.snapshot()).grants).toHaveLength(1); // the same grant, no new one
  });
});

describe('no credential prompts', () => {
  it('every ServiceNow request carries X-UserToken; without a token nothing is sent', async () => {
    const sn = fakeServiceNow({ 'a.service-now.com': 'tok' });
    const ex = new Executor({ fetch: sn.fetch, tokens: tabTokens({ 'a.service-now.com': 'tok' }) });
    await ex.run('a.service-now.com', listOp);
    await ex.run('a.service-now.com', { kind: 'probe' });
    sn.valid['a.service-now.com'] = undefined;
    await ex.run('a.service-now.com', listOp);
    expect(sn.calls.length).toBeGreaterThan(2);
    expect(sn.calls.every((c) => typeof c.token === 'string' && c.token.length > 0)).toBe(true);

    const none = fakeServiceNow({});
    const r = await new Executor({ fetch: none.fetch, tokens: tabTokens({}) }).run(
      'x.service-now.com',
      listOp,
    );
    expect(r).toMatchObject({ ok: false, code: 'NO_INSTANCE_TAB' });
    expect(none.calls).toEqual([]);
  });
});

describe('SessionTracker (AC3: status within 30 s or on the next request)', () => {
  function tracker(opts: { perm?: boolean; tab?: boolean; probe?: ExecResult } = {}) {
    const env = { perm: opts.perm ?? true, tab: opts.tab ?? true, t: 1_000_000, probes: 0 };
    const probeResult = {
      current: opts.probe ?? ({ ok: true, status: 200, body: [], bytes: 1 } as ExecResult),
    };
    const t = new SessionTracker({
      hasPermission: async () => env.perm,
      hasTab: async () => env.tab,
      probe: async () => {
        env.probes++;
        return probeResult.current;
      },
      now: () => env.t,
    });
    return { t, env, probeResult };
  }
  const H = 'a.service-now.com';
  const expired: ExecResult = { ok: false, code: 'SESSION_EXPIRED', message: 'x' };
  const okRes: ExecResult = { ok: true, status: 200, body: [], bytes: 1 };

  it('local signals: no_permission beats no_tab beats session knowledge', async () => {
    const { t, env } = tracker();
    expect(await t.status(H)).toBe('unknown');
    t.record(H, okRes);
    expect(await t.status(H)).toBe('connected');
    env.tab = false;
    expect(await t.status(H)).toBe('no_tab');
    env.tab = true;
    expect(await t.status(H)).toBe('unknown'); // closing all tabs forgot the session
    env.perm = false;
    expect(await t.status(H)).toBe('no_permission');
  });

  it('requests update the state immediately; other errors do not', async () => {
    const { t } = tracker();
    t.record(H, okRes);
    t.record(H, { ok: false, code: 'ACL_DENIED', message: 'x' });
    expect(await t.status(H)).toBe('connected');
    t.record(H, expired);
    expect(await t.status(H)).toBe('session_expired');
  });

  it('unknown hosts are probed only when the user opens the popup', async () => {
    const { t, env } = tracker();
    expect(await t.check(H)).toBe('unknown');
    expect(env.probes).toBe(0);
    expect(await t.check(H, { probeUnknown: true })).toBe('connected');
    expect(env.probes).toBe(1);
    env.tab = false;
    expect(await t.check(H, { probeUnknown: true })).toBe('no_tab');
    expect(env.probes).toBe(1); // no tab → no request
  });

  it('expired hosts are re-probed at most every 30 s and recover after re-login', async () => {
    const { t, env, probeResult } = tracker({ probe: expired });
    t.record(H, expired);
    expect(await t.check(H)).toBe('session_expired');
    expect(env.probes).toBe(1);
    env.t += 10_000;
    expect(await t.check(H)).toBe('session_expired');
    expect(env.probes).toBe(1); // throttled
    probeResult.current = okRes; // user signed in again
    env.t += EXPIRED_REPROBE_MS;
    expect(await t.check(H)).toBe('connected');
    expect(env.probes).toBe(2);
  });

  it('concurrent checks share one probe; refresh reports changes', async () => {
    const { t, env } = tracker();
    await Promise.all([1, 2, 3].map(() => t.check(H, { probeUnknown: true })));
    expect(env.probes).toBe(1);
    const first = await t.refresh([H], new Map());
    expect(first).toMatchObject({ changed: true });
    expect(first.states.get(H)).toBe('connected');
    expect((await t.refresh([H], first.states)).changed).toBe(false);
    env.tab = false;
    expect((await t.refresh([H], first.states)).changed).toBe(true);
  });

  it('registry.get reports the connection state', async () => {
    const r = await handleForward(
      {
        v: 1,
        kind: 'forward',
        client: { keyId: 'a'.repeat(64), label: { name: 't', pid: 1 } },
        request: { v: 1, kind: 'registry.get', id: 'g' },
      },
      {
        grants: new Grants(
          { load: async () => undefined, save: async () => undefined },
          { now: () => 0, randomBytes: (n) => new Uint8Array(n), sha256Hex: async () => '' },
        ),
        registry: async () => [{ alias: 'a', host: H, label: '', env: 'dev', addedAt: 'x' }],
        hasPermission: async () => true,
        execute: async () => okRes,
        connection: async () => 'session_expired',
      },
    );
    expect(r).toMatchObject({
      result: { instances: [{ alias: 'a', connection: 'session_expired' }] },
    });
  });

  it('describes every state as plain text', () => {
    for (const s of [
      'connected',
      'no_tab',
      'session_expired',
      'no_permission',
      'unknown',
    ] as const) {
      expect(describeState(s, H).length).toBeGreaterThan(5);
    }
    expect(describeState('no_tab', H)).toContain(H);
  });
});
