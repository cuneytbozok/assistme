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
