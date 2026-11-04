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
  stripSensitiveKeys,
} from './request-builder.js';
import { ConcurrencyLimiter, retryAfterSeconds } from './safeguards.js';
import type { Safeguards } from './settings.js';

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
  /** Fixed values (tests); `safeguards` takes precedence when given. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** User settings per host (T-019): timeout, size cap, concurrency. */
  safeguards?: (host: string) => Promise<Safeguards>;
  limiter?: ConcurrencyLimiter;
  /** Extra denied table patterns from the user's settings (added to the defaults; T-020). */
  extraDeniedTables?: () => Promise<readonly string[]>;
}

const fail = (code: ErrorCode, message: string): ExecResult => ({ ok: false, code, message });

export class Executor {
  private readonly limiter: ConcurrencyLimiter;

  constructor(private readonly deps: ExecutorDeps) {
    this.limiter = deps.limiter ?? new ConcurrencyLimiter();
  }

  private async safeguardsFor(host: string): Promise<Safeguards> {
    if (this.deps.safeguards) return this.deps.safeguards(host);
    return {
      requestTimeoutMs: this.deps.timeoutMs ?? SAFEGUARD_DEFAULTS.requestTimeoutMs,
      maxResponseBytes: this.deps.maxResponseBytes ?? SAFEGUARD_DEFAULTS.maxResponseBytes,
      maxConcurrentPerInstance: SAFEGUARD_DEFAULTS.maxConcurrentPerInstance,
    };
  }

  /**
   * Runs one operation within the host's concurrency limit. Queued operations wait in FIFO
   * order; one that can't start within the timeout gets TIMEOUT and is never sent.
   */
  async run(host: string, rawOp: unknown): Promise<ExecResult> {
    const sg = await this.safeguardsFor(host);
    return this.limiter.run(
      host,
      sg.maxConcurrentPerInstance,
      sg.requestTimeoutMs,
      () => this.runNow(host, rawOp, sg),
      () =>
        fail(
          'TIMEOUT',
          `Waited ${Math.round(sg.requestTimeoutMs / 1000)} s for a free slot (${sg.maxConcurrentPerInstance} parallel requests to ${host}); the request was not sent.`,
        ),
    );
  }

  private async runNow(host: string, rawOp: unknown, sg: Safeguards): Promise<ExecResult> {
    const extra = (await this.deps.extraDeniedTables?.()) ?? [];
    const checked = revalidate(rawOp, extra);
    if (!checked.ok) return checked;
    const build = (token: string): BuiltRequest | ExecResult => {
      try {
        return buildRequest(host, checked.op, token, extra);
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
    let res = await this.fetchOnce(req, sg);
    if (res.kind === 'http' && res.status === 401) {
      token = await this.deps.tokens.get(host, { refresh: true });
      if (!token) return fail('NO_INSTANCE_TAB', `Open ${host} in a Chrome tab and log in.`);
      req = build(token);
      if (!('url' in req)) return req;
      res = await this.fetchOnce(req, sg);
      if (res.kind === 'http' && res.status === 401) {
        this.deps.tokens.clear(host);
        return fail('SESSION_EXPIRED', `The ServiceNow session for ${host} has expired.`);
      }
    }
    if (res.kind !== 'http') return res.result;
    return this.mapResponse(res);
  }

  private async fetchOnce(
    req: BuiltRequest,
    sg: Safeguards,
  ): Promise<
    | {
        kind: 'http';
        status: number;
        contentType: string;
        text: string;
        bytes: number;
        totalCount: string | null;
        retryAfter: string | null;
        redirected: boolean;
      }
    | { kind: 'error'; result: ExecResult }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), sg.requestTimeoutMs);
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
          retryAfter: null,
          redirected: true,
        };
      }
      const { text, bytes, tooLarge } = await readCapped(res, sg.maxResponseBytes, controller);
      if (tooLarge) {
        return {
          kind: 'error',
          result: fail('RESPONSE_TOO_LARGE', `The response exceeded ${sg.maxResponseBytes} bytes.`),
        };
      }
      return {
        kind: 'http',
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        text,
        bytes,
        totalCount: res.headers.get('x-total-count'),
        retryAfter: res.headers.get('retry-after'),
        redirected: false,
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return {
          kind: 'error',
          result: fail('TIMEOUT', `No response within ${sg.requestTimeoutMs} ms.`),
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
    retryAfter: string | null;
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
        // Name-based fallback: credential-like keys never leave the extension (T-020).
        body: stripSensitiveKeys((body as { result?: unknown }).result ?? null),
        ...(total !== undefined && Number.isInteger(total) && total >= 0
          ? { totalCount: total }
          : {}),
        bytes: r.bytes,
      };
    }
    if (r.status === 403) return fail('ACL_DENIED', snMessage());
    if (r.status === 404) return fail('NOT_FOUND', snMessage());
    if (r.status === 429 || /maximum transaction|quota/i.test(snMessage())) {
      const after = retryAfterSeconds(r.retryAfter);
      return fail(
        'RATE_LIMITED',
        `${snMessage()}${after !== undefined ? ` Retry after ${after} s.` : ' Retry later.'}`,
      );
    }
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
