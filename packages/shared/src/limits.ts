/**
 * Shared limits, defaults and policy constants (docs/ARCHITECTURE.md §5.4, §6, §8; ADR-011).
 *
 * ADR-011: nothing here caps the total amount Claude can investigate. Constants are either
 * validation bounds on a single query/request, per-request reliability safeguards (defaults that
 * the user can change), or response-shaping defaults that always come with a continuation.
 */

export const PROTOCOL_VERSION = 1 as const;

// --- single-query validation bounds (size of one query, not amount of data) ---
/** Rows returned by a tool when `limit` is omitted. `limit` itself has no maximum. */
export const DEFAULT_LIMIT = 20;
/** Max rows in one upstream HTTP request (wire bound). Tools paginate automatically beyond it. */
export const MAX_PAGE_SIZE = 1000;
export const MAX_FIELDS = 50;
export const MAX_DOT_WALK_DEPTH = 3;
export const MAX_ENCODED_QUERY_LENGTH = 2048;
export const MAX_QUERY_TERMS = 20;
export const MAX_NQ_GROUPS = 3;
export const MAX_GROUP_BY_FIELDS = 2;
export const MAX_AGGREGATES = 4;

// --- MCP server response shaping (defaults; configurable via env / .mcpb user_config) ---
export const SERVER_DEFAULTS = {
  /** Size of one tool result. More data → continuation, never a silent drop. */
  responseChars: 24_000,
  /** Ceiling for the per-call `max_chars` argument. */
  maxResponseChars: 100_000,
  /** Rows per upstream request during automatic pagination (≤ MAX_PAGE_SIZE). */
  pageSize: 100,
  /** Preview length of long fields in record lists (full text via get_field_content). */
  fieldPreviewChars: 1_000,
  /** Default line window for get_field_content (no hard maximum). */
  fieldChunkLines: 400,
  /** In-process cache for chunked field reads (never persisted). */
  fieldCacheBytes: 64 * 1024 * 1024,
  fieldCacheTtlMs: 10 * 60_000,
  metadataCacheTtlMs: 15 * 60_000,
} as const;

// --- extension per-request safeguards (defaults + allowed ranges; user-set in the popup) ---
export const SAFEGUARD_DEFAULTS = {
  requestTimeoutMs: 30_000,
  maxResponseBytes: 10 * 1024 * 1024,
  maxConcurrentPerInstance: 4,
} as const;

export const SAFEGUARD_RANGES = {
  requestTimeoutMs: { min: 5_000, max: 300_000 },
  maxResponseBytes: { min: 1024 * 1024, max: 50 * 1024 * 1024 },
  maxConcurrentPerInstance: { min: 1, max: 16 },
} as const;

// --- bridge / transport ---
export const MAX_UPSTREAM_MESSAGE_BYTES = 256 * 1024;
/** Per-client in-flight maximum in the broker (protects against a misbehaving client). */
export const BROKER_MAX_IN_FLIGHT_PER_CLIENT = 64;
export const AUTH_TIMEOUT_MS = 2_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** No inbound message for this long → the extension drops the port and reconnects (T-014). */
export const HEARTBEAT_TIMEOUT_MS = 3 * HEARTBEAT_INTERVAL_MS;

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
