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

export function toolError(
  code: ErrorCode,
  message: string,
  hint?: string,
  extra?: Record<string, unknown>,
): CallToolResult {
  const body = { ok: false, error: { code, message, hint: hint ?? DEFAULT_HINTS[code], ...extra } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

/** Provenance for a result (FR-3.11): instance, env, host, scope suffix, retrieval time. */
export function provenance(p: {
  source: string;
  instance?: string;
  env?: string;
  host?: string;
  scopeId?: string;
}): Provenance {
  return {
    ...(p.instance ? { instance: p.instance } : {}),
    ...(p.env ? { env: p.env } : {}),
    ...(p.host ? { host: p.host } : {}),
    ...(p.scopeId ? { scope: scopeSuffix(p.scopeId) } : {}),
    retrieved_at: new Date().toISOString(),
    source: p.source,
  };
}
