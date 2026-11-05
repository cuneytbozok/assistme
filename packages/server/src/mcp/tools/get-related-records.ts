/**
 * get_related_records (T-029): what points at this record? No hard-coded relationships: the
 * dictionary lists every field referencing the table or its ancestors. For each, a count through
 * the Stats API and a few sys_id samples. Every relation is covered, across cursor pages; each
 * call handles a batch so a single tool call stays short. No relation is dropped silently.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { compileFilter, type ErrorCode, isDeniedTable, isSensitiveFieldName } from '@sn-mcp/shared';
import { z } from 'zod';
import { compactValue } from '../compact.js';
import type { ReferencingField } from '../metadata.js';
import { dataResponse, type Omission } from '../response.js';
import { toolError } from '../results.js';
import {
  CursorInput,
  InstanceInput,
  lean,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  SysIdInput,
  TableInput,
  UNTRUSTED_NOTE,
} from './common.js';
import type { ToolContext } from './context.js';
import {
  beginTool,
  isFatal,
  isToolError,
  mapConcurrent,
  maxCharsInput,
  moreOmission,
  RESPONSE_OVERHEAD_CHARS,
  type SnFailure,
} from './support.js';

const DEFAULT_SAMPLES = 3;
const MAX_SAMPLES = 50;
const CONCURRENCY = 4;
/** Relations handled by one call, so it finishes well inside client tool timeouts. */
const RELATIONS_PER_CALL = 60;

const StateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.literal('get_related_records'),
  instance: z.string().max(32),
  table: z.string().max(80),
  sys_id: z.string().max(32),
  samples: z.int().min(0).max(MAX_SAMPLES),
  index: z.int().min(0),
  seen: z.int().min(0),
});

/** A list-type field holds several sys_ids, so it matches with "contains". */
const conditionFor = (r: ReferencingField, sysId: string) => ({
  field: r.field,
  op: r.type === 'glide_list' ? ('contains' as const) : ('=' as const),
  value: sysId,
});

type Outcome =
  | { kind: 'denied'; r: ReferencingField }
  | { kind: 'failed'; r: ReferencingField; failure: SnFailure }
  | {
      kind: 'counted';
      r: ReferencingField;
      count: number;
      samples: string[];
      samplesFailed?: ErrorCode;
    };

const REASONS: Partial<Record<ErrorCode, string>> = {
  ACL_DENIED: 'acl_denied',
  TIMEOUT: 'timeout',
  NOT_FOUND: 'not_found',
};

export function registerGetRelatedRecords(server: McpServer, ctx: ToolContext): void {
  const { config, meta, metadataError } = ctx;
  server.registerTool(
    'get_related_records',
    {
      description:
        'Finds what references a record, from the dictionary: every relation with a count, `samples` sys_ids (default 3) and a `list_all` call. Continue with `cursor`.',
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: InstanceInput,
        table: TableInput.optional(),
        sys_id: SysIdInput.optional(),
        samples: lean(z.int().min(0).max(MAX_SAMPLES), z.number()).optional(),
        cursor: CursorInput,
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const start = beginTool(ctx, args, { tool: 'get_related_records', schema: StateSchema });
      if (isToolError(start)) return start;
      const { id, hints, maxChars, instance, sn, mc, state } = start;
      if (state && (args.table || args.sys_id || args.samples !== undefined)) {
        return toolError('INVALID_INPUT', 'Pass only scope_id and cursor to continue.');
      }
      const table = state?.table ?? args.table;
      const sysId = state?.sys_id ?? args.sys_id;
      if (table === undefined || sysId === undefined) {
        return toolError('INVALID_INPUT', 'table and sys_id are required (or pass a cursor).');
      }
      const denied = config.extraDeniedTables;
      if (isDeniedTable(table, denied)) {
        return toolError(
          'TABLE_DENIED',
          `The table ${table} may contain credentials and is blocked.`,
        );
      }
      const sampleCount = state?.samples ?? args.samples ?? DEFAULT_SAMPLES;
      const index = state?.index ?? 0;

      let relations: ReferencingField[];
      try {
        relations = await meta.referencesTo(mc, table);
      } catch (e) {
        return metadataError(e, id);
      }
      if (!state) {
        // Counting references to a record that doesn't exist would just look like "no relations".
        const exists = await sn.get({ table, sysId, fields: ['sys_id'], displayValue: 'false' });
        if (!exists.ok) {
          if (exists.code === 'NOT_FOUND') {
            return toolError('NOT_FOUND', `No readable record ${sysId} in ${table}.`);
          }
          return sn.fail(exists);
        }
      }

      const batch = relations.slice(index, index + RELATIONS_PER_CALL);
      const listAll = (r: ReferencingField) => ({
        tool: 'query_records',
        args: {
          scope_id: id,
          table: r.table,
          where: [conditionFor(r, sysId)],
          include_total: true,
        },
      });
      const outcomes = await mapConcurrent(batch, CONCURRENCY, async (r): Promise<Outcome> => {
        if (isDeniedTable(r.table, denied) || isSensitiveFieldName(r.field)) {
          return { kind: 'denied', r };
        }
        const compiled = compileFilter({ where: [conditionFor(r, sysId)] });
        if (!compiled.ok) {
          return {
            kind: 'failed',
            r,
            failure: { ok: false, code: 'INVALID_INPUT', message: compiled.error.message },
          };
        }
        const query = compiled.value.query;
        const stats = await sn.stats({ table: r.table, query, displayValue: 'false' });
        if (!stats.ok) return { kind: 'failed', r, failure: stats };
        const raw = (stats.body as { stats?: { count?: unknown } } | null)?.stats?.count;
        const count = Number(raw ?? 0);
        if (count === 0 || sampleCount === 0) return { kind: 'counted', r, count, samples: [] };
        const rows = await sn.list({
          table: r.table,
          query: `${query}^ORDERBYsys_id`,
          fields: ['sys_id'],
          limit: sampleCount,
          offset: 0,
          displayValue: 'false',
        });
        if (!rows.ok) return { kind: 'counted', r, count, samples: [], samplesFailed: rows.code };
        return {
          kind: 'counted',
          r,
          count,
          samples: rows.rows.map((x) => String(compactValue(x.sys_id))),
        };
      });

      // A session or scope problem applies to everything that follows: stop and report it.
      const fatalAt = outcomes.findIndex((o) => o.kind === 'failed' && isFatal(o.failure.code));
      const fatal =
        fatalAt >= 0 ? (outcomes[fatalAt] as Extract<Outcome, { kind: 'failed' }>) : undefined;
      if (fatal && fatalAt === 0) return sn.fail(fatal.failure);
      const usable = fatal ? outcomes.slice(0, fatalAt) : outcomes;
      if (fatal) hints.push(`Stopped early: ${fatal.failure.code} — ${fatal.failure.message}`);

      let budget = maxChars - RESPONSE_OVERHEAD_CHARS;
      const out: Record<string, unknown>[] = [];
      const omitted: Omission[] = [];
      let handled = 0;
      for (const o of usable) {
        let entry: Record<string, unknown> | undefined;
        let omission: Omission | undefined;
        if (o.kind === 'denied') {
          omission = {
            kind: 'relation',
            reason: 'table_denied',
            table: o.r.table,
            field: o.r.field,
            note: 'This table or field may hold credentials and is blocked.',
          };
        } else if (o.kind === 'failed') {
          omission = {
            kind: 'relation',
            reason: REASONS[o.failure.code] ?? 'error',
            code: o.failure.code,
            table: o.r.table,
            field: o.r.field,
            next: listAll(o.r),
          };
        } else {
          entry = {
            table: o.r.table,
            field: o.r.field,
            count: o.count,
            ...(o.samples.length > 0 ? { samples: o.samples } : {}),
            ...(o.count > 0 ? { list_all: listAll(o.r) } : {}),
          };
          if (o.samplesFailed) {
            omission = {
              kind: 'relation',
              reason: 'samples_unavailable',
              code: o.samplesFailed,
              table: o.r.table,
              field: o.r.field,
              next: listAll(o.r),
            };
          }
        }
        const cost = JSON.stringify(entry ?? '').length + JSON.stringify(omission ?? '').length + 1;
        if (cost > budget && handled > 0) break;
        budget -= cost;
        if (entry) out.push(entry);
        if (omission) omitted.push(omission);
        handled++;
      }

      const nextIndex = index + handled;
      const seen = (state?.seen ?? 0) + out.length;
      const cursor =
        nextIndex < relations.length
          ? ctx.cursors.encodeState(StateSchema, {
              v: 1,
              tool: 'get_related_records',
              instance,
              table,
              sys_id: sysId,
              samples: sampleCount,
              index: nextIndex,
              seen,
            })
          : undefined;
      if (cursor) {
        omitted.unshift(
          moreOmission(
            'get_related_records',
            id,
            cursor,
            fatal ? 'error' : handled < batch.length ? 'response_budget' : 'batch',
            `${relations.length - nextIndex} of ${relations.length} relations remain. Follow next.`,
          ),
        );
      }
      return dataResponse({
        provenance: sn.provenance(`dictionary references to ${table}, stats per table`),
        data: {
          table,
          sys_id: sysId,
          relation_count: relations.length,
          relations: out,
        },
        omitted,
        page: {
          returned: out.length,
          returned_total: seen,
          ...(cursor ? { next_cursor: cursor } : {}),
          total: relations.length,
        },
        hints,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: sn.requests,
      });
    },
  );
}
