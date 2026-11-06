/**
 * get_record_history (T-030): one record's full timeline, any age: field changes from sys_audit
 * and comments and work notes from sys_journal_field, merged by time. No default time window.
 * Internal conditions come only from structured filters. A source the user can't read is reported
 * in `omitted`; the other still works. Audit values of credential fields are never returned.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { isDeniedTable, type Where } from '@sn-mcp/shared';
import { z } from 'zod';
import { compactRecord, compactValue, type FieldOmission, isSensitiveField } from '../compact.js';
import { FILTER_NOT_APPLIED_HINT, FILTER_NOT_APPLIED_MESSAGE } from '../filter-check.js';
import { type FieldInfo, MetadataError } from '../metadata.js';
import type { Row } from '../paginate.js';
import { planQuery } from '../query-guard.js';
import { dataResponse, type Omission } from '../response.js';
import { toolError } from '../results.js';
import {
  CountInput,
  CursorInput,
  InstanceInput,
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
  isToolError,
  maxCharsInput,
  moreOmission,
  RESPONSE_OVERHEAD_CHARS,
} from './support.js';
import { ReaderPositionSchema, WindowReader } from './window-reader.js';

const DEFAULT_LIMIT = 50;
/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS` (ServiceNow's UTC format). */
const DateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/, 'use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS');

const SOURCES = {
  audit: {
    table: 'sys_audit',
    key: 'documentkey',
    fields: [
      'sys_id',
      'sys_created_on',
      'documentkey',
      'user',
      'fieldname',
      'oldvalue',
      'newvalue',
    ],
  },
  journal: {
    table: 'sys_journal_field',
    key: 'element_id',
    fields: ['sys_id', 'sys_created_on', 'element_id', 'sys_created_by', 'element', 'value'],
  },
} as const;
type SourceName = keyof typeof SOURCES;
const NAMES = Object.keys(SOURCES) as SourceName[];

const StateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.literal('get_record_history'),
  instance: z.string().max(32),
  table: z.string().max(80),
  sys_id: z.string().max(32),
  since: z.string().max(19).optional(),
  until: z.string().max(19).optional(),
  order: z.enum(['asc', 'desc']),
  limit: z.int().min(1),
  seen: z.int().min(0),
  audit: ReaderPositionSchema,
  journal: ReaderPositionSchema,
});

const text = (row: Row, f: string): string => String(compactValue(row[f]) ?? '');

export function registerGetRecordHistory(server: McpServer, ctx: ToolContext): void {
  const { config, meta, metadataError } = ctx;
  server.registerTool(
    'get_record_history',
    {
      description:
        "A record's full timeline of any age, from sys_audit and sys_journal_field merged by time, newest first: `data.timeline` with {at, user, field, old, new} for changes and {at, user, field, journal} for comments and work notes. Use it to see who changed what and when. Optional `since`/`until` (YYYY-MM-DD[ HH:MM:SS], UTC); there is no default window. A source you can't read is in `omitted`. Continue with `cursor`.",
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: InstanceInput,
        table: TableInput.optional(),
        sys_id: SysIdInput.optional(),
        since: DateInput.optional(),
        until: DateInput.optional(),
        order: z.enum(['asc', 'desc']).optional().describe('desc (default): newest first'),
        limit: CountInput.optional().describe('Default 50'),
        cursor: CursorInput,
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const start = beginTool(ctx, args, { tool: 'get_record_history', schema: StateSchema });
      if (isToolError(start)) return start;
      const { id, hints, maxChars, instance, sn, mc, state } = start;
      if (
        state &&
        (args.table || args.sys_id || args.since || args.until || args.order !== undefined)
      ) {
        return toolError(
          'INVALID_INPUT',
          'Pass only scope_id and cursor (optionally limit or max_chars) to continue.',
        );
      }
      const table = state?.table ?? args.table;
      const sysId = state?.sys_id ?? args.sys_id;
      if (table === undefined || sysId === undefined) {
        return toolError('INVALID_INPUT', 'table and sys_id are required (or pass a cursor).');
      }
      if (isDeniedTable(table, config.extraDeniedTables)) {
        return toolError(
          'TABLE_DENIED',
          `The table ${table} may contain credentials and is blocked.`,
        );
      }
      const since = state?.since ?? args.since;
      const until = state?.until ?? args.until;
      const order = state?.order ?? args.order ?? 'desc';
      const limit = args.limit ?? state?.limit ?? DEFAULT_LIMIT;

      let known: ReadonlyMap<string, FieldInfo>;
      try {
        known = await meta.fields(mc, table);
      } catch (e) {
        return metadataError(e, id);
      }

      // One query per source, validated like any other: an unknown field would return every row.
      const omitted: Omission[] = [];
      const readers = new Map<SourceName, WindowReader>();
      const windowSize = Math.max(1, Math.min(config.pageSize, limit));
      for (const name of NAMES) {
        const src = SOURCES[name];
        const internal: Where = [
          { field: src.key, op: '=', value: sysId },
          ...(since ? [{ field: 'sys_created_on', op: '>=' as const, value: since }] : []),
          ...(until ? [{ field: 'sys_created_on', op: '<=' as const, value: until }] : []),
        ];
        let query: string;
        try {
          const plan = await planQuery(
            meta,
            mc,
            {
              table: src.table,
              internal,
              order_by: [
                { field: 'sys_created_on', direction: order },
                { field: 'sys_id', direction: 'asc' },
              ],
              fields: [...src.fields],
            },
            { highVolumeTables: [], extraDeniedTables: config.extraDeniedTables },
          );
          query = plan.query;
        } catch (e) {
          if (e instanceof MetadataError && (e.code === 'ACL_DENIED' || e.code === 'NOT_FOUND')) {
            omitted.push({ kind: 'source', source: src.table, reason: 'acl_denied', code: e.code });
            continue;
          }
          return metadataError(e, id);
        }
        readers.set(
          name,
          new WindowReader(
            (offset, n) =>
              sn.list({
                table: src.table,
                query,
                fields: [...src.fields],
                limit: n,
                offset,
                displayValue: 'false',
                count: true,
              }),
            state?.[name] ?? { offset: 0, skip: 0 },
            windowSize,
          ),
        );
      }

      const dir = order === 'asc' ? 1 : -1;
      const before = (a: Row, b: Row): boolean => {
        const x = text(a, 'sys_created_on');
        const y = text(b, 'sys_created_on');
        if (x !== y) return (x < y ? -1 : 1) * dir < 0;
        return text(a, 'sys_id') < text(b, 'sys_id');
      };

      const timeline: Record<string, unknown>[] = [];
      const fieldOmissions: FieldOmission[] = [];
      const redacted = new Set<string>();
      const previewOpts = { scopeId: id, previewChars: config.fieldPreviewChars };
      let budget = maxChars - RESPONSE_OVERHEAD_CHARS;
      let stop: 'limit' | 'response_budget' | 'error' | undefined;
      const failed = new Set<SourceName>();

      /** Next row of each source; a denied source is dropped, any other failure stops the merge. */
      const heads = async (): Promise<{ a?: Row; j?: Row; blocked: boolean }> => {
        const out: { a?: Row; j?: Row; blocked: boolean } = { blocked: false };
        for (const name of NAMES) {
          const reader = readers.get(name);
          if (!reader) continue;
          const row = await reader.peek();
          if (reader.failure) {
            if (reader.failure.code === 'ACL_DENIED') {
              omitted.push({
                kind: 'source',
                source: SOURCES[name].table,
                reason: 'acl_denied',
                code: reader.failure.code,
              });
              readers.delete(name);
              continue;
            }
            failed.add(name);
            out.blocked = true;
            continue;
          }
          if (row) out[name === 'audit' ? 'a' : 'j'] = row;
        }
        return out;
      };

      for (;;) {
        const h = await heads();
        if (h.blocked) {
          stop = 'error';
          break;
        }
        if (!h.a && !h.j) break;
        if (timeline.length >= limit) {
          stop = 'limit';
          break;
        }
        const useAudit = h.a !== undefined && (h.j === undefined || before(h.a, h.j));
        const row = (useAudit ? h.a : h.j) as Row;
        // Another record's history must never appear as this one's.
        const owner = text(row, useAudit ? SOURCES.audit.key : SOURCES.journal.key);
        if (owner !== '' && owner !== sysId) {
          const source = useAudit ? SOURCES.audit : SOURCES.journal;
          return toolError(
            'FILTER_NOT_APPLIED',
            FILTER_NOT_APPLIED_MESSAGE(source.table, source.key),
            FILTER_NOT_APPLIED_HINT,
          );
        }
        const sysIdOf = text(row, 'sys_id');
        const at = text(row, 'sys_created_on');
        let entry: Record<string, unknown>;
        let om: FieldOmission[] = [];
        if (useAudit) {
          const field = text(row, 'fieldname');
          if (isSensitiveField(field, known)) {
            redacted.add(field);
            entry = { at, user: text(row, 'user'), field, redacted: true };
          } else {
            const shaped = compactRecord(
              { sys_id: sysIdOf, oldvalue: row.oldvalue, newvalue: row.newvalue },
              { ...previewOpts, table: SOURCES.audit.table },
            );
            om = shaped.omitted;
            entry = {
              at,
              user: text(row, 'user'),
              field,
              old: shaped.record.oldvalue,
              new: shaped.record.newvalue,
            };
          }
        } else {
          const shaped = compactRecord(
            { sys_id: sysIdOf, value: row.value },
            { ...previewOpts, table: SOURCES.journal.table },
          );
          om = shaped.omitted;
          entry = {
            at,
            user: text(row, 'sys_created_by'),
            field: text(row, 'element'),
            journal: shaped.record.value,
          };
        }
        const cost = JSON.stringify(entry).length + JSON.stringify(om).length + 1;
        if (cost > budget && timeline.length > 0) {
          stop = 'response_budget';
          break;
        }
        budget -= cost;
        timeline.push(entry);
        fieldOmissions.push(...om);
        readers.get(useAudit ? 'audit' : 'journal')?.take();
      }

      if (readers.size === 0) {
        return toolError(
          'ACL_DENIED',
          "The signed-in user can't read this record's history: both sys_audit and sys_journal_field are refused.",
        );
      }
      if (failed.size > 0 && timeline.length === 0) {
        const f = readers.get([...failed][0] as SourceName)?.failure;
        if (f) return sn.fail(f);
      }
      if (stop === 'error') {
        const f = readers.get([...failed][0] as SourceName)?.failure;
        hints.push(`Stopped early: ${f?.code} — ${f?.message}`);
      }

      const seen = (state?.seen ?? 0) + timeline.length;
      const position = (name: SourceName) =>
        readers.get(name)?.position() ?? state?.[name] ?? { offset: 0, skip: 0 };
      const cursor = stop
        ? ctx.cursors.encodeState(StateSchema, {
            v: 1,
            tool: 'get_record_history',
            instance,
            table,
            sys_id: sysId,
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
            order,
            limit,
            seen,
            audit: position('audit'),
            journal: position('journal'),
          })
        : undefined;
      if (cursor && stop) {
        omitted.unshift(
          moreOmission(
            'get_record_history',
            id,
            cursor,
            stop,
            stop === 'error'
              ? 'Reading stopped on an error. Continue with the cursor to retry from here.'
              : 'More history exists. Continue with the cursor.',
          ),
        );
      }
      omitted.push(...fieldOmissions);
      if (redacted.size > 0) {
        omitted.push({
          kind: 'fields',
          reason: 'sensitive',
          fields: [...redacted].sort(),
          note: 'Changes to credential fields are listed without their values.',
        });
      }
      const totals = NAMES.map((n) => readers.get(n)?.total);
      return dataResponse({
        provenance: sn.provenance('sys_audit + sys_journal_field'),
        data: { table, sys_id: sysId, order, timeline },
        omitted,
        page: {
          returned: timeline.length,
          returned_total: seen,
          ...(cursor ? { next_cursor: cursor } : {}),
          ...(totals.some((t) => t !== undefined)
            ? { total: totals.reduce<number>((x, y) => x + (y ?? 0), 0) }
            : {}),
        },
        hints,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: sn.requests,
      });
    },
  );
}
