import {
  MAX_DOT_WALK_DEPTH,
  MAX_ENCODED_QUERY_LENGTH,
  MAX_NQ_GROUPS,
  MAX_QUERY_TERMS,
} from '../limits.js';
import { FIELD_PATH_RE, TABLE_NAME_RE } from '../validation.js';
import { containsScriptLikePattern, containsScriptMarker, hasControlChars } from './normalize.js';
import {
  ALLOWED_OPERATORS,
  MAX_LIST_ITEMS,
  MAX_VALUE_LENGTH,
  OPERATORS_LONGEST_FIRST,
  REJECTED_KEYWORDS,
  RELATIVE_VALUE_RE,
  TEXT_SEARCH_FIELD,
} from './operators.js';

/**
 * Encoded-query tokenizer, parser, validator and serializer (ADR-005, ARCHITECTURE §6.2).
 *
 * Grammar accepted (subset of ServiceNow encoded queries):
 *   query   := segment ( '^' segment )*
 *   segment := 'NQ' term | 'OR' term | 'ORDERBY' field | 'ORDERBYDESC' field | term
 *   term    := field operator value          (field: lowercase path, ≤3 dot-walk hops)
 *            | '123TEXTQUERY321=' value      (only with allowTextSearch, first term only)
 * Every term must parse completely; anything else is rejected.
 *
 * Profiles:
 *   - 'enforce': authoritative checks (run in the extension and the server).
 *   - 'strict' : 'enforce' + rejects script-like patterns (gs., ${, eval(, new X). Used for raw
 *                `encoded_query` input typed by the model.
 * Field existence (dictionary) is checked separately by the server (T-018) using
 * `referencedFields`.
 */

export type QueryProfile = 'strict' | 'enforce';

export interface ParseOptions {
  profile: QueryProfile;
  /** Allow a leading `123TEXTQUERY321=` term (emitted only by the server's `text` param). */
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
}

export type QueryErrorCode = 'UNSAFE_QUERY' | 'INVALID_INPUT';

export interface QueryError {
  code: QueryErrorCode;
  message: string;
  term?: string;
}

export type QueryResult<T> = { ok: true; value: T } | { ok: false; error: QueryError };

export const MAX_ORDER_BY = 3;

const FIELD_PREFIX_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*/;

function fail(
  code: QueryErrorCode,
  message: string,
  term?: string,
): { ok: false; error: QueryError } {
  return { ok: false, error: term === undefined ? { code, message } : { code, message, term } };
}

export function isValidFieldPath(field: string): boolean {
  return FIELD_PATH_RE.test(field) && field.split('.').length <= MAX_DOT_WALK_DEPTH + 1;
}

/**
 * Validates a single value for an operator. Shared by the parser and the structured compiler.
 * Returns extra referenced fields (for field-valued operators).
 */
export function validateValue(
  operator: string,
  value: string,
  profile: QueryProfile,
): QueryResult<string[]> {
  const spec = ALLOWED_OPERATORS.get(operator);
  if (!spec) return fail('UNSAFE_QUERY', `operator "${operator}" is not allowed`);
  if (value.length > MAX_VALUE_LENGTH) {
    return fail('INVALID_INPUT', `value longer than ${MAX_VALUE_LENGTH} characters`);
  }
  if (hasControlChars(value)) return fail('INVALID_INPUT', 'control characters are not allowed');
  if (value.includes('^')) return fail('INVALID_INPUT', 'values must not contain "^"');
  if (containsScriptMarker(value)) {
    return fail('UNSAFE_QUERY', 'script values (javascript:) are not allowed');
  }
  if (profile === 'strict' && containsScriptLikePattern(value)) {
    return fail(
      'UNSAFE_QUERY',
      'script-like value (gs., ${, eval(, new …) is not allowed in raw encoded queries; use a structured filter for literal code searches',
    );
  }
  switch (spec.value) {
    case 'none':
      return value === ''
        ? { ok: true, value: [] }
        : fail('INVALID_INPUT', `operator ${operator} takes no value`);
    case 'any':
      return value === ''
        ? fail('INVALID_INPUT', `operator ${operator} needs a value (use ISEMPTY for empty)`)
        : { ok: true, value: [] };
    case 'list': {
      const items = value.split(',');
      if (value === '' || items.some((i) => i === '')) {
        return fail('INVALID_INPUT', `operator ${operator} needs a non-empty comma-separated list`);
      }
      if (items.length > MAX_LIST_ITEMS) {
        return fail('INVALID_INPUT', `lists are limited to ${MAX_LIST_ITEMS} items`);
      }
      return { ok: true, value: [] };
    }
    case 'field':
      return isValidFieldPath(value)
        ? { ok: true, value: [value] }
        : fail('INVALID_INPUT', `operator ${operator} needs a field name as value`);
    case 'table':
      return TABLE_NAME_RE.test(value)
        ? { ok: true, value: [] }
        : fail('INVALID_INPUT', `operator ${operator} needs a table name as value`);
    case 'range': {
      const parts = value.split('@');
      return parts.length === 2 && parts.every((p) => p.length > 0)
        ? { ok: true, value: [] }
        : fail('INVALID_INPUT', 'BETWEEN needs exactly two values: "a@b"');
    }
    case 'relative':
      return RELATIVE_VALUE_RE.test(value)
        ? { ok: true, value: [] }
        : fail(
            'INVALID_INPUT',
            `${operator} needs "@unit@ago|ahead@n" (unit: minute…year, n ≤ 9999)`,
          );
  }
}

function parseTerm(
  raw: string,
  join: Join,
  profile: QueryProfile,
): QueryResult<{ term: Term; fields: string[] }> {
  if (raw === '')
    return fail('INVALID_INPUT', 'empty condition (check for "^^" or a dangling "^")');
  const keyword = REJECTED_KEYWORDS.find((k) => raw.startsWith(k));
  if (keyword) return fail('UNSAFE_QUERY', `"${keyword}" is not allowed`, raw);
  const fieldMatch = FIELD_PREFIX_RE.exec(raw);
  if (!fieldMatch) {
    return fail('UNSAFE_QUERY', 'condition must start with a lowercase field name', raw);
  }
  const field = fieldMatch[0];
  if (!isValidFieldPath(field)) {
    return fail(
      'INVALID_INPUT',
      `invalid field "${field}" (max ${MAX_DOT_WALK_DEPTH} dot-walk hops)`,
      raw,
    );
  }
  const rest = raw.slice(field.length);
  const operator = OPERATORS_LONGEST_FIRST.find((op) => rest.startsWith(op));
  if (!operator) return fail('UNSAFE_QUERY', 'unknown or missing operator', raw);
  const value = rest.slice(operator.length);
  const checked = validateValue(operator, value, profile);
  if (!checked.ok) return { ok: false, error: { ...checked.error, term: raw } };
  return {
    ok: true,
    value: { term: { field, operator, value, join }, fields: [field, ...checked.value] },
  };
}

/** Parses and validates an encoded query. Never throws. */
export function parseEncodedQuery(query: string, options: ParseOptions): QueryResult<ParsedQuery> {
  if (query.length > MAX_ENCODED_QUERY_LENGTH) {
    return fail('INVALID_INPUT', `query longer than ${MAX_ENCODED_QUERY_LENGTH} characters`);
  }
  if (hasControlChars(query)) return fail('INVALID_INPUT', 'control characters are not allowed');

  const groups: Term[][] = [[]];
  const orderBy: OrderBy[] = [];
  const fields = new Set<string>();
  let textSearch: string | undefined;
  let termCount = 0;

  if (query === '') return { ok: true, value: { groups: [], orderBy, referencedFields: [] } };

  const segments = query.split('^');
  for (const [index, segment] of segments.entries()) {
    const current = groups[groups.length - 1] as Term[];

    if (segment.startsWith('ORDERBYDESC') || segment.startsWith('ORDERBY')) {
      const descending = segment.startsWith('ORDERBYDESC');
      const field = segment.slice(descending ? 11 : 7);
      if (!isValidFieldPath(field))
        return fail('INVALID_INPUT', `invalid ORDERBY field "${field}"`);
      if (orderBy.length >= MAX_ORDER_BY) {
        return fail('INVALID_INPUT', `at most ${MAX_ORDER_BY} ORDERBY terms`);
      }
      orderBy.push({ field, descending });
      fields.add(field);
      continue;
    }

    if (segment.startsWith(TEXT_SEARCH_FIELD)) {
      if (!options.allowTextSearch) {
        return fail(
          'UNSAFE_QUERY',
          'text search keyword is not allowed here; use the `text` parameter',
        );
      }
      if (index !== 0 || textSearch !== undefined || !segment.startsWith(`${TEXT_SEARCH_FIELD}=`)) {
        return fail('INVALID_INPUT', 'text search must be the first term, used once, with "="');
      }
      const value = segment.slice(TEXT_SEARCH_FIELD.length + 1);
      const checked = validateValue('=', value, options.profile);
      if (!checked.ok) return checked;
      textSearch = value;
      continue;
    }

    let join: Join = 'AND';
    let body = segment;
    if (index > 0 && segment.startsWith('NQ')) {
      if (current.length === 0) return fail('INVALID_INPUT', 'empty query group before ^NQ');
      groups.push([]);
      if (groups.length > MAX_NQ_GROUPS) {
        return fail('INVALID_INPUT', `at most ${MAX_NQ_GROUPS} ^NQ groups`);
      }
      body = segment.slice(2);
    } else if (index > 0 && segment.startsWith('OR')) {
      join = 'OR';
      body = segment.slice(2);
    }

    const group = groups[groups.length - 1] as Term[];
    if (join === 'OR' && group.length === 0) {
      return fail('INVALID_INPUT', '^OR must follow a condition in the same group', segment);
    }
    const parsed = parseTerm(body, join, options.profile);
    if (!parsed.ok) return parsed;
    group.push(parsed.value.term);
    for (const f of parsed.value.fields) fields.add(f);
    termCount++;
    if (termCount > MAX_QUERY_TERMS) {
      return fail('INVALID_INPUT', `at most ${MAX_QUERY_TERMS} conditions`);
    }
  }

  const nonEmpty = groups.filter((g) => g.length > 0);
  if (nonEmpty.length !== groups.length && nonEmpty.length > 0) {
    return fail('INVALID_INPUT', 'empty query group');
  }
  const value: ParsedQuery = { groups: nonEmpty, orderBy, referencedFields: [...fields] };
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
