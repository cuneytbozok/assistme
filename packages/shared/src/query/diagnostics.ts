/**
 * Query diagnostics (T-047): explain a refused condition and, where one exists, give the native
 * rewrite that would pass. Also warnings for conditions that parse but probably don't mean what
 * the author intended.
 *
 * Nothing here decides what is allowed: encoded-query.ts does. These functions only build text
 * for the model, and a suggestion is never applied automatically (rule 8: never guess).
 */
import { normalizeForInspection } from './normalize.js';
import { ALLOWED_OPERATORS, OPERATOR_ALIASES, OPERATORS_LONGEST_FIRST } from './operators.js';

/** Why a condition was refused, as a stable code (tests and programmatic callers). */
export type QueryRejectReason =
  | 'SCRIPT_VALUE'
  | 'DYNAMIC_FILTER'
  | 'SCRIPTED_DATE_OPERATOR'
  | 'UNVERIFIED_OPERATOR'
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

const UNIT_OF: Record<string, string> = {
  minutes: 'minute',
  hours: 'hour',
  days: 'day',
  weeks: 'week',
  months: 'month',
  years: 'year',
};

/** `gs.daysAgoStart(7)` and friends → their RELATIVE equivalent, or undefined. */
function relativeFor(field: string, operator: string, script: string): string | undefined {
  const m =
    /^gs\.(minutes|hours|days|weeks|months|quarters|years)ago(?:start|end)?\((\d{1,4})\)$/.exec(
      script,
    );
  if (!m) return undefined;
  let unit = UNIT_OF[m[1] as string];
  let n = Number(m[2]);
  if (m[1] === 'quarters') {
    unit = 'month';
    n *= 3;
  }
  const rel: Record<string, string> = {
    '>': 'RELATIVEGT',
    '>=': 'RELATIVEGE',
    '<': 'RELATIVELT',
    '<=': 'RELATIVELE',
  };
  const op = rel[operator];
  if (!op || !unit || n < 1 || n > 9999) return undefined;
  return `${field}${op}@${unit}@ago@${n}`;
}

/** `gs.dateGenerate('2026-11-01','00:00:00')` (or 'start' / 'end') → `2026-11-01 00:00:00`. */
function literalDate(script: string): string | undefined {
  const m =
    /^gs\.dategenerate\(\s*['"](\d{4}-\d{2}-\d{2})['"]\s*,\s*['"](start|end|\d{2}:\d{2}:\d{2})['"]\s*\)$/.exec(
      script,
    );
  if (!m) return undefined;
  const time = m[2] === 'start' ? '00:00:00' : m[2] === 'end' ? '23:59:59' : m[2];
  return `${m[1]} ${time}`;
}

const scriptOf = (v: string): string | undefined => {
  const n = normalizeForInspection(v).trim();
  const m = /^javascript\s*:\s*(.*)$/.exec(n);
  return m ? (m[1] as string).replace(/;\s*$/, '').trim() : undefined;
};

const TZ_NOTE =
  'ServiceNow reads a literal date-time in the session user’s time zone, as the script would.';

/** Advice for a value that contains `javascript:`, with a native rewrite where one exists. */
export function adviseScriptValue(field: string, operator: string, value: string): Advice {
  const base =
    'ServiceNow runs a javascript: value as server-side script, and this connector never sends one.';
  const parts = operator === 'BETWEEN' ? value.split('@') : [value];
  const scripts = parts.map(scriptOf);

  if (operator === 'BETWEEN' && parts.length === 2) {
    const lits = parts.map((p, i) =>
      scripts[i] === undefined ? p : literalDate(scripts[i] as string),
    );
    if (lits.every((l) => l !== undefined)) {
      return {
        reason: 'SCRIPT_VALUE',
        message: `${base} The dates can be written literally.`,
        suggestion: `${field}BETWEEN${lits.join('@')} (${TZ_NOTE})`,
      };
    }
  }
  const script = scripts[0];
  if (script !== undefined) {
    const rel = relativeFor(field, operator, script);
    if (rel) {
      return {
        reason: 'SCRIPT_VALUE',
        message: `${base} A relative date condition does the same without script.`,
        suggestion: `${rel} (RELATIVE counts from now, not from the start of the day; use an absolute date-time for a calendar boundary)`,
      };
    }
    const lit = literalDate(script);
    if (lit) {
      return {
        reason: 'SCRIPT_VALUE',
        message: `${base} The date can be written literally.`,
        suggestion: `${field}${operator}${lit} (${TZ_NOTE})`,
      };
    }
    if (/^gs\.(beginning|end)of/.test(script)) {
      return {
        reason: 'SCRIPT_VALUE',
        message: `${base} Calendar boundaries like ${script} have no script-free form.`,
        suggestion: `Use an absolute date-time, e.g. ${field}${operator}YYYY-MM-DD 00:00:00, or ${field}RELATIVEGE@day@ago@1 for the last 24 hours.`,
      };
    }
    if (/^gs\.getuser(id\(\)|\(\)\.getid\(\))$/.test(script)) {
      return {
        reason: 'SCRIPT_VALUE',
        message: `${base} The current user can't be resolved inside the query.`,
        suggestion: `Find the user's sys_id first (query_records on sys_user, e.g. user_name=… or email=…), then use ${field}=<sys_id>.`,
      };
    }
    if (/getmygroups\(\)/.test(script)) {
      return {
        reason: 'SCRIPT_VALUE',
        message: `${base} Group membership can't be resolved inside the query.`,
        suggestion: `Read the user's groups from sys_user_grmember (user=<sys_id>, fields group), then use ${field}IN<group sys_ids>.`,
      };
    }
  }
  return {
    reason: 'SCRIPT_VALUE',
    message: base,
    suggestion: 'Replace the javascript: expression with the literal value it would produce.',
  };
}

/** Advice for a refused operator. */
export function adviseRejectedOperator(field: string, operator: string, value: string): Advice {
  switch (operator) {
    case 'DYNAMIC':
      return {
        reason: 'DYNAMIC_FILTER',
        message:
          'DYNAMIC filters (such as "Me" or "My groups") evaluate a stored script, which this connector never triggers.',
        suggestion: `Resolve the value first (for "Me", the signed-in user's sys_id from sys_user), then use ${field}=<sys_id> or ${field}IN<sys_ids>.`,
      };
    case 'ON':
    case 'NOTON': {
      const [, start, end] = value.split('@');
      const s = start !== undefined ? scriptOf(start) : undefined;
      const e = end !== undefined ? scriptOf(end) : undefined;
      const a = s ? literalDate(s) : undefined;
      const b = e ? literalDate(e) : undefined;
      const message = `${operator} takes a date range written as script (javascript:gs.…), which this connector never sends.`;
      if (a && b) {
        return {
          reason: 'SCRIPTED_DATE_OPERATOR',
          message,
          suggestion:
            operator === 'ON'
              ? `${field}BETWEEN${a}@${b} (${TZ_NOTE})`
              : `${field}<${a}^OR${field}>${b} (${TZ_NOTE})`,
        };
      }
      return {
        reason: 'SCRIPTED_DATE_OPERATOR',
        message,
        suggestion: `Use ${field}BETWEENYYYY-MM-DD 00:00:00@YYYY-MM-DD 23:59:59 for a calendar range, or ${field}RELATIVEGE@day@ago@n for the last n days.`,
      };
    }
    case 'DATEPART':
      return {
        reason: 'SCRIPTED_DATE_OPERATOR',
        message: 'DATEPART (day of week, month, …) is evaluated with script.',
        suggestion: `Filter a date range with BETWEEN or RELATIVEGE, read ${field}, and pick the matching rows yourself.`,
      };
    case 'MORETHAN':
    case 'LESSTHAN':
      return {
        reason: 'UNVERIFIED_OPERATOR',
        message: `${operator} (two date fields with an offset) isn't supported: an operator ServiceNow misreads can be ignored, which returns unfiltered rows.`,
        suggestion: `For a plain comparison of two fields use GT_FIELD / LT_FIELD (e.g. ${field}GT_FIELD<other_field>), then check the offset in the rows.`,
      };
    case 'RELATIVEEE':
      return {
        reason: 'UNVERIFIED_OPERATOR',
        message: 'RELATIVEEE isn’t supported.',
        suggestion: `Combine RELATIVEGE and RELATIVELT, or use BETWEEN with absolute date-times.`,
      };
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
