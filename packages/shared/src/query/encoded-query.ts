import {
  MAX_DOT_WALK_DEPTH,
  MAX_ENCODED_QUERY_LENGTH,
  MAX_NQ_GROUPS,
  MAX_QUERY_TERMS,
} from '../limits.js';
import { FIELD_PATH_RE, TABLE_NAME_RE } from '../validation.js';
import {
  adviseBadField,
  adviseKeyword,
  adviseMissingOperator,
  adviseRejectedOperator,
  type QueryRejectReason,
  warnTerm,
} from './diagnostics.js';
import { hasControlChars } from './normalize.js';
import {
  ALLOWED_OPERATORS,
  END_MARKER,
  FIELD_OFFSET_VALUE_RE,
  MAX_LIST_ITEMS,
  MAX_VALUE_LENGTH,
  normalizeRelativeValue,
  OPERATOR_ALIASES,
  OPERATORS_LONGEST_FIRST,
  REJECTED_KEYWORDS,
  REJECTED_OPERATORS,
  RELATIVE_VALUE_RE,
  TEXT_SEARCH_FIELD,
} from './operators.js';

/**
 * Encoded-query tokenizer, parser, validator and serializer (ADR-005, ARCHITECTURE §6.2).
 *
 * Grammar accepted (the read-only subset of ServiceNow encoded queries):
 *   query   := segment ( '^' segment )* [ '^EQ' ( '^' order )* ]
 *   segment := 'NQ' term | 'OR' term | order | text | term
 *   order   := 'ORDERBY' field | 'ORDERBYDESC' field
 *   text    := '123TEXTQUERY321=' value      (only with allowTextSearch, once, before any ^NQ)
 *   term    := field operator value          (field: lowercase path, ≤3 dot-walk hops)
 * Every term must parse completely; anything else is rejected, with a reason and, where one
 * exists, a native rewrite (diagnostics.ts).
 *
 * Accepted as written by ServiceNow's own tools and rewritten to canonical form (T-047): the
 * trailing `^EQ` end marker, and the operator spellings in OPERATOR_ALIASES. Each rewrite is
 * listed in `normalizations`; `serializeQuery` gives the canonical query that is sent.
 *
 * The same rules run in the server and in the extension (the authority). Field existence
 * (dictionary) is checked separately by the server using `referencedFields`.
 */

export interface ParseOptions {
  /** Allow a `123TEXTQUERY321=` term (keyword search). */
  allowTextSearch?: boolean;
}

export type Join = 'AND' | 'OR';

export interface Term {
  field: string;
  operator: string;
  value: string;
  join: Join;
}

export interface OrderBy {
  field: string;
  descending: boolean;
}

export interface ParsedQuery {
  /** NQ groups (OR-ed together). Empty when the query has no conditions. */
  groups: Term[][];
  orderBy: OrderBy[];
  textSearch?: string;
  /** Every field path referenced (conditions, field-valued operators, ordering), deduplicated. */
  referencedFields: string[];
  /** Rewrites applied to reach canonical form (e.g. "removed the trailing ^EQ"). */
  normalizations: string[];
  /** Conditions that are valid but probably not what was meant. Never a rejection. */
  warnings: string[];
}

export type QueryErrorCode = 'UNSAFE_QUERY' | 'INVALID_INPUT';

export interface QueryError {
  code: QueryErrorCode;
  message: string;
  /** The condition as written. */
  term?: string;
  /** 1-based position of the condition among the query's `^`-separated parts. */
  position?: number;
  reason?: QueryRejectReason;
  /** A native rewrite that would pass, or what to do instead. Never applied automatically. */
  suggestion?: string;
}

export type QueryResult<T> = { ok: true; value: T } | { ok: false; error: QueryError };

export const MAX_ORDER_BY = 3;

const FIELD_PREFIX_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*/;

type Fail = { ok: false; error: QueryError };

function fail(
  code: QueryErrorCode,
  message: string,
  extra: Omit<QueryError, 'code' | 'message'> = {},
): Fail {
  const error: QueryError = { code, message };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) (error as unknown as Record<string, unknown>)[k] = v;
  }
  return { ok: false, error };
}

/** "Condition 3 (`priority = 2`): … Try: priority=2" — one line for an error message. */
export function formatQueryError(e: QueryError): string {
  const where =
    e.term !== undefined
      ? `Condition ${e.position ?? '?'} (\`${e.term.length > 120 ? `${e.term.slice(0, 117)}…` : e.term}\`): `
      : '';
  return `${where}${e.message}`;
}

export function isValidFieldPath(field: string): boolean {
  return FIELD_PATH_RE.test(field) && field.split('.').length <= MAX_DOT_WALK_DEPTH + 1;
}

/**
 * Validates a single value for an operator. Shared by the parser and the structured compiler.
 * Returns extra referenced fields (for field-valued operators).
 */
export function validateValue(operator: string, value: string): QueryResult<string[]> {
  const spec = ALLOWED_OPERATORS.get(operator);
  if (!spec) {
    return fail('UNSAFE_QUERY', `operator "${operator}" is not allowed`, {
      reason: 'UNKNOWN_OPERATOR',
    });
  }
  if (spec.value !== 'list' && value.length > MAX_VALUE_LENGTH) {
    return fail('INVALID_INPUT', `value longer than ${MAX_VALUE_LENGTH} characters`, {
      reason: 'LIMIT',
      suggestion: 'Search for a shorter, distinctive part of the value with LIKE.',
    });
  }
  if (hasControlChars(value)) {
    return fail('INVALID_INPUT', 'control characters are not allowed', { reason: 'BAD_VALUE' });
  }
  if (value.includes('^')) {
    return fail('INVALID_INPUT', 'values must not contain "^"', {
      reason: 'BAD_VALUE',
      suggestion: 'ServiceNow has no escape for "^"; match a part of the value without it (LIKE).',
    });
  }
  const bad = (message: string, suggestion?: string) =>
    fail('INVALID_INPUT', message, { reason: 'BAD_VALUE', suggestion });
  switch (spec.value) {
    case 'none':
      return value === ''
        ? { ok: true, value: [] }
        : bad(`operator ${operator} takes no value`, `Remove the value after ${operator}.`);
    case 'any':
      // `field=` and `field!=` are native: they test for an empty / non-empty value.
      return value === '' && operator !== '=' && operator !== '!='
        ? bad(`operator ${operator} needs a value`, 'Use ISEMPTY / ISNOTEMPTY to test for empty.')
        : { ok: true, value: [] };
    case 'list': {
      const items = value.split(',');
      if (value === '' || items.some((i) => i === '')) {
        return bad(
          `operator ${operator} needs a non-empty comma-separated list`,
          'Remove empty items (",,", or a trailing ",").',
        );
      }
      if (items.length > MAX_LIST_ITEMS) {
        return fail('INVALID_INPUT', `lists are limited to ${MAX_LIST_ITEMS} items`, {
          reason: 'LIMIT',
          suggestion: 'Split the list across several queries.',
        });
      }
      if (items.some((i) => i.length > MAX_VALUE_LENGTH)) {
        return fail('INVALID_INPUT', `list items are limited to ${MAX_VALUE_LENGTH} characters`, {
          reason: 'LIMIT',
        });
      }
      return { ok: true, value: [] };
    }
    case 'field':
      return isValidFieldPath(value)
        ? { ok: true, value: [value] }
        : bad(`operator ${operator} needs a field name as value`);
    case 'field_offset': {
      const m = FIELD_OFFSET_VALUE_RE.exec(value);
      const other = m?.[1];
      return other !== undefined && isValidFieldPath(other)
        ? { ok: true, value: [other] }
        : bad(
            `${operator} needs "other_field@unit@before|after@n" (unit: minute, hour, day, week, month, quarter or year; n 0–9999)`,
            `e.g. ${operator}sys_created_on@hour@after@1`,
          );
    }
    case 'table':
      return TABLE_NAME_RE.test(value)
        ? { ok: true, value: [] }
        : bad(`operator ${operator} needs a table name as value`);
    case 'range': {
      const parts = value.split('@');
      return parts.length === 2 && parts.every((p) => p.length > 0)
        ? { ok: true, value: [] }
        : bad(
            'BETWEEN needs exactly two values: "a@b"',
            'e.g. 2026-11-01 00:00:00@2026-11-02 00:00:00',
          );
    }
    case 'relative':
      return RELATIVE_VALUE_RE.test(value)
        ? { ok: true, value: [] }
        : bad(
            `${operator} needs "@unit@ago|ahead@n" (unit: minute, hour, dayofweek, month, quarter or year; n 1–9999)`,
            `e.g. ${operator}@dayofweek@ago@7`,
          );
  }
}

interface ParsedTerm {
  term: Term;
  fields: string[];
  alias?: string;
  warning?: string;
}

function parseTerm(raw: string, join: Join, position: number): QueryResult<ParsedTerm> {
  const at = { term: raw, position };
  if (raw === '') {
    return fail('INVALID_INPUT', 'empty condition (check for "^^" or a dangling "^")', {
      ...at,
      reason: 'STRUCTURE',
    });
  }
  const keyword = REJECTED_KEYWORDS.find((k) => raw.startsWith(k));
  if (keyword) {
    const a = adviseKeyword(keyword, raw);
    return fail(keyword === 'EQ' ? 'INVALID_INPUT' : 'UNSAFE_QUERY', a.message, { ...at, ...a });
  }
  const fieldMatch = FIELD_PREFIX_RE.exec(raw);
  if (!fieldMatch) {
    const a = adviseBadField(raw);
    return fail('UNSAFE_QUERY', a.message, { ...at, ...a });
  }
  const field = fieldMatch[0];
  if (!isValidFieldPath(field)) {
    return fail(
      'INVALID_INPUT',
      `invalid field "${field}" (max ${MAX_DOT_WALK_DEPTH} dot-walk hops)`,
      {
        ...at,
        reason: 'BAD_FIELD',
      },
    );
  }
  const rest = raw.slice(field.length);
  const written = OPERATORS_LONGEST_FIRST.find((op) => rest.startsWith(op));
  if (!written) {
    const a = adviseMissingOperator(field, rest);
    return fail('UNSAFE_QUERY', a.message, { ...at, ...a });
  }
  const writtenValue = rest.slice(written.length);
  // SQL spellings: as written they would compare with the literal "=2" or ">2".
  if (
    (written === '=' && writtenValue.startsWith('=')) ||
    (written === '<' && writtenValue.startsWith('>'))
  ) {
    const a = adviseMissingOperator(field, rest);
    return fail('INVALID_INPUT', a.message, { ...at, ...a });
  }
  if (REJECTED_OPERATORS.includes(written)) {
    const a = adviseRejectedOperator(field, written);
    return fail('UNSAFE_QUERY', a.message, { ...at, ...a });
  }
  const operator = OPERATOR_ALIASES.get(written) ?? written;
  const value =
    ALLOWED_OPERATORS.get(operator)?.value === 'relative'
      ? normalizeRelativeValue(writtenValue)
      : writtenValue;
  const checked = validateValue(operator, value);
  if (!checked.ok) {
    return { ok: false, error: { ...checked.error, ...at } };
  }
  const out: ParsedTerm = {
    term: { field, operator, value, join },
    fields: [field, ...checked.value],
  };
  if (operator !== written) out.alias = `operator ${written} → ${operator}`;
  else if (value !== writtenValue) out.alias = `${writtenValue} → ${value}`;
  const warning = warnTerm(field, operator, value);
  if (warning) out.warning = warning;
  return { ok: true, value: out };
}

/** Parses and validates an encoded query. Never throws. */
export function parseEncodedQuery(
  query: string,
  options: ParseOptions = {},
): QueryResult<ParsedQuery> {
  if (query.length > MAX_ENCODED_QUERY_LENGTH) {
    return fail('INVALID_INPUT', `query longer than ${MAX_ENCODED_QUERY_LENGTH} characters`, {
      reason: 'LIMIT',
      suggestion:
        'Split it into several queries (e.g. one per ^NQ group, or per part of an IN list).',
    });
  }
  if (hasControlChars(query)) {
    return fail('INVALID_INPUT', 'control characters are not allowed', {
      reason: 'BAD_VALUE',
      suggestion: 'Remove line breaks and tabs: the whole query is one line.',
    });
  }

  const groups: Term[][] = [[]];
  const orderBy: OrderBy[] = [];
  const fields = new Set<string>();
  const normalizations: string[] = [];
  const aliases = new Set<string>();
  const warnings: string[] = [];
  let textSearch: string | undefined;
  let termCount = 0;
  let ended = false;

  const segments = query === '' ? [] : query.split('^');
  for (const [index, segment] of segments.entries()) {
    const position = index + 1;
    const at = { term: segment, position };

    if (segment.startsWith('ORDERBYDESC') || segment.startsWith('ORDERBY')) {
      const descending = segment.startsWith('ORDERBYDESC');
      const field = segment.slice(descending ? 11 : 7);
      if (!isValidFieldPath(field)) {
        return fail('INVALID_INPUT', `invalid ORDERBY field "${field}"`, {
          ...at,
          reason: 'BAD_FIELD',
          suggestion: 'ORDERBY<field> or ORDERBYDESC<field>, with a lowercase field name.',
        });
      }
      if (orderBy.length >= MAX_ORDER_BY) {
        return fail('INVALID_INPUT', `at most ${MAX_ORDER_BY} ORDERBY terms`, {
          ...at,
          reason: 'LIMIT',
        });
      }
      orderBy.push({ field, descending });
      fields.add(field);
      continue;
    }

    if (segment === END_MARKER) {
      if (!ended) normalizations.push('removed the ^EQ end marker');
      ended = true;
      continue;
    }
    if (ended) {
      const a = adviseKeyword('EQ', segment);
      return fail('INVALID_INPUT', a.message, { ...at, ...a });
    }

    if (segment.startsWith(TEXT_SEARCH_FIELD)) {
      if (!options.allowTextSearch) {
        return fail('UNSAFE_QUERY', 'this tool does not support text search', {
          ...at,
          reason: 'TEXT_SEARCH',
          suggestion: 'Use query_records for keyword search, or a LIKE condition on a field.',
        });
      }
      if (
        groups.length > 1 ||
        textSearch !== undefined ||
        !segment.startsWith(`${TEXT_SEARCH_FIELD}=`)
      ) {
        return fail('INVALID_INPUT', 'text search is used once, with "=", before any ^NQ', {
          ...at,
          reason: 'STRUCTURE',
          suggestion: `${TEXT_SEARCH_FIELD}=<words> as the first condition.`,
        });
      }
      const value = segment.slice(TEXT_SEARCH_FIELD.length + 1);
      const checked = validateValue('=', value);
      if (!checked.ok) return { ok: false, error: { ...checked.error, ...at } };
      if (value === '') {
        return fail('INVALID_INPUT', 'text search needs words', { ...at, reason: 'BAD_VALUE' });
      }
      textSearch = value;
      continue;
    }

    let join: Join = 'AND';
    let body = segment;
    if (index > 0 && segment.startsWith('NQ')) {
      if ((groups[groups.length - 1] as Term[]).length === 0) {
        return fail('INVALID_INPUT', 'empty query group before ^NQ', {
          ...at,
          reason: 'STRUCTURE',
        });
      }
      groups.push([]);
      if (groups.length > MAX_NQ_GROUPS) {
        return fail('INVALID_INPUT', `at most ${MAX_NQ_GROUPS} ^NQ groups`, {
          ...at,
          reason: 'LIMIT',
          suggestion: 'Run the remaining groups as separate queries.',
        });
      }
      body = segment.slice(2);
    } else if (index > 0 && segment.startsWith('OR')) {
      join = 'OR';
      body = segment.slice(2);
    }

    if (body.startsWith(TEXT_SEARCH_FIELD)) {
      return options.allowTextSearch
        ? fail('INVALID_INPUT', 'text search is used once, with "=", before any ^NQ', {
            ...at,
            reason: 'STRUCTURE',
            suggestion: `${TEXT_SEARCH_FIELD}=<words> as the first condition.`,
          })
        : fail('UNSAFE_QUERY', 'this tool does not support text search', {
            ...at,
            reason: 'TEXT_SEARCH',
          });
    }
    const group = groups[groups.length - 1] as Term[];
    if (join === 'OR' && group.length === 0) {
      return fail('INVALID_INPUT', '^OR must follow a condition in the same group', {
        ...at,
        reason: 'STRUCTURE',
      });
    }
    const parsed = parseTerm(body, join, position);
    if (!parsed.ok) {
      // Report the segment as written, including its ^OR / ^NQ prefix.
      return { ok: false, error: { ...parsed.error, term: segment } };
    }
    group.push(parsed.value.term);
    for (const f of parsed.value.fields) fields.add(f);
    if (parsed.value.alias) aliases.add(parsed.value.alias);
    if (parsed.value.warning) warnings.push(parsed.value.warning);
    termCount++;
    if (termCount > MAX_QUERY_TERMS) {
      return fail('INVALID_INPUT', `at most ${MAX_QUERY_TERMS} conditions`, {
        ...at,
        reason: 'LIMIT',
        suggestion: 'Use IN for several values of one field, or split the query.',
      });
    }
  }

  const nonEmpty = groups.filter((g) => g.length > 0);
  if (nonEmpty.length !== groups.length && nonEmpty.length > 0) {
    return fail('INVALID_INPUT', 'empty query group', { reason: 'STRUCTURE' });
  }
  for (const a of aliases) normalizations.push(a);
  const value: ParsedQuery = {
    groups: nonEmpty,
    orderBy,
    referencedFields: [...fields],
    normalizations,
    warnings,
  };
  if (textSearch !== undefined) value.textSearch = textSearch;
  return { ok: true, value };
}

/** Serializes a parsed query back to canonical encoded form (text search first, ORDERBY last). */
export function serializeQuery(parsed: ParsedQuery): string {
  const parts: string[] = [];
  if (parsed.textSearch !== undefined) parts.push(`${TEXT_SEARCH_FIELD}=${parsed.textSearch}`);
  const groups = parsed.groups.map((g) =>
    g
      .map((t, i) => `${i > 0 && t.join === 'OR' ? 'OR' : ''}${t.field}${t.operator}${t.value}`)
      .join('^'),
  );
  if (groups.length > 0) parts.push(groups.join('^NQ'));
  for (const o of parsed.orderBy)
    parts.push(`${o.descending ? 'ORDERBYDESC' : 'ORDERBY'}${o.field}`);
  return parts.join('^');
}

/** Number of conditions (excluding ordering and text search). */
export function conditionCount(parsed: ParsedQuery): number {
  return parsed.groups.reduce((n, g) => n + g.length, 0);
}
