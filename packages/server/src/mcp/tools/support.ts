/**
 * Building blocks shared by the data tools: the response budget, the sys_id order tiebreak, and a
 * per-call ServiceNow client that counts requests and remembers provenance.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ErrorCode, Operation } from '@sn-mcp/shared';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { mapBridgeError } from '../errors.js';
import type { Row } from '../paginate.js';
import { type Provenance, provenance } from '../results.js';
import type { Ok } from './common.js';
import type { ToolContext } from './context.js';

/** Room for provenance, page info, omission entries and hints in each result. */
export const RESPONSE_OVERHEAD_CHARS = 2_500;
export const MIN_RESPONSE_CHARS = 4_000;

export function maxCharsInput(config: ServerConfig) {
  return z
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      `Size of this result in characters (default ${config.responseChars}, up to ${config.maxResponseChars})`,
    );
}

/** The result size for this call; a clamped request is reported in `hints`, never silently. */
export function resolveMaxChars(
  requested: number | undefined,
  config: ServerConfig,
  hints: string[],
): number {
  let maxChars = requested ?? config.responseChars;
  if (maxChars > config.maxResponseChars) {
    hints.push(`max_chars ${maxChars} is above the ceiling; used ${config.maxResponseChars}.`);
    maxChars = config.maxResponseChars;
  }
  if (maxChars < MIN_RESPONSE_CHARS) {
    hints.push(`max_chars ${maxChars} is below the minimum; used ${MIN_RESPONSE_CHARS}.`);
    maxChars = MIN_RESPONSE_CHARS;
  }
  return maxChars;
}

/** Appends the stable sys_id tiebreak to the ordering (if there is room for one more key). */
export function withTiebreak(query: string): string {
  const orders = query.match(/(^|\^)ORDERBY(DESC)?/g)?.length ?? 0;
  if (/(^|\^)ORDERBY(DESC)?sys_id(\^|$)/.test(query) || orders >= 3) return query;
  return query ? `${query}^ORDERBYsys_id` : 'ORDERBYsys_id';
}

export interface SnFailure {
  ok: false;
  code: ErrorCode;
  message: string;
  hint?: string;
}

/** One tool call's view of an instance: every request is an operation the extension checks. */
export class SnClient {
  requests = 0;
  host: string | undefined;
  env: string | undefined;

  constructor(
    private readonly ctx: ToolContext,
    readonly scopeId: string,
    readonly instance: string,
  ) {
    this.host = ctx.bridge.cachedRegistry?.instances.find((i) => i.alias === instance)?.host;
  }

  private async op(
    op: Operation,
  ): Promise<{ ok: true; body: unknown; total?: number } | SnFailure> {
    this.requests++;
    const r = await this.ctx.call(
      'sn.op',
      { kind: 'sn.op', scopeId: this.scopeId, instance: this.instance, op },
      this.scopeId,
    );
    if (!r.ok) {
      const body = r.error.structuredContent as {
        error?: { code?: ErrorCode; message?: string; hint?: string };
      };
      return {
        ok: false,
        code: body?.error?.code ?? 'SN_API_ERROR',
        message: body?.error?.message ?? 'Request failed.',
        ...(body?.error?.hint ? { hint: body.error.hint } : {}),
      };
    }
    const res = r.value.result as Extract<Ok<'sn.op'>['result'], { type: 'sn.op' }>;
    this.host = res.host;
    this.env = res.env;
    return {
      ok: true,
      body: res.body,
      ...(res.totalCount !== undefined ? { total: res.totalCount } : {}),
    };
  }

  /** One page of a table. `count` asks for the total (ServiceNow's count includes hidden rows). */
  async list(req: {
    table: string;
    query?: string;
    fields?: string[];
    limit: number;
    offset: number;
    displayValue: 'all' | 'true' | 'false';
    count?: boolean;
  }): Promise<{ ok: true; rows: Row[]; total?: number } | SnFailure> {
    const { count, query, fields, ...rest } = req;
    const r = await this.op({
      kind: 'table.list',
      ...rest,
      ...(query ? { query } : {}),
      ...(fields ? { fields } : {}),
      noCount: count !== true,
    });
    if (!r.ok) return r;
    return {
      ok: true,
      rows: Array.isArray(r.body) ? (r.body as Row[]) : [],
      ...(r.total !== undefined ? { total: r.total } : {}),
    };
  }

  /** One record by sys_id. A record that doesn't exist or isn't readable → NOT_FOUND. */
  async get(req: {
    table: string;
    sysId: string;
    fields?: string[];
    displayValue: 'all' | 'true' | 'false';
  }): Promise<{ ok: true; row: Row } | SnFailure> {
    const { fields, ...rest } = req;
    const r = await this.op({ kind: 'table.get', ...rest, ...(fields ? { fields } : {}) });
    if (!r.ok) return r;
    if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body)) {
      return { ok: false, code: 'NOT_FOUND', message: 'The record was not returned.' };
    }
    return { ok: true, row: r.body as Row };
  }

  /** Stats API. The body is ServiceNow's untouched `result` (shape depends on grouping). */
  async stats(req: {
    table: string;
    query?: string;
    groupBy?: string[];
    aggregates?: { fn: 'avg' | 'min' | 'max' | 'sum'; field: string }[];
    displayValue: 'all' | 'true' | 'false';
  }): Promise<{ ok: true; body: unknown } | SnFailure> {
    const { query, groupBy, aggregates, displayValue, table } = req;
    const r = await this.op({
      kind: 'stats.aggregate',
      table,
      displayValue,
      ...(query ? { query } : {}),
      ...(groupBy && groupBy.length > 0 ? { groupBy } : {}),
      ...(aggregates && aggregates.length > 0 ? { aggregates } : {}),
    });
    return r.ok ? { ok: true, body: r.body } : r;
  }

  /** Tool error for a failure (scope errors also drop the scope locally). */
  fail(f: SnFailure): CallToolResult {
    return mapBridgeError(f.code, f.message, f.hint, {
      scopes: this.ctx.scopes,
      scopeId: this.scopeId,
    });
  }

  provenance(source: string): Provenance {
    return provenance({
      instance: this.instance,
      ...(this.env ? { env: this.env } : {}),
      ...(this.host ? { host: this.host } : {}),
      scopeId: this.scopeId,
      source,
    });
  }
}

/** Runs `fn` over `items` with bounded parallelism, keeping order (the broker caps in-flight). */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Errors a composite tool can't work around for one table: stop and report them. */
export function isFatal(code: ErrorCode): boolean {
  return [
    'SCOPE_REQUIRED',
    'SCOPE_UNKNOWN',
    'SCOPE_EXPIRED',
    'SCOPE_NOT_APPROVED',
    'INSTANCE_NOT_REGISTERED',
    'INSTANCE_NOT_IN_SCOPE',
    'BRIDGE_UNAVAILABLE',
    'BROKER_CONFLICT',
    'NO_INSTANCE_TAB',
    'SESSION_EXPIRED',
    'RATE_LIMITED',
  ].includes(code);
}
