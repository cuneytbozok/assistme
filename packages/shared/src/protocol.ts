import { z } from 'zod';
import { ProtocolErrorSchema } from './errors.js';
import {
  MAX_AGGREGATES,
  MAX_ENCODED_QUERY_LENGTH,
  MAX_FIELDS,
  MAX_GROUP_BY_FIELDS,
  MAX_PAGE_SIZE,
  MAX_PURPOSE_LENGTH,
  PROTOCOL_VERSION,
} from './limits.js';
import {
  AliasSchema,
  ApprovalCodeSchema,
  EnvNameSchema,
  FieldPathSchema,
  Hex256Schema,
  HostSchema,
  MessageIdSchema,
  NO_CONTROL_CHARS_RE,
  NonceSchema,
  RequestIdSchema,
  ScopeIdSchema,
  SysIdSchema,
  TableNameSchema,
} from './validation.js';

/**
 * Bridge protocol (docs/ARCHITECTURE.md §2–§4, ADR-001, ADR-004).
 *
 * Hops:
 *   MCP server ──ClientToBroker──▶ broker ──BrokerToExtension──▶ extension
 *   MCP server ◀─BrokerToClient─── broker ◀─ExtensionToBroker─── extension
 *
 * Security invariants encoded here:
 * - Every object is strict: unknown properties are rejected at every hop.
 * - No schema has a field for URLs, HTTP methods, headers, cookies or tokens. ServiceNow
 *   operations are closed descriptors (`Operation`); only the extension builds URLs.
 * - Operation `query` strings are length/charset-checked here; full syntactic validation
 *   lives in the shared query module (T-003) and runs on both sides.
 */

const v = z.literal(PROTOCOL_VERSION);

// ---------------------------------------------------------------------------
// Operations (closed union — ADR-004)
// ---------------------------------------------------------------------------

/** Encoded query as compiled/validated by the query module. Never contains newlines/control chars. */
export const EncodedQuerySchema = z
  .string()
  .max(MAX_ENCODED_QUERY_LENGTH)
  .regex(NO_CONTROL_CHARS_RE, 'control characters are not allowed');

export const FieldListSchema = z.array(FieldPathSchema).min(1).max(MAX_FIELDS);
export const DisplayValueSchema = z.enum(['false', 'true', 'all']);

export const TableListOpSchema = z.strictObject({
  kind: z.literal('table.list'),
  table: TableNameSchema,
  query: EncodedQuerySchema.optional(),
  fields: FieldListSchema.optional(),
  /** Rows in this one HTTP request (the server paginates automatically; ADR-011). */
  limit: z.int().min(1).max(MAX_PAGE_SIZE),
  /** No ceiling: any record of a large table is reachable. */
  offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  displayValue: DisplayValueSchema,
  /** When false the extension requests X-Total-Count (opt-in, ADR-005). */
  noCount: z.boolean(),
});

export const TableGetOpSchema = z.strictObject({
  kind: z.literal('table.get'),
  table: TableNameSchema,
  sysId: SysIdSchema,
  fields: FieldListSchema.optional(),
  displayValue: DisplayValueSchema,
});

export const AggregateSchema = z.strictObject({
  fn: z.enum(['avg', 'min', 'max', 'sum']),
  field: FieldPathSchema,
});

export const StatsAggregateOpSchema = z.strictObject({
  kind: z.literal('stats.aggregate'),
  table: TableNameSchema,
  query: EncodedQuerySchema.optional(),
  groupBy: z.array(FieldPathSchema).min(1).max(MAX_GROUP_BY_FIELDS).optional(),
  aggregates: z.array(AggregateSchema).min(1).max(MAX_AGGREGATES).optional(),
  displayValue: DisplayValueSchema,
});

/** Cheap session check (`sys_db_object`, limit 1, `sys_id` only). */
export const ProbeOpSchema = z.strictObject({
  kind: z.literal('probe'),
});

export const OperationSchema = z.discriminatedUnion('kind', [
  TableListOpSchema,
  TableGetOpSchema,
  StatsAggregateOpSchema,
  ProbeOpSchema,
]);
export type Operation = z.infer<typeof OperationSchema>;
export type OperationKind = Operation['kind'];

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/**
 * `unclassified` is the "Other" environment in the UI. It always gets PROD rules; an optional
 * user-chosen `envName` (e.g. "UAT") is a display label only and never changes policy.
 */
export const EnvSchema = z.enum(['dev', 'test', 'prod', 'unclassified']);
export type Env = z.infer<typeof EnvSchema>;

export const ConnectionStateSchema = z.enum([
  'connected',
  'no_tab',
  'session_expired',
  'no_permission',
  'unknown',
]);

export const ScopeModeSchema = z.enum(['single', 'compare']);

/** Display-only label; never used as an identity (ARCHITECTURE §4.3). */
export const ClientLabelSchema = z.strictObject({
  name: z.string().max(64).regex(NO_CONTROL_CHARS_RE),
  pid: z.int().min(1),
  cwd: z.string().max(512).regex(NO_CONTROL_CHARS_RE).optional(),
});

/** Identity attached by the broker to every forwarded request. */
export const ClientContextSchema = z.strictObject({
  keyId: Hex256Schema,
  label: ClientLabelSchema,
});

export const InstanceInfoSchema = z.strictObject({
  alias: AliasSchema,
  label: z.string().max(64).regex(NO_CONTROL_CHARS_RE),
  host: HostSchema,
  env: EnvSchema,
  /** Only with env "unclassified" (Other): the user's name for it. Display only. */
  envName: EnvNameSchema.optional(),
  connection: ConnectionStateSchema,
});
export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;

/** Per-client view (registry.get only — never broadcast). Exposes no scope ids. */
export const ClientInstanceInfoSchema = InstanceInfoSchema.extend({
  thisClient: z.strictObject({
    pendingRequest: z.boolean(),
    activeGrant: z.boolean(),
  }),
});
export type ClientInstanceInfo = z.infer<typeof ClientInstanceInfoSchema>;

// ---------------------------------------------------------------------------
// Requests (MCP server → broker → extension)
// ---------------------------------------------------------------------------

export const SnOpRequestSchema = z.strictObject({
  v,
  kind: z.literal('sn.op'),
  id: MessageIdSchema,
  scopeId: ScopeIdSchema,
  /** Target instance alias; must be covered by the grant (compare grants cover two). */
  instance: AliasSchema,
  op: OperationSchema,
});

export const ScopeRequestSchema = z.strictObject({
  v,
  kind: z.literal('scope.request'),
  id: MessageIdSchema,
  instances: z.array(AliasSchema).min(1).max(2),
  mode: ScopeModeSchema,
  /** Untrusted free text, displayed as plain text in the popup. */
  purpose: z.string().min(1).max(MAX_PURPOSE_LENGTH).regex(NO_CONTROL_CHARS_RE),
});

export const ScopeClaimSchema = z.strictObject({
  v,
  kind: z.literal('scope.claim'),
  id: MessageIdSchema,
  requestId: RequestIdSchema,
});

export const ScopeReleaseSchema = z.strictObject({
  v,
  kind: z.literal('scope.release'),
  id: MessageIdSchema,
  scopeId: ScopeIdSchema,
});

/**
 * "Is this grant still valid for this instance?" No request reaches ServiceNow. The server asks
 * before answering from its in-process field cache, so the extension still decides every read
 * (T-027) and a revoked scope stops working at once, cached or not.
 */
export const ScopeCheckSchema = z.strictObject({
  v,
  kind: z.literal('scope.check'),
  id: MessageIdSchema,
  scopeId: ScopeIdSchema,
  instance: AliasSchema,
});

export const RegistryGetSchema = z.strictObject({
  v,
  kind: z.literal('registry.get'),
  id: MessageIdSchema,
});

export const RequestEnvelopeSchema = z.discriminatedUnion('kind', [
  SnOpRequestSchema,
  ScopeRequestSchema,
  ScopeClaimSchema,
  ScopeReleaseSchema,
  ScopeCheckSchema,
  RegistryGetSchema,
]);
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;
export type RequestKind = RequestEnvelope['kind'];

// ---------------------------------------------------------------------------
// Responses (extension → broker → MCP server)
// ---------------------------------------------------------------------------

export const SnOpResultSchema = z.strictObject({
  type: z.literal('sn.op'),
  instance: AliasSchema,
  host: HostSchema,
  env: EnvSchema,
  status: z.int().min(100).max(599),
  /** Parsed ServiceNow JSON body (`result` payload). Untrusted data. */
  body: z.unknown(),
  totalCount: z.int().min(0).optional(),
  bytes: z.int().min(0),
});

export const ScopeRequestResultSchema = z.strictObject({
  type: z.literal('scope.request'),
  requestId: RequestIdSchema,
  approvalCode: ApprovalCodeSchema,
  expiresInSeconds: z.int().min(1),
});

export const ScopeClaimResultSchema = z.strictObject({
  type: z.literal('scope.claim'),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'claimed']),
  /** Only when status === 'approved' (first and only successful claim). */
  scopeId: ScopeIdSchema.optional(),
  instances: z.array(AliasSchema).min(1).max(2).optional(),
  mode: ScopeModeSchema.optional(),
  expiresAt: z.iso.datetime().optional(),
});

export const ScopeReleaseResultSchema = z.strictObject({
  type: z.literal('scope.release'),
  released: z.boolean(),
});

export const ScopeCheckResultSchema = z.strictObject({
  type: z.literal('scope.check'),
  valid: z.literal(true),
});

export const RegistryResultSchema = z.strictObject({
  type: z.literal('registry.get'),
  instances: z.array(ClientInstanceInfoSchema).max(50),
});

export const ResultSchema = z.discriminatedUnion('type', [
  SnOpResultSchema,
  ScopeRequestResultSchema,
  ScopeClaimResultSchema,
  ScopeReleaseResultSchema,
  ScopeCheckResultSchema,
  RegistryResultSchema,
]);
export type Result = z.infer<typeof ResultSchema>;

export const ResponseOkSchema = z.strictObject({
  v,
  kind: z.literal('response'),
  id: MessageIdSchema,
  ok: z.literal(true),
  result: ResultSchema,
});

export const ResponseErrSchema = z.strictObject({
  v,
  kind: z.literal('response'),
  id: MessageIdSchema,
  ok: z.literal(false),
  error: ProtocolErrorSchema,
});

export const ResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  ResponseOkSchema,
  ResponseErrSchema,
]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------

export const PingSchema = z.strictObject({ v, kind: z.literal('ping'), id: MessageIdSchema });
export const PongSchema = z.strictObject({ v, kind: z.literal('pong'), id: MessageIdSchema });

/** Extension → broker → all clients when instances/connection states change. */
export const RegistryUpdateSchema = z.strictObject({
  v,
  kind: z.literal('registry.update'),
  instances: z.array(InstanceInfoSchema).max(50),
});

/** Broker → extension / clients: broker state (e.g. another profile owns the socket). */
export const BrokerStatusSchema = z.strictObject({
  v,
  kind: z.literal('broker.status'),
  state: z.enum(['ready', 'conflict', 'shutting_down']),
});

// --- client ↔ broker mutual authentication (ARCHITECTURE §4.3) ---

export const HelloSchema = z.strictObject({
  v,
  kind: z.literal('hello'),
  clientNonce: NonceSchema,
  /** SHA-256 of the per-process random client key; grants are bound to it. */
  clientKeyId: Hex256Schema,
  label: ClientLabelSchema,
});

export const ChallengeSchema = z.strictObject({
  v,
  kind: z.literal('challenge'),
  brokerNonce: NonceSchema,
  /** HMAC(key, clientNonce‖"broker"‖"sn-mcp/v1") — lets the client detect a fake broker. */
  brokerProof: Hex256Schema,
});

export const AuthSchema = z.strictObject({
  v,
  kind: z.literal('auth'),
  /** HMAC(key, brokerNonce‖clientNonce‖"client"‖"sn-mcp/v1"). */
  clientProof: Hex256Schema,
});

export const AuthOkSchema = z.strictObject({ v, kind: z.literal('auth_ok') });

/** Broker → extension: a client request with broker-rewritten id and client identity. */
export const ForwardSchema = z.strictObject({
  v,
  kind: z.literal('forward'),
  client: ClientContextSchema,
  request: RequestEnvelopeSchema,
});

// ---------------------------------------------------------------------------
// Per-direction unions (each hop parses only what it may receive)
// ---------------------------------------------------------------------------

/** MCP server → broker. Requests are only accepted after authentication. */
export const ClientToBrokerSchema = z.discriminatedUnion('kind', [
  HelloSchema,
  AuthSchema,
  PingSchema,
  SnOpRequestSchema,
  ScopeRequestSchema,
  ScopeClaimSchema,
  ScopeReleaseSchema,
  ScopeCheckSchema,
  RegistryGetSchema,
]);
export type ClientToBroker = z.infer<typeof ClientToBrokerSchema>;

/** Broker → MCP server. */
export const BrokerToClientSchema = z.union([
  ChallengeSchema,
  AuthOkSchema,
  PongSchema,
  RegistryUpdateSchema,
  BrokerStatusSchema,
  ResponseEnvelopeSchema,
]);
export type BrokerToClient = z.infer<typeof BrokerToClientSchema>;

/** Broker → extension. */
export const BrokerToExtensionSchema = z.discriminatedUnion('kind', [
  ForwardSchema,
  PingSchema,
  PongSchema,
  BrokerStatusSchema,
]);
export type BrokerToExtension = z.infer<typeof BrokerToExtensionSchema>;

/** Extension → broker. */
export const ExtensionToBrokerSchema = z.union([
  ResponseEnvelopeSchema,
  RegistryUpdateSchema,
  PingSchema,
  PongSchema,
]);
export type ExtensionToBroker = z.infer<typeof ExtensionToBrokerSchema>;

/** All schemas that cross a process boundary (used by the redaction audit test). */
export const ALL_WIRE_SCHEMAS = {
  ClientToBroker: ClientToBrokerSchema,
  BrokerToClient: BrokerToClientSchema,
  BrokerToExtension: BrokerToExtensionSchema,
  ExtensionToBroker: ExtensionToBrokerSchema,
} as const;
