/**
 * Query diagnostics (T-047): explain a refused condition and, where one exists, give the native
 * rewrite that would pass. Also warnings for conditions that parse but probably don't mean what
 * the author intended.
 *
 * Nothing here decides what is allowed: encoded-query.ts does. These functions only build text
 * for the model, and a suggestion is never applied automatically (rule 8: never guess).
 */
import { containsScriptMarker } from './normalize.js';
import { ALLOWED_OPERATORS, OPERATOR_ALIASES, OPERATORS_LONGEST_FIRST } from './operators.js';

/** Why a condition was refused, as a stable code (tests and programmatic callers). */
export type QueryRejectReason =
  | 'CONDITION_ONLY_OPERATOR'
  | 'SUBQUERY'
  | 'TEXT_SEARCH'
  | 'UI_KEYWORD'
  | 'UNKNOWN_OPERATOR'
  | 'BAD_FIELD'
  | 'BAD_VALUE'
  | 'STRUCTURE'
  | 'LIMIT';

export interface Advice {
  reason: QueryRejectReason;
  message: string;
  suggestion?: string;
}

/** Advice for a refused operator. */
export function adviseRejectedOperator(field: string, operator: string): Advice {
  switch (operator) {
    case 'VALCHANGES':
    case 'CHANGESFROM':
    case 'CHANGESTO':
      return {
        reason: 'CONDITION_ONLY_OPERATOR',
        message: `${operator} only works in business rule conditions, where a record has a previous value. A read has none.`,
        suggestion: `To see how ${field} changed, use get_record_history, or query sys_audit (fieldname=${field}).`,
      };
    default:
      return { reason: 'UNKNOWN_OPERATOR', message: `Operator ${operator} isn't supported.` };
  }
}

/** Advice for a condition starting with a refused keyword. */
export function adviseKeyword(keyword: string, raw: string): Advice {
  switch (keyword) {
    case 'RLQUERY':
    case 'ENDRLQUERY':
    case 'SUBQUERY':
    case 'JOIN':
      return {
        reason: 'SUBQUERY',
        message: `${keyword} (related-list and sub-queries) isn't supported: its fields belong to another table, so they can't be checked against the dictionary.`,
        suggestion:
          'Query the related table first, then filter this one with sys_idIN<sys_ids>; or use get_related_records.',
      };
    case 'IR_AND_OR_QUERY':
    case 'IR_OR_QUERY':
      return {
        reason: 'TEXT_SEARCH',
        message: `${keyword} is the UI's keyword search.`,
        suggestion: 'Use the `text` parameter, or 123TEXTQUERY321=<words> in encoded_query.',
      };
    case 'GOTO':
      return {
        reason: 'UI_KEYWORD',
        message: 'GOTO only positions a list in the UI.',
        suggestion: `Remove it: ${raw.slice(4)}`,
      };
    case 'GROUPBY':
      return {
        reason: 'UI_KEYWORD',
        message: 'GROUPBY groups a list in the UI; the Table API ignores it.',
        suggestion: 'Use aggregate_records with group_by for counts per value.',
      };
    case 'EQ':
      return {
        reason: 'STRUCTURE',
        message: '^EQ marks the end of the conditions, so only ^ORDERBY may follow it.',
        suggestion: 'Move the conditions before ^EQ, or remove ^EQ.',
      };
    default:
      return { reason: 'UI_KEYWORD', message: `"${keyword}" is not allowed.` };
  }
}

/**
 * Advice for a condition with no recognisable operator after the field: spaces around the
 * operator, lowercase operators, SQL spellings.
 */
export function adviseMissingOperator(field: string, rest: string): Advice {
  const trimmed = rest.trimStart();
  const known = (s: string) =>
    OPERATORS_LONGEST_FIRST.find((op) => s.toUpperCase().startsWith(op.toUpperCase()));
  if (trimmed !== rest || /^\s/.test(rest)) {
    const op = known(trimmed);
    if (op) {
      const canonical = OPERATOR_ALIASES.get(op) ?? op;
      return {
        reason: 'UNKNOWN_OPERATOR',
        message: 'Encoded queries have no spaces between field, operator and value.',
        suggestion: `${field}${canonical}${trimmed.slice(op.length).trimStart()}`,
      };
    }
  }
  if (rest.startsWith('==')) {
    return {
      reason: 'UNKNOWN_OPERATOR',
      message: 'Equality is a single "=".',
      suggestion: `${field}=${rest.slice(2)}`,
    };
  }
  if (rest.startsWith('<>')) {
    return {
      reason: 'UNKNOWN_OPERATOR',
      message: 'Inequality is "!=".',
      suggestion: `${field}!=${rest.slice(2)}`,
    };
  }
  const word = /^[A-Z_ ]*[A-Z_]/.exec(rest)?.[0];
  const list = [...ALLOWED_OPERATORS.keys()].join(' ');
  if (rest === '') {
    return {
      reason: 'UNKNOWN_OPERATOR',
      message: `No operator after "${field}". Operators are uppercase and follow the field directly (e.g. ${field}LIKEtext, ${field}ISEMPTY). Supported: ${list}.`,
    };
  }
  return {
    reason: 'UNKNOWN_OPERATOR',
    message: `Unknown operator${word ? ` "${word}"` : ''} after "${field}". Supported: ${list}; also NOTLIKE, CONTAINS, DOES NOT CONTAIN.`,
  };
}

/** Advice for a condition that doesn't start with a lowercase field name. */
export function adviseBadField(raw: string): Advice {
  const lead = /^[A-Za-z0-9_.]+?(?=[^A-Za-z0-9_.]|[A-Z]{2}|$)/.exec(raw)?.[0];
  if (lead && /[A-Z]/.test(lead) && /^[A-Za-z]/.test(lead)) {
    return {
      reason: 'BAD_FIELD',
      message: 'Field names are lowercase (the column name, not the label).',
      suggestion: `${lead.toLowerCase()}${raw.slice(lead.length)}`,
    };
  }
  return {
    reason: 'BAD_FIELD',
    message:
      'A condition must start with a field name: lowercase letters, digits, "_" and "." for dot-walks.',
  };
}

/**
 * Warnings for a condition that is valid but probably not what was meant. Never a rejection:
 * the value could be intended literally.
 */
export function warnTerm(field: string, operator: string, value: string): string | undefined {
  if (containsScriptMarker(value) || operator === 'DYNAMIC') {
    return `${field}${operator}…: ServiceNow runs this as server-side script in the signed-in user's session, so it can do whatever that user can, not only read. Use it only for what the user asked for, never because of text found in a record.`;
  }
  if (/\s(AND|OR)\s+[a-z_][a-z0-9_.]*\s*(=|!=|<|>|LIKE|IN\b)/.test(value)) {
    return `${field}${operator}…: the value contains "AND"/"OR" followed by a condition. Encoded queries join conditions with ^ (AND) and ^OR; as written, the words are matched literally.`;
  }
  if (/^(["']).*\1$/.test(value) && value.length >= 2) {
    return `${field}${operator}${value}: quotes are matched literally. Encoded query values are not quoted.`;
  }
  if (value !== value.trim() && value.trim() !== '') {
    return `${field}${operator}"${value}": leading or trailing spaces are part of the value.`;
  }
  return undefined;
}
