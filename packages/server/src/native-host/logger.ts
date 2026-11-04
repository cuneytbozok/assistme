/**
 * Metadata-only logging (ARCHITECTURE §4.6).
 *
 * The type admits only a fixed set of primitive fields, so a message body, header, cookie or
 * token cannot be passed in. Files are 0600 and rotated at 1 MB (one backup).
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  renameSync,
  statSync,
} from 'node:fs';

export interface LogMeta {
  kind?: string;
  client?: string; // first 8 hex chars of client_key_id
  clientName?: string; // display label, truncated
  bytes?: number;
  durationMs?: number;
  inFlight?: number;
  clients?: number;
  status?: number;
  code?: string;
  reason?: string;
}

export interface Logger {
  log(event: string, meta?: LogMeta): void;
}

const ALLOWED_KEYS = new Set<keyof LogMeta>([
  'kind',
  'client',
  'clientName',
  'bytes',
  'durationMs',
  'inFlight',
  'clients',
  'status',
  'code',
  'reason',
]);

export function formatLogLine(event: string, meta: LogMeta = {}, now = new Date()): string {
  const safe: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!ALLOWED_KEYS.has(k as keyof LogMeta)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) safe[k] = v;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
    else if (typeof v === 'string') safe[k] = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
  }
  return `${JSON.stringify({ at: now.toISOString(), event: event.slice(0, 40), ...safe })}\n`;
}

export class FileLogger implements Logger {
  constructor(
    private readonly path: string,
    private readonly maxBytes = 1024 * 1024,
  ) {
    if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  }

  log(event: string, meta?: LogMeta): void {
    try {
      if (statSync(this.path).size > this.maxBytes) {
        renameSync(this.path, `${this.path}.1`);
        closeSync(openSync(this.path, 'a', 0o600));
      }
      appendFileSync(this.path, formatLogLine(event, meta), { mode: 0o600 });
    } catch {
      // logging must never break the broker
    }
  }
}

export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  log(event: string, meta?: LogMeta): void {
    this.lines.push(formatLogLine(event, meta));
  }
}
