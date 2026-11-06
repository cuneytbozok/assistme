/**
 * discover_tables (T-026): finds tables by name or label on any instance, custom u_/x_ tables
 * included, from sys_db_object. Nothing is hard-coded. Blocked credential tables stay listed and
 * are marked, so nothing disappears silently.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { compileFilter, isDeniedTable, MAX_PAGE_SIZE } from '@sn-mcp/shared';
import { z } from 'zod';
import { compactValue } from '../compact.js';
import { type PaginateResult, paginate } from '../paginate.js';
import { listResponse } from '../response.js';
import { toolError } from '../results.js';
import {
  CountInput,
  CursorInput,
  InstanceInput,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  UNTRUSTED_NOTE,
} from './common.js';
import type { ToolContext } from './context.js';
import { beginTool, isToolError, maxCharsInput, RESPONSE_OVERHEAD_CHARS } from './support.js';

const DEFAULT_LIMIT = 50;
const FIELDS = ['name', 'label', 'super_class.name'];

const StateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.literal('discover_tables'),
  instance: z.string().max(32),
  query: z.string().max(4000),
  offset: z.int().min(0),
  skip: z.int().min(0),
  limit: z.int().min(1),
  seen: z.int().min(0),
});

export function registerDiscoverTables(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    'discover_tables',
    {
      description:
        "Finds tables by words in their name or label, custom u_ and x_ tables included; without `search`, lists all tables. Returns `data.records` with `name`, `label`, `extends`; credential tables are listed but marked `blocked`. Then use describe_table for a table's fields. Continue with `cursor`.",
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: InstanceInput,
        search: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Words contained in the table name or label, e.g. "change" or "x_acme"'),
        limit: CountInput.optional().describe('Tables wanted (default 50)'),
        cursor: CursorInput,
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const start = beginTool(ctx, args, { tool: 'discover_tables', schema: StateSchema });
      if (isToolError(start)) return start;
      const { id, hints, maxChars, instance, sn, state } = start;
      if (state && args.search !== undefined) {
        return toolError('INVALID_INPUT', 'Pass only scope_id and cursor to continue.');
      }
      let query = state?.query;
      if (query === undefined) {
        const compiled = compileFilter({
          ...(args.search !== undefined
            ? {
                where: [
                  {
                    or: [
                      { field: 'name', op: 'contains' as const, value: args.search },
                      { field: 'label', op: 'contains' as const, value: args.search },
                    ],
                  },
                ],
              }
            : {}),
          order_by: [
            { field: 'name', direction: 'asc' },
            { field: 'sys_id', direction: 'asc' },
          ],
        });
        if (!compiled.ok) return toolError(compiled.error.code, compiled.error.message);
        query = compiled.value.query;
      }
      const limit = args.limit ?? state?.limit ?? DEFAULT_LIMIT;
      const q = query;
      const result = await paginate({
        fetch: async (offset, n, withCount) =>
          sn.list({
            table: 'sys_db_object',
            query: q,
            fields: FIELDS,
            limit: Math.min(n, MAX_PAGE_SIZE),
            offset,
            displayValue: 'false',
            count: withCount === true,
          }),
        offset: state?.offset ?? 0,
        skip: state?.skip ?? 0,
        limit,
        pageSize: config.pageSize,
        budgetChars: maxChars - RESPONSE_OVERHEAD_CHARS,
        shape: (raw) => {
          const name = String(compactValue(raw.name) ?? '');
          const parent = String(compactValue(raw['super_class.name']) ?? '');
          return {
            record: {
              name,
              label: compactValue(raw.label),
              ...(parent ? { extends: parent } : {}),
              ...(isDeniedTable(name, config.extraDeniedTables) ? { blocked: true } : {}),
            },
            omitted: [],
          };
        },
        fit: (record, omitted) => ({ record, omitted }),
      });
      if ('error' in result && !('records' in result))
        return sn.fail({ ok: false, ...result.error });
      const page = result as PaginateResult;
      if (page.error) hints.push(`Stopped early: ${page.error.code} — ${page.error.message}`);
      const seen = (state?.seen ?? 0) + page.records.length;
      const nextCursor = page.hasMore
        ? ctx.cursors.encodeState(StateSchema, {
            v: 1,
            tool: 'discover_tables',
            instance,
            query: q,
            offset: page.nextOffset,
            skip: page.nextSkip,
            limit,
            seen,
          })
        : undefined;
      if (page.records.some((r) => r.blocked)) {
        hints.push('Tables marked blocked may hold credentials: this connector never reads them.');
      }
      return listResponse({
        provenance: sn.provenance('table sys_db_object'),
        records: page.records,
        fieldOmissions: [],
        hasMore: page.hasMore,
        stop: page.stop,
        ...(nextCursor
          ? {
              nextCursor,
              nextCall: { tool: 'discover_tables', args: { scope_id: id, cursor: nextCursor } },
            }
          : {}),
        returnedTotal: seen,
        hints,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: sn.requests,
      });
    },
  );
}
