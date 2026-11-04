/**
 * Tool result envelopes (ARCHITECTURE §8.3). Results carry provenance; errors are
 * `isError: true` with `{code, message, hint}`. ServiceNow data sits under `data` and is
 * untrusted content.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_HINTS, type ErrorCode } from '@sn-mcp/shared';

export interface Provenance {
  instance?: string;
  env?: string;
  host?: string;
  scope?: string;
  retrieved_at: string;
  source: string;
}

export function scopeSuffix(scopeId: string): string {
  return `…${scopeId.slice(-4)}`;
}

export function ok(payload: Record<string, unknown> & { provenance: Provenance }): CallToolResult {
  const body = { ok: true, ...payload };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

export function toolError(code: ErrorCode, message: string, hint?: string): CallToolResult {
  const body = { ok: false, error: { code, message, hint: hint ?? DEFAULT_HINTS[code] } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}
