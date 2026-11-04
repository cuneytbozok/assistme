/**
 * Sensitive data protection (T-020, SECURITY S-5). Shared by the extension (enforcement) and the
 * MCP server (mirror + dictionary-aware stripping). Lists here are the minimum: configuration
 * can only add patterns, never remove these.
 */

/** Tables that hold credential material. `*` is a wildcard at the start and/or end. */
export const DEFAULT_DENIED_TABLES: readonly string[] = [
  'discovery_credentials*',
  'sys_auth_profile*',
  'oauth_entity*',
  'oauth_credential*',
  'oauth_requestor_profile',
  'sys_certificate*',
  'sys_user_token',
  'sys_credentials*',
  'sys_alias*',
  'basic_auth_credentials',
  'ssh_credentials',
  'ssh_private_key_credentials',
  'api_key_credentials',
  'jdbc_credentials',
  'cloud_credentials',
  'sys_user_password',
  'user_password_history',
  'sys_password*',
  'key_management*',
  'sys_kmf*',
  'sys_encryption*',
  'sn_cmp_cloud_credentials',
  'sys_ws_credentials',
  'sys_hub_connection_*',
];

/** sys_dictionary internal types whose values are secrets. */
export const PASSWORD_INTERNAL_TYPES: readonly string[] = [
  'password',
  'password2',
  'encrypted_password',
  'masked',
];

/**
 * Name-based fallback (when the dictionary isn't consulted, e.g. in the extension): a field path
 * segment that looks like a credential.
 */
export const SENSITIVE_FIELD_NAME_RE =
  /^(?:.*_)?(?:password\d?|passwd|pwd|secret|client_secret|private_key|privatekey|api_key|apikey|access_token|refresh_token|auth_token|bearer_token|credential|credentials|passphrase)$/;

export const TABLE_PATTERN_RE = /^\*?[a-z0-9_]+\*?$/;

export function matchesTablePattern(table: string, pattern: string): boolean {
  const start = pattern.startsWith('*');
  const end = pattern.endsWith('*');
  const core = pattern.replace(/^\*|\*$/g, '');
  if (start && end) return table.includes(core);
  if (start) return table.endsWith(core);
  if (end) return table.startsWith(core);
  return table === core;
}

export function isDeniedTable(table: string, extra: readonly string[] = []): boolean {
  return [...DEFAULT_DENIED_TABLES, ...extra].some((p) => matchesTablePattern(table, p));
}

/** True if any segment of a (dot-walked) field path looks like a credential field. */
export function isSensitiveFieldName(path: string): boolean {
  return path.split('.').some((seg) => SENSITIVE_FIELD_NAME_RE.test(seg));
}

/** Parses a comma-separated pattern list; invalid entries are dropped. */
export function parseTablePatterns(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => TABLE_PATTERN_RE.test(p));
}
