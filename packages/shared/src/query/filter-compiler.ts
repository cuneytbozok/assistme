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

const StringValue = z.string().min(1).max(MAX_VALUE_LENGTH);
const ScalarValue = z.union([StringValue, z.number().finite(), z.boolean()]);
const ListItem = z.union([StringValue, z.number().finite()]);

const ScalarCondition = z.strictObject({
  field: FieldPathSchema,
  op: z.enum([
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
  ]),
  value: ScalarValue,
});

const ListCondition = z.strictObject({
  field: FieldPathSchema,
  op: z.enum(['in', 'not_in']),
  value: z.array(ListItem).min(1).max(MAX_LIST_ITEMS),
});

const UnaryCondition = z.strictObject({
  field: FieldPathSchema,
  op: z.enum(['is_empty', 'is_not_empty']),
});

const BetweenCondition = z.strictObject({
  field: FieldPathSchema,
  op: z.literal('between'),
  value: z.tuple([ListItem, ListItem]),
});

const RelativeCondition = z.strictObject({
  field: FieldPathSchema,
  /** within_last: field ≥ now − n units · older_than: field < now − n units */
  op: z.enum(['within_last', 'older_than']),
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

export const FilterTermSchema = z.union([
  FilterConditionSchema,
  z.strictObject({ or: z.array(FilterConditionSchema).min(2).max(10) }),
]);
export type FilterTerm = z.infer<typeof FilterTermSchema>;

export const WhereSchema = z.array(FilterTermSchema).min(1).max(MAX_QUERY_TERMS);
export type Where = z.infer<typeof WhereSchema>;

export const AnyOfSchema = z.array(WhereSchema).min(2).max(MAX_NQ_GROUPS);

export const OrderBySchema = z
  .array(z.strictObject({ field: FieldPathSchema, direction: z.enum(['asc', 'desc']) }))
  .min(1)
  .max(MAX_ORDER_BY);
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
      const [a, b] = c.value.map(str) as [string, string];
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
      value = `@${c.value.unit}@ago@${c.value.amount}`;
      break;
    default:
      operator = SIMPLE_OPS[c.op] as string;
      value = str(c.value);
  }
  const checked = validateValue(operator, value, 'enforce');
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
    const checked = validateValue('=', f.text, 'enforce');
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
  const reparsed = parseEncodedQuery(query, {
    profile: 'enforce',
    allowTextSearch: options.allowTextSearch === true,
  });
  if (!reparsed.ok) return reparsed;
  return {
    ok: true,
    value: { query, parsed: reparsed.value, referencedFields: reparsed.value.referencedFields },
  };
}
