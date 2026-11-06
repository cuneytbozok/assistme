/**
 * query_records (T-023/T-024): the primary general-purpose read tool.
 *
 * Inputs: structured filters (`where` / `any_of`) or a raw `encoded_query` (exclusive), `text`
 * (server-added text search), `order_by`, `fields` (list or ["*"]), `display_value`, `limit`
 * (default 20, no maximum), `include_total`, `max_chars`, or a `cursor` alone to continue.
 * Validation and defaults: query-guard (T-018). Paging and completeness: paginate/response (T-023).
 */
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  type ErrorCode,
  FieldPathSchema,
  isDeniedTable,
  MAX_FIELDS,
  MAX_RAW_QUERY_LENGTH,
} from '@sn-mcp/shared';
import { z } from 'zod';
import {
  compactRecord,
  compactValue,
  defaultProjection,
  fitRecord,
  recordLink,
  stripSensitive,
} from '../compact.js';
import type { CursorState } from '../cursor.js';
import { mapBridgeError } from '../errors.js';
import {
  buildFilterCheck,
  FILTER_NOT_APPLIED_HINT,
  FILTER_NOT_APPLIED_MESSAGE,
} from '../filter-check.js';
import { type PageResult, type PaginateResult, paginate, type Row } from '../paginate.js';
import { emptyResultHints } from '../query-diagnostics.js';
import { planQuery } from '../query-guard.js';
import { listResponse } from '../response.js';
import { provenance, toolError } from '../results.js';
import {
  AnyOfInput,
  CountInput,
  CursorInput,
  InstanceInput,
  type Ok,
  OrderByInput,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  TableInput,
  UNTRUSTED_NOTE,
  WhereInput,
} from './common.js';
import type { ToolContext } from './context.js';
import {
  maxCharsInput,
  RESPONSE_OVERHEAD_CHARS,
  resolveMaxChars,
  withTiebreak,
} from './support.js';

const DEFAULT_LIMIT = 20;
const LARGE_TYPES = new Set([
  'html',
  'translated_html',
  'script',
  'script_plain',
  'script_server',
  'xml',
  'json',
  'css',
  'journal',
  'journal_input',
  'journal_list',
  'conditions',
  'email_script',
  'wiki_text',
]);

/** Fields likely to be large (left out when a single record exceeds the size cap). */
function isLargeField(f: { type: string; maxLength?: number } | undefined): boolean {
  if (!f) return false;
  return LARGE_TYPES.has(f.type) || (f.maxLength ?? 0) > 4000;
}

export function registerQueryRecords(server: McpServer, ctx: ToolContext): void {
  const { bridge, scopes, cursors, config, meta, metaContext, metadataError, call, requireScope } =
    ctx;
  server.registerTool(
    'query_records',
    {
      description:
        'Reads records from a table (`data.records`). Filter with `where` (preferred), `any_of`, or a raw `encoded_query`; prefer a short `fields` list, and use aggregate_records to count. `where` is an AND list of {field, op, value} or {or: [conditions]}. field: the column name (lowercase, not the label; dot-walk references with ".", e.g. caller_id.name). value by op: = != > >= < <= contains not_contains starts_with ends_with take one stored value: a choice value (state 2, not "In Progress"), a sys_id for a reference, true/false; in / not_in take a list (no ","); between takes [low, high], inclusive, date-times as "YYYY-MM-DD HH:MM:SS"; within_last / older_than take {amount, unit}, relative to now; is_empty / is_not_empty take none. Every field is checked against the dictionary first; an unknown one gives INVALID_FIELD with suggestions. `limit` defaults to 20, with no maximum: continue with {scope_id, cursor} while page.next_cursor is set; `complete` is true only when nothing was left out. Read `hints`: they explain query rewrites and why nothing matched. On logs and other busy tables, start with a short time window (sys_created_on within_last).',
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
          .describe(
            'Raw ServiceNow encoded query, e.g. active=true^priority<=2^ORDERBYDESCsys_created_on. A query copied from a list (with ^EQ) works. javascript: values are refused; the error suggests a native rewrite. Not with where, any_of, text or order_by.',
          ),
        text: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('Keyword search over the text index (matches whole words); combine with where'),
        order_by: OrderByInput.optional(),
        display_value: z
          .enum(['all', 'true', 'false'])
          .optional()
          .describe('false (default): stored values; true: display values; all: both'),
        fields: z
          .array(z.string())
          .min(1)
          .max(49)
          .superRefine((f, ctx) => {
            const all = f.length === 1 && f[0] === '*';
            if (!all && !f.every((x) => FieldPathSchema.safeParse(x).success)) {
              ctx.addIssue({ code: 'custom', message: 'field names, or ["*"] for all fields' });
            }
          })
          .optional()
          .describe(
            'Column names to return (up to 49; sys_id is always added), or ["*"] for every field. Default: a short projection (number, name, short_description, …).',
          ),
        limit: CountInput.optional().describe('Rows wanted in total (default 20, no maximum)'),
        include_total: z
          .boolean()
          .optional()
          .describe('Also count all matching rows (page.total); costs a count'),
        cursor: CursorInput,
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const id = requireScope(args.scope_id);
      if (typeof id !== 'string') return id;
      const hints: string[] = [];
      const maxChars = resolveMaxChars(args.max_chars, config, hints);

      // 1. Where are we: a fresh query, or a continuation from a cursor.
      let state: CursorState;
      if (args.cursor !== undefined) {
        try {
          state = cursors.decode(args.cursor);
        } catch (e) {
          return toolError(
            'INVALID_INPUT',
            (e as Error).message,
            'Run the query again without a cursor.',
          );
        }
        if (state.tool !== 'query_records') {
          return toolError(
            'INVALID_INPUT',
            `This cursor belongs to ${state.tool}, not query_records.`,
          );
        }
        const conflict =
          (args.table !== undefined && args.table !== state.table) ||
          (args.fields !== undefined &&
            JSON.stringify(args.fields[0] === '*' ? '*' : args.fields) !==
              JSON.stringify(state.fields)) ||
          args.include_total !== undefined ||
          args.where !== undefined ||
          args.any_of !== undefined ||
          args.encoded_query !== undefined ||
          args.text !== undefined ||
          args.order_by !== undefined ||
          args.display_value !== undefined;
        if (conflict) {
          return toolError(
            'INVALID_INPUT',
            'This cursor belongs to a different query. Pass only scope_id and cursor (optionally limit or max_chars) to continue, or start a new query without a cursor.',
          );
        }
        if (args.instance !== undefined && args.instance !== state.instance) {
          return toolError(
            'INVALID_INPUT',
            `This cursor is for instance "${state.instance}", not "${args.instance}".`,
          );
        }
      } else {
        if (args.table === undefined)
          return toolError('INVALID_INPUT', 'table is required (or pass a cursor).');
        state = {
          v: 1,
          tool: 'query_records',
          instance: '',
          table: args.table,
          query: '',
          fields: '*',
          displayValue: args.display_value ?? 'all',
          offset: 0,
          limit: args.limit ?? DEFAULT_LIMIT,
          seen: 0,
        };
      }
      const table = state.table;
      const target = scopes.resolveTarget(
        id,
        args.cursor !== undefined ? state.instance : args.instance,
      );
      if (!target.ok) {
        if (args.cursor !== undefined && target.code === 'INSTANCE_NOT_IN_SCOPE') {
          return toolError(
            'INVALID_INPUT',
            `This cursor is for instance "${state.instance}", which this scope doesn't cover.`,
            target.hint,
          );
        }
        return toolError(target.code, target.message, target.hint);
      }
      if (args.cursor === undefined) state.instance = target.instance;
      const limit = args.limit ?? state.limit;

      // 2. Credential tables are refused before any request (T-020).
      if (isDeniedTable(table, config.extraDeniedTables)) {
        return toolError(
          'TABLE_DENIED',
          `The table ${table} may contain credentials and is blocked.`,
        );
      }
      // 3. Dictionary: validate the query and fields before reading data (T-018).
      const ctx = metaContext(id, target.instance);
      let known: Awaited<ReturnType<typeof meta.fields>>;
      try {
        known = await meta.fields(ctx, table);
        if (args.cursor === undefined) {
          const wantsAll = args.fields?.[0] === '*';
          const explicit = args.fields as string[] | undefined;
          const projection = wantsAll
            ? undefined
            : explicit
              ? [...new Set(['sys_id', ...explicit])] // sys_id is needed for links and next calls
              : defaultProjection(known);
          const plan = await planQuery(
            meta,
            ctx,
            {
              table,
              ...(args.where ? { where: args.where } : {}),
              ...(args.any_of ? { any_of: args.any_of } : {}),
              ...(args.encoded_query !== undefined ? { encoded_query: args.encoded_query } : {}),
              ...(args.text !== undefined ? { text: args.text } : {}),
              ...(args.order_by ? { order_by: args.order_by } : {}),
              ...(projection ? { fields: projection } : {}),
              include_total: args.include_total === true,
            },
            {
              highVolumeTables: config.highVolumeTables,
              extraDeniedTables: config.extraDeniedTables,
              allowTextSearch: true,
            },
          );
          hints.push(...plan.hints);
          state.fields = projection ?? '*';
          state.query = withTiebreak(plan.query);
          state.limit = limit;
        }
      } catch (e) {
        return metadataError(e, id);
      }

      // 4. Read pages within the response budget.
      const host = bridge.cachedRegistry?.instances.find((i) => i.alias === target.instance)?.host;
      const shapeOpts = { table, scopeId: id, previewChars: config.fieldPreviewChars };
      const sensitiveSeen = new Set<string>();
      let resultHost = host;
      let resultEnv: string | undefined;
      const countFirst = args.cursor === undefined && args.include_total === true;
      // Rows that contradict the filter mean ServiceNow ignored a condition: never pass them on.
      const check =
        state.displayValue === 'true'
          ? { fields: [] as string[], contradiction: () => undefined }
          : buildFilterCheck(state.query, known, state.fields === '*' ? undefined : state.fields);
      const extras = new Set(check.fields);
      const fetchPage = async (
        offset: number,
        n: number,
        fieldsOverride?: string[],
        withCount = false,
      ): Promise<PageResult> => {
        const fields =
          fieldsOverride ?? (state.fields === '*' ? undefined : [...state.fields, ...check.fields]);
        const r = await call(
          'sn.op',
          {
            kind: 'sn.op',
            scopeId: id,
            instance: target.instance,
            op: {
              kind: 'table.list',
              table,
              ...(state.query ? { query: state.query } : {}),
              ...(fields ? { fields } : {}),
              limit: n,
              offset,
              displayValue: state.displayValue,
              noCount: !(withCount || (countFirst && offset === state.offset)),
            },
          },
          id,
        );
        if (!r.ok) {
          const body = r.error.structuredContent as {
            error?: { code?: ErrorCode; message?: string; hint?: string };
          };
          return {
            ok: false,
            code: (body?.error?.code ?? 'SN_API_ERROR') as ErrorCode,
            message: body?.error?.message ?? 'Request failed.',
            ...(body?.error?.hint ? { hint: body.error.hint } : {}),
          };
        }
        const res = r.value.result as Extract<Ok<'sn.op'>['result'], { type: 'sn.op' }>;
        resultHost = res.host;
        resultEnv = res.env;
        const rows = Array.isArray(res.body) ? (res.body as Row[]) : [];
        for (const row of rows) {
          const field = check.contradiction(row);
          if (field !== undefined) {
            return {
              ok: false,
              code: 'FILTER_NOT_APPLIED',
              message: FILTER_NOT_APPLIED_MESSAGE(table, field),
              hint: FILTER_NOT_APPLIED_HINT,
            };
          }
        }
        return {
          ok: true,
          rows,
          ...(res.totalCount !== undefined ? { total: res.totalCount } : {}),
        };
      };
      const result = await paginate({
        fetch: (offset, n, withCount) => fetchPage(offset, n, undefined, withCount === true),
        offset: state.offset,
        ...(state.skip ? { skip: state.skip } : {}),
        ...(state.recent ? { recent: state.recent.match(/.{10}/g) ?? [] } : {}),
        // A hash of the whole id: real sys_ids often share long prefixes or suffixes, so a slice of one
        // would make different rows look the same and drop them.
        rowId: (raw) =>
          createHash('sha256')
            .update(String(compactValue(raw.sys_id) ?? ''))
            .digest('hex')
            .slice(0, 10),
        limit,
        pageSize: config.pageSize,
        budgetChars: maxChars - RESPONSE_OVERHEAD_CHARS,
        shape: (raw) => {
          const {
            records: [clean],
            stripped,
          } = stripSensitive([raw], known);
          for (const f of stripped) sensitiveSeen.add(f);
          // Fields read only for the check weren't asked for.
          const shown = Object.fromEntries(
            Object.entries(clean as Row).filter(([k]) => !extras.has(k)),
          );
          const shaped = compactRecord(shown, shapeOpts);
          const sysId = String(shaped.record.sys_id ?? '');
          return {
            ...shaped,
            ...(resultHost && sysId ? { link: recordLink(resultHost, table, sysId) } : {}),
          };
        },
        fit: (record, omitted, budget) => fitRecord(record, omitted, budget, shapeOpts),
        onOversized: async (offset) => {
          // One record over the extension's size cap: read it without its large fields.
          const all = state.fields === '*' ? [...known.keys()] : state.fields;
          const notLarge = all.filter((f) => !isLargeField(known.get(f.split('.')[0] as string)));
          // One request carries at most 50 fields; any others are reported like the large ones.
          const smaller = [...new Set(['sys_id', ...notLarge])].slice(0, MAX_FIELDS);
          const large = all.filter((f) => !smaller.includes(f));
          const r = await fetchPage(offset, 1, smaller);
          if (!r.ok) return r;
          const sysId = String(compactValue(r.rows[0]?.sys_id) ?? '');
          return {
            ...r,
            omitted: large.map((f) => ({
              kind: 'field' as const,
              reason: 'too_large' as const,
              sys_id: sysId,
              field: f,
              shown_chars: 0,
              total_chars: null,
              next: {
                tool: 'get_field_content',
                args: { scope_id: id, table, sys_id: sysId, field: f },
              },
            })),
          };
        },
      });
      if ('error' in result && !('records' in result)) {
        return mapBridgeError(result.error.code, result.error.message, result.error.hint, {
          scopes,
          scopeId: id,
        });
      }
      const page = result as PaginateResult;
      if (page.adapted)
        hints.push(`Large records: the upstream page size was reduced to ${page.pageSize}.`);
      if (page.repeats > 0) {
        hints.push(
          `This table changed while being read: ${page.repeats} row(s) moved back into this page and were left out, because you already have them. Rows added since the first page may not appear, and a long read of a busy table isn't reliable: use a short time window or a filter from the issue.`,
        );
      }
      if (page.error) hints.push(`Stopped early: ${page.error.code} — ${page.error.message}`);
      if (args.cursor === undefined && page.records.length === 0 && !page.hasMore && !page.error) {
        hints.push(...(await emptyResultHints(meta, ctx, table, state.query, known)));
      }
      const nextState: CursorState = {
        ...state,
        offset: page.nextOffset,
        ...(page.nextSkip > 0 ? { skip: page.nextSkip } : { skip: 0 }),
        ...(page.recent.length > 0 ? { recent: page.recent.join('') } : {}),
        limit,
        seen: state.seen + page.records.length,
      };
      if (page.total !== undefined && !page.hasMore && nextState.seen < page.total) {
        hints.push(
          `ServiceNow counted ${page.total} matching rows; ${nextState.seen} were readable. The difference is rows the signed-in user's ACLs hide (the count includes them).`,
        );
      }
      const nextCursor = page.hasMore ? cursors.encode(nextState) : undefined;
      return listResponse({
        provenance: provenance({
          instance: target.instance,
          ...(resultEnv ? { env: resultEnv } : {}),
          ...(resultHost ? { host: resultHost } : {}),
          scopeId: id,
          source: `table ${table}`,
        }),
        records: page.records,
        fieldOmissions: page.omitted,
        extraOmissions:
          sensitiveSeen.size > 0
            ? [
                {
                  kind: 'fields',
                  reason: 'sensitive',
                  fields: [...sensitiveSeen].sort(),
                  note: 'Credential fields are never returned by this connector.',
                },
              ]
            : [],
        hasMore: page.hasMore,
        stop: page.stop,
        ...(nextCursor
          ? {
              nextCursor,
              nextCall: { tool: 'query_records', args: { scope_id: id, cursor: nextCursor } },
            }
          : {}),
        ...(page.total !== undefined ? { total: page.total } : {}),
        returnedTotal: nextState.seen,
        hints,
        links: page.links,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: page.requests,
      });
    },
  );
}
