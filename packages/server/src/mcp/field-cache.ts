/**
 * In-process cache for chunked field reads (T-027, ADR-010/ADR-011): a large field is fetched
 * once, then served window by window. LRU by size, with a TTL. Held in memory only: nothing here
 * touches the disk, and it is gone when the process ends.
 *
 * Entries are keyed by scope, so another scope never sees them, and the caller asks the extension
 * (`scope.check`) before using a hit: the extension still decides every read.
 */
export interface CachedField {
  value: string;
  /** Start offset of each line in `value`. */
  lineStarts: number[];
}

/** Rough memory cost of a JavaScript string (UTF-16) plus its line index. */
const cost = (f: CachedField) => f.value.length * 2 + f.lineStarts.length * 8;

export function indexLines(value: string): CachedField {
  const lineStarts = [0];
  for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1);
  }
  return { value, lineStarts };
}

export class FieldCache {
  private readonly entries = new Map<
    string,
    { field: CachedField; expires: number; bytes: number }
  >();
  private bytes = 0;

  constructor(
    private readonly opts: { maxBytes: number; ttlMs: number },
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): CachedField | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // Most recently used goes last.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.field;
  }

  /** Returns false when the value alone is larger than the cache (it isn't stored). */
  set(key: string, field: CachedField): boolean {
    this.delete(key);
    const bytes = cost(field);
    if (bytes > this.opts.maxBytes) return false;
    while (this.bytes + bytes > this.opts.maxBytes) {
      const oldest = this.entries.keys().next().value as string;
      this.delete(oldest);
    }
    this.entries.set(key, { field, expires: this.now() + this.opts.ttlMs, bytes });
    this.bytes += bytes;
    return true;
  }

  delete(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.bytes -= e.bytes;
    this.entries.delete(key);
  }

  /** Drops everything held for a scope (it was revoked, released or expired). */
  forgetScope(scopeId: string): void {
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${scopeId}|`)) this.delete(k);
  }

  get size(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }
}
