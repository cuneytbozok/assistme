/**
 * Dev-only broker traffic capture (T-009), enabled with
 * `SN_MCP_CAPTURE=metadata+bodies-redacted` (set by `install-native-host --capture`).
 *
 * Each frame that crosses the broker after client authentication is written as one JSONL line
 * to `broker.capture.jsonl` (0600) with:
 *   - direction, kind, size;
 *   - `findings`: credential-pattern matches in the RAW frame (checked before redaction);
 *   - `hashes`: 16-hex SHA-256 prefixes of every long string in the RAW frame, so the check can
 *     prove a specific token value never appeared without the capture storing it;
 *   - `frame`: the message with ServiceNow record values and handshake proofs redacted.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, openSync } from 'node:fs';

export const CAPTURE_MODE = 'metadata+bodies-redacted';
export const CAPTURE_FILE = 'broker.capture.jsonl';

export type Direction = 'client>broker' | 'broker>ext' | 'ext>broker' | 'broker>client';

/** Names and markers of browser credentials that must never cross the bridge (AC3). */
export const FORBIDDEN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'Cookie', re: /cookie/i },
  { name: 'JSESSIONID', re: /jsessionid/i },
  { name: 'glide_', re: /glide_/i },
  { name: 'g_ck', re: /g_ck/i },
  { name: 'X-UserToken', re: /x-usertoken/i },
];

export function scanForCredentials(raw: string): string[] {
  return FORBIDDEN_PATTERNS.filter((p) => p.re.test(raw)).map((p) => p.name);
}

export function hashPrefix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Hashes of every string leaf of 16+ chars (token candidates). */
export function longStringHashes(message: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length >= 16) out.add(hashPrefix(v));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(message);
  return [...out];
}

/** Handshake material and access handles (bearer capabilities) are never stored. */
const SECRET_KEYS = new Set([
  'clientProof',
  'brokerProof',
  'clientNonce',
  'brokerNonce',
  'scopeId',
  'requestId',
]);

/** Deep copy with ServiceNow record values replaced by `<redacted:N chars>`. Keys are kept. */
export function redactFrame(message: unknown): unknown {
  const redactValues = (v: unknown): unknown => {
    if (typeof v === 'string') return `<redacted:${v.length} chars>`;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return '<redacted>';
    if (Array.isArray(v)) return v.map(redactValues);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValues(x)]));
    }
    return v;
  };
  const walk = (v: unknown, parentKey?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const isSnResult = o.type === 'sn.op' && 'body' in o;
      return Object.fromEntries(
        Object.entries(o).map(([k, x]) => {
          if (SECRET_KEYS.has(k)) return [k, '<redacted>'];
          if (isSnResult && k === 'body') return [k, redactValues(x)];
          if (parentKey === 'request' && k === 'purpose' && typeof x === 'string') {
            return [k, `<redacted:${x.length} chars>`];
          }
          return [k, walk(x, k)];
        }),
      );
    }
    return v;
  };
  return walk(message);
}

export class CaptureWriter {
  constructor(private readonly path: string) {
    if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  }

  record(dir: Direction, message: unknown): void {
    try {
      const raw = JSON.stringify(message);
      const m = message as {
        kind?: unknown;
        request?: { kind?: unknown };
        result?: { type?: unknown };
      };
      const line = {
        at: new Date().toISOString(),
        dir,
        kind: typeof m?.kind === 'string' ? m.kind : 'unknown',
        detail:
          typeof m?.request?.kind === 'string'
            ? m.request.kind
            : typeof m?.result?.type === 'string'
              ? m.result.type
              : undefined,
        bytes: Buffer.byteLength(raw),
        findings: scanForCredentials(raw),
        hashes: longStringHashes(message),
        frame: redactFrame(message),
      };
      appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // capture must never break the broker
    }
  }
}
