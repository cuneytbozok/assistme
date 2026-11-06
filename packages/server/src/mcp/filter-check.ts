/**
 * Checks that returned rows really satisfy the query (ADR-005 addendum, 2026-11-05).
 *
 * ServiceNow ignores conditions it can't apply: an unknown field (T-005), and possibly a field
 * under a `query_range` ACL ("Part of the query has been ignored"). Refused queries are fine, but
 * an ignored condition would return rows that don't match, looking like an answer.
 *
 * A false alarm would block a good result, so this only reports a row that certainly contradicts
 * the query. Anything it can't judge counts as a match: dot-walks, dates (the query uses the
 * user's time zone, values are UTC), display-value matches on references, blank values (a field
 * ACL can blank them), and every operator not listed below. Comparisons ignore case, as
 * ServiceNow's normally do. So a pass doesn't prove a filter was applied; a failure shows it wasn't.
 */
import { containsScriptMarker, parseEncodedQuery, type Term } from '@sn-mcp/shared';
import { compactValue } from './compact.js';
import type { FieldInfo } from './metadata.js';
import type { Row } from './paginate.js';

const TEXT_TYPES = new Set([
  'string',
  'script',
  'script_plain',
  'script_server',
  'email_script',
  'html_script',
  'conditions',
  'condition_string',
]);
const NUMBER_TYPES = new Set(['integer', 'decimal', 'float', 'longint']);
const SYS_ID = /^[0-9a-f]{32}$/i;
/** More fields than this and the extra check fields wouldn't fit in one request. */
const MAX_REQUEST_FIELDS = 50;

export interface FilterCheck {
  /** Fields the check needs in the response. */
  fields: string[];
  /** The first condition a row certainly contradicts, or undefined if it may match. */
  contradiction: (row: Row) => string | undefined;
}

const rawText = (v: unknown): string | undefined => {
  const c = compactValue(v);
  const raw = c && typeof c === 'object' && 'v' in c ? (c as { v: unknown }).v : c;
  if (raw === undefined || raw === null || typeof raw === 'object') return undefined;
  const s = String(raw);
  return s === '' ? undefined : s;
};

/** true: matches. false: certainly doesn't. undefined: can't tell. */
function judge(t: Term, f: FieldInfo | undefined, value: string | undefined): boolean | undefined {
  if (!f || value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  const want = t.value.trim().toLowerCase();
  const equals = (w: string): boolean | undefined => {
    if (TEXT_TYPES.has(f.type)) return v === w;
    if (f.type === 'boolean') {
      const b = (x: string) =>
        x === 'true' || x === '1' ? 1 : x === 'false' || x === '0' ? 0 : -1;
      return b(v) < 0 || b(w) < 0 ? undefined : b(v) === b(w);
    }
    if (NUMBER_TYPES.has(f.type)) {
      const [x, y] = [Number(v), Number(w)];
      return Number.isFinite(x) && Number.isFinite(y) ? x === y : undefined;
    }
    if (f.type === 'reference' || f.type === 'GUID') {
      // A reference can also match on its display value: only a sys_id condition is exact.
      return SYS_ID.test(w) && SYS_ID.test(v) ? v === w : undefined;
    }
    return undefined;
  };
  // A script's result isn't in the query, so the rows can't be checked against it.
  if (containsScriptMarker(want)) return undefined;
  switch (t.operator) {
    case '=':
      return equals(want);
    case 'IN': {
      const results = want.split(',').map((w) => equals(w.trim()));
      if (results.includes(true)) return true;
      return results.includes(undefined) ? undefined : false;
    }
    case 'LIKE':
    case 'STARTSWITH':
    case 'ENDSWITH':
      if (!TEXT_TYPES.has(f.type) || want.includes('%')) return undefined;
      if (t.operator === 'LIKE') return v.includes(want);
      return t.operator === 'STARTSWITH' ? v.startsWith(want) : v.endsWith(want);
    default:
      return undefined;
  }
}

export function buildFilterCheck(
  query: string,
  known: ReadonlyMap<string, FieldInfo>,
  requested: readonly string[] | undefined,
): FilterCheck {
  const parsed = parseEncodedQuery(query, { allowTextSearch: true });
  if (!parsed.ok) return { fields: [], contradiction: () => undefined };
  const groups = parsed.value.groups;
  const needed = groups
    .flat()
    .map((t) => t.field)
    .filter((f) => !f.includes('.') && known.has(f));
  const room = requested ? MAX_REQUEST_FIELDS - requested.length : 0;
  const fields = requested
    ? [...new Set(needed)].filter((f) => !requested.includes(f)).slice(0, Math.max(0, room))
    : [];
  return {
    fields,
    contradiction: (row) => {
      if (groups.length === 0) return undefined;
      let failed: string | undefined;
      for (const group of groups) {
        // Same reading as the query itself: a^ORb binds as an OR with what precedes it.
        let acc: boolean | undefined;
        let failedHere: string | undefined;
        group.forEach((t, i) => {
          const m = judge(
            t,
            known.get(t.field),
            t.field in row ? rawText(row[t.field]) : undefined,
          );
          if (i === 0) acc = m;
          else if (t.join === 'OR')
            acc =
              acc === true || m === true
                ? true
                : acc === undefined || m === undefined
                  ? undefined
                  : false;
          else
            acc =
              acc === false || m === false
                ? false
                : acc === undefined || m === undefined
                  ? undefined
                  : true;
          if (m === false && !failedHere) failedHere = t.field;
        });
        if (acc !== false) return undefined; // this group may match
        failed ??= failedHere;
      }
      return failed;
    },
  };
}

export const FILTER_NOT_APPLIED_MESSAGE = (table: string, field: string | undefined) =>
  `ServiceNow returned rows from ${table} that don't match the filter${field ? ` on ${field}` : ''}, so it seems to have ignored the condition. These rows aren't an answer to the query, and they were not returned.`;
export const FILTER_NOT_APPLIED_HINT =
  "Tell the user the filter couldn't be applied, usually because of an ACL on that field. Don't present unfiltered rows as results. Try a condition on another field, or ask a ServiceNow admin about access.";
