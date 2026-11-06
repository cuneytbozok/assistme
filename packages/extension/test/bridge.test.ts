/**
 * Executor, dispatcher, port and popup-sender tests with stubbed fetch and Chrome APIs (mocks;
 * not evidence of ServiceNow connectivity).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleForward } from '../src/background/authz.js';
import {
  buildPath,
  containsSecret,
  Executor,
  type TokenProvider,
} from '../src/background/executor.js';
import { type GrantStorage, Grants } from '../src/background/grants.js';
import { isPopupSender } from '../src/background/popup-api.js';
import { BridgePort, type BridgeState, backoffMs, type PortLike } from '../src/background/port.js';
import type { InstanceEntry } from '../src/background/registry.js';

const TOKEN = 'tok-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

function tokens(
  values: (string | undefined)[] = [TOKEN],
): TokenProvider & { calls: number; cleared: number } {
  const t = {
    calls: 0,
    cleared: 0,
    async get() {
      return values[Math.min(t.calls++, values.length - 1)];
    },
    clear() {
      t.cleared++;
    },
  };
  return t;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', ...headers },
  });
}

const listOp = {
  kind: 'table.list',
  table: 'incident',
  limit: 1,
  offset: 0,
  displayValue: 'false',
  noCount: true,
};

describe('executor (path A)', () => {
  it('builds fixed Table API paths only', () => {
    expect(buildPath({ kind: 'probe' })).toBe(
      '/api/now/table/sys_db_object?sysparm_limit=1&sysparm_fields=sys_id&sysparm_no_count=true',
    );
    expect(
      buildPath({
        ...listOp,
        fields: ['number', 'caller_id.name'],
        query: 'active=true^ORDERBYnumber',
      } as never),
    ).toBe(
      '/api/now/table/incident?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_fields=number%2Ccaller_id.name&sysparm_limit=1&sysparm_offset=0&sysparm_display_value=false&sysparm_exclude_reference_link=true&sysparm_no_count=true&sysparm_suppress_pagination_header=true',
    );
    expect(
      buildPath({
        kind: 'table.get',
        table: 'incident',
        sysId: 'a'.repeat(32),
        displayValue: 'all',
      } as never),
    ).toBe(
      `/api/now/table/incident/${'a'.repeat(32)}?sysparm_display_value=all&sysparm_exclude_reference_link=true`,
    );
  });

  it('sends GET with cookies + X-UserToken, manual redirects, and returns the result', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ex = new Executor({
      tokens: tokens(),
      fetch: async (url, init) => {
        seen.push({ url: String(url), init: init as RequestInit });
        return jsonResponse(200, { result: [{ number: 'INC0000060' }] }, { 'x-total-count': '67' });
      },
    });
    const r = await ex.run('dev1.service-now.com', listOp);
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      body: [{ number: 'INC0000060' }],
      totalCount: 67,
    });
    expect(seen[0]?.url.startsWith('https://dev1.service-now.com/api/now/table/incident?')).toBe(
      true,
    );
    expect(seen[0]?.init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      redirect: 'manual',
    });
    expect((seen[0]?.init.headers ?? {}) as Record<string, string>).toMatchObject({
      'X-UserToken': TOKEN,
    });
  });

  it('re-validates operations from the untrusted broker', async () => {
    const ex = new Executor({
      tokens: tokens(),
      fetch: async () => jsonResponse(200, { result: [] }),
    });
    expect(await ex.run('h.service-now.com', { ...listOp, table: '../x' })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await ex.run('h.service-now.com', { ...listOp, method: 'DELETE' })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(
      await ex.run('h.service-now.com', { ...listOp, query: 'priority=1^RLQUERYsys_user' }),
    ).toMatchObject({ ok: false, code: 'UNSAFE_QUERY' });
  });

  it('no tab → NO_INSTANCE_TAB; 401 → token refresh + one retry; still 401 → SESSION_EXPIRED', async () => {
    expect(
      await new Executor({
        tokens: tokens([undefined]),
        fetch: async () => jsonResponse(200, {}),
      }).run('h.service-now.com', listOp),
    ).toMatchObject({
      ok: false,
      code: 'NO_INSTANCE_TAB',
    });
    let n = 0;
    const t1 = tokens([TOKEN, `${TOKEN}x`]);
    const recovered = await new Executor({
      tokens: t1,
      fetch: async () =>
        n++ === 0
          ? jsonResponse(401, { error: { message: 'User is not authenticated' } })
          : jsonResponse(200, { result: [] }),
    }).run('h.service-now.com', listOp);
    expect(recovered.ok).toBe(true);
    expect(t1.calls).toBe(2);
    const t2 = tokens();
    const expired = await new Executor({
      tokens: t2,
      fetch: async () => jsonResponse(401, {}),
    }).run('h.service-now.com', listOp);
    expect(expired).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(t2.cleared).toBe(1);
  });

  it('maps statuses, redirects, timeouts and oversized bodies', async () => {
    const run = (res: () => Promise<Response>, opts = {}) =>
      new Executor({ tokens: tokens(), fetch: res, ...opts }).run('h.service-now.com', listOp);
    expect(await run(async () => jsonResponse(403, { error: { message: 'ACL' } }))).toMatchObject({
      code: 'ACL_DENIED',
      message: 'ACL',
    });
    expect(await run(async () => jsonResponse(404, {}))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await run(async () => jsonResponse(429, {}))).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await run(async () => jsonResponse(500, {}))).toMatchObject({ code: 'SN_API_ERROR' });
    // T-047: ServiceNow's detail is relayed with its message, as the official SDK relays the body.
    expect(
      await run(async () =>
        jsonResponse(400, { error: { message: 'Invalid query', detail: 'field xyz not found' } }),
      ),
    ).toMatchObject({ code: 'SN_API_ERROR', message: 'Invalid query (field xyz not found)' });
    expect(
      await run(async () => jsonResponse(400, { error: { message: 'Same', detail: 'Same' } })),
    ).toMatchObject({ message: 'Same' });
    expect(
      await run(async () => jsonResponse(400, { error: { detail: 'only detail' } })),
    ).toMatchObject({ message: 'only detail' });
    const long = await run(async () =>
      jsonResponse(400, { error: { message: 'm'.repeat(300), detail: 'd'.repeat(300) } }),
    );
    expect(!long.ok && long.message.length).toBe(400);
    expect(await run(async () => new Response('', { status: 414 }))).toMatchObject({
      code: 'SN_API_ERROR',
      message: expect.stringMatching(/^HTTP 414: the request URL is too long/),
    });
    expect(
      await run(
        async () =>
          new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    ).toMatchObject({
      code: 'SN_API_ERROR',
    });
    expect(
      await run(
        async () => new Response(null, { status: 302, headers: { location: '/login.do' } }),
      ),
    ).toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(
      await run(async () => jsonResponse(200, { result: 'x'.repeat(5000) }), {
        maxResponseBytes: 1000,
      }),
    ).toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(
      await run(
        (_u?: unknown, init?: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
        { timeoutMs: 50 },
      ),
    ).toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('credential guard (AC4)', () => {
  it('detects token values anywhere in a serialized message', () => {
    expect(containsSecret(JSON.stringify({ body: { x: `a${TOKEN}b` } }), [TOKEN])).toBe(true);
    expect(containsSecret(JSON.stringify({ body: 'clean' }), [TOKEN])).toBe(false);
    expect(containsSecret('abc', ['ab'])).toBe(false); // too short to be a token
  });

  it('the port refuses to send a message containing a known token', () => {
    const posted: unknown[] = [];
    const port = new BridgePort({
      connect: () => fakePort(posted).port,
      lastError: () => undefined,
      onMessage: () => {},
      onReady: () => {},
      onState: () => {},
      secrets: () => [TOKEN],
      setInterval: () => 0,
      clearInterval: () => {},
    });
    port.start();
    const leak = {
      v: 1,
      kind: 'response',
      id: 'b1',
      ok: true,
      result: {
        type: 'sn.op',
        instance: 'dev',
        host: 'dev.service-now.com',
        env: 'dev',
        status: 200,
        body: { t: TOKEN },
        bytes: 1,
      },
    } as const;
    expect(port.send(leak)).toBe(false);
    expect(port.blockedSends).toBe(1);
    expect(posted).toHaveLength(0);
    expect(port.send({ ...leak, result: { ...leak.result, body: { t: 'fine' } } })).toBe(true);
    expect(posted).toHaveLength(1);
  });
});

function fakePort(posted: unknown[]) {
  const msg: ((m: unknown) => void)[] = [];
  const disc: (() => void)[] = [];
  const port: PortLike = {
    postMessage: (m) => posted.push(m),
    disconnect: () => {},
    onMessage: { addListener: (cb) => msg.push(cb) },
    onDisconnect: { addListener: (cb) => disc.push(cb) },
  };
  return {
    port,
    emit: (m: unknown) => {
      for (const cb of msg) cb(m);
    },
    drop: () => {
      for (const cb of disc) cb();
    },
  };
}

describe('port lifecycle (AC1, mocked)', () => {
  it('reconnects with exponential backoff, resets on ready, and surfaces conflicts', () => {
    expect([0, 1, 2, 6, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 60_000, 60_000]);
    const timers: { fn: () => void; ms: number }[] = [];
    const states: BridgeState[] = [];
    const ports: ReturnType<typeof fakePort>[] = [];
    let ready = 0;
    const port = new BridgePort({
      connect: () => {
        const p = fakePort([]);
        ports.push(p);
        return p.port;
      },
      lastError: () => 'Native host has exited.',
      onMessage: () => {},
      onReady: () => ready++,
      onState: (s) => states.push(s),
      secrets: () => [],
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    });
    port.start();
    ports[0]?.emit({ v: 1, kind: 'broker.status', state: 'ready' });
    expect(ready).toBe(1);
    ports[0]?.drop(); // host killed
    expect(states.at(-1)).toEqual({
      state: 'disconnected',
      reason: 'Native host has exited.',
      retryInMs: 1000,
    });
    timers.shift()?.fn();
    ports[1]?.drop();
    expect(timers.at(-1)?.ms).toBe(2000);
    timers.shift()?.fn();
    ports[2]?.emit({ v: 1, kind: 'broker.status', state: 'ready' });
    expect(ready).toBe(2); // reconnected
    ports[2]?.drop();
    expect(timers.at(-1)?.ms).toBe(1000); // backoff reset after a successful connection
    timers.shift()?.fn();
    ports[3]?.emit({ v: 1, kind: 'broker.status', state: 'conflict' });
    expect(states.at(-1)).toEqual({ state: 'conflict' });
    ports[3]?.drop();
    expect(timers.at(-1)?.ms).toBe(60_000);
  });

  it('answers broker pings and ignores invalid messages', () => {
    const posted: unknown[] = [];
    const delivered: unknown[] = [];
    let fp: ReturnType<typeof fakePort> | undefined;
    const port = new BridgePort({
      connect: () => {
        fp = fakePort(posted);
        return fp.port;
      },
      lastError: () => undefined,
      onMessage: (m) => delivered.push(m),
      onReady: () => {},
      onState: () => {},
      secrets: () => [],
      setInterval: () => 0,
      clearInterval: () => {},
    });
    port.start();
    fp?.emit({ v: 1, kind: 'ping', id: 'p1' });
    fp?.emit({ v: 1, kind: 'forward', evil: true });
    fp?.emit('garbage');
    expect(posted).toEqual([{ v: 1, kind: 'pong', id: 'p1' }]);
    expect(delivered).toHaveLength(0);
  });
});

describe('popup sender check (AC5)', () => {
  const id = 'clipfeocpiljpcngmjpdbegciimchbol';
  const url = `chrome-extension://${id}/popup.html`;
  it('accepts only the extension popup (no tab, exact URL)', () => {
    expect(isPopupSender({ id, url }, id, url)).toBe(true);
    expect(isPopupSender({ id, url, tab: { id: 3 } }, id, url)).toBe(false); // popup.html opened in a tab / content script
    expect(isPopupSender({ id: 'otherextension', url }, id, url)).toBe(false);
    expect(isPopupSender({ id, url: `chrome-extension://${id}/other.html` }, id, url)).toBe(false);
    expect(isPopupSender({ id, url: 'https://dev1.service-now.com/' }, id, url)).toBe(false);
    expect(isPopupSender({}, id, url)).toBe(false);
  });
});

describe('dispatcher', () => {
  const registry: InstanceEntry[] = [
    { alias: 'dev', host: 'dev1.service-now.com', label: 'Dev', env: 'dev', addedAt: 'x' },
  ];
  const keyId = 'c'.repeat(64);
  const client = { keyId, label: { name: 'dev-client', pid: 1 } };

  function deps(
    execute = async () => ({
      ok: true as const,
      status: 200,
      body: [{ number: 'INC1' }],
      bytes: 10,
    }),
  ) {
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
    const executed: string[] = [];
    return {
      grants,
      executed,
      d: {
        grants,
        registry: async () => registry,
        hasPermission: async () => true,
        execute: async (host: string, op: unknown) => {
          executed.push(host);
          void op;
          return execute();
        },
      },
    };
  }
  const fwd = (request: Record<string, unknown>) => ({
    v: 1,
    kind: 'forward',
    client,
    request: { v: 1, ...request },
  });

  it('runs request → approve → claim → sn.op, and refuses ops without a valid grant (AC2)', async () => {
    const { grants, d, executed } = deps();
    const op = {
      kind: 'table.list',
      table: 'incident',
      limit: 1,
      offset: 0,
      displayValue: 'false',
      noCount: true,
    };
    const denied = await handleForward(
      fwd({ kind: 'sn.op', id: 'b1', scopeId: `scp_${'x'.repeat(22)}`, instance: 'dev', op }),
      d,
    );
    expect(denied).toMatchObject({ ok: false, error: { code: 'SCOPE_UNKNOWN' } });
    expect(executed).toHaveLength(0);

    const req = await handleForward(
      fwd({ kind: 'scope.request', id: 'b2', instances: ['dev'], mode: 'single', purpose: 'p' }),
      d,
    );
    expect(req).toMatchObject({ ok: true, result: { type: 'scope.request' } });
    const requestId = (req as { result: { requestId: string } }).result.requestId;
    await grants.approve(requestId, registry);
    const claim = await handleForward(fwd({ kind: 'scope.claim', id: 'b3', requestId }), d);
    const scopeId = (claim as { result: { scopeId: string } }).result.scopeId;
    const ok = await handleForward(
      fwd({ kind: 'sn.op', id: 'b4', scopeId, instance: 'dev', op }),
      d,
    );
    expect(ok).toMatchObject({
      id: 'b4',
      ok: true,
      result: {
        type: 'sn.op',
        instance: 'dev',
        host: 'dev1.service-now.com',
        env: 'dev',
        status: 200,
      },
    });
    expect(executed).toEqual(['dev1.service-now.com']);
    // A different client presenting the same scope id is refused.
    const other = await handleForward(
      {
        ...fwd({ kind: 'sn.op', id: 'b5', scopeId, instance: 'dev', op }),
        client: { keyId: 'd'.repeat(64), label: client.label },
      },
      d,
    );
    expect(other).toMatchObject({ ok: false, error: { code: 'SCOPE_UNKNOWN' } });
  });

  it('ignores malformed forwards', async () => {
    const { d } = deps();
    expect(
      await handleForward({ v: 1, kind: 'forward', client, request: { kind: 'sn.op' } }, d),
    ).toBeUndefined();
    expect(await handleForward({ kind: 'nope' }, d)).toBeUndefined();
  });

  it('registry.get exposes no scope ids', async () => {
    const { d } = deps();
    const r = await handleForward(fwd({ kind: 'registry.get', id: 'b1' }), d);
    expect(r).toMatchObject({
      ok: true,
      result: { instances: [{ alias: 'dev', thisClient: { activeGrant: false } }] },
    });
    expect(JSON.stringify(r)).not.toMatch(/scp_/);
  });
});
