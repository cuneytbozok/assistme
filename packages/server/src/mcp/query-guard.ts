/**
 * Dictionary-aware query planning (T-018, ARCHITECTURE §6.3–6.4, ADR-005/ADR-011).
 *
 * Rejects only *unsafe* or *invalid* queries:
 * - every referenced field (filters, raw query terms, `fields`, `order_by`, each dot-walk hop)
 *   must exist in the dictionary, because ServiceNow ignores unknown fields and would return
 *   all rows (anti-broadening, confirmed live in T-005);
 * - raw `encoded_query` is validated with the strict profile and can never be combined with a
 *   tool's internal conditions (internal conditions are structured only).
 *
 * Never rejects a query for being broad, old or unconditioned. On high-volume tables an
 * unordered query gets `ORDERBYDESCsys_created_on`, and unselective queries get hints. A
 * user-specified order is never overridden. Counts are opt-in.
 */
import {
  compileFilter,
  type FilterInput,
  isDeniedTable,
  isSensitiveFieldName,
  MAX_ENCODED_QUERY_LENGTH,
  PASSWORD_INTERNAL_TYPES,
  type ParsedQuery,
  parseEncodedQuery,
  TEXT_SEARCH_FIELD,
  type Where,
} from '@sn-mcp/shared';
import { isHighVolume } from '../config.js';
import { type MetaContext, MetadataError, type MetadataService } from './metadata.js';

export const MAX_DOT_WALK_HOPS = 3;
export const DEFAULT_ORDER_FIELD = 'sys_created_on';

export interface QueryRequest {
  table: string;
  where?: FilterInput['where'];
  any_of?: FilterInput['any_of'];
  order_by?: FilterInput['order_by'];
  text?: string;
  /** Raw encoded query from the model (strict profile). Exclusive with structured filters. */
  encoded_query?: string;
  fields?: string[];
  include_total?: boolean;
  /** Conditions a tool adds itself (e.g. "records of this sys_id"); structured only. */
  internal?: Where;
}

export interface QueryPlan {
  query: string;
  fields?: string[];
  noCount: boolean;
  /** True when the server added the default newest-first order (high-volume table). */
  defaultedOrder: boolean;
  highVolume: boolean;
  hints: string[];
  referencedFields: string[];
}

export class QueryGuardError extends MetadataError {}

const SELECTIVE_OPS = new Set(['=', 'IN', 'STARTSWITH', 'BETWEEN', '>', '>=', '<', '<=']);
const TIME_FIELDS = new Set(['sys_created_on', 'sys_updated_on']);

function isRelative(op: string): boolean {
  return op.startsWith('RELATIVE');
}

/** A condition that narrows the scan: time ranges or exact/prefix key matches. */
function selectivity(parsed: ParsedQuery): { selective: boolean; contains: boolean } {
  let selective = false;
  let contains = false;
  for (const g of parsed.groups) {
    for (const t of g) {
      if (t.field === TEXT_SEARCH_FIELD) continue;
      if (t.operator === 'LIKE' || t.operator === 'NOT LIKE' || t.operator === 'ENDSWITH')
        contains = true;
      if (TIME_FIELDS.has(t.field) && (isRelative(t.operator) || SELECTIVE_OPS.has(t.operator)))
        selective = true;
      else if (t.operator === '=' || t.operator === 'IN' || t.operator === 'STARTSWITH')
        selective = true;
    }
  }
  if (parsed.textSearch) contains = true;
  return { selective, contains };
}

function invalid(message: string, hint?: string): QueryGuardError {
  return new QueryGuardError('INVALID_INPUT', message, hint);
}

/**
 * Validates and compiles a query for `table`. Throws QueryGuardError / MetadataError
 * (INVALID_INPUT, INVALID_FIELD, UNSAFE_QUERY, NOT_FOUND) before any data request is made.
 */
export async function planQuery(
  meta: MetadataService,
  ctx: MetaContext,
  req: QueryRequest,
  opts: {
    highVolumeTables: readonly string[];
    allowTextSearch?: boolean;
    extraDeniedTables?: readonly string[];
    /** Aggregates read no rows: no default order, no row-reading hints. */
    aggregate?: boolean;
  },
): Promise<QueryPlan> {
  const denied = opts.extraDeniedTables ?? [];
  if (isDeniedTable(req.table, denied)) {
    throw new QueryGuardError(
      'TABLE_DENIED',
      `The table ${req.table} may contain credentials and is blocked.`,
      'Credential tables (and fields of type password) are never readable through this connector.',
    );
  }
  const structured = req.where !== undefined || req.any_of !== undefined || req.text !== undefined;
  if (req.where !== undefined && req.any_of !== undefined) {
    // Never silently drop one of them: they mean different things.
    throw invalid(
      'Use either `where` (one AND group) or `any_of` (alternative groups), not both.',
      'To combine, repeat the shared conditions inside each any_of group.',
    );
  }
  if (req.encoded_query !== undefined && structured) {
    throw invalid('Use either structured filters (where/any_of/text) or encoded_query, not both.');
  }
  if (req.encoded_query !== undefined && req.internal !== undefined) {
    throw invalid(
      'This tool adds its own conditions, so encoded_query is not accepted here.',
      'Express the filter with `where` instead.',
    );
  }
  if (req.encoded_query !== undefined && req.order_by !== undefined) {
    throw invalid('Put the ordering inside encoded_query (ORDERBY…), or use where + order_by.');
  }

  // 1. Compile or parse (syntax and safety).
  let query = '';
  let parsed: ParsedQuery;
  if (req.encoded_query !== undefined) {
    if (req.encoded_query.length > MAX_ENCODED_QUERY_LENGTH) {
      throw invalid(`encoded_query is longer than ${MAX_ENCODED_QUERY_LENGTH} characters.`);
    }
    const p = parseEncodedQuery(req.encoded_query, { profile: 'strict', allowTextSearch: false });
    if (!p.ok)
      throw new QueryGuardError(
        p.error.code,
        p.error.message,
        'Prefer structured `where` filters.',
      );
    query = req.encoded_query;
    parsed = p.value;
  } else {
    const internal = req.internal ?? [];
    const input: FilterInput = {
      ...(req.any_of
        ? { any_of: req.any_of.map((g) => [...internal, ...g]) }
        : req.where || internal.length > 0
          ? { where: [...internal, ...(req.where ?? [])] }
          : {}),
      ...(req.order_by ? { order_by: req.order_by } : {}),
      ...(req.text !== undefined ? { text: req.text } : {}),
    };
    const c = compileFilter(input, { allowTextSearch: opts.allowTextSearch === true });
    if (!c.ok) throw new QueryGuardError(c.error.code, c.error.message);
    query = c.value.query;
    parsed = c.value.parsed;
  }

  // 2. Anti-broadening: every referenced field must exist (table first: NOT_FOUND + matches).
  await meta.table(ctx, req.table);
  const referenced = new Set<string>(
    parsed.referencedFields.filter((f) => f !== TEXT_SEARCH_FIELD),
  );
  for (const f of req.fields ?? []) referenced.add(f);
  const problems: { field: string; message: string; suggestions: string[] }[] = [];
  for (const path of referenced) {
    if (path.split('.').length - 1 > MAX_DOT_WALK_HOPS) {
      problems.push({
        field: path,
        message: `"${path}" walks more than ${MAX_DOT_WALK_HOPS} references.`,
        suggestions: [],
      });
      continue;
    }
    try {
      const resolved = await meta.resolvePath(ctx, req.table, path);
      const blockedHop = resolved.tables.find((t) => isDeniedTable(t, denied));
      if (blockedHop) {
        throw new QueryGuardError(
          'TABLE_DENIED',
          `"${path}" reaches the blocked table ${blockedHop}.`,
          'Credential tables are never readable, also not through a dot-walk.',
        );
      }
      if (PASSWORD_INTERNAL_TYPES.includes(resolved.field.type) || isSensitiveFieldName(path)) {
        throw new QueryGuardError(
          'FORBIDDEN_OPERATION',
          `"${path}" is a credential field and can't be read or filtered on.`,
        );
      }
    } catch (e) {
      if (e instanceof MetadataError && e.code === 'INVALID_FIELD') {
        const segs = path.split('.');
        problems.push({
          field: path,
          message: e.message,
          suggestions: (e.suggestions ?? []).map((s) =>
            [...segs.slice(0, segs.length - 1), s].join('.'),
          ),
        });
      } else throw e;
    }
  }
  if (problems.length > 0) {
    const hint = problems
      .filter((p) => p.suggestions.length > 0)
      .map((p) => `${p.field} → ${p.suggestions.slice(0, 3).join(' / ')}`)
      .join('; ');
    throw new QueryGuardError(
      'INVALID_FIELD',
      `${problems.map((p) => p.message).join(' ')} ServiceNow ignores unknown fields and could return unfiltered rows, so the query was not sent.`,
      hint
        ? `Did you mean: ${hint}? describe_table lists all fields.`
        : `Use describe_table on ${req.table} to see its fields.`,
      problems.flatMap((p) => p.suggestions),
    );
  }

  // 3. Cost-aware defaults (no rejection).
  const highVolume = isHighVolume(req.table, opts.highVolumeTables);
  const hints: string[] = [];
  let defaultedOrder = false;
  if (highVolume && !opts.aggregate) {
    if (parsed.orderBy.length === 0) {
      const fields = await meta.fields(ctx, req.table);
      if (fields.has(DEFAULT_ORDER_FIELD)) {
        query = query
          ? `${query}^ORDERBYDESC${DEFAULT_ORDER_FIELD}`
          : `ORDERBYDESC${DEFAULT_ORDER_FIELD}`;
        defaultedOrder = true;
        hints.push(
          `${req.table} is a high-volume table: results are newest first (sys_created_on). Pass order_by to change it.`,
        );
      }
    }
    const { selective, contains } = selectivity(parsed);
    if (!selective) {
      hints.push(
        `No selective condition on ${req.table}. For faster reads add a time range (e.g. sys_created_on within_last), an exact key condition, or use aggregate_records for counts.`,
      );
    }
    if (contains) {
      hints.push(
        `"contains"/text conditions on ${req.table} scan many rows. starts_with or an exact match on an indexed field is faster.`,
      );
    }
  }

  return {
    query,
    ...(req.fields ? { fields: req.fields } : {}),
    noCount: req.include_total !== true,
    defaultedOrder,
    highVolume,
    hints,
    referencedFields: [...referenced],
  };
}
