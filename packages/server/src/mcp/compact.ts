/**
 * Response compaction (T-020 part; response shaping grows in T-023).
 *
 * `stripSensitive` removes password-type fields (by dictionary type) and credential-like field
 * names (fallback) from records, including dot-walked keys, and reports which field names were
 * removed — never their values — so the result stays explicit about what it omits.
 */
import { isSensitiveFieldName, PASSWORD_INTERNAL_TYPES } from '@sn-mcp/shared';
import type { FieldInfo } from './metadata.js';

export function isSensitiveField(name: string, fields?: ReadonlyMap<string, FieldInfo>): boolean {
  const top = name.split('.')[0] as string;
  const f = fields?.get(top);
  if (f && PASSWORD_INTERNAL_TYPES.includes(f.type) && !name.includes('.')) return true;
  return isSensitiveFieldName(name);
}

export function stripSensitive(
  records: readonly unknown[],
  fields?: ReadonlyMap<string, FieldInfo>,
): { records: unknown[]; stripped: string[] } {
  const stripped = new Set<string>();
  const out = records.map((r) => {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return r;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (isSensitiveField(k, fields)) stripped.add(k);
      else clean[k] = v;
    }
    return clean;
  });
  return { records: out, stripped: [...stripped].sort() };
}

// --- T-023: projection, value compaction, previews, budget fitting, links -------------------

/** Fields every list shows first when the caller gives no projection (ARCHITECTURE §8.3). */
const DEFAULT_CANDIDATES = [
  'number',
  'name',
  'short_description',
  'sys_updated_on',
  'sys_class_name',
];

/** sys_id, the dictionary display field, then the usual identifying fields that exist. */
export function defaultProjection(fields: ReadonlyMap<string, FieldInfo>): string[] {
  const out = ['sys_id'];
  const display = [...fields.values()].find((f) => f.display)?.name;
  if (display && !out.includes(display)) out.push(display);
  for (const c of DEFAULT_CANDIDATES) if (fields.has(c) && !out.includes(c)) out.push(c);
  return out;
}

/** A next-call descriptor Claude can use as is. */
export interface NextCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface FieldOmission {
  kind: 'field';
  reason: 'preview' | 'response_budget' | 'too_large';
  sys_id: string;
  field: string;
  shown_chars: number;
  /** null when the size is unknown (the record was too large to read whole). */
  total_chars: number | null;
  next: NextCall;
}

/** `{value, display_value}` → plain value when equal (or no display), else `{v, d}`. */
export function compactValue(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    const { value, display_value: display } = raw as { value: unknown; display_value?: unknown };
    if (display === undefined || display === null || display === '' || display === value)
      return value;
    return { v: value, d: display };
  }
  return raw;
}

const textLength = (v: unknown): number =>
  typeof v === 'string'
    ? v.length
    : v && typeof v === 'object'
      ? JSON.stringify(v).length
      : String(v ?? '').length;

function truncate(v: unknown, max: number): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  if (v && typeof v === 'object' && 'v' in v) {
    const o = v as { v: unknown; d: unknown };
    return { v: truncate(o.v, max), d: truncate(o.d, max) };
  }
  return v;
}

export interface CompactOptions {
  table: string;
  scopeId: string;
  previewChars: number;
  host?: string;
}

function fieldNext(o: CompactOptions, sysId: string, field: string): NextCall {
  return {
    tool: 'get_field_content',
    args: { scope_id: o.scopeId, table: o.table, sys_id: sysId, field },
  };
}

/** Compacts one record: {v,d}, long-field previews. Returns the record and its omissions. */
export function compactRecord(
  raw: Record<string, unknown>,
  o: CompactOptions,
): { record: Record<string, unknown>; omitted: FieldOmission[] } {
  const record: Record<string, unknown> = {};
  const omitted: FieldOmission[] = [];
  const sysId = String(compactValue(raw.sys_id) ?? '');
  for (const [k, rawValue] of Object.entries(raw)) {
    const v = compactValue(rawValue);
    const total = textLength(typeof v === 'object' && v && 'v' in v ? (v as { v: unknown }).v : v);
    if (k !== 'sys_id' && total > o.previewChars) {
      record[k] = truncate(v, o.previewChars);
      omitted.push({
        kind: 'field',
        reason: 'preview',
        sys_id: sysId,
        field: k,
        shown_chars: o.previewChars,
        total_chars: total,
        next: fieldNext(o, sysId, k),
      });
    } else record[k] = v;
  }
  return { record, omitted };
}

/**
 * Makes one record (plus its omission entries) fit `budget` characters by removing its largest
 * fields first. Each removed field gets an omission entry with the exact call to read it.
 * sys_id is never removed.
 */
export function fitRecord(
  record: Record<string, unknown>,
  omitted: FieldOmission[],
  budget: number,
  o: CompactOptions,
): { record: Record<string, unknown>; omitted: FieldOmission[] } {
  const rec = { ...record };
  let om = [...omitted];
  const size = () => JSON.stringify(rec).length + JSON.stringify(om).length;
  const sysId = String(rec.sys_id ?? '');
  while (size() > budget) {
    const largest = Object.keys(rec)
      .filter((k) => k !== 'sys_id')
      .sort((a, b) => JSON.stringify(rec[b]).length - JSON.stringify(rec[a]).length)[0];
    if (!largest) break;
    const total = om.find((x) => x.field === largest)?.total_chars ?? textLength(rec[largest]);
    delete rec[largest];
    om = om.filter((x) => x.field !== largest);
    om.push({
      kind: 'field',
      reason: 'response_budget',
      sys_id: sysId,
      field: largest,
      shown_chars: 0,
      total_chars: total,
      next: fieldNext(o, sysId, largest),
    });
  }
  return { record: rec, omitted: om };
}

/** Classic UI link for a record (opened by the user, never fetched by the connector). */
export function recordLink(host: string, table: string, sysId: string): string {
  return `https://${host}/nav_to.do?uri=${encodeURIComponent(`${table}.do?sys_id=${sysId}`)}`;
}
