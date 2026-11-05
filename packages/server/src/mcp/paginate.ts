/**
 * Automatic upstream pagination within a response budget (T-023, ARCHITECTURE §8.3, ADR-011).
 *
 * - Pages of `pageSize` rows, asking one extra row to detect `has_more` (no count needed).
 * - Stops when `limit` rows are collected, the response budget is full, or the data ends.
 *   ServiceNow drops ACL-hidden rows from a window after windowing, so neither a short nor an
 *   empty page proves the end: after one, the total count (which includes hidden rows) decides
 *   whether to skip ahead. A small read costs at most one extra request for this.
 * - `RESPONSE_TOO_LARGE` from the extension → halve the page size and retry, down to 1 row.
 *   A single record still too large is handed to `onOversized` (refetch without its largest
 *   fields, each reported in `omitted`).
 * - An error after some rows were collected returns those rows plus a continuation; nothing
 *   is dropped silently. No total-row cap, no offset ceiling.
 */
import { type ErrorCode, MAX_PAGE_SIZE } from '@sn-mcp/shared';
import type { FieldOmission } from './compact.js';

export type Row = Record<string, unknown>;
export type PageResult =
  | { ok: true; rows: Row[]; total?: number }
  | { ok: false; code: ErrorCode; message: string; hint?: string };

export interface PaginateInput {
  /**
   * One upstream request: `limit` rows from `offset`, in the cursor's stable order. With
   * `withCount`, the result carries ServiceNow's total match count (which includes rows the
   * user's ACLs hide).
   */
  fetch: (offset: number, limit: number, withCount?: boolean) => Promise<PageResult>;
  offset: number;
  /** Readable rows of the window at `offset` already returned (a stop inside a short window). */
  skip?: number;
  /**
   * Rows returned most recently, by id. On a table being written to, a new row pushes older rows
   * down, so the next offset can hand back a row already returned: those are skipped.
   */
  recent?: readonly string[];
  /** A row's id, for `recent`. */
  rowId?: (raw: Row) => string;
  limit: number;
  pageSize: number;
  /** Characters available for records (and their omission entries and links). */
  budgetChars: number;
  /** Raw row → compacted record + its field omissions + an optional link. */
  shape: (raw: Row) => { record: Row; omitted: FieldOmission[]; link?: string };
  /** Shrinks one shaped record to `budget` characters (largest fields first). */
  fit: (
    record: Row,
    omitted: FieldOmission[],
    budget: number,
  ) => { record: Row; omitted: FieldOmission[] };
  /** A single record over the extension's size cap: refetch it without its largest fields. */
  onOversized?: (offset: number) => Promise<PageResult & { omitted?: FieldOmission[] }>;
}

export type StopReason = 'limit' | 'response_budget' | 'end' | 'error';

export interface PaginateResult {
  records: Row[];
  omitted: FieldOmission[];
  links: string[];
  nextOffset: number;
  /** With `nextOffset`: readable rows of that window to skip when continuing. */
  nextSkip: number;
  /** Ids to remember for the next call (the most recent MAX_RECENT_ROWS). */
  recent: string[];
  /** Rows skipped because they had already been returned. */
  repeats: number;
  hasMore: boolean;
  stop: StopReason;
  /** Upstream requests made for this response. */
  requests: number;
  /** Page size after adaptive halving (when it was reduced). */
  pageSize: number;
  adapted: boolean;
  total?: number;
  error?: { code: ErrorCode; message: string; hint?: string };
}

/** How many returned rows a cursor remembers. */
export const MAX_RECENT_ROWS = 50;

export async function paginate(
  p: PaginateInput,
): Promise<PaginateResult | { error: { code: ErrorCode; message: string; hint?: string } }> {
  const records: Row[] = [];
  const omitted: FieldOmission[] = [];
  const links: string[] = [];
  let offset = p.offset;
  let skip = p.skip ?? 0;
  let nextSkip = 0;
  const recent = [...(p.recent ?? [])];
  const seen = new Set(recent);
  let repeats = 0;
  let pageSize = Math.max(1, Math.min(p.pageSize, MAX_PAGE_SIZE));
  let budget = p.budgetChars;
  let requests = 0;
  let adapted = false;
  let total: number | undefined;

  const done = (
    stop: StopReason,
    hasMore: boolean,
    error?: PaginateResult['error'],
  ): PaginateResult => ({
    records,
    omitted,
    links,
    nextOffset: offset,
    nextSkip,
    recent: recent.slice(-MAX_RECENT_ROWS),
    repeats,
    hasMore,
    stop,
    requests,
    pageSize,
    adapted,
    ...(total !== undefined ? { total } : {}),
    ...(error ? { error } : {}),
  });

  /** Adds one shaped row if it fits; the first row is shrunk to fit instead of refused. */
  const accept = (raw: Row, extraOmitted: FieldOmission[] = []): boolean => {
    const shaped = p.shape(raw);
    let rec = shaped.record;
    let om = [...shaped.omitted, ...extraOmitted];
    const linkCost = shaped.link ? shaped.link.length + 3 : 0;
    let cost = JSON.stringify(rec).length + JSON.stringify(om).length + linkCost + 1;
    if (cost > budget) {
      if (records.length > 0) return false;
      const fitted = p.fit(rec, om, Math.max(200, budget - linkCost));
      rec = fitted.record;
      om = fitted.omitted;
      cost = JSON.stringify(rec).length + JSON.stringify(om).length + linkCost + 1;
    }
    records.push(rec);
    omitted.push(...om);
    if (shaped.link) links.push(shaped.link);
    budget -= cost;
    offset++;
    return true;
  };

  let noLookahead = false;
  // After a short page we can't tell "end of data" from "ACL-hidden rows": the next request
  // asks for the total count to decide.
  let needCount = false;
  while (records.length < p.limit) {
    const want = p.limit - records.length;
    const lookahead = !noLookahead && Math.min(pageSize, want) < MAX_PAGE_SIZE;
    const n = Math.min(pageSize, want) + (lookahead ? 1 : 0);
    requests++;
    const r = await p.fetch(offset, n, needCount);
    if (!r.ok) {
      if (r.code === 'RESPONSE_TOO_LARGE' && n > 1) {
        // Halve; at one row, drop the lookahead row before treating a record as oversized.
        if (pageSize > 1) pageSize = Math.max(1, Math.floor(Math.min(pageSize, n) / 2));
        else noLookahead = true;
        adapted = true;
        continue;
      }
      if (r.code === 'RESPONSE_TOO_LARGE' && p.onOversized) {
        requests++;
        const single = await p.onOversized(offset);
        if (single.ok && single.rows[0]) {
          adapted = true;
          if (!accept(single.rows[0], single.omitted ?? [])) return done('response_budget', true);
          continue;
        }
        const e = single.ok ? { code: r.code, message: r.message } : single;
        if (records.length === 0) {
          return {
            error: {
              code: e.code,
              message: e.message,
              ...('hint' in e && e.hint ? { hint: e.hint } : {}),
            },
          };
        }
        return done('error', true, { code: e.code, message: e.message });
      }
      const err = { code: r.code, message: r.message, ...(r.hint ? { hint: r.hint } : {}) };
      if (records.length === 0) return { error: err };
      return done('error', true, err);
    }
    if (total === undefined && r.total !== undefined && offset === p.offset) total = r.total;
    // A cursor can resume inside a window: its first readable rows were already returned.
    const usedBefore = skip;
    const rows = r.rows.slice(skip);
    skip = Math.max(0, skip - r.rows.length);
    noLookahead = false;
    if (r.rows.length === 0) {
      // Empty: the end, unless the count says matching rows exist further on (all hidden here).
      let count = r.total;
      if (count === undefined) {
        requests++;
        const c = await p.fetch(offset, 1, true);
        count = c.ok ? c.total : undefined;
      }
      if (count !== undefined && count > offset + n) {
        offset += n; // a window of only ACL-hidden rows: skip it
        needCount = true;
        continue;
      }
      return done('end', false);
    }
    const short = r.rows.length < n;
    // A full window has no hidden rows, so its positions are exact (data changed since the stop).
    if (!short) offset += Math.min(usedBefore, r.rows.length);
    const pageStart = offset;
    let taken = 0;
    /**
     * Hidden rows make a short window's positions unknowable, so a stop inside one resumes at the
     * window start and skips the readable rows already returned. No row is lost or repeated.
     */
    const stopInside = (stop: StopReason): PaginateResult => {
      if (short) {
        offset = pageStart;
        nextSkip = usedBefore + taken;
      }
      return done(stop, true);
    };
    for (const raw of rows) {
      if (records.length >= p.limit) break;
      const id = p.rowId?.(raw);
      if (id && seen.has(id)) {
        repeats++;
        offset++;
        taken++;
        continue;
      }
      if (!accept(raw)) return stopInside('response_budget');
      if (id) {
        seen.add(id);
        recent.push(id);
      }
      taken++;
    }
    // A short page may just have hidden rows (ServiceNow drops them after windowing), so the
    // whole window counts as read; the next request checks the count.
    if (short && taken === rows.length) offset = pageStart + n;
    needCount = short;
    if (records.length >= p.limit) {
      if (rows.length > taken) return stopInside('limit'); // rows of this page remain
      // Anything after this window? The count answers it (it includes hidden rows).
      requests++;
      const c = await p.fetch(offset, 1, true);
      if (c.ok && c.total !== undefined) return done('limit', c.total > offset);
      return done('limit', c.ok ? c.rows.length > 0 : true);
    }
  }
  return done('limit', false);
}
