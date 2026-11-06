/**
 * describe_table (T-026): a table's fields from the dictionary hierarchy (metadata service):
 * type, label, reference target, and where an inherited field is defined. Compact, cached per
 * instance, and paged by cursor when it doesn't fit one result.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { isDeniedTable, PASSWORD_INTERNAL_TYPES } from '@sn-mcp/shared';
import { z } from 'zod';
import { dataResponse } from '../response.js';
import { toolError } from '../results.js';
import {
  CursorInput,
  InstanceInput,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  TableInput,
  UNTRUSTED_NOTE,
} from './common.js';
import type { ToolContext } from './context.js';
import {
  beginTool,
  isToolError,
  maxCharsInput,
  moreOmission,
  RESPONSE_OVERHEAD_CHARS,
} from './support.js';

const StateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.literal('describe_table'),
  instance: z.string().max(32),
  table: z.string().max(80),
  inherited: z.boolean(),
  choices: z.boolean(),
  offset: z.int().min(0),
});

export function registerDescribeTable(server: McpServer, ctx: ToolContext): void {
  const { config, meta, metadataError } = ctx;
  server.registerTool(
    'describe_table',
    {
      description:
        "Lists a table's fields from the dictionary (`data.fields`): `name` (use it in filters), `type`, `label`, `reference` target, `mandatory`, `inherited_from`, `sensitive`; plus the parent `chain` (e.g. incident extends task). `include_choices` adds each choice field's values and labels: filters compare values. An unknown table gives NOT_FOUND with suggestions. Continue with `cursor`.",
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: InstanceInput,
        table: TableInput.optional(),
        include_inherited: z
          .boolean()
          .optional()
          .describe('Include fields from parent tables (default true)'),
        include_choices: z.boolean().optional().describe('Add choice values and labels'),
        cursor: CursorInput,
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const start = beginTool(ctx, args, { tool: 'describe_table', schema: StateSchema });
      if (isToolError(start)) return start;
      const { id, hints, maxChars, instance, sn, mc, state } = start;
      if (
        state &&
        (args.table !== undefined ||
          args.include_inherited !== undefined ||
          args.include_choices !== undefined)
      ) {
        return toolError('INVALID_INPUT', 'Pass only scope_id and cursor to continue.');
      }
      const table = state?.table ?? args.table;
      if (table === undefined) {
        return toolError('INVALID_INPUT', 'table is required (or pass a cursor).');
      }
      const inherited = state?.inherited ?? args.include_inherited ?? true;
      const withChoices = state?.choices ?? args.include_choices ?? false;
      const offset = state?.offset ?? 0;
      if (isDeniedTable(table, config.extraDeniedTables)) {
        return toolError(
          'TABLE_DENIED',
          `The table ${table} may contain credentials and is blocked.`,
        );
      }
      let info: Awaited<ReturnType<typeof meta.table>>;
      let known: Awaited<ReturnType<typeof meta.fields>>;
      let choices: Awaited<ReturnType<typeof meta.allChoices>> | undefined;
      try {
        info = await meta.table(mc, table);
        known = await meta.fields(mc, table);
        if (withChoices) choices = await meta.allChoices(mc, table);
      } catch (e) {
        return metadataError(e, id);
      }
      const all = [...known.values()]
        .filter((f) => inherited || f.definedOn === table)
        .sort((a, b) => a.name.localeCompare(b.name));
      let budget = maxChars - RESPONSE_OVERHEAD_CHARS;
      const fields: Record<string, unknown>[] = [];
      let i = offset;
      for (; i < all.length; i++) {
        const f = all[i] as (typeof all)[number];
        const fieldChoices = choices?.get(f.name);
        const entry = {
          name: f.name,
          type: f.type,
          label: f.label,
          ...(f.reference ? { reference: f.reference } : {}),
          ...(f.maxLength !== undefined ? { max_length: f.maxLength } : {}),
          ...(f.mandatory ? { mandatory: true } : {}),
          ...(f.display ? { display: true } : {}),
          ...(f.definedOn !== table ? { inherited_from: f.definedOn } : {}),
          ...(PASSWORD_INTERNAL_TYPES.includes(f.type) ? { sensitive: true } : {}),
          ...(fieldChoices?.length
            ? { choices: fieldChoices.map((c) => ({ value: c.value, label: c.label })) }
            : {}),
        };
        const cost = JSON.stringify(entry).length + 1;
        if (cost > budget && fields.length > 0) break;
        budget -= cost;
        fields.push(entry);
      }
      const cursor =
        i < all.length
          ? ctx.cursors.encodeState(StateSchema, {
              v: 1,
              tool: 'describe_table',
              instance,
              table,
              inherited,
              choices: withChoices,
              offset: i,
            })
          : undefined;
      if (all.some((f) => PASSWORD_INTERNAL_TYPES.includes(f.type))) {
        hints.push('Fields marked sensitive hold credentials: their values are never returned.');
      }
      return dataResponse({
        provenance: sn.provenance(`dictionary of ${table}`),
        data: {
          table: info.name,
          label: info.label,
          chain: info.chain,
          field_count: all.length,
          fields,
        },
        ...(cursor
          ? {
              omitted: [
                moreOmission(
                  'describe_table',
                  id,
                  cursor,
                  'response_budget',
                  'More fields exist; this result reached its size budget.',
                ),
              ],
            }
          : {}),
        page: {
          returned: fields.length,
          returned_total: i,
          ...(cursor ? { next_cursor: cursor } : {}),
          total: all.length,
        },
        hints,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: sn.requests,
      });
    },
  );
}
