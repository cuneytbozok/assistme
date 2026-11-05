/**
 * discover_tables (T-026): finds tables by name or label on any instance, custom u_/x_ tables
 * included, from sys_db_object. Nothing is hard-coded. Blocked credential tables stay listed and
 * are marked, so nothing disappears silently.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { AliasSchema, compileFilter, isDeniedTable, MAX_PAGE_SIZE } from '@sn-mcp/shared';
import { z } from 'zod';
import { compactValue } from '../compact.js';
import { type PaginateResult, paginate } from '../paginate.js';
import { listResponse } from '../response.js';
import { toolError } from '../results.js';
import { READ_ONLY, ResultEnvelope, ScopeIdInput, UNTRUSTED_NOTE } from './common.js';
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
  limit: z.int().min(1),
  seen: z.int().min(0),
});

export function registerDiscoverTables(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    'discover_tables',
    {
      title: 'Find tables',
      description:
        'Finds tables by words in their name or label (custom u_ and x_ tables too). Omit `search` to walk all tables. Returns name, label and parent (`extends`), up to `limit` (default 50) with `page.next_cursor` when more exist; continue with {scope_id, cursor}. Use describe_table next to see a table’s fields.',
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: AliasSchema.optional().describe(
          'Instance alias; defaults to the scope’s instance (required for compare scopes)',
        ),
        search: z.string().min(1).max(100).optional().describe('Part of a table name or label'),
        limit: z.int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe('Tables wanted'),
        cursor: z.string().max(8000).optional().describe('page.next_cursor from a previous call'),
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
