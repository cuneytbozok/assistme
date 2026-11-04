/**
 * Maps bridge/extension errors to tool errors (T-012). Messages from the extension are fixed
 * strings built by our own code; hints tell Claude the next step. Scope errors also drop the
 * scope from the local store so later calls fail fast.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ErrorCode } from '@sn-mcp/shared';
import { toolError } from './results.js';
import type { ScopeStore } from './scope-store.js';

const SCOPE_HINTS: Partial<Record<ErrorCode, string>> = {
  SCOPE_UNKNOWN:
    'This scope is not valid (revoked, released, or from another session). Call request_scope; the user must approve again.',
  SCOPE_EXPIRED: 'Call request_scope again; the user must approve a new request.',
  INSTANCE_NOT_IN_SCOPE: 'Request a scope that covers this instance with request_scope.',
  INSTANCE_NOT_REGISTERED:
    'Call list_instances to see registered aliases (exact match). Only the user can register instances.',
  BRIDGE_UNAVAILABLE: 'Ask the user to open Chrome with the sn-mcp extension enabled, then retry.',
};

export function mapBridgeError(
  code: ErrorCode,
  message: string,
  hint: string | undefined,
  ctx: { scopes?: ScopeStore; scopeId?: string } = {},
): CallToolResult {
  if ((code === 'SCOPE_UNKNOWN' || code === 'SCOPE_EXPIRED') && ctx.scopes && ctx.scopeId) {
    ctx.scopes.forget(ctx.scopeId);
  }
  return toolError(code, message, hint ?? SCOPE_HINTS[code]);
}
