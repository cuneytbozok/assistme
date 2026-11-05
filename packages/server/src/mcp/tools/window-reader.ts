/**
 * Reads rows of one query in a stable order, resumable at an exact row even when ACLs hide some.
 *
 * ServiceNow removes hidden rows from a window after windowing, so counting returned rows can't
 * give the upstream offset. A position is therefore a window start plus how many *readable* rows
 * of that window were already used. Resuming re-reads the window and skips them: no row is lost
 * or repeated, as long as the data doesn't change. The total count, which includes hidden rows,
 * decides where the query ends.
 */
import { z } from 'zod';
import type { Row } from '../paginate.js';
import type { SnFailure } from './support.js';

export const ReaderPositionSchema = z.strictObject({
  offset: z.int().min(0),
  skip: z.int().min(0),
});
export type ReaderPosition = z.infer<typeof ReaderPositionSchema>;

export type WindowFetch = (
  offset: number,
  limit: number,
) => Promise<{ ok: true; rows: Row[]; total?: number } | SnFailure>;

export class WindowReader {
  private offset: number;
  private skip: number;
  private buf: Row[] = [];
  private used = 0;
  private loaded = false;
  private ended = false;
  total: number | undefined;
  failure: SnFailure | undefined;

  constructor(
    private readonly fetch: WindowFetch,
    start: ReaderPosition,
    private size: number,
  ) {
    this.offset = start.offset;
    this.skip = start.skip;
  }

  /** The next row without using it; undefined at the end or on a failure (see `failure`). */
  async peek(): Promise<Row | undefined> {
    while (this.buf.length === 0 && !this.ended && !this.failure) {
      if (this.loaded) {
        this.offset += this.size;
        this.skip = 0;
        this.used = 0;
        this.loaded = false;
        if (this.total !== undefined && this.offset >= this.total) {
          this.ended = true;
          break;
        }
      }
      const r = await this.fetch(this.offset, this.size);
      if (!r.ok) {
        this.failure = r;
        break;
      }
      this.total = r.total ?? this.total;
      this.loaded = true;
      this.used = this.skip;
      this.buf = r.rows.slice(this.skip);
      if (this.total === undefined && r.rows.length < this.size) this.ended = this.buf.length === 0;
    }
    return this.buf[0];
  }

  take(): Row | undefined {
    const row = this.buf.shift();
    if (row) this.used++;
    return row;
  }

  /** Where to resume so the next row returned is the next unused one. */
  position(): ReaderPosition {
    if (!this.loaded) return { offset: this.offset, skip: this.skip };
    if (this.buf.length === 0) return { offset: this.offset + this.size, skip: 0 };
    return { offset: this.offset, skip: this.used };
  }
}
