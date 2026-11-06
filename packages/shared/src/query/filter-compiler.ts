import { z } from 'zod';
import { MAX_NQ_GROUPS, MAX_QUERY_TERMS } from '../limits.js';
import { FieldPathSchema } from '../validation.js';
import {
  isValidFieldPath,
  MAX_ORDER_BY,
  type ParsedQuery,
  parseEncodedQuery,
  type QueryError,
  type QueryResult,
  validateValue,
} from './encoded-query.js';
import {
  MAX_LIST_ITEMS,
  MAX_VALUE_LENGTH,
  nativeRelativeValue,
  RELATIVE_UNITS,
  TEXT_SEARCH_FIELD,
} from './operators.js';

/**
 * Structured filters — the primary query input (ADR-005, ARCHITECTURE §6.1).
 *
 *   where:  [ cond | {or: [cond, …]}, … ]   → AND of terms; an `or` group compiles to a^ORb
 *   any_of: [ where, where, … ] (2–3)       → groups joined with ^NQ
 *   cond:   {field, op, value}
 *
 * The compiler emits an encoded query and then re-parses its own output with the
 * authoritative ('enforce') validator, so a compiled query can never be something the
 * extension would reject.
 */

/*
 * These are the validation schemas. MCP clients are shown the compact PublishedWhereSchema below
 * instead (T-048). Only portable keywords are used either way: a pair is a 2-item array, not a
 * tuple (tuples become `prefixItems` / `items: false`, which some model APIs reject).
 */
const StringValue = z.string().min(1).max(MAX_VALUE_LENGTH);
const ScalarValue = z.union([StringValue, z.number().finite(), z.boolean()]);
const ListItem = z.union([StringValue, z.number().finite()]);

const Field = FieldPathSchema;

const SCALAR_OPS = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
] as const;
const RELATIVE_OPS = ['within_last', 'older_than'] as const;

const ScalarCondition = z.strictObject({
  field: Field,
  op: z.enum(SCALAR_OPS),
  value: ScalarValue,
});

const ListCondition = z.strictObject({
  field: Field,
  op: z.enum(['in', 'not_in']),
  value: z.array(ListItem).min(1).max(MAX_LIST_ITEMS),
});

const UnaryCondition = z.strictObject({
  field: Field,
  op: z.enum(['is_empty', 'is_not_empty']),
});

const BetweenCondition = z.strictObject({
  field: Field,
  op: z.literal('between'),
  value: z.array(ListItem).length(2),
});

const RelativeCondition = z.strictObject({
  field: Field,
  /** within_last: field ≥ now − n units · older_than: field < now − n units */
  op: z.enum(RELATIVE_OPS),
  value: z.strictObject({
    amount: z.int().min(1).max(9999),
    unit: z.enum(RELATIVE_UNITS),
  }),
});

export const FilterConditionSchema = z.union([
  ScalarCondition,
  ListCondition,
  UnaryCondition,
  BetweenCondition,
  RelativeCondition,
]);
export type FilterCondition = z.infer<typeof FilterConditionSchema>;

/** How a relative date is written, for tool descriptions and errors: clients may not show types. */
export const RELATIVE_VALUE_HELP = `{amount, unit}, relative to now, with unit one of ${RELATIVE_UNITS.join(', ')} (singular): {"amount": 30, "unit": "day"}`;

/**
 * Replaces zod's bare "Invalid input" for a condition that fits no form. Some clients don't show
 * the model the typed `where` (seen live in a Claude Code session, T-048), so this has to teach.
 */
const FILTER_TERM_ERROR = `Not a valid filter condition. Expected {field, op, value} or {or: [2-10 conditions]}. value by op: one stored value for = != > >= < <= contains not_contains starts_with ends_with; a list for in / not_in; [low, high] for between; ${RELATIVE_VALUE_HELP} for within_last / older_than; none for is_empty / is_not_empty.`;

export const FilterTermSchema = z.union(
  [FilterConditionSchema, z.strictObject({ or: z.array(FilterConditionSchema).min(2).max(10) })],
  { error: FILTER_TERM_ERROR },
);
export type FilterTerm = z.infer<typeof FilterTermSchema>;

export const WhereSchema = z
  .array(FilterTermSchema)
  .min(1)
  .max(MAX_QUERY_TERMS)
  .describe('Conditions that must all hold');
export type Where = z.infer<typeof WhereSchema>;

export const AnyOfSchema = z
  .array(WhereSchema)
  .min(2)
  .max(MAX_NQ_GROUPS)
  .describe('Alternative where lists');

/**
 * What MCP clients are shown for `where` (T-048): one condition shape with every operator and
 * every value type, instead of the per-operator union above, which expands to about 4 KB per copy.
 * The Codex engine in ChatGPT Desktop (0.166) strips the descriptions and nested structure of any
 * tool input schema over about 5,000 bytes, so the full union would reach its model as `{}`.
 * It accepts everything WhereSchema accepts (tested); WhereSchema still validates every input.
 */
const PublishedCondition = z.strictObject({
  field: z.string().describe('Column name, lowercase; dot-walk with "." (caller_id.name)'),
  op: z.enum([
    ...SCALAR_OPS,
    'in',
    'not_in',
    'is_empty',
    'is_not_empty',
    'between',
    ...RELATIVE_OPS,
  ]),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number()])),
      z.strictObject({ amount: z.int().min(1).max(9999), unit: z.enum(RELATIVE_UNITS) }),
    ])
    .optional()
    .describe('Depends on op (see the tool description); none for is_empty / is_not_empty'),
});
const PublishedTerm = z.union(
  [PublishedCondition, z.strictObject({ or: z.array(PublishedCondition).min(2).max(10) })],
  { error: FILTER_TERM_ERROR },
);
export const PublishedWhereSchema = z
  .array(PublishedTerm)
  .min(1)
  .max(MAX_QUERY_TERMS)
  .describe('Conditions that must all hold: {field, op, value}, or {or: [conditions]} for any');
/** `any_of` as shown to clients: its items have the shape of `where` (validated in full). */
export const PublishedAnyOfSchema = z
  .array(z.array(z.looseObject({})).min(1).max(MAX_QUERY_TERMS))
  .min(2)
  .max(MAX_NQ_GROUPS)
  .describe('2-10 alternative lists, each shaped like where; a record matches if any list holds');

export const OrderBySchema = z
  .array(z.strictObject({ field: Field, direction: z.enum(['asc', 'desc']) }))
  .min(1)
  .max(MAX_ORDER_BY)
  .describe('Sort keys, first one first');
export type OrderByInput = z.infer<typeof OrderBySchema>;

export const FilterInputSchema = z
  .strictObject({
    where: WhereSchema.optional(),
    any_of: AnyOfSchema.optional(),
    order_by: OrderBySchema.optional(),
    /** Full-text search; compiled to a leading 123TEXTQUERY321 term. */
    text: StringValue.optional(),
  })
  .refine((f) => !(f.where && f.any_of), { message: 'use either `where` or `any_of`, not both' });
export type FilterInput = z.infer<typeof FilterInputSchema>;

export interface CompiledQuery {
  query: string;
  parsed: ParsedQuery;
  referencedFields: string[];
}

const SIMPLE_OPS: Record<string, string> = {
  '=': '=',
  '!=': '!=',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
  contains: 'LIKE',
  not_contains: 'NOT LIKE',
  starts_with: 'STARTSWITH',
  ends_with: 'ENDSWITH',
};

function err(
  code: QueryError['code'],
  message: string,
  term?: string,
): { ok: false; error: QueryError } {
  return { ok: false, error: term === undefined ? { code, message } : { code, message, term } };
}

const str = (v: string | number | boolean): string => (typeof v === 'string' ? v : String(v));

function compileCondition(c: FilterCondition): QueryResult<string> {
  if (!isValidFieldPath(c.field)) return err('INVALID_INPUT', `invalid field "${c.field}"`);
  let operator: string;
  let value: string;
  switch (c.op) {
    case 'is_empty':
      operator = 'ISEMPTY';
      value = '';
      break;
    case 'is_not_empty':
      operator = 'ISNOTEMPTY';
      value = '';
      break;
    case 'in':
    case 'not_in': {
      const items = c.value.map(str);
      if (items.some((i) => i.includes(','))) {
        return err('INVALID_INPUT', `"${c.op}" items must not contain ","`, c.field);
      }
      operator = c.op === 'in' ? 'IN' : 'NOT IN';
      value = items.join(',');
      break;
    }
    case 'between': {
      const [a = '', b = ''] = c.value.map(str);
      if (a.includes('@') || b.includes('@')) {
        return err('INVALID_INPUT', '"between" values must not contain "@"', c.field);
      }
      operator = 'BETWEEN';
      value = `${a}@${b}`;
      break;
    }
    case 'within_last':
    case 'older_than':
      operator = c.op === 'within_last' ? 'RELATIVEGE' : 'RELATIVELT';
      value = nativeRelativeValue(c.value.unit, 'ago', c.value.amount);
      break;
    default:
      operator = SIMPLE_OPS[c.op] as string;
      value = str(c.value);
  }
  const checked = validateValue(operator, value);
  if (!checked.ok) return { ok: false, error: { ...checked.error, term: c.field } };
  return { ok: true, value: `${c.field}${operator}${value}` };
}

function compileWhere(where: Where): QueryResult<string> {
  const out: string[] = [];
  for (const term of where) {
    if ('or' in term) {
      const parts: string[] = [];
      for (const c of term.or) {
        const r = compileCondition(c);
        if (!r.ok) return r;
        parts.push(r.value);
      }
      out.push(parts.join('^OR'));
    } else {
      const r = compileCondition(term);
      if (!r.ok) return r;
      out.push(r.value);
    }
  }
  return { ok: true, value: out.join('^') };
}

export interface CompileOptions {
  /** Permit `text` (text search). Default false. */
  allowTextSearch?: boolean;
}

/**
 * Compiles structured filter input into a validated encoded query.
 * Accepts untrusted input (validated with FilterInputSchema first). Never throws.
 */
export function compileFilter(
  input: unknown,
  options: CompileOptions = {},
): QueryResult<CompiledQuery> {
  const parsedInput = FilterInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const issue = parsedInput.error.issues[0];
    return err(
      'INVALID_INPUT',
      `${issue?.path.join('.') || 'filter'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const f = parsedInput.data;
  if (f.text !== undefined && !options.allowTextSearch) {
    return err('INVALID_INPUT', 'text search is not available for this operation');
  }

  const parts: string[] = [];
  if (f.text !== undefined) {
    const checked = validateValue('=', f.text);
    if (!checked.ok) return checked as { ok: false; error: QueryError };
    parts.push(`${TEXT_SEARCH_FIELD}=${f.text}`);
  }
  if (f.where) {
    const r = compileWhere(f.where);
    if (!r.ok) return r;
    parts.push(r.value);
  } else if (f.any_of) {
    const groups: string[] = [];
    for (const w of f.any_of) {
      const r = compileWhere(w);
      if (!r.ok) return r;
      groups.push(r.value);
    }
    parts.push(groups.join('^NQ'));
  }
  for (const o of f.order_by ?? []) {
    parts.push(`${o.direction === 'desc' ? 'ORDERBYDESC' : 'ORDERBY'}${o.field}`);
  }

  const query = parts.join('^');
  // Self-check: the compiled output must pass the authoritative validator.
  const reparsed = parseEncodedQuery(query, { allowTextSearch: options.allowTextSearch === true });
  if (!reparsed.ok) return reparsed;
  return {
    ok: true,
    value: { query, parsed: reparsed.value, referencedFields: reparsed.value.referencedFields },
  };
}
