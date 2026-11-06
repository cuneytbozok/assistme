/**
 * Why did a query return nothing? (T-047)
 *
 * An empty result is a valid answer, so this never changes it. When a fresh query returns no
 * rows, it looks for the common causes that make a correct-looking query miss: a choice label
 * where ServiceNow compares stored values (`state=Resolved` vs `state=6`), a display value on a
 * reference (`assigned_to=Beth Anglin`), or `=` on a date-time (exact to the second). Each finding
 * is a hint; nothing is retried or rewritten (rule 8: never guess).
 *
 * Cost: choice lists are read only here, for at most MAX_CHOICE_READS fields, and are cached.
 */
import { parseEncodedQuery, type Term } from '@sn-mcp/shared';
import type { FieldInfo, MetaContext, MetadataService } from './metadata.js';

const MAX_CHOICE_READS = 3;
const MAX_HINTS = 5;
const SYS_ID = /^[0-9a-f]{32}$/i;
const CHOICE_TYPES = new Set(['string', 'integer', 'choice']);
const DATE_TYPES = new Set(['glide_date_time', 'due_date', 'glide_date']);
const BOOLEAN_VALUES = new Set(['true', 'false', '1', '0']);
const EQUALITY = new Set(['=', '!=', 'IN', 'NOT IN']);

const itemsOf = (t: Term): string[] =>
  t.operator === 'IN' || t.operator === 'NOT IN' ? t.value.split(',') : [t.value];

export async function emptyResultHints(
  meta: MetadataService,
  ctx: MetaContext,
  table: string,
  query: string,
  known: ReadonlyMap<string, FieldInfo>,
): Promise<string[]> {
  const parsed = parseEncodedQuery(query, { allowTextSearch: true });
  if (!parsed.ok) return [];
  const hints: string[] = [];
  const terms = parsed.value.groups
    .flat()
    .filter((t) => EQUALITY.has(t.operator) && t.value !== '' && !t.field.includes('.'));
  let choiceReads = 0;
  const seen = new Set<string>();
  for (const t of terms) {
    if (hints.length >= MAX_HINTS) break;
    const f = known.get(t.field);
    if (!f || seen.has(`${t.field}|${t.value}`)) continue;
    seen.add(`${t.field}|${t.value}`);
    const items = itemsOf(t);

    if (f.type === 'reference' || f.type === 'GUID') {
      const named = items.filter((i) => !SYS_ID.test(i));
      if (named.length > 0) {
        hints.push(
          `${t.field} is a reference${f.reference ? ` to ${f.reference}` : ''}, and "${named[0]}" isn't a sys_id. Compare with the record's sys_id, or dot-walk to one of its fields (e.g. ${t.field}.name=${named[0]}).`,
        );
      }
      continue;
    }
    if (f.type === 'boolean') {
      const odd = items.find((i) => !BOOLEAN_VALUES.has(i.toLowerCase()));
      if (odd) hints.push(`${t.field} is true/false; "${odd}" never matches.`);
      continue;
    }
    if (DATE_TYPES.has(f.type) && (t.operator === '=' || t.operator === 'IN')) {
      hints.push(
        `${t.field}${t.operator}… matches the exact value to the second. For a day or a range, use BETWEEN (e.g. ${t.field}BETWEEN2026-11-01 00:00:00@2026-11-01 23:59:59) or within_last.`,
      );
      continue;
    }
    if (!CHOICE_TYPES.has(f.type) || choiceReads >= MAX_CHOICE_READS) continue;
    choiceReads++;
    let choices: { value: string; label: string }[];
    try {
      choices = await meta.choices(ctx, table, t.field);
    } catch {
      continue; // a diagnostic must never fail the result
    }
    if (choices.length === 0) continue;
    const values = new Set(choices.map((c) => c.value));
    for (const item of items) {
      if (values.has(item)) continue;
      const byLabel = choices.find((c) => c.label.toLowerCase() === item.toLowerCase());
      if (byLabel) {
        hints.push(
          `"${item}" is the label of ${t.field} choice ${byLabel.value}. Queries compare stored values: use ${t.field}${t.operator === 'NOT IN' || t.operator === '!=' ? '!=' : '='}${byLabel.value}.`,
        );
      } else {
        const list = choices
          .slice(0, 10)
          .map((c) => `${c.value} (${c.label})`)
          .join(', ');
        hints.push(
          `${t.field} has no choice value "${item}". Its values: ${list}${choices.length > 10 ? ', …' : ''}.`,
        );
      }
      break;
    }
  }
  return hints.slice(0, MAX_HINTS);
}
