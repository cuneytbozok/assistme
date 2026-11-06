/**
 * Encoded-query operator allowlist (ADR-005).
 *
 * Only operators listed in ALLOWED_OPERATORS may appear in a query. Anything else is rejected
 * with UNSAFE_QUERY. REJECTED_OPERATORS / REJECTED_KEYWORDS exist only to give precise error
 * messages — the allowlist is what enforces safety.
 *
 * Why some ServiceNow operators are excluded (diagnostics.ts explains each one to the model,
 * with a native rewrite where one exists):
 * - DYNAMIC: resolves a sys_filter_option_dynamic record, which runs server-side script.
 * - ON / NOTON / DATEPART: their values are `javascript:` expressions.
 * - MORETHAN / LESSTHAN / RELATIVEEE: not verified live; an operator ServiceNow misreads could
 *   be ignored, which broadens results (T-005).
 * - VALCHANGES / CHANGESFROM / CHANGESTO: condition-only operators, meaningless for reads.
 * - RLQUERY / SUBQUERY / JOIN / IR_*: related-list and sub-queries. Their fields belong to other
 *   tables, so dictionary validation can't cover them.
 * - 123TEXTQUERY321: text search, only where the tool allows it.
 * - GOTO / GROUPBY: UI list keywords.
 * `^EQ` (the end marker the condition builder appends) is accepted and dropped (T-047).
 */

export type ValueKind =
  | 'any' // free value (subject to safety checks)
  | 'none' // unary operator: value must be empty
  | 'list' // comma-separated list
  | 'field' // value is another field path on the same table
  | 'table' // value is a table name
  | 'range' // `a@b`
  | 'relative'; // `@unit@ago|ahead@n`

export interface OperatorSpec {
  readonly op: string;
  readonly value: ValueKind;
}

const SPECS: readonly OperatorSpec[] = [
  { op: '=', value: 'any' },
  { op: '!=', value: 'any' },
  { op: '>', value: 'any' },
  { op: '>=', value: 'any' },
  { op: '<', value: 'any' },
  { op: '<=', value: 'any' },
  { op: 'LIKE', value: 'any' },
  { op: 'NOT LIKE', value: 'any' },
  { op: 'STARTSWITH', value: 'any' },
  { op: 'ENDSWITH', value: 'any' },
  { op: 'IN', value: 'list' },
  { op: 'NOT IN', value: 'list' },
  { op: 'ISEMPTY', value: 'none' },
  { op: 'ISNOTEMPTY', value: 'none' },
  { op: 'ANYTHING', value: 'none' },
  { op: 'EMPTYSTRING', value: 'none' },
  { op: 'BETWEEN', value: 'range' },
  { op: 'SAMEAS', value: 'field' },
  { op: 'NSAMEAS', value: 'field' },
  { op: 'GT_FIELD', value: 'field' },
  { op: 'LT_FIELD', value: 'field' },
  { op: 'GT_OR_EQUALS_FIELD', value: 'field' },
  { op: 'LT_OR_EQUALS_FIELD', value: 'field' },
  { op: 'INSTANCEOF', value: 'table' },
  { op: 'RELATIVEGT', value: 'relative' },
  { op: 'RELATIVEGE', value: 'relative' },
  { op: 'RELATIVELT', value: 'relative' },
  { op: 'RELATIVELE', value: 'relative' },
];

export const ALLOWED_OPERATORS: ReadonlyMap<string, OperatorSpec> = new Map(
  SPECS.map((s) => [s.op, s]),
);

/**
 * Spellings accepted as input and rewritten to the canonical operator before sending (T-047).
 * Each means exactly the same as its target: `NOTLIKE` is how ServiceNow docs often write
 * `NOT LIKE`, and `CONTAINS` / `DOES NOT CONTAIN` are the GlideRecord names of LIKE / NOT LIKE.
 */
export const OPERATOR_ALIASES: ReadonlyMap<string, string> = new Map([
  ['NOTLIKE', 'NOT LIKE'],
  ['CONTAINS', 'LIKE'],
  ['DOES NOT CONTAIN', 'NOT LIKE'],
]);

/** Operators recognised only to produce a clear rejection message. */
export const REJECTED_OPERATORS: readonly string[] = [
  'DYNAMIC',
  'DATEPART',
  'MORETHAN',
  'LESSTHAN',
  'VALCHANGES',
  'CHANGESFROM',
  'CHANGESTO',
  'RELATIVEEE',
  'NOTON',
  'ON',
];

/** Term-level keywords (a term starting with one of these is rejected). */
export const REJECTED_KEYWORDS: readonly string[] = [
  'RLQUERY',
  'ENDRLQUERY',
  'SUBQUERY',
  'JOIN',
  'IR_AND_OR_QUERY',
  'IR_OR_QUERY',
  'GOTO',
  'GROUPBY',
  'EQ',
];

/** End-of-query marker appended by the condition builder ("Copy query"). Dropped. */
export const END_MARKER = 'EQ';

export const TEXT_SEARCH_FIELD = '123TEXTQUERY321';

/** All operator strings (allowed, aliases, rejected), longest first, for prefix matching. */
export const OPERATORS_LONGEST_FIRST: readonly string[] = [
  ...ALLOWED_OPERATORS.keys(),
  ...OPERATOR_ALIASES.keys(),
  ...REJECTED_OPERATORS,
].sort((a, b) => b.length - a.length);

export const RELATIVE_UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const;
export const RELATIVE_VALUE_RE =
  /^@(minute|hour|day|week|month|year)@(ago|ahead)@([1-9][0-9]{0,3})$/;

/** Items in one IN / NOT IN list. The query length bounds it too. */
export const MAX_LIST_ITEMS = 1000;
/** Length of one value; for IN / NOT IN, of each list item. */
export const MAX_VALUE_LENGTH = 500;
