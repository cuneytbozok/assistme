import { z } from 'zod';

/**
 * Error codes shared by every hop (extension → broker → MCP server → Claude).
 * Catalog with full descriptions: docs/TOOLS.md (T-033). Keep this list in sync with
 * docs/ARCHITECTURE.md §8.
 */
export const ERROR_CODES = [
  'SCOPE_REQUIRED',
  'SCOPE_UNKNOWN',
  'SCOPE_EXPIRED',
  'SCOPE_NOT_APPROVED',
  'REQUEST_DENIED',
  'INSTANCE_NOT_REGISTERED',
  'INSTANCE_NOT_IN_SCOPE',
  'BRIDGE_UNAVAILABLE',
  'BROKER_CONFLICT',
  'NO_INSTANCE_TAB',
  'SESSION_EXPIRED',
  'ACL_DENIED',
  'NOT_FOUND',
  'AMBIGUOUS_MATCH',
  'INVALID_INPUT',
  'INVALID_FIELD',
  'UNSAFE_QUERY',
  'QUERY_TOO_BROAD',
  'FORBIDDEN_OPERATION',
  'TABLE_DENIED',
  'BUDGET_EXCEEDED',
  'RESPONSE_TOO_LARGE',
  'TIMEOUT',
  'SN_API_ERROR',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Default, user-actionable hints. Tools may override with a more specific hint. */
export const DEFAULT_HINTS: Readonly<Record<ErrorCode, string>> = {
  SCOPE_REQUIRED:
    'Call request_scope for the instance, ask the user to approve the code in the extension, then claim_scope.',
  SCOPE_UNKNOWN:
    'The scope is not valid (revoked, browser restarted or server restarted). Request a new scope.',
  SCOPE_EXPIRED: 'The scope expired. Request a new scope; the user must approve it again.',
  SCOPE_NOT_APPROVED:
    'The request is still pending. Ask the user to approve the code in the extension popup, then claim again.',
  REQUEST_DENIED:
    'The user denied or let the request expire. Do not retry without asking the user.',
  INSTANCE_NOT_REGISTERED:
    'No instance with this alias is registered. Call list_instances; the user registers instances in the extension.',
  INSTANCE_NOT_IN_SCOPE: 'This scope does not cover that instance. Request a scope for it.',
  BRIDGE_UNAVAILABLE:
    'Cannot reach the Chrome extension. Check that Chrome is running and the extension is enabled.',
  BROKER_CONFLICT: 'The connector is active in another Chrome profile. Use one profile at a time.',
  NO_INSTANCE_TAB:
    'Open and log in to the instance in a Chrome tab (needed to use the existing session).',
  SESSION_EXPIRED:
    'The ServiceNow session expired. Ask the user to log in to that instance in Chrome.',
  ACL_DENIED: "The user's ServiceNow roles/ACLs do not allow reading this data.",
  NOT_FOUND: 'Nothing matched. Check the table name or identifiers (see suggestions if provided).',
  AMBIGUOUS_MATCH:
    'More than one record matched. Choose one of the candidates explicitly (e.g. by sys_id).',
  INVALID_INPUT: 'The input failed validation. Fix the reported fields and retry.',
  INVALID_FIELD: 'A field does not exist on the table. Use describe_table to see valid fields.',
  UNSAFE_QUERY: 'The query uses a disallowed operator or value. Use structured filters instead.',
  QUERY_TOO_BROAD:
    'Narrow the query: add a sys_created_on time window or a selective key condition, or lower the limit.',
  FORBIDDEN_OPERATION: 'This connector is read-only; the requested operation is not available.',
  TABLE_DENIED: 'This table is blocked because it may contain credentials or secrets.',
  BUDGET_EXCEEDED: 'Too many requests for this scope. Wait a moment and retry with fewer calls.',
  RESPONSE_TOO_LARGE: 'The response was too large. Request fewer fields or rows.',
  TIMEOUT: 'ServiceNow did not respond in time. Retry with a narrower query.',
  SN_API_ERROR: 'ServiceNow returned an error. See the message for details.',
};

export const ProtocolErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().max(1000),
  hint: z.string().max(500).optional(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export function protocolError(code: ErrorCode, message: string, hint?: string): ProtocolError {
  return { code, message, hint: hint ?? DEFAULT_HINTS[code] };
}
