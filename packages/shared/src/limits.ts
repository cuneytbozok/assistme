/**
 * Shared numeric limits and policy constants (docs/ARCHITECTURE.md §5.4, §6, §8).
 * Enforced on both sides: MCP server (friendly errors) and extension (authoritative).
 */

export const PROTOCOL_VERSION = 1 as const;

// --- query / result limits ---
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const PROD_MAX_LIMIT = 50;
export const UNBOUNDED_QUERY_MAX_LIMIT = 20;
export const ALL_FIELDS_MAX_LIMIT = 10;
export const MAX_OFFSET = 2000;
export const MAX_FIELDS = 50;
export const MAX_DOT_WALK_DEPTH = 3;
export const MAX_ENCODED_QUERY_LENGTH = 2048;
export const MAX_QUERY_TERMS = 20;
export const MAX_NQ_GROUPS = 3;
export const MAX_GROUP_BY_FIELDS = 2;
export const MAX_AGGREGATES = 4;
export const LONG_FIELD_TRUNCATE_CHARS = 1000;
export const RESPONSE_BUDGET_CHARS = 24_000;

// --- bridge / transport ---
export const MAX_UPSTREAM_MESSAGE_BYTES = 256 * 1024;
export const MAX_RAW_RESPONSE_BYTES = 5 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const AUTH_TIMEOUT_MS = 2_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;

// --- scope requests / grants ---
export const MAX_PURPOSE_LENGTH = 200;
export const SCOPE_REQUEST_TTL_SECONDS = 300;
/** Unambiguous alphabet (no I, L, O, U, 0, 1). */
export const APPROVAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const APPROVAL_CODE_LENGTH = 6;

export const GRANT_TTL_MINUTES = {
  dev: { default: 240, max: 720 },
  test: { default: 240, max: 720 },
  prod: { default: 15, max: 60 },
  unclassified: { default: 15, max: 60 },
} as const;

export const SCOPE_BUDGETS = {
  standard: { requestsPerMinute: 60, concurrency: 4, maxLimit: MAX_LIMIT },
  prod: { requestsPerMinute: 20, concurrency: 2, maxLimit: PROD_MAX_LIMIT },
} as const;
