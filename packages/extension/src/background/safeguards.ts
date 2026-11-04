/**
 * Per-instance concurrency limit with a FIFO queue (T-019, ARCHITECTURE §8.2).
 *
 * Requests beyond the limit wait their turn; they are never rejected while within the
 * timeout. Waiting longer than the timeout → TIMEOUT (the request was never sent). There is
 * no per-minute quota, no dedup and no fan-out cap (ADR-011).
 */
export interface Waiter {
  start: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();

  /** Current active and queued counts (diagnostics and tests). */
  stats(key: string): { active: number; queued: number } {
    return { active: this.active.get(key) ?? 0, queued: this.queues.get(key)?.length ?? 0 };
  }

  /**
   * Runs `fn` when a slot for `key` is free. Resolves to `onTimeout()` if no slot frees up within
   * `timeoutMs` (the function is then never called).
   */
  run<T>(
    key: string,
    limit: number,
    timeoutMs: number,
    fn: () => Promise<T>,
    onTimeout: () => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        this.active.set(key, (this.active.get(key) ?? 0) + 1);
        fn()
          .then(resolve, reject)
          .finally(() => this.release(key, limit));
      };
      if ((this.active.get(key) ?? 0) < limit) {
        go();
        return;
      }
      const waiter: Waiter = { start: go };
      waiter.timer = setTimeout(() => {
        const q = this.queues.get(key) ?? [];
        const i = q.indexOf(waiter);
        if (i >= 0) {
          q.splice(i, 1);
          resolve(onTimeout());
        }
      }, timeoutMs);
      const q = this.queues.get(key) ?? [];
      q.push(waiter);
      this.queues.set(key, q);
    });
  }

  private release(key: string, limit: number): void {
    this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
    const q = this.queues.get(key);
    while (q && q.length > 0 && (this.active.get(key) ?? 0) < limit) {
      const next = q.shift() as Waiter;
      clearTimeout(next.timer);
      next.start();
    }
  }
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date). */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number.parseInt(t, 10);
  const d = Date.parse(t);
  if (Number.isNaN(d)) return undefined;
  return Math.max(0, Math.ceil((d - now) / 1000));
}
