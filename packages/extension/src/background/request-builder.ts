/**
 * The only place a ServiceNow URL is built (T-016, ADR-004, SECURITY S-1..S-3).
 *
 * - GET only, to exactly two templates:
 *     /api/now/table/{table}[/{sys_id}]      (Table API)
 *     /api/now/stats/{table}                 (Stats API)
 * - Query parameters from a fixed allowlist per template; values are URL-encoded by
 *   URLSearchParams, so nothing in a value can add a parameter or change the path.
 * - Fixed headers (Accept, X-UserToken), `redirect: 'manual'` (a redirect is never followed),
 *   `credentials: 'include'`, `cache: 'no-store'`.
 * - The operation is re-validated with the shared schema and the encoded-query validator
 *   ('enforce' profile): the broker and MCP server are untrusted.
 * - The built URL is parsed back and checked (scheme, exact host, no port or credentials, path
 *   matches a template, every parameter allowlisted) before it is returned.
 */
import { type ErrorCode, type Operation, OperationSchema, parseEncodedQuery } from '@sn-mcp/shared';
import { isValidInstanceHost } from './registry.js';

export type Template = 'table.list' | 'table.get' | 'stats';

export const PATH_TEMPLATES: Record<Template, RegExp> = {
  'table.list': /^\/api\/now\/table\/[a-z0-9_]{1,80}$/,
  'table.get': /^\/api\/now\/table\/[a-z0-9_]{1,80}\/[0-9a-f]{32}$/,
  stats: /^\/api\/now\/stats\/[a-z0-9_]{1,80}$/,
};

export const ALLOWED_PARAMS: Record<Template, readonly string[]> = {
  'table.list': [
    'sysparm_query',
    'sysparm_fields',
    'sysparm_limit',
    'sysparm_offset',
    'sysparm_display_value',
    'sysparm_exclude_reference_link',
    'sysparm_no_count',
  ],
  'table.get': ['sysparm_fields', 'sysparm_display_value', 'sysparm_exclude_reference_link'],
  stats: [
    'sysparm_query',
    'sysparm_count',
    'sysparm_group_by',
    'sysparm_avg_fields',
    'sysparm_min_fields',
    'sysparm_max_fields',
    'sysparm_sum_fields',
    'sysparm_display_value',
  ],
};

export interface BuiltRequest {
  readonly url: string;
  readonly template: Template;
  readonly init: Readonly<{
    method: 'GET';
    credentials: 'include';
    redirect: 'manual';
    cache: 'no-store';
    headers: Readonly<{ Accept: 'application/json'; 'X-UserToken': string }>;
  }>;
}

export class RequestBuildError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Re-validates an operation that arrived from the (untrusted) broker. */
export function revalidate(
  op: unknown,
): { ok: true; op: Operation } | { ok: false; code: ErrorCode; message: string } {
  const parsed = OperationSchema.safeParse(op);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', message: 'Invalid operation.' };
  const o = parsed.data;
  if ((o.kind === 'table.list' || o.kind === 'stats.aggregate') && o.query) {
    const q = parseEncodedQuery(o.query, { profile: 'enforce', allowTextSearch: true });
    if (!q.ok) return { ok: false, code: q.error.code, message: q.error.message };
  }
  return { ok: true, op: o };
}

function pathAndParams(op: Operation): {
  template: Template;
  path: string;
  params: URLSearchParams;
} {
  const params = new URLSearchParams();
  switch (op.kind) {
    case 'probe':
      params.set('sysparm_limit', '1');
      params.set('sysparm_fields', 'sys_id');
      params.set('sysparm_no_count', 'true');
      return { template: 'table.list', path: '/api/now/table/sys_db_object', params };
    case 'table.list':
      if (op.query) params.set('sysparm_query', op.query);
      if (op.fields) params.set('sysparm_fields', op.fields.join(','));
      params.set('sysparm_limit', String(op.limit));
      params.set('sysparm_offset', String(op.offset));
      params.set('sysparm_display_value', op.displayValue);
      params.set('sysparm_exclude_reference_link', 'true');
      params.set('sysparm_no_count', String(op.noCount));
      return { template: 'table.list', path: `/api/now/table/${op.table}`, params };
    case 'table.get':
      if (op.fields) params.set('sysparm_fields', op.fields.join(','));
      params.set('sysparm_display_value', op.displayValue);
      params.set('sysparm_exclude_reference_link', 'true');
      return { template: 'table.get', path: `/api/now/table/${op.table}/${op.sysId}`, params };
    case 'stats.aggregate': {
      if (op.query) params.set('sysparm_query', op.query);
      params.set('sysparm_count', 'true');
      if (op.groupBy) params.set('sysparm_group_by', op.groupBy.join(','));
      for (const fn of ['avg', 'min', 'max', 'sum'] as const) {
        const fields = (op.aggregates ?? []).filter((a) => a.fn === fn).map((a) => a.field);
        if (fields.length > 0) params.set(`sysparm_${fn}_fields`, fields.join(','));
      }
      params.set('sysparm_display_value', op.displayValue);
      return { template: 'stats', path: `/api/now/stats/${op.table}`, params };
    }
  }
}

/** Checks a built URL against every invariant. Throws on any violation. */
export function assertSafeUrl(url: string, host: string, template: Template): void {
  const u = new URL(url);
  const fail = (why: string) => {
    throw new RequestBuildError('FORBIDDEN_OPERATION', `Refused to build request: ${why}.`);
  };
  if (u.protocol !== 'https:') fail('not https');
  if (u.username || u.password) fail('credentials in URL');
  if (u.port !== '') fail('port in URL');
  if (u.hostname !== host) fail('host is not the granted host');
  if (u.hash !== '') fail('fragment in URL');
  if (!PATH_TEMPLATES[template].test(u.pathname)) fail('path outside the templates');
  const allowed = ALLOWED_PARAMS[template];
  const seen = new Set<string>();
  for (const key of u.searchParams.keys()) {
    if (!allowed.includes(key)) fail(`parameter ${key} not allowed`);
    if (seen.has(key)) fail(`duplicate parameter ${key}`);
    seen.add(key);
  }
}

/**
 * Builds the one request for an operation on the granted host. Throws RequestBuildError for an
 * invalid operation or host; never returns anything but a GET to an allowlisted URL.
 */
export function buildRequest(grantedHost: string, rawOp: unknown, token: string): BuiltRequest {
  if (!isValidInstanceHost(grantedHost)) {
    throw new RequestBuildError('FORBIDDEN_OPERATION', 'Refused to build request: invalid host.');
  }
  const checked = revalidate(rawOp);
  if (!checked.ok) throw new RequestBuildError(checked.code, checked.message);
  const { template, path, params } = pathAndParams(checked.op);
  const qs = params.toString();
  const url = `https://${grantedHost}${path}${qs ? `?${qs}` : ''}`;
  assertSafeUrl(url, grantedHost, template);
  return Object.freeze({
    url,
    template,
    init: Object.freeze({
      method: 'GET' as const,
      credentials: 'include' as const,
      redirect: 'manual' as const,
      cache: 'no-store' as const,
      headers: Object.freeze({ Accept: 'application/json' as const, 'X-UserToken': token }),
    }),
  });
}

/** Path + query only (diagnostics and tests). */
export function buildPath(op: unknown): string {
  const b = buildRequest('example.service-now.com', op, 'x');
  const u = new URL(b.url);
  return `${u.pathname}${u.search}`;
}
