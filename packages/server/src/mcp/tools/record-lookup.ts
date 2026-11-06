/**
 * Resolves `{sys_id}` or `{match}` to exactly one record, never guessing (T-025, ADR-006).
 * Used by get_record and compare_records.
 *
 * A match reads small windows of candidates (default projection), with the total count, then
 * reads the record itself by sys_id. ServiceNow drops ACL-hidden rows from a window and still
 * counts them, so a window with one readable row isn't proof of uniqueness while the count says
 * more rows follow: reading continues until two readable rows are seen or the matches end.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { FieldPathSchema } from '@sn-mcp/shared';
import { z } from 'zod';
import { compactValue, defaultProjection, stripSensitive } from '../compact.js';
import {
  buildFilterCheck,
  FILTER_NOT_APPLIED_HINT,
  FILTER_NOT_APPLIED_MESSAGE,
} from '../filter-check.js';
import type { FieldInfo, MetaContext } from '../metadata.js';
import type { Row } from '../paginate.js';
import { planQuery } from '../query-guard.js';
import { toolError } from '../results.js';
import { UNTRUSTED_NOTE } from './common.js';
import type { ToolContext } from './context.js';
import { type SnClient, withTiebreak } from './support.js';

export const MatchValue = z.union([z.string().min(1).max(1000), z.number(), z.boolean()]);

/**
 * {field: value} that identifies one record. Keys are checked here rather than published as
 * `propertyNames`, which not every model API accepts (T-048); the validation is the same.
 */
export const MatchInput = z
  .looseObject({})
  .catchall(MatchValue)
  .superRefine((m, ctx) => {
    for (const k of Object.keys(m)) {
      if (!FieldPathSchema.safeParse(k).success) {
        ctx.addIssue({ code: 'custom', message: `invalid field name "${k}"`, path: [k] });
      }
    }
  });
export type Match = Record<string, string | number | boolean>;
export interface Lookup {
  sys_id?: string;
  match?: Match;
}

const CANDIDATE_WINDOW = 6;
const MAX_CANDIDATES = 5;
const MAX_MATCH_FIELDS = 10;

export type LookupOutcome =
  | { ok: true; sysId: string; hints: string[] }
  | { ok: false; result: CallToolResult };

/** `side` labels the errors of compare_records (a or b). */
export async function resolveSysId(o: {
  ctx: ToolContext;
  sn: SnClient;
  mc: MetaContext;
  table: string;
  lookup: Lookup;
  known: ReadonlyMap<string, FieldInfo>;
  side?: 'a' | 'b';
}): Promise<LookupOutcome> {
  const { ctx, sn, mc, table, lookup, known, side } = o;
  const label = side ? ` (side ${side})` : '';
  const extra = side ? { side } : undefined;
  if ((lookup.sys_id === undefined) === (lookup.match === undefined)) {
    return {
      ok: false,
      result: toolError('INVALID_INPUT', `Pass either sys_id or match${label}, not both.`),
    };
  }
  if (lookup.sys_id !== undefined) return { ok: true, sysId: lookup.sys_id, hints: [] };

  const entries = Object.entries(lookup.match as Match);
  if (entries.length === 0 || entries.length > MAX_MATCH_FIELDS) {
    return {
      ok: false,
      result: toolError('INVALID_INPUT', `match needs 1–${MAX_MATCH_FIELDS} fields${label}.`),
    };
  }
  const where = entries.map(([field, value]) => ({ field, op: '=' as const, value }));
  const matchFields = entries.map(([f]) => f).filter((f) => !f.includes('.'));
  const projection = [...new Set([...defaultProjection(known), ...matchFields])];
  const plan = await planQuery(
    ctx.meta,
    mc,
    { table, where, fields: projection },
    {
      highVolumeTables: ctx.config.highVolumeTables,
      extraDeniedTables: ctx.config.extraDeniedTables,
    },
  );
  const query = withTiebreak(plan.query);
  const check = buildFilterCheck(query, known, undefined);
  const found: Row[] = [];
  let total: number | undefined;
  for (let offset = 0; found.length < 2; offset += CANDIDATE_WINDOW) {
    const r = await sn.list({
      table,
      query,
      fields: projection,
      limit: CANDIDATE_WINDOW,
      offset,
      displayValue: 'all',
      count: true,
    });
    if (!r.ok) return { ok: false, result: sn.fail(r) };
    total = r.total ?? total;
    // A record that doesn't match must never become "the unique match".
    for (const row of r.rows) {
      const field = check.contradiction(row);
      if (field !== undefined) {
        return {
          ok: false,
          result: toolError(
            'FILTER_NOT_APPLIED',
            FILTER_NOT_APPLIED_MESSAGE(table, field),
            FILTER_NOT_APPLIED_HINT,
            extra,
          ),
        };
      }
    }
    found.push(...r.rows);
    // Without a count, only a full window can have more behind it.
    const more =
      total !== undefined ? offset + CANDIDATE_WINDOW < total : r.rows.length === CANDIDATE_WINDOW;
    if (!more) break;
  }
  if (found.length === 0) {
    return {
      ok: false,
      result: toolError(
        'NOT_FOUND',
        `No readable record in ${table} matches${label}: ${entries.map(([f, v]) => `${f}=${String(v)}`).join(', ')}.`,
        'Check the values, or search with query_records.',
        extra,
      ),
    };
  }
  if (found.length > 1) {
    const { records } = stripSensitive(found.slice(0, MAX_CANDIDATES), known);
    const candidates = (records as Row[]).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, compactValue(v)])),
    );
    return {
      ok: false,
      result: toolError(
        'AMBIGUOUS_MATCH',
        `${total ?? found.length} records in ${table} match${label}. The connector never guesses: choose one by sys_id.`,
        "Pass one candidate's sys_id, or use list_all to see every match.",
        {
          ...extra,
          total: total ?? found.length,
          candidates,
          list_all: {
            tool: 'query_records',
            args: {
              scope_id: sn.scopeId,
              table,
              ...(sn.instance && side ? { instance: sn.instance } : {}),
              where,
              include_total: true,
            },
          },
          untrusted_content: UNTRUSTED_NOTE,
        },
      ),
    };
  }
  const row = found[0] as Row;
  const hints =
    total !== undefined && total > 1
      ? [
          `ServiceNow counted ${total} matching rows; only this one is readable by the signed-in user. The others are hidden by ACLs.`,
        ]
      : [];
  return { ok: true, sysId: String(compactValue(row.sys_id)), hints };
}
