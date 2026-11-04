/**
 * The list response envelope (T-023, ARCHITECTURE §8.3). Completeness is mandatory: a result is
 * `complete: true`, or it says exactly what is missing and gives the call that gets it.
 */
import type { FieldOmission, NextCall } from './compact.js';
import type { StopReason } from './paginate.js';
import { ok, type Provenance } from './results.js';

export interface RowsOmission {
  kind: 'rows';
  reason: Exclude<StopReason, 'end'>;
  note: string;
  next: NextCall;
}

export type Omission =
  | FieldOmission
  | RowsOmission
  | { kind: string; reason: string; [k: string]: unknown };

const ROW_NOTES: Record<RowsOmission['reason'], string> = {
  limit: 'More rows exist beyond the requested limit.',
  response_budget:
    'More rows exist; this result reached its size budget. Continue with the cursor (or raise max_chars).',
  error:
    'Reading stopped on an error after the rows shown. Continue with the cursor to retry from here.',
};

export function listResponse(r: {
  provenance: Provenance;
  records: unknown[];
  fieldOmissions: FieldOmission[];
  extraOmissions?: Omission[];
  hasMore: boolean;
  stop: StopReason;
  nextCall?: NextCall;
  nextCursor?: string;
  total?: number;
  returnedTotal: number;
  hints?: string[];
  links?: string[];
  untrusted: string;
  requestsUsed: number;
}) {
  const rows: RowsOmission[] =
    r.hasMore && r.nextCall && r.stop !== 'end'
      ? [{ kind: 'rows', reason: r.stop, note: ROW_NOTES[r.stop], next: r.nextCall }]
      : [];
  const omitted: Omission[] = [...rows, ...r.fieldOmissions, ...(r.extraOmissions ?? [])];
  const complete = !r.hasMore && omitted.length === 0;
  return ok({
    provenance: r.provenance,
    data: { records: r.records },
    untrusted_content: r.untrusted,
    complete,
    page: {
      returned: r.records.length,
      returned_total: r.returnedTotal,
      has_more: r.hasMore,
      next_cursor: r.hasMore ? (r.nextCursor ?? null) : null,
      total: r.total ?? null,
    },
    ...(omitted.length > 0 ? { omitted } : {}),
    ...(r.hints && r.hints.length > 0 ? { hints: r.hints } : {}),
    ...(r.links && r.links.length > 0 ? { links: r.links } : {}),
    requests_used: r.requestsUsed,
  });
}
