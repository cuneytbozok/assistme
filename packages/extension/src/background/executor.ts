/**
 * Executes operation descriptors against a granted instance via ADR-002 Path A:
 * service-worker fetch with the user's session cookies plus `X-UserToken` (g_ck).
 *
 * The URL is built only here, from fixed templates (hardened further in T-016). Only GET to
 * /api/now/table/{table}[/{sys_id}]. The operation is re-validated with the shared schema and
 * the encoded-query validator ('enforce' profile) — the broker and MCP server are untrusted.
 */
import {
  type ErrorCode,
  type Operation,
  OperationSchema,
  parseEncodedQuery,
  SAFEGUARD_DEFAULTS,
} from '@sn-mcp/shared';

export interface TokenProvider {
  /** Returns the session token for the host, or undefined when no tab of the host is open. */
  get(host: string, opts?: { refresh?: boolean }): Promise<string | undefined>;
  clear(host: string): void;
}

export type ExecResult =
  | { ok: true; status: number; body: unknown; totalCount?: number; bytes: number }
  | { ok: false; code: ErrorCode; message: string };

export interface ExecutorDeps {
  fetch: typeof fetch;
  tokens: TokenProvider;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const fail = (code: ErrorCode, message: string): ExecResult => ({ ok: false, code, message });

/** Builds the URL path + query for an operation. Pure; throws on anything unexpected. */
export function buildPath(op: Operation): string {
  const params = new URLSearchParams();
  let path: string;
  switch (op.kind) {
    case 'probe':
      path = '/api/now/table/sys_db_object';
      params.set('sysparm_limit', '1');
      params.set('sysparm_fields', 'sys_id');
      params.set('sysparm_no_count', 'true');
      break;
    case 'table.list':
      path = `/api/now/table/${op.table}`;
      if (op.query) params.set('sysparm_query', op.query);
      if (op.fields) params.set('sysparm_fields', op.fields.join(','));
      params.set('sysparm_limit', String(op.limit));
      params.set('sysparm_offset', String(op.offset));
      params.set('sysparm_display_value', op.displayValue);
      params.set('sysparm_exclude_reference_link', 'true');
      params.set('sysparm_no_count', String(op.noCount));
      break;
    case 'table.get':
      path = `/api/now/table/${op.table}/${op.sysId}`;
      if (op.fields) params.set('sysparm_fields', op.fields.join(','));
      params.set('sysparm_display_value', op.displayValue);
      params.set('sysparm_exclude_reference_link', 'true');
      break;
    default:
      throw new Error(`operation ${op.kind} is not supported yet`);
  }
  return `${path}?${params.toString()}`;
}

/** Re-validates an operation that arrived from the (untrusted) broker. */
export function revalidate(
  op: unknown,
): { ok: true; op: Operation } | { ok: false; code: ErrorCode; message: string } {
  const parsed = OperationSchema.safeParse(op);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', message: 'Invalid operation.' };
  const o = parsed.data;
  if (o.kind === 'stats.aggregate') {
    return { ok: false, code: 'INVALID_INPUT', message: 'stats.aggregate is not available yet.' };
  }
  if (o.kind === 'table.list' && o.query) {
    const q = parseEncodedQuery(o.query, { profile: 'enforce', allowTextSearch: true });
    if (!q.ok) return { ok: false, code: q.error.code, message: q.error.message };
  }
  return { ok: true, op: o };
}

export class Executor {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly deps: ExecutorDeps) {
    this.timeoutMs = deps.timeoutMs ?? SAFEGUARD_DEFAULTS.requestTimeoutMs;
    this.maxBytes = deps.maxResponseBytes ?? SAFEGUARD_DEFAULTS.maxResponseBytes;
  }

  async run(host: string, rawOp: unknown): Promise<ExecResult> {
    const checked = revalidate(rawOp);
    if (!checked.ok) return checked;
    const url = `https://${host}${buildPath(checked.op)}`;

    let token = await this.deps.tokens.get(host);
    if (!token) {
      return fail('NO_INSTANCE_TAB', `Open ${host} in a Chrome tab and log in.`);
    }
    let res = await this.fetchOnce(url, token);
    if (res.kind === 'http' && res.status === 401) {
      token = await this.deps.tokens.get(host, { refresh: true });
      if (!token) return fail('NO_INSTANCE_TAB', `Open ${host} in a Chrome tab and log in.`);
      res = await this.fetchOnce(url, token);
      if (res.kind === 'http' && res.status === 401) {
        this.deps.tokens.clear(host);
        return fail('SESSION_EXPIRED', `The ServiceNow session for ${host} has expired.`);
      }
    }
    if (res.kind !== 'http') return res.result;
    return this.mapResponse(res);
  }

  private async fetchOnce(
    url: string,
    token: string,
  ): Promise<
    | {
        kind: 'http';
        status: number;
        contentType: string;
        text: string;
        bytes: number;
        totalCount: string | null;
        redirected: boolean;
      }
    | { kind: 'error'; result: ExecResult }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    try {
      const res = await this.deps.fetch(url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json', 'X-UserToken': token },
      });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return {
          kind: 'http',
          status: 401,
          contentType: '',
          text: '',
          bytes: 0,
          totalCount: null,
          redirected: true,
        };
      }
      const { text, bytes, tooLarge } = await readCapped(res, this.maxBytes, controller);
      if (tooLarge) {
        return {
          kind: 'error',
          result: fail('RESPONSE_TOO_LARGE', `The response exceeded ${this.maxBytes} bytes.`),
        };
      }
      return {
        kind: 'http',
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        text,
        bytes,
        totalCount: res.headers.get('x-total-count'),
        redirected: false,
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return {
          kind: 'error',
          result: fail('TIMEOUT', `No response within ${this.timeoutMs} ms.`),
        };
      }
      return {
        kind: 'error',
        result: fail('SN_API_ERROR', `Network error: ${String(e).slice(0, 200)}`),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private mapResponse(r: {
    status: number;
    contentType: string;
    text: string;
    bytes: number;
    totalCount: string | null;
  }): ExecResult {
    let body: unknown;
    if (r.contentType.includes('application/json')) {
      try {
        body = JSON.parse(r.text);
      } catch {
        return fail('SN_API_ERROR', 'ServiceNow returned invalid JSON.');
      }
    }
    const snMessage = () => {
      const m = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
      return typeof m === 'string' ? m.slice(0, 300) : `HTTP ${r.status}`;
    };
    if (r.status === 200) {
      if (body === undefined)
        return fail('SN_API_ERROR', 'ServiceNow returned a non-JSON response.');
      const total = r.totalCount === null ? undefined : Number.parseInt(r.totalCount, 10);
      return {
        ok: true,
        status: 200,
        body: (body as { result?: unknown }).result ?? null,
        ...(total !== undefined && Number.isInteger(total) && total >= 0
          ? { totalCount: total }
          : {}),
        bytes: r.bytes,
      };
    }
    if (r.status === 403) return fail('ACL_DENIED', snMessage());
    if (r.status === 404) return fail('NOT_FOUND', snMessage());
    if (r.status === 429) return fail('RATE_LIMITED', snMessage());
    return fail('SN_API_ERROR', snMessage());
  }
}

async function readCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
  if (!res.body) return { text: '', bytes: 0, tooLarge: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      controller.abort('too large');
      await reader.cancel().catch(() => {});
      return { text: '', bytes, tooLarge: true };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(all), bytes, tooLarge: false };
}

/** Reads g_ck from an open tab of the granted host (MAIN world). Cached in memory only. */
export class ChromeTokenProvider implements TokenProvider {
  private readonly cache = new Map<string, string>();

  async get(host: string, opts: { refresh?: boolean } = {}): Promise<string | undefined> {
    if (!opts.refresh) {
      const cached = this.cache.get(host);
      if (cached) return cached;
    }
    const tabs = await chrome.tabs.query({ url: `https://${host}/*` });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const results = await chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          func: () => {
            const v = (window as unknown as { g_ck?: unknown }).g_ck;
            return typeof v === 'string' && v.length > 0 && v.length < 256 ? v : null;
          },
        })
        .catch(() => []);
      const token = results.map((r) => r.result).find((v): v is string => typeof v === 'string');
      if (token) {
        this.cache.set(host, token);
        return token;
      }
    }
    this.cache.delete(host);
    return undefined;
  }

  clear(host: string): void {
    this.cache.delete(host);
  }

  /** Values that must never appear in an outbound message (credential guard). */
  knownSecrets(): string[] {
    return [...this.cache.values()];
  }
}

/** True if a serialized outbound message contains any credential value. */
export function containsSecret(serialized: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => s.length >= 8 && serialized.includes(s));
}
