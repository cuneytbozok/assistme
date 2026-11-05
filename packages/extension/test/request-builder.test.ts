/**
 * T-016: the request builder can only produce GETs to the two templates, with allowlisted
 * parameters, for the granted host; the attack corpus is rejected; redirects are never followed.
 */
import { readFileSync } from 'node:fs';
import { parseEncodedQuery } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { Executor, type TokenProvider } from '../src/background/executor.js';
import {
  ALLOWED_PARAMS,
  assertSafeUrl,
  buildPath,
  buildRequest,
  PATH_TEMPLATES,
  RequestBuildError,
  revalidate,
} from '../src/background/request-builder.js';

const HOST = 'dev12345.service-now.com';
const SYS = 'a'.repeat(32);
const list = (extra: Record<string, unknown> = {}) => ({
  kind: 'table.list',
  table: 'incident',
  limit: 10,
  offset: 0,
  displayValue: 'false',
  noCount: true,
  ...extra,
});

/** Every invariant a built request must satisfy. */
function expectSafe(b: ReturnType<typeof buildRequest>, host = HOST) {
  const u = new URL(b.url);
  expect(b.init.method).toBe('GET');
  expect(b.init.redirect).toBe('manual');
  expect(b.init.credentials).toBe('include');
  expect(Object.keys(b.init.headers).sort()).toEqual(['Accept', 'X-UserToken']);
  expect(u.protocol).toBe('https:');
  expect(u.hostname).toBe(host);
  expect(u.port).toBe('');
  expect(u.username + u.password).toBe('');
  expect(Object.values(PATH_TEMPLATES).some((re) => re.test(u.pathname))).toBe(true);
  expect(PATH_TEMPLATES[b.template].test(u.pathname)).toBe(true);
  for (const k of u.searchParams.keys()) expect(ALLOWED_PARAMS[b.template]).toContain(k);
  expect(Object.isFrozen(b) && Object.isFrozen(b.init) && Object.isFrozen(b.init.headers)).toBe(
    true,
  );
}

describe('AC1: only GET, two templates, allowlisted params, granted host', () => {
  it('builds each operation kind to its template', () => {
    const cases = [
      [{ kind: 'probe' }, '/api/now/table/sys_db_object'],
      [
        list({ query: 'active=true', fields: ['number', 'caller_id.name'] }),
        '/api/now/table/incident',
      ],
      [
        { kind: 'table.get', table: 'sys_user', sysId: SYS, displayValue: 'all' },
        `/api/now/table/sys_user/${SYS}`,
      ],
      [
        {
          kind: 'stats.aggregate',
          table: 'incident',
          query: 'active=true',
          groupBy: ['priority'],
          aggregates: [
            { fn: 'avg', field: 'reassignment_count' },
            { fn: 'max', field: 'reassignment_count' },
          ],
          displayValue: 'true',
        },
        '/api/now/stats/incident',
      ],
    ] as const;
    for (const [op, path] of cases) {
      const b = buildRequest(HOST, op, 'tok');
      expectSafe(b);
      expect(new URL(b.url).pathname).toBe(path);
    }
    expect(buildPath(cases[3][0])).toBe(
      '/api/now/stats/incident?sysparm_query=active%3Dtrue&sysparm_count=true&sysparm_group_by=priority&sysparm_avg_fields=reassignment_count&sysparm_max_fields=reassignment_count&sysparm_display_value=true',
    );
  });

  it.each([
    ['path traversal in table', list({ table: '../../api/now/import' })],
    ['slash in table', list({ table: 'incident/1' })],
    ['uppercase table', list({ table: 'Incident' })],
    [
      'sys_id with slash',
      { kind: 'table.get', table: 'incident', sysId: `${'a'.repeat(31)}/`, displayValue: 'all' },
    ],
    ['field with ampersand', list({ fields: ['number&sysparm_limit=999999'] })],
    ['method smuggled in op', list({ method: 'POST' })],
    ['url smuggled in op', list({ url: 'https://evil.example/' })],
    ['headers smuggled in op', list({ headers: { 'X-HTTP-Method-Override': 'DELETE' } })],
    ['unknown kind', { kind: 'table.delete', table: 'incident', sysId: SYS }],
    ['import set kind', { kind: 'import', table: 'incident' }],
    ['script kind', { kind: 'script', script: 'gs.print(1)' }],
    ['limit too big', list({ limit: 1_000_000 })],
    ['negative offset', list({ offset: -1 })],
    ['control chars in query', list({ query: 'active=true\nsysparm_limit=1' })],
    ['bad display value', list({ displayValue: 'javascript' })],
    [
      'bad aggregate fn',
      {
        kind: 'stats.aggregate',
        table: 'incident',
        aggregates: [{ fn: 'exec', field: 'x' }],
        displayValue: 'false',
      },
    ],
  ])('refuses: %s', (_n, op) => {
    expect(() => buildRequest(HOST, op, 'tok')).toThrow(RequestBuildError);
  });

  it('a value can never add a parameter or change the path (URL-encoded)', () => {
    const b = buildRequest(
      HOST,
      list({ query: 'short_descriptionLIKEa&sysparm_limit=99999#x?/y' }),
      't',
    );
    expectSafe(b);
    const u = new URL(b.url);
    expect(u.searchParams.get('sysparm_limit')).toBe('10');
    expect(u.searchParams.getAll('sysparm_limit')).toHaveLength(1);
    expect(u.hash).toBe('');
  });

  it.each([
    'evil.example#',
    `${HOST}@evil.example`,
    `${HOST}:8443`,
    'evil.example/',
    `${HOST}.`,
    '10.0.0.1',
    '',
    'localhost',
    `https://${HOST}`,
    `${HOST}/api/now/import`,
  ])('refuses host %j', (host) => {
    expect(() => buildRequest(host, { kind: 'probe' }, 't')).toThrow(RequestBuildError);
  });

  it('the self-check rejects URLs that break any invariant', () => {
    const bad = [
      [`http://${HOST}/api/now/table/incident`, 'table.list'],
      [`https://u:p@${HOST}/api/now/table/incident`, 'table.list'],
      [`https://${HOST}:444/api/now/table/incident`, 'table.list'],
      [`https://other.service-now.com/api/now/table/incident`, 'table.list'],
      [`https://${HOST}/api/now/import/incident`, 'table.list'],
      [`https://${HOST}/api/now/table/incident/${SYS}`, 'table.list'],
      [`https://${HOST}/api/now/table/incident?sysparm_input_display_value=true`, 'table.list'],
      [`https://${HOST}/api/now/table/incident?sysparm_limit=1&sysparm_limit=2`, 'table.list'],
      [`https://${HOST}/api/now/stats/incident?sysparm_limit=1`, 'stats'],
      [`https://${HOST}/api/now/table/incident#frag`, 'table.list'],
    ] as const;
    for (const [url, t] of bad)
      expect(() => assertSafeUrl(url, HOST, t), url).toThrow(RequestBuildError);
    expect(() =>
      assertSafeUrl(`https://${HOST}/api/now/table/incident?sysparm_limit=1`, HOST, 'table.list'),
    ).not.toThrow();
  });

  it('fuzz (10,000 cases): random and hostile operations never yield an unsafe request', () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const junk = [
      '',
      '../',
      '%2e%2e/',
      '?',
      '#',
      '&',
      '=',
      '/',
      '\\',
      '@',
      ':',
      ' ',
      '\u0000',
      'javascript:',
      'gs.',
      'POST',
      'import',
      'sys_script',
      '😀',
    ];
    const word = () =>
      Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
        pick([...junk, 'incident', 'a', 'sys_id', 'number']),
      ).join('');
    let built = 0;
    for (let i = 0; i < 10_000; i++) {
      const kind = pick([
        'table.list',
        'table.get',
        'stats.aggregate',
        'probe',
        'table.delete',
        'x',
      ]);
      const op: Record<string, unknown> = { kind };
      if (kind !== 'probe') op.table = rnd() < 0.7 ? pick(['incident', 'sys_user']) : word();
      if (kind === 'table.get' || kind === 'table.delete') op.sysId = rnd() < 0.7 ? SYS : word();
      if (kind === 'table.list') {
        op.limit = pick([1, 10, 1000, 1001, -1, 0, 1.5]);
        op.offset = pick([0, 5, -1]);
        op.noCount = pick([true, false]);
      }
      if (kind !== 'probe') op.displayValue = rnd() < 0.8 ? pick(['false', 'true', 'all']) : word();
      if ((kind === 'table.list' || kind === 'stats.aggregate') && rnd() < 0.5) {
        op.query = pick([
          'active=true',
          'priority=1^ORpriority=2',
          word(),
          `active=true^${word()}`,
        ]);
      }
      if ((kind === 'table.list' || kind === 'table.get') && rnd() < 0.5) {
        op.fields = [rnd() < 0.7 ? pick(['number', 'sys_id']) : word()];
      }
      if (kind === 'stats.aggregate' && rnd() < 0.5) {
        op.aggregates = [
          { fn: pick(['avg', 'sum', 'exec']), field: rnd() < 0.7 ? 'priority' : word() },
        ];
      }
      if (rnd() < 0.2) op[pick(['method', 'url', 'path', 'headers', 'body'])] = word();
      try {
        expectSafe(buildRequest(HOST, op, 'tok'));
        built++;
      } catch (e) {
        if (!(e instanceof RequestBuildError)) throw e;
      }
    }
    expect(built).toBeGreaterThan(10); // the fuzzer does reach the success path
  });
});

describe('AC2: the attack corpus is rejected in the extension too', () => {
  const corpus = JSON.parse(
    readFileSync(new URL('../../shared/test/fixtures/attack-corpus.json', import.meta.url), 'utf8'),
  ) as { name: string; query: string; profile: 'enforce' | 'strict' }[];
  // Text search is a server-side policy (ADR-005); the extension allows it on purpose, so cases
  // whose only fault is text search are excluded (computed with the shared validator).
  const textSearchOnly = (c: { query: string }) =>
    !parseEncodedQuery(c.query, { profile: 'enforce', allowTextSearch: false }).ok &&
    parseEncodedQuery(c.query, { profile: 'enforce', allowTextSearch: true }).ok;
  const enforce = corpus.filter((c) => c.profile === 'enforce' && !textSearchOnly(c));

  it('has the shared corpus', () => {
    expect(enforce.length).toBeGreaterThanOrEqual(40);
  });

  it.each(enforce.map((c) => [c.name, c.query] as const))('rejects: %s', (_n, query) => {
    expect(revalidate(list({ query })).ok).toBe(false);
    expect(
      revalidate({ kind: 'stats.aggregate', table: 'incident', query, displayValue: 'false' }).ok,
    ).toBe(false);
    expect(() => buildRequest(HOST, list({ query }), 't')).toThrow(RequestBuildError);
  });
});

describe('AC3: a redirect response is never followed', () => {
  const tokens: TokenProvider = { get: async () => 'tok', clear: () => {} };
  it.each([
    ['opaque redirect', () => Response.redirect('https://evil.example/login', 302)],
    [
      '3xx with Location',
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }),
    ],
    ['307', () => new Response(null, { status: 307, headers: { Location: '/api/now/import' } })],
  ])('%s → treated as unauthenticated, Location never requested', async (_n, make) => {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const ex = new Executor({
      tokens,
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(url));
        inits.push(init ?? {});
        return make();
      }) as typeof fetch,
    });
    const r = await ex.run(HOST, list());
    expect(r).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(
      urls.every((u) => new URL(u).hostname === HOST && u.includes('/api/now/table/incident')),
    ).toBe(true);
    expect(inits.every((i) => i.redirect === 'manual' && i.method === 'GET')).toBe(true);
  });
});

describe('the builder is the only URL constructor', () => {
  it('no other source file mentions a ServiceNow API path or calls fetch directly', async () => {
    const { readdirSync, readFileSync: read } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../src/', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
      }
    };
    walk(root);
    for (const f of files) {
      const src = read(f, 'utf8');
      const rel = f.slice(root.length);
      if (rel !== 'background/request-builder.ts') expect(src, rel).not.toContain('/api/now/');
      const fetches = src.match(/\bfetch\(/g) ?? [];
      if (rel === 'background/executor.ts') {
        expect(fetches.length, rel).toBe(1); // this.deps.fetch(req.url, …) with a built request
        expect(src).toContain('this.deps.fetch(req.url, {');
      } else if (rel === 'background/index.ts')
        expect(fetches.length, rel).toBe(1); // executor's fetch dep
      else expect(fetches.length, rel).toBe(0);
    }
  });
});

describe('javascript in query values (ADR-005 addendum, T-034)', () => {
  const op = (query: string) => ({
    kind: 'table.list',
    table: 'incident',
    query,
    limit: 1,
    offset: 0,
    displayValue: 'false',
    noCount: true,
  });

  it('the word alone is allowed; the extension builds the request', () => {
    for (const q of ['scriptLIKEjavascript', 'name=automation_pipeline_transformer_javascript']) {
      expect(buildPath(op(q))).toContain('/api/now/table/incident');
    }
  });

  it('the prefix is refused here too, in any disguise', () => {
    for (const q of [
      'scriptLIKEjavascript:gs.x()',
      'scriptLIKEjava script :gs.x()',
      'scriptLIKEjavascript%3Ags.x()',
      'scriptLIKEjavascript&colon;gs.x()',
    ]) {
      expect(() => buildPath(op(q)), q).toThrow();
    }
  });
});
