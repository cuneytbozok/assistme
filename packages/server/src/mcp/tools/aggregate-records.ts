/**
 * aggregate_records (T-028): counts, distributions and min/max/avg/sum through the Stats API, the
 * efficient alternative to pulling rows. All groups are returned, largest first; when they don't
 * fit one result, a cursor continues. The Stats API has no paging, so each continuation asks again
 * and takes up where it left off in the same stable order (count, then group values).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import {
  FieldPathSchema,
  MAX_AGGREGATES,
  MAX_GROUP_BY_FIELDS,
  MAX_RAW_QUERY_LENGTH,
} from '@sn-mcp/shared';
import { z } from 'zod';
import { planQuery } from '../query-guard.js';
import { dataResponse } from '../response.js';
import { toolError } from '../results.js';
import {
  AnyOfInput,
  CursorInput,
  InstanceInput,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  TableInput,
  UNTRUSTED_NOTE,
  WhereInput,
} from './common.js';
import type { ToolContext } from './context.js';
import {
  beginTool,
  isToolError,
  maxCharsInput,
  moreOmission,
  RESPONSE_OVERHEAD_CHARS,
} from './support.js';

const AggregateInput = z.strictObject({
  fn: z.enum(['avg', 'min', 'max', 'sum']),
  field: FieldPathSchema,
});

const StateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.literal('aggregate_records'),
  instance: z.string().max(32),
  table: z.string().max(80),
  query: z.string().max(4000),
  groupBy: z.array(z.string().max(200)).max(MAX_GROUP_BY_FIELDS),
  aggregates: z.array(AggregateInput).max(MAX_AGGREGATES),
  offset: z.int().min(0),
});

const num = (v: unknown): unknown => {
  if (typeof v !== 'string' || v.trim() === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

interface StatsRow {
  stats?: Record<string, unknown>;
  groupby_fields?: { field?: string; value?: unknown; display_value?: unknown }[];
}

/** `{count: "3", avg: {f: "2"}}` → `{count: 3, avg: {f: 2}}`. */
function shapeStats(stats: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stats ?? {})) {
    out[k] =
      v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([f, x]) => [f, num(x)]))
        : num(v);
  }
  return out;
}

function shapeGroup(row: StatsRow): Record<string, unknown> & { count: number; key: string } {
  const group: Record<string, unknown> = {};
  for (const g of row.groupby_fields ?? []) {
    const raw = g.value ?? '';
    group[String(g.field)] =
      g.display_value !== undefined && g.display_value !== '' && g.display_value !== raw
        ? { v: raw, d: g.display_value }
        : raw;
  }
  const stats = shapeStats(row.stats);
  return {
    group,
    ...stats,
    count: typeof stats.count === 'number' ? stats.count : 0,
    key: JSON.stringify(group),
  };
}

export function registerAggregateRecords(server: McpServer, ctx: ToolContext): void {
  const { config, meta, metadataError } = ctx;
  server.registerTool(
    'aggregate_records',
    {
      description:
        'Counts and summarizes without reading rows (Stats API): prefer it to query_records for "how many", distributions and averages. Filters as in query_records (`where`, `any_of` or `encoded_query`). Without `group_by`, returns `data.count` and the aggregates; with `group_by` (1–2 fields), `data.group_count` and `data.groups`, largest first, every group reachable by cursor. `aggregates`: up to 4 {fn: avg|min|max|sum, field}. Continue with `cursor`.',
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: InstanceInput,
        table: TableInput.optional(),
        where: WhereInput.optional(),
        any_of: AnyOfInput.optional(),
        encoded_query: z
          .string()
          .min(1)
          .max(MAX_RAW_QUERY_LENGTH)
          .optional()
          .describe('Raw ServiceNow encoded query, as in query_records; not with where or any_of'),
        group_by: z
          .array(FieldPathSchema)
          .min(1)
          .max(MAX_GROUP_BY_FIELDS)
          .optional()
          .describe('Fields to group by, e.g. ["state"]'),
        aggregates: z
          .array(AggregateInput)
          .min(1)
          .max(MAX_AGGREGATES)
          .optional()
          .describe('e.g. [{"fn": "avg", "field": "reassignment_count"}]'),
        cursor: CursorInput,
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const start = beginTool(ctx, args, { tool: 'aggregate_records', schema: StateSchema });
      if (isToolError(start)) return start;
      const { id, hints, maxChars, instance, sn, mc, state } = start;
      if (
        state &&
        (args.table ||
          args.where ||
          args.any_of ||
          args.encoded_query ||
          args.group_by ||
          args.aggregates)
      ) {
        return toolError('INVALID_INPUT', 'Pass only scope_id and cursor to continue.');
      }
      const table = state?.table ?? args.table;
      if (table === undefined) {
        return toolError('INVALID_INPUT', 'table is required (or pass a cursor).');
      }
      let query = state?.query ?? '';
      const groupBy = state?.groupBy ?? args.group_by ?? [];
      const aggregates = state?.aggregates ?? args.aggregates ?? [];
      if (!state) {
        try {
          const plan = await planQuery(
            meta,
            mc,
            {
              table,
              ...(args.where ? { where: args.where } : {}),
              ...(args.any_of ? { any_of: args.any_of } : {}),
              ...(args.encoded_query !== undefined ? { encoded_query: args.encoded_query } : {}),
              fields: [...groupBy, ...aggregates.map((a) => a.field)],
            },
            {
              highVolumeTables: config.highVolumeTables,
              extraDeniedTables: config.extraDeniedTables,
              aggregate: true,
            },
          );
          query = plan.query;
          hints.push(...plan.hints); // with `aggregate`, only query rewrites and warnings
        } catch (e) {
          return metadataError(e, id);
        }
      }
      const r = await sn.stats({
        table,
        ...(query ? { query } : {}),
        groupBy,
        aggregates,
        displayValue: 'all',
      });
      if (!r.ok) return sn.fail(r);
      const source = `stats ${table}`;

      if (groupBy.length === 0) {
        const stats = shapeStats((r.body as StatsRow | null)?.stats);
        return dataResponse({
          provenance: sn.provenance(source),
          data: { table, ...stats },
          hints,
          untrusted: UNTRUSTED_NOTE,
          requestsUsed: sn.requests,
        });
      }

      const rows = Array.isArray(r.body) ? (r.body as StatsRow[]) : [];
      const groups = rows
        .map(shapeGroup)
        .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const offset = state?.offset ?? 0;
      let budget = maxChars - RESPONSE_OVERHEAD_CHARS;
      const out: Record<string, unknown>[] = [];
      let i = offset;
      for (; i < groups.length; i++) {
        const { key: _key, ...entry } = groups[i] as (typeof groups)[number];
        const cost = JSON.stringify(entry).length + 1;
        if (cost > budget && out.length > 0) break;
        budget -= cost;
        out.push(entry);
      }
      const cursor =
        i < groups.length
          ? ctx.cursors.encodeState(StateSchema, {
              v: 1,
              tool: 'aggregate_records',
              instance,
              table,
              query,
              groupBy,
              aggregates,
              offset: i,
            })
          : undefined;
      return dataResponse({
        provenance: sn.provenance(source),
        data: { table, group_by: groupBy, group_count: groups.length, groups: out },
        ...(cursor
          ? {
              omitted: [
                {
                  ...moreOmission(
                    'aggregate_records',
                    id,
                    cursor,
                    'response_budget',
                    'More groups exist; this result reached its size budget.',
                  ),
                  kind: 'groups',
                },
              ],
            }
          : {}),
        page: {
          returned: out.length,
          returned_total: i,
          ...(cursor ? { next_cursor: cursor } : {}),
          total: groups.length,
        },
        hints,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: sn.requests,
      });
    },
  );
}
