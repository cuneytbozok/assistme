/**
 * MCP server settings (ARCHITECTURE §6.4, §8.3). Read once from the environment (or the .mcpb
 * user_config, which arrives as env vars). Invalid values fall back to the default; nothing
 * here can widen authorization, it only shapes responses.
 */
import { MAX_PAGE_SIZE, parseTablePatterns, SERVER_DEFAULTS } from '@sn-mcp/shared';

/** Tables where unordered reads default to newest-first and get selectivity hints. */
export const DEFAULT_HIGH_VOLUME_TABLES = [
  'syslog*',
  'sys_audit',
  'sys_journal_field',
  'ecc_queue',
  'sys_email',
  'sys_history_line',
  'discovery_device_history',
  'sys_poll',
  '*_log',
] as const;

/**
 * Long enough for GitMCP's measured slow case (open a session, 11 s, plus a 37 s search), and under
 * the 60-second default of the MCP SDK and of clients that keep it, so the model gets our clear
 * answer rather than a client timeout. Claude Code's default is far longer, and a user can raise it.
 */
export const DEFAULT_DOCS_TIMEOUT_S = 55;

export interface ServerConfig {
  responseChars: number;
  maxResponseChars: number;
  pageSize: number;
  fieldPreviewChars: number;
  /** Default line window of get_field_content (no hard maximum). */
  fieldChunkLines: number;
  /** In-process cache for chunked field reads (never persisted). */
  fieldCacheBytes: number;
  fieldCacheTtlMs: number;
  highVolumeTables: readonly string[];
  /** Extra denied table patterns (SN_MCP_DENIED_TABLES); added to the shared defaults. */
  extraDeniedTables: readonly string[];
  /** docs_search and docs_read (SN_MCP_DOCS, ADR-019). Off unless turned on. */
  docsEnabled: boolean;
  /** Time limit for one docs_search or docs_read call (SN_MCP_DOCS_TIMEOUT_S). */
  docsTimeoutMs: number;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const PATTERN_RE = /^\*?[a-z0-9_]+\*?$/;

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const hv = env.SN_MCP_HIGH_VOLUME_TABLES;
  const patterns =
    hv === undefined
      ? [...DEFAULT_HIGH_VOLUME_TABLES]
      : hv
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .filter((p) => PATTERN_RE.test(p));
  const maxResponseChars = int(
    env.SN_MCP_MAX_RESPONSE_CHARS,
    SERVER_DEFAULTS.maxResponseChars,
    2_000,
    1_000_000,
  );
  return {
    responseChars: Math.min(
      int(env.SN_MCP_RESPONSE_CHARS, SERVER_DEFAULTS.responseChars, 1_000, 1_000_000),
      maxResponseChars,
    ),
    maxResponseChars,
    pageSize: int(env.SN_MCP_PAGE_SIZE, SERVER_DEFAULTS.pageSize, 1, MAX_PAGE_SIZE),
    fieldPreviewChars: int(
      env.SN_MCP_FIELD_PREVIEW_CHARS,
      SERVER_DEFAULTS.fieldPreviewChars,
      50,
      100_000,
    ),
    fieldChunkLines: SERVER_DEFAULTS.fieldChunkLines,
    fieldCacheBytes:
      int(env.SN_MCP_FIELD_CACHE_MB, SERVER_DEFAULTS.fieldCacheBytes / (1024 * 1024), 1, 4096) *
      1024 *
      1024,
    fieldCacheTtlMs:
      int(env.SN_MCP_FIELD_CACHE_TTL_S, SERVER_DEFAULTS.fieldCacheTtlMs / 1000, 1, 86_400) * 1000,
    highVolumeTables: patterns,
    extraDeniedTables: parseTablePatterns(env.SN_MCP_DENIED_TABLES),
    docsEnabled: ['1', 'true'].includes(env.SN_MCP_DOCS?.trim().toLowerCase() ?? ''),
    docsTimeoutMs: int(env.SN_MCP_DOCS_TIMEOUT_S, DEFAULT_DOCS_TIMEOUT_S, 5, 600) * 1000,
  };
}

/** `syslog*` matches syslog and syslog_transaction; `*_log` matches sys_rest_log, etc. */
export function isHighVolume(table: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    const start = p.startsWith('*');
    const end = p.endsWith('*');
    const core = p.replace(/^\*|\*$/g, '');
    if (start && end) return table.includes(core);
    if (start) return table.endsWith(core);
    if (end) return table.startsWith(core);
    return table === core;
  });
}
