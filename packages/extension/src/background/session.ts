/**
 * T-005 session spike (ADR-002 hypotheses H1–H8). DEV_DIAGNOSTICS builds only.
 *
 * Rules kept even in the spike:
 * - GET only, to fixed paths under /api/now/table and /api/now/stats on a registered, granted host.
 * - No `cookies` permission. Token values (g_ck) are read into the service worker's memory only.
 *   Results carry presence, length and an 8-hex SHA-256 fingerprint, never the value.
 * - No navigation: scripts run in existing tabs of the granted host; tab URLs are never changed.
 *
 * Everything above `runSpike` is pure and unit-tested.
 */

export const SPIKE_PATHS = {
  probe: '/api/now/table/sys_db_object?sysparm_limit=1&sysparm_fields=sys_id,name',
  incident:
    '/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id,number,short_description',
  buildTag:
    '/api/now/table/sys_properties?sysparm_query=name%3Dglide.buildtag&sysparm_fields=value&sysparm_limit=1',
  stats: '/api/now/stats/incident?sysparm_count=true',
  /** glide.buildtag is not a sys_properties row (run 1); the upgrade history has the version. */
  version:
    '/api/now/table/sys_upgrade_history?sysparm_query=ORDERBYDESCupgrade_started&sysparm_fields=to_version&sysparm_limit=1',
} as const;

/** Encoded queries whose effect on sys_db_object's row count tells us how ServiceNow parses them. */
export const QUERY_SEMANTICS_CASES = [
  { id: 'baseline', query: '' },
  { id: 'relative_ge_1_minute', query: 'sys_created_onRELATIVEGE@minute@ago@1' },
  { id: 'relative_lt_1_minute', query: 'sys_created_onRELATIVELT@minute@ago@1' },
  { id: 'relative_ge_100_years', query: 'sys_created_onRELATIVEGE@year@ago@100' },
  {
    id: 'between_plain_dates_2000',
    query: 'sys_created_onBETWEEN2000-01-01 00:00:00@2000-01-02 00:00:00',
  },
  {
    id: 'between_plain_dates_2000_2100',
    query: 'sys_created_onBETWEEN2000-01-01 00:00:00@2100-01-01 00:00:00',
  },
  { id: 'gte_plain_date_2000', query: 'sys_created_on>=2000-01-01 00:00:00' },
  { id: 'lt_plain_date_2000', query: 'sys_created_on<2000-01-01 00:00:00' },
  { id: 'invalid_field', query: 'zz_no_such_field_zz=1' },
  { id: 'invalid_field_or_valid', query: 'name=zz_no_such_table_zz^ORzz_no_such_field_zz=1' },
] as const;

export function countPath(query: string): string {
  const q = query === '' ? '' : `&sysparm_query=${encodeURIComponent(query)}`;
  return `/api/now/table/sys_db_object?sysparm_limit=1&sysparm_fields=sys_id${q}`;
}

export const USERNAME_RE = /^[A-Za-z0-9._@-]{1,100}$/;

export function userPaths(userName: string): { user: string; sessions: string } {
  if (!USERNAME_RE.test(userName)) throw new Error('invalid user name');
  return {
    user: `/api/now/table/sys_user?sysparm_query=${encodeURIComponent(`user_name=${userName}`)}&sysparm_fields=sys_id,last_login_time&sysparm_limit=1`,
    sessions: '/api/now/table/sys_user_session?sysparm_limit=1&sysparm_fields=sys_id',
  };
}

/** Allowed spike paths: fixed table/stats API GETs only. */
export function isAllowedSpikePath(path: string): boolean {
  return /^\/api\/now\/(table|stats)\/[a-z0-9_]{1,80}\?[A-Za-z0-9_=&%.,-]*$/.test(path);
}

/** Names probed for the session token, per frame. */
export const TOKEN_CANDIDATES = ['g_ck', 'NOW.g_ck', 'NOW.ck'] as const;

export interface FetchOutcome {
  ok: boolean;
  status: number;
  responseType: string;
  contentType: string;
  totalCount: string | null;
  isJson: boolean;
  rows: number | null;
  /** First 200 chars of a ServiceNow JSON error message (not secret). */
  errorMessage?: string;
  /** For JSON bodies with one row: the value of a small allowlisted field (build tag, count). */
  sample?: string;
  networkError?: string;
}

/** Small, non-sensitive fields echoed into results (build tag, incident number, login time). */
export const SAMPLE_FIELDS = ['value', 'number', 'last_login_time', 'to_version'] as const;

/** Summarizes a parsed body without keeping record content (apart from allowlisted samples). */
export function summarizeBody(
  body: unknown,
): Pick<FetchOutcome, 'rows' | 'errorMessage' | 'sample'> {
  if (typeof body !== 'object' || body === null) return { rows: null };
  const b = body as Record<string, unknown>;
  const out: Pick<FetchOutcome, 'rows' | 'errorMessage' | 'sample'> = { rows: null };
  if (Array.isArray(b.result)) {
    out.rows = b.result.length;
    const first = b.result[0] as Record<string, unknown> | undefined;
    for (const key of SAMPLE_FIELDS) {
      if (first && typeof first[key] === 'string')
        out.sample = `${key}=${first[key].slice(0, 120)}`;
    }
  } else if (b.result && typeof b.result === 'object') {
    const stats = (b.result as Record<string, unknown>).stats as
      | Record<string, unknown>
      | undefined;
    out.rows = 1;
    if (stats && (typeof stats.count === 'string' || typeof stats.count === 'number')) {
      out.sample = `count=${String(stats.count)}`;
    }
  }
  const err = b.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === 'string') out.errorMessage = err.message.slice(0, 200);
  return out;
}

export async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type Path = 'A' | 'B' | 'none';

/** ADR-002 decision rule applied to the H1/H5 outcomes. */
export function choosePath(r: {
  swWithCookies: FetchOutcome;
  swWithToken?: FetchOutcome;
  tabWithToken?: FetchOutcome;
  tabWithoutToken?: FetchOutcome;
}): Path {
  const good = (o?: FetchOutcome) => !!o && o.status === 200 && o.isJson && o.rows !== null;
  if (good(r.swWithCookies) || good(r.swWithToken)) return 'A';
  if (good(r.tabWithToken) || good(r.tabWithoutToken)) return 'B';
  return 'none';
}

// ---------------------------------------------------------------------------------------------
// Chrome-dependent runner
// ---------------------------------------------------------------------------------------------

export interface FrameToken {
  frameId: number;
  path: string;
  candidates: Record<string, { present: boolean; length: number; fingerprint?: string }>;
}

export interface SpikeReport {
  kind: 'full' | 'expiry';
  at: string;
  host: string;
  userAgent: string;
  tabs: { count: number; paths: string[] };
  h3_tokens: FrameToken[];
  h1_h2: Record<string, FetchOutcome>;
  h5_tab: Record<string, FetchOutcome>;
  path: Path;
  data?: Record<string, FetchOutcome>;
  querySemantics?: Record<string, FetchOutcome>;
  h8?: {
    before: Record<string, FetchOutcome>;
    requests: number;
    after: Record<string, FetchOutcome>;
  };
  notes: string[];
}

async function swFetch(
  host: string,
  path: string,
  opts: { credentials: RequestCredentials; token?: string },
): Promise<FetchOutcome> {
  if (!isAllowedSpikePath(path)) throw new Error(`path not allowed: ${path}`);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token !== undefined) headers['X-UserToken'] = opts.token;
  try {
    const res = await fetch(`https://${host}${path}`, {
      method: 'GET',
      credentials: opts.credentials,
      redirect: 'manual',
      cache: 'no-store',
      headers,
    });
    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    let body: unknown;
    if (isJson) body = await res.json().catch(() => undefined);
    else await res.body?.cancel();
    return {
      ok: res.ok,
      status: res.status,
      responseType: res.type,
      contentType: contentType.slice(0, 80),
      totalCount: res.headers.get('x-total-count'),
      isJson,
      ...summarizeBody(body),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      responseType: 'error',
      contentType: '',
      totalCount: null,
      isJson: false,
      rows: null,
      networkError: String(e).slice(0, 200),
    };
  }
}

/** Runs in the page (MAIN world). Returns token candidates per frame; values stay in the SW. */
function readTokensInPage(names: readonly string[]) {
  const out: Record<string, string | null> = {};
  for (const name of names) {
    let v: unknown = window;
    for (const part of name.split('.')) {
      v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    }
    out[name] = typeof v === 'string' && v.length > 0 ? v : null;
  }
  return { path: location.pathname, values: out };
}

/** Runs in the page (MAIN world): same-origin fetch with the page's own session (path B, H5). */
async function fetchInPage(path: string, useToken: boolean) {
  if (!/^\/api\/now\/(table|stats)\//.test(path)) return { error: 'path not allowed' };
  const w = window as unknown as { g_ck?: string };
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (useToken && typeof w.g_ck === 'string') headers['X-UserToken'] = w.g_ck;
  try {
    const res = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers,
      redirect: 'manual',
      cache: 'no-store',
    });
    const contentType = res.headers.get('content-type') ?? '';
    let rows: number | null = null;
    let errorMessage: string | undefined;
    let sample: string | undefined;
    if (contentType.includes('application/json')) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (body && Array.isArray(body.result)) {
        rows = body.result.length;
        const first = body.result[0] as Record<string, unknown> | undefined;
        for (const key of ['value', 'number', 'last_login_time']) {
          if (first && typeof first[key] === 'string')
            sample = `${key}=${first[key].slice(0, 120)}`;
        }
      } else if (body?.result && typeof body.result === 'object') rows = 1;
      const err = body?.error as Record<string, unknown> | undefined;
      if (err && typeof err.message === 'string') errorMessage = err.message.slice(0, 200);
    }
    return {
      ok: res.ok,
      status: res.status,
      responseType: res.type,
      contentType: contentType.slice(0, 80),
      totalCount: res.headers.get('x-total-count'),
      isJson: contentType.includes('application/json'),
      rows,
      errorMessage,
      sample,
      tokenPresent: typeof w.g_ck === 'string',
    };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

async function hostTabs(host: string): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: `https://${host}/*` });
}

async function readTokens(
  tabs: chrome.tabs.Tab[],
): Promise<{ frames: FrameToken[]; token?: string }> {
  const frames: FrameToken[] = [];
  let token: string | undefined;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const results = await chrome.scripting
      .executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: readTokensInPage,
        args: [TOKEN_CANDIDATES],
      })
      .catch(() => []);
    for (const r of results) {
      const res = r.result as ReturnType<typeof readTokensInPage> | undefined;
      if (!res) continue;
      const candidates: FrameToken['candidates'] = {};
      for (const [name, value] of Object.entries(res.values)) {
        candidates[name] = value
          ? { present: true, length: value.length, fingerprint: await fingerprint(value) }
          : { present: false, length: 0 };
        if (value && name === 'g_ck' && token === undefined) token = value;
      }
      frames.push({ frameId: r.frameId, path: res.path, candidates });
    }
  }
  return token === undefined ? { frames } : { frames, token };
}

async function tabFetch(tab: chrome.tabs.Tab | undefined, path: string, useToken: boolean) {
  if (tab?.id === undefined) return undefined;
  if (!isAllowedSpikePath(path)) throw new Error(`path not allowed: ${path}`);
  const [r] = await chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fetchInPage,
      args: [path, useToken],
    })
    .catch(() => [undefined]);
  return r?.result as FetchOutcome | undefined;
}

export async function runSpike(
  host: string,
  options: { kind: 'full' | 'expiry'; userName?: string },
): Promise<SpikeReport> {
  const notes: string[] = [];
  const tabs = await hostTabs(host);
  const { frames, token } = await readTokens(tabs);
  if (tabs.length === 0) notes.push('No open tab of the instance: H3/H5 untested in this run.');
  if (!token) notes.push('No g_ck found in any frame.');

  const p = SPIKE_PATHS.probe;
  const h1_h2: Record<string, FetchOutcome> = {
    sw_cookies_no_token: await swFetch(host, p, { credentials: 'include' }),
    sw_omit_cookies_no_token: await swFetch(host, p, { credentials: 'omit' }),
  };
  if (token) {
    h1_h2.sw_cookies_with_token = await swFetch(host, p, { credentials: 'include', token });
    h1_h2.sw_omit_cookies_with_token = await swFetch(host, p, { credentials: 'omit', token });
  }
  h1_h2.sw_cookies_invalid_token = await swFetch(host, p, {
    credentials: 'include',
    token: 'invalid0000000000000000000000000000000000000000000000000000000000',
  });

  const tab = tabs[0];
  const h5_tab: Record<string, FetchOutcome> = {};
  const tWith = await tabFetch(tab, p, true);
  const tWithout = await tabFetch(tab, p, false);
  if (tWith) h5_tab.tab_with_token = tWith;
  if (tWithout) h5_tab.tab_without_token = tWithout;

  const path = choosePath({
    swWithCookies: h1_h2.sw_cookies_no_token as FetchOutcome,
    ...(h1_h2.sw_cookies_with_token ? { swWithToken: h1_h2.sw_cookies_with_token } : {}),
    ...(tWith ? { tabWithToken: tWith } : {}),
    ...(tWithout ? { tabWithoutToken: tWithout } : {}),
  });

  const report: SpikeReport = {
    kind: options.kind,
    at: new Date().toISOString(),
    host,
    userAgent: navigator.userAgent,
    tabs: { count: tabs.length, paths: tabs.map((t) => (t.url ? new URL(t.url).pathname : '?')) },
    h3_tokens: frames,
    h1_h2,
    h5_tab,
    path,
    notes,
  };
  if (options.kind === 'expiry' || path === 'none') return report;

  // Fetch via the chosen path.
  const swNeedsToken = h1_h2.sw_cookies_no_token?.status !== 200;
  const get = async (q: string): Promise<FetchOutcome> => {
    if (path === 'A') {
      return swFetch(
        host,
        q,
        swNeedsToken && token ? { credentials: 'include', token } : { credentials: 'include' },
      );
    }
    return (await tabFetch(tab, q, true)) ?? (await swFetch(host, q, { credentials: 'include' }));
  };

  report.data = {
    incident: await get(SPIKE_PATHS.incident),
    build_tag: await get(SPIKE_PATHS.buildTag),
    stats_count: await get(SPIKE_PATHS.stats),
    version: await get(SPIKE_PATHS.version),
  };
  report.querySemantics = {};
  for (const c of QUERY_SEMANTICS_CASES)
    report.querySemantics[c.id] = await get(countPath(c.query));

  if (options.userName) {
    const up = userPaths(options.userName);
    const before = { user: await get(up.user), sessions: await get(up.sessions) };
    const n = 5;
    for (let i = 0; i < n; i++) await get(SPIKE_PATHS.probe);
    const after = { user: await get(up.user), sessions: await get(up.sessions) };
    report.h8 = { before, requests: n, after };
  } else {
    notes.push('No user name given: H8 untested in this run.');
  }
  return report;
}
