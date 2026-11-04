/**
 * T-019: per-request safeguards and settings (stubbed fetch; mocks only).
 */
import { SAFEGUARD_DEFAULTS } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { handleForward } from '../src/background/authz.js';
import { Executor, type TokenProvider } from '../src/background/executor.js';
import { type GrantStorage, Grants } from '../src/background/grants.js';
import { handlePopupMessage, isPopupSender } from '../src/background/popup-api.js';
import { Registry, type RegistryStorage } from '../src/background/registry.js';
import { ConcurrencyLimiter, retryAfterSeconds } from '../src/background/safeguards.js';
import {
  effectiveSafeguards,
  type Safeguards,
  Settings,
  type SettingsStorage,
  validateOverrides,
} from '../src/background/settings.js';

const HOST = 'dev.service-now.com';
const op = {
  kind: 'table.list',
  table: 'incident',
  limit: 1,
  offset: 0,
  displayValue: 'false',
  noCount: true,
};
const tokens: TokenProvider = { get: async () => 'tok', clear: () => {} };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const sg = (o: Partial<Safeguards> = {}): Safeguards => ({ ...SAFEGUARD_DEFAULTS, ...o });

function memorySettings(initial?: unknown): Settings & { mem: { data: unknown } } {
  const storage = { data: initial as unknown };
  const s: SettingsStorage = {
    load: async () => structuredClone(storage.data),
    save: async (v) => {
      storage.data = structuredClone(v);
    },
  };
  return Object.assign(new Settings(s), { mem: storage });
}

describe('AC1: timeout, size cap, concurrency, 429', () => {
  it('timeout → TIMEOUT (the fetch is aborted)', async () => {
    let aborted = false;
    const ex = new Executor({
      tokens,
      safeguards: async () => sg({ requestTimeoutMs: 50 }),
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            rej(new DOMException('aborted', 'AbortError'));
          });
        })) as typeof fetch,
    });
    expect(await ex.run(HOST, op)).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(aborted).toBe(true);
  });

  it('size cap aborts the stream → RESPONSE_TOO_LARGE', async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const ex = new Executor({
      tokens,
      safeguards: async () => sg({ maxResponseBytes: 256 * 1024 }),
      fetch: (async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    expect(await ex.run(HOST, op)).toMatchObject({ ok: false, code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10); // stopped early, not read to the end
  });

  it('concurrency: the 5th request waits, then runs; never rejected within the timeout', async () => {
    const gates: (() => void)[] = [];
    let started = 0;
    const ex = new Executor({
      tokens,
      safeguards: async () => sg({ maxConcurrentPerInstance: 4, requestTimeoutMs: 5_000 }),
      fetch: (async () => {
        started++;
        await new Promise<void>((r) => gates.push(r));
        return json(200, { result: [] });
      }) as typeof fetch,
    });
    const runs = Array.from({ length: 5 }, () => ex.run(HOST, op));
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(4); // the 5th is queued
    gates.shift()?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(5); // it ran once a slot freed up
    for (const g of gates.splice(0)) g();
    const results = await Promise.all(runs);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('a queue wait longer than the timeout → TIMEOUT, and that request is never sent', async () => {
    let started = 0;
    const gate: (() => void)[] = [];
    const ex = new Executor({
      tokens,
      safeguards: async () => sg({ maxConcurrentPerInstance: 1, requestTimeoutMs: 60 }),
      fetch: (async (_u: unknown, init?: RequestInit) => {
        started++;
        await new Promise<void>((r) => {
          gate.push(r);
          init?.signal?.addEventListener('abort', () => r());
        });
        return json(200, { result: [] });
      }) as typeof fetch,
    });
    const first = ex.run(HOST, op);
    const second = await ex.run(HOST, op);
    expect(second).toMatchObject({
      ok: false,
      code: 'TIMEOUT',
      message: expect.stringMatching(/not sent/),
    });
    expect(started).toBe(1);
    gate[0]?.();
    await first;
  });

  it('limits are per instance: another host is not blocked', async () => {
    const l = new ConcurrencyLimiter();
    let release: () => void = () => {};
    const a = l.run(
      'a',
      1,
      1000,
      () =>
        new Promise<number>((r) => {
          release = () => r(1);
        }),
      () => -1,
    );
    const b = await l.run(
      'b',
      1,
      1000,
      async () => 2,
      () => -1,
    );
    expect(b).toBe(2);
    expect(l.stats('a')).toEqual({ active: 1, queued: 0 });
    release();
    expect(await a).toBe(1);
  });

  it('429 → RATE_LIMITED with the Retry-After value', async () => {
    const run = (
      h: Record<string, string>,
      status = 429,
      body: unknown = { error: { message: 'Too many requests' } },
    ) =>
      new Executor({ tokens, fetch: (async () => json(status, body, h)) as typeof fetch }).run(
        HOST,
        op,
      );
    expect(await run({ 'Retry-After': '12' })).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('Retry after 12 s'),
    });
    expect(await run({})).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('Retry later'),
    });
    // Transaction quota rule (ServiceNow answers 4xx with a quota message)
    expect(
      await run({}, 400, { error: { message: 'Maximum transaction quota exceeded' } }),
    ).toMatchObject({ code: 'RATE_LIMITED' });
    expect(
      retryAfterSeconds('Wed, 04 Nov 2026 12:00:30 GMT', Date.parse('2026-11-04T12:00:00Z')),
    ).toBe(30);
    expect(retryAfterSeconds('soon')).toBeUndefined();
  });
});

describe('AC1: settings precedence, ranges, and who may change them', () => {
  it('per-instance override > global > default', async () => {
    const s = memorySettings();
    await s.set(
      {
        global: { requestTimeoutMs: 60_000 },
        perInstance: { prod: { requestTimeoutMs: 10_000, maxConcurrentPerInstance: 1 } },
      },
      ['dev', 'prod'],
    );
    expect(await s.forInstance('prod')).toEqual({
      ...SAFEGUARD_DEFAULTS,
      requestTimeoutMs: 10_000,
      maxConcurrentPerInstance: 1,
    });
    expect(await s.forInstance('dev')).toEqual({ ...SAFEGUARD_DEFAULTS, requestTimeoutMs: 60_000 });
    expect(await s.forInstance(undefined)).toEqual({
      ...SAFEGUARD_DEFAULTS,
      requestTimeoutMs: 60_000,
    });
  });

  it.each([
    [{ requestTimeoutMs: 4_999 }],
    [{ requestTimeoutMs: 300_001 }],
    [{ maxResponseBytes: 1024 }],
    [{ maxResponseBytes: 51 * 1024 * 1024 }],
    [{ maxConcurrentPerInstance: 0 }],
    [{ maxConcurrentPerInstance: 17 }],
    [{ maxConcurrentPerInstance: 2.5 }],
    [{ requestTimeoutMs: '30000' }],
    [{ perMinuteQuota: 10 }],
  ])('refuses %j', async (o) => {
    expect(validateOverrides(o).ok).toBe(false);
    const s = memorySettings();
    expect(await s.set({ global: o, perInstance: {} }, [])).toMatchObject({ ok: false });
    expect(s.mem.data).toBeUndefined();
  });

  it('refuses overrides for unregistered instances; accepts boundary values', async () => {
    const s = memorySettings();
    expect(
      await s.set({ global: {}, perInstance: { ghost: { requestTimeoutMs: 10_000 } } }, ['dev']),
    ).toMatchObject({ ok: false });
    expect(
      await s.set(
        {
          global: {
            requestTimeoutMs: 5_000,
            maxResponseBytes: 50 * 1024 * 1024,
            maxConcurrentPerInstance: 16,
          },
          perInstance: {},
        },
        [],
      ),
    ).toMatchObject({ ok: true });
  });

  it('tampered storage is re-validated on load', async () => {
    const s = memorySettings({
      global: { requestTimeoutMs: 1, maxConcurrentPerInstance: 8 },
      perInstance: { x: { evil: 1 } },
    });
    expect(await s.get()).toEqual({ global: {}, perInstance: {} });
    const ok = memorySettings({
      global: { maxConcurrentPerInstance: 8 },
      perInstance: { x: { evil: 1 } },
    });
    expect(await ok.get()).toEqual({ global: { maxConcurrentPerInstance: 8 }, perInstance: {} });
  });

  it('only the popup can change settings', async () => {
    const id = 'clipfeocpiljpcngmjpdbegciimchbol';
    const popup = `chrome-extension://${id}/popup.html`;
    expect(isPopupSender({ id, url: popup }, id, popup)).toBe(true);
    expect(isPopupSender({ id, url: popup, tab: { id: 1 } }, id, popup)).toBe(false); // a page/tab
    expect(isPopupSender({ id: 'other', url: popup }, id, popup)).toBe(false);
    expect(isPopupSender({ id, url: `chrome-extension://${id}/other.html` }, id, popup)).toBe(
      false,
    );
    // The broker/MCP side has no settings message: a forged one is not even parsed.
    const grants = new Grants(
      { load: async () => undefined, save: async () => undefined } as GrantStorage,
      {
        now: () => 0,
        randomBytes: (n) => new Uint8Array(n),
        sha256Hex: async () => '',
      },
    );
    const forged = await handleForward(
      {
        v: 1,
        kind: 'forward',
        client: { keyId: 'a'.repeat(64), label: { name: 'x', pid: 1 } },
        request: {
          v: 1,
          kind: 'settings.set',
          id: 'x',
          settings: { global: { requestTimeoutMs: 300_000 } },
        },
      },
      {
        grants,
        registry: async () => [],
        hasPermission: async () => true,
        execute: async () => ({ ok: false, code: 'TIMEOUT', message: '' }),
      },
    );
    expect(forged).toBeUndefined();
  });

  it('popup messages read and write settings; removing an instance drops its overrides', async () => {
    const settings = memorySettings();
    let regData: unknown = [{ alias: 'dev', host: HOST, label: '', env: 'dev', addedAt: 'x' }];
    const registryStore = new Registry({
      load: async () => structuredClone(regData),
      save: async (e) => {
        regData = structuredClone(e);
      },
    } as RegistryStorage);
    const grants = new Grants(
      { load: async () => undefined, save: async () => undefined } as GrantStorage,
      {
        now: () => 0,
        randomBytes: (n) => new Uint8Array(n),
        sha256Hex: async () => '',
      },
    );
    const d = {
      grants,
      registry: () => registryStore.list(),
      registryStore,
      settings,
      bridgeState: () => ({ state: 'connected' as const }),
      onChanged: () => {},
    };
    expect(
      await handlePopupMessage(
        {
          type: 'popup.settings.set',
          settings: { global: {}, perInstance: { dev: { maxConcurrentPerInstance: 2 } } },
        },
        d,
      ),
    ).toMatchObject({ ok: true });
    expect(await handlePopupMessage({ type: 'popup.settings.get' }, d)).toMatchObject({
      settings: { perInstance: { dev: { maxConcurrentPerInstance: 2 } } },
    });
    expect(
      await handlePopupMessage(
        { type: 'popup.settings.set', settings: { global: { requestTimeoutMs: 1 } } },
        d,
      ),
    ).toMatchObject({ ok: false });
    await handlePopupMessage(
      { type: 'popup.registry.remove', alias: 'dev', removeHostPermission: false },
      d,
    );
    expect((await settings.get()).perInstance).toEqual({});
  });
});

describe('AC2: the same defaults for DEV and PROD', () => {
  it('effective safeguards take no environment input', () => {
    const state = { global: {}, perInstance: {} };
    expect(effectiveSafeguards(state, 'dev')).toEqual(effectiveSafeguards(state, 'prod'));
    expect(effectiveSafeguards(state, 'prod')).toEqual(SAFEGUARD_DEFAULTS);
    expect(effectiveSafeguards.length).toBe(2); // (state, alias): no env parameter
  });
});

describe('AC3: no quota', () => {
  it('500 sequential requests complete with no quota error', async () => {
    let n = 0;
    const ex = new Executor({
      tokens,
      fetch: (async () => {
        n++;
        return json(200, { result: [{ n }] });
      }) as typeof fetch,
    });
    for (let i = 0; i < 500; i++) {
      const r = await ex.run(HOST, op);
      if (!r.ok) throw new Error(`request ${i}: ${r.code}`);
    }
    expect(n).toBe(500);
  });
});
