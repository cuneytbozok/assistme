/**
 * Executes operation descriptors against a granted instance via ADR-002 Path A:
 * service-worker fetch with the user's session cookies plus `X-UserToken` (g_ck).
 *
 * Requests come only from `request-builder.ts` (T-016): GET to the Table/Stats API templates,
 * allowlisted parameters, fixed headers, redirects never followed. The operation is
 * re-validated there; the broker and MCP server are untrusted.
 */
import { type ErrorCode, SAFEGUARD_DEFAULTS } from '@sn-mcp/shared';
import {
  type BuiltRequest,
  buildRequest,
  RequestBuildError,
  revalidate,
} from './request-builder.js';

export { buildPath, revalidate } from './request-builder.js';

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
    const build = (token: string): BuiltRequest | ExecResult => {
      try {
        return buildRequest(host, checked.op, token);
      } catch (e) {
        if (e instanceof RequestBuildError) return fail(e.code, e.message);
        return fail('FORBIDDEN_OPERATION', 'Refused to build the request.');
      }
    };

    let token = await this.deps.tokens.get(host);
    if (!token) {
      return fail('NO_INSTANCE_TAB', `Open ${host} in a Chrome tab and log in.`);
    }
    let req = build(token);
    if (!('url' in req)) return req;
    let res = await this.fetchOnce(req);
    if (res.kind === 'http' && res.status === 401) {
      token = await this.deps.tokens.get(host, { refresh: true });
      if (!token) return fail('NO_INSTANCE_TAB', `Open ${host} in a Chrome tab and log in.`);
      req = build(token);
      if (!('url' in req)) return req;
      res = await this.fetchOnce(req);
      if (res.kind === 'http' && res.status === 401) {
        this.deps.tokens.clear(host);
        return fail('SESSION_EXPIRED', `The ServiceNow session for ${host} has expired.`);
      }
    }
    if (res.kind !== 'http') return res.result;
    return this.mapResponse(res);
  }

  private async fetchOnce(req: BuiltRequest): Promise<
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
      const res = await this.deps.fetch(req.url, {
        ...req.init,
        headers: { ...req.init.headers },
        signal: controller.signal,
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
