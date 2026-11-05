/**
 * search_code (T-031): which scripts or conditions mention something? The script-type fields come
 * from the dictionary (cached), so no table list is hard-coded and custom tables are covered.
 * Each table gets a structured `LIKE` query; matches come back as record references with ±3-line
 * snippets. A cursor continues across rows and tables; `complete: true` only after the last table.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import {
  compileFilter,
  type ErrorCode,
  FIELD_PATH_RE,
  isDeniedTable,
  MAX_ENCODED_QUERY_LENGTH,
  TABLE_NAME_RE,
  TableNameSchema,
} from '@sn-mcp/shared';
import { z } from 'zod';
import { compactValue, type FieldOmission, isSensitiveField } from '../compact.js';
import { FILTER_NOT_APPLIED_MESSAGE } from '../filter-check.js';
import { type FieldInfo, MetadataError } from '../metadata.js';
import { dataResponse, type Omission } from '../response.js';
import { toolError } from '../results.js';
import {
  CountInput,
  CursorInput,
  InstanceInput,
  lean,
  READ_ONLY,
  ResultEnvelope,
  ScopeIdInput,
  UNTRUSTED_NOTE,
} from './common.js';
import type { ToolContext } from './context.js';
import {
  beginTool,
  isFatal,
  isToolError,
  maxCharsInput,
  moreOmission,
  RESPONSE_OVERHEAD_CHARS,
} from './support.js';
import { ReaderPositionSchema, WindowReader } from './window-reader.js';

export const SCRIPT_TYPES = [
  'script',
  'script_plain',
  'script_server',
  'conditions',
  'condition_string',
  'email_script',
  'html_script',
] as const;

const DEFAULT_LIMIT = 20;
/** Script rows are large: read fewer per upstream request. */
const MAX_WINDOW = 50;
/** Tables searched by one call, so it stays well inside client tool timeouts. */
const TABLES_PER_CALL = 25;
const CONTEXT_LINES = 3;
const SNIPPETS_PER_FIELD = 3;
const MAX_SNIPPET_LINE = 240;
const MAX_OR_TERMS = 10;
/** Query room per target, leaving space for `^OR`, the operator and the sys_id order. */
const MAX_QUERY_ROOM = MAX_ENCODED_QUERY_LENGTH - 100;

const StateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.literal('search_code'),
  instance: z.string().max(32),
  pattern: z.string().max(200),
  tables: z.array(z.string().max(80)).max(100).optional(),
  target: z.int().min(0),
  pos: ReaderPositionSchema,
  limit: z.int().min(1),
  seen: z.int().min(0),
});

interface Target {
  table: string;
  fields: string[];
}

/** One query per group of fields, so a table with many script fields stays within query limits. */
export function buildTargets(
  fields: { table: string; field: string }[],
  pattern: string,
): Target[] {
  const byTable = new Map<string, string[]>();
  for (const f of fields) {
    // One unusable name must not sink the other fields of its query group.
    if (!FIELD_PATH_RE.test(f.field)) continue;
    byTable.set(f.table, [...(byTable.get(f.table) ?? []), f.field]);
  }
  const out: Target[] = [];
  for (const table of [...byTable.keys()].sort()) {
    let group: string[] = [];
    let used = 0;
    for (const field of byTable.get(table) as string[]) {
      const cost = field.length + pattern.length + 10;
      if (group.length > 0 && (group.length >= MAX_OR_TERMS || used + cost > MAX_QUERY_ROOM)) {
        out.push({ table, fields: group });
        group = [];
        used = 0;
      }
      group.push(field);
      used += cost;
    }
    if (group.length > 0) out.push({ table, fields: group });
  }
  return out;
}

export interface Snippet {
  start_line: number;
  lines: string[];
}

/** ±3 lines around each matching line, with overlaps merged; very long lines are cut to the match. */
export function makeSnippets(
  text: string,
  pattern: string,
): { matches: number; snippets: Snippet[]; shownMatches: number } {
  const needle = pattern.toLowerCase();
  const lines = text.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).toLowerCase().includes(needle)) hits.push(i);
  }
  const ranges: { from: number; to: number; hits: number }[] = [];
  for (const h of hits) {
    const last = ranges.at(-1);
    if (last && h - CONTEXT_LINES <= last.to + 1) {
      last.to = Math.min(lines.length - 1, h + CONTEXT_LINES);
      last.hits++;
    } else {
      ranges.push({
        from: Math.max(0, h - CONTEXT_LINES),
        to: Math.min(lines.length - 1, h + CONTEXT_LINES),
        hits: 1,
      });
    }
  }
  const shown = ranges.slice(0, SNIPPETS_PER_FIELD);
  return {
    matches: hits.length,
    shownMatches: shown.reduce((n, r) => n + r.hits, 0),
    snippets: shown.map((r) => ({
      start_line: r.from + 1,
      lines: lines.slice(r.from, r.to + 1).map((l) => cutLine(l, needle)),
    })),
  };
}

function cutLine(line: string, needle: string): string {
  if (line.length <= MAX_SNIPPET_LINE) return line;
  const at = Math.max(0, line.toLowerCase().indexOf(needle));
  const from = Math.max(0, at - Math.floor((MAX_SNIPPET_LINE - needle.length) / 2));
  const piece = line.slice(from, from + MAX_SNIPPET_LINE);
  return `${from > 0 ? '…' : ''}${piece}${from + MAX_SNIPPET_LINE < line.length ? '…' : ''}`;
}

const REASONS: Partial<Record<ErrorCode, string>> = {
  ACL_DENIED: 'acl_denied',
  TIMEOUT: 'timeout',
  NOT_FOUND: 'not_found',
  TABLE_DENIED: 'table_denied',
};

export function registerSearchCode(server: McpServer, ctx: ToolContext): void {
  const { config, meta, metadataError } = ctx;
  server.registerTool(
    'search_code',
    {
      description:
        'Finds scripts and conditions containing `pattern`: any script-type field in the dictionary. `tables` narrows it. Returns ±3-line snippets; get_field_content reads a whole script. Continue with `cursor`; `complete` only after the last table.',
      inputSchema: z.strictObject({
        scope_id: ScopeIdInput,
        instance: InstanceInput,
        pattern: lean(z.string().min(1).max(200)).optional().describe('Not with cursor'),
        tables: lean(z.array(TableNameSchema).min(1).max(100), z.array(z.string())).optional(),
        limit: CountInput.optional().describe('Records wanted'),
        cursor: CursorInput,
        max_chars: maxCharsInput(config),
      }),
      outputSchema: ResultEnvelope,
      annotations: READ_ONLY,
    },
    async (args) => {
      const start = beginTool(ctx, args, { tool: 'search_code', schema: StateSchema });
      if (isToolError(start)) return start;
      const { id, hints, maxChars, instance, sn, mc, state } = start;
      if (state && (args.pattern !== undefined || args.tables !== undefined)) {
        return toolError(
          'INVALID_INPUT',
          'Pass only scope_id and cursor (optionally limit or max_chars) to continue.',
        );
      }
      const pattern = state?.pattern ?? args.pattern;
      if (pattern === undefined) {
        return toolError('INVALID_INPUT', 'pattern is required (or pass a cursor).');
      }
      // The pattern goes through the same value validation as any filter.
      const probe = compileFilter({ where: [{ field: 'sys_id', op: 'contains', value: pattern }] });
      if (!probe.ok) {
        return toolError(
          probe.error.code,
          probe.error.message,
          /javascript/i.test(pattern)
            ? 'Search for "javascript" without the colon: it finds those lines too, and the snippets show them.'
            : undefined,
        );
      }

      const explicit = state?.tables ?? args.tables;
      const limit = args.limit ?? state?.limit ?? DEFAULT_LIMIT;
      const omitted: Omission[] = [];
      let fieldList: { table: string; field: string }[];
      try {
        if (explicit) {
          fieldList = [];
          for (const table of explicit) {
            if (isDeniedTable(table, config.extraDeniedTables)) {
              fieldList.push({ table, field: '' });
              continue;
            }
            const known = await meta.fields(mc, table);
            const own = [...known.values()].filter((f) =>
              (SCRIPT_TYPES as readonly string[]).includes(f.type),
            );
            if (own.length === 0) {
              hints.push(`${table} has no script-type fields, so it was not searched.`);
            }
            for (const f of own) fieldList.push({ table, field: f.name });
          }
        } else {
          fieldList = (await meta.fieldsOfTypes(mc, SCRIPT_TYPES)).map((f) => ({
            table: f.table,
            field: f.field,
          }));
        }
      } catch (e) {
        return metadataError(e, id);
      }
      const targets = buildTargets(fieldList, pattern);
      const unusable = fieldList.filter((f) => f.field && !FIELD_PATH_RE.test(f.field));
      if (unusable.length > 0 && !state) {
        omitted.push({
          kind: 'fields',
          reason: 'unsupported_name',
          fields: unusable.map((f) => `${f.table}.${f.field}`),
          note: 'The dictionary lists these fields, but their names are outside what the connector can query.',
        });
      }
      const tablesTotal = new Set(targets.map((t) => t.table)).size;

      const matches: Record<string, unknown>[] = [];
      const fieldOmissions: FieldOmission[] = [];
      let budget = maxChars - RESPONSE_OVERHEAD_CHARS;
      let targetIndex = state?.target ?? 0;
      let position = state?.pos ?? { offset: 0, skip: 0 };
      let stop: 'limit' | 'response_budget' | 'batch' | 'error' | undefined;
      let fatal: { code: ErrorCode; message: string } | undefined;
      let visited = 0;
      const windowSize = Math.min(MAX_WINDOW, config.pageSize);

      search: while (targetIndex < targets.length) {
        if (visited >= TABLES_PER_CALL) {
          stop = 'batch';
          break;
        }
        visited++;
        const target = targets[targetIndex] as Target;
        const next = () => {
          targetIndex++;
          position = { offset: 0, skip: 0 };
        };
        const retry = {
          tool: 'search_code',
          args: { scope_id: id, pattern, tables: [target.table] },
        };
        if (isDeniedTable(target.table, config.extraDeniedTables)) {
          omitted.push({ kind: 'table', reason: 'table_denied', table: target.table });
          next();
          continue;
        }
        if (!TABLE_NAME_RE.test(target.table)) {
          omitted.push({
            kind: 'table',
            reason: 'unsupported_name',
            table: target.table,
            note: 'The dictionary lists this table, but its name is outside what the connector can query.',
          });
          next();
          continue;
        }
        let known: ReadonlyMap<string, FieldInfo>;
        try {
          known = await meta.fields(mc, target.table);
        } catch (e) {
          const code = e instanceof MetadataError ? e.code : 'SN_API_ERROR';
          if (isFatal(code)) {
            if (matches.length === 0) return metadataError(e, id);
            fatal = { code, message: (e as Error).message };
            stop = 'error';
            break;
          }
          omitted.push({
            kind: 'table',
            reason: REASONS[code] ?? 'error',
            code,
            message: (e as Error).message,
            table: target.table,
            next: retry,
          });
          next();
          continue;
        }
        const fields = target.fields.filter((f) => !isSensitiveField(f, known));
        const sensitive = target.fields.filter((f) => isSensitiveField(f, known));
        if (sensitive.length > 0) {
          omitted.push({
            kind: 'fields',
            reason: 'sensitive',
            table: target.table,
            fields: sensitive,
            note: 'Credential fields are never searched.',
          });
        }
        if (fields.length === 0) {
          next();
          continue;
        }
        const compiled = compileFilter({
          where:
            fields.length === 1
              ? [{ field: fields[0] as string, op: 'contains', value: pattern }]
              : [
                  {
                    or: fields.map((f) => ({ field: f, op: 'contains' as const, value: pattern })),
                  },
                ],
          order_by: [{ field: 'sys_id', direction: 'asc' }],
        });
        if (!compiled.ok) {
          omitted.push({
            kind: 'table',
            reason: 'error',
            code: compiled.error.code,
            message: compiled.error.message,
            table: target.table,
            fields,
          });
          next();
          continue;
        }
        const display = [...known.values()].find((f) => f.display)?.name;
        const nameField = display ?? (known.has('name') ? 'name' : undefined);
        const read = [...new Set(['sys_id', ...(nameField ? [nameField] : []), ...fields])];
        const reader = new WindowReader(
          (offset, n) =>
            sn.list({
              table: target.table,
              query: compiled.value.query,
              fields: read,
              limit: n,
              offset,
              displayValue: 'false',
              count: true,
            }),
          position,
          windowSize,
        );
        for (;;) {
          const row = await reader.peek();
          if (matches.length >= limit && !reader.failure) {
            if (!row && targetIndex === targets.length - 1) {
              next(); // that was the last row of the last table: nothing is left
              continue search;
            }
            stop = 'limit';
            position = reader.position();
            break search;
          }
          if (reader.failure) {
            const f = reader.failure;
            if (f.code === 'RESPONSE_TOO_LARGE') {
              // One record over the size cap even alone: name it instead of losing it.
              const at = reader.position().offset;
              const idRow = await sn.list({
                table: target.table,
                query: compiled.value.query,
                fields: ['sys_id'],
                limit: 1,
                offset: at,
                displayValue: 'false',
              });
              const oversized = idRow.ok ? String(compactValue(idRow.rows[0]?.sys_id) ?? '') : '';
              for (const field of fields) {
                fieldOmissions.push({
                  kind: 'field',
                  reason: 'too_large',
                  sys_id: oversized,
                  field,
                  shown_chars: 0,
                  total_chars: null,
                  next: {
                    tool: 'get_field_content',
                    args: { scope_id: id, table: target.table, sys_id: oversized, field },
                  },
                });
              }
              reader.skipOversized();
              continue;
            }
            if (isFatal(f.code)) {
              if (matches.length === 0) return sn.fail(f);
              fatal = f;
              stop = 'error';
              position = reader.position();
              break search;
            }
            omitted.push({
              kind: 'table',
              reason: REASONS[f.code] ?? 'error',
              code: f.code,
              message: f.message,
              table: target.table,
              next: retry,
            });
            next();
            continue search;
          }
          if (!row) {
            next();
            continue search;
          }
          const sysId = String(compactValue(row.sys_id) ?? '');
          const hits: Record<string, unknown>[] = [];
          const rowOmissions: FieldOmission[] = [];
          for (const field of fields) {
            const value = String(compactValue(row[field]) ?? '');
            const found = makeSnippets(value, pattern);
            const nextCall = {
              tool: 'get_field_content',
              args: { scope_id: id, table: target.table, sys_id: sysId, field },
            };
            if (found.matches === 0) continue;
            hits.push({ field, matches: found.matches, snippets: found.snippets });
            if (found.shownMatches < found.matches) {
              rowOmissions.push({
                kind: 'field',
                reason: 'preview',
                sys_id: sysId,
                field,
                shown_chars: found.shownMatches,
                total_chars: value.length,
                next: nextCall,
              });
            }
          }
          // Searched fields all have text, and none holds the pattern: the condition was ignored.
          const allFilled = fields.every((f) => String(compactValue(row[f]) ?? '') !== '');
          if (hits.length === 0 && allFilled) {
            omitted.push({
              kind: 'table',
              reason: 'filter_not_applied',
              code: 'FILTER_NOT_APPLIED',
              message: FILTER_NOT_APPLIED_MESSAGE(target.table, undefined),
              table: target.table,
            });
            next();
            continue search;
          }
          const name = nameField ? compactValue(row[nameField]) : undefined;
          const entry = {
            table: target.table,
            sys_id: sysId,
            ...(name ? { name } : {}),
            ...(hits.length > 0
              ? { hits }
              : {
                  note: 'ServiceNow matched this record, but not within one line. Read it with get_field_content.',
                  fields,
                }),
          };
          const cost = JSON.stringify(entry).length + JSON.stringify(rowOmissions).length + 1;
          if (cost > budget && matches.length > 0) {
            stop = 'response_budget';
            position = reader.position();
            break search;
          }
          budget -= cost;
          reader.take();
          matches.push(entry);
          fieldOmissions.push(...rowOmissions);
          position = reader.position();
        }
      }
      if (fatal) hints.push(`Stopped early: ${fatal.code} — ${fatal.message}`);

      const done = new Set(targets.slice(0, targetIndex).map((t) => t.table));
      // A table with more query groups still to run isn't done yet.
      for (const t of targets.slice(targetIndex)) done.delete(t.table);
      const seen = (state?.seen ?? 0) + matches.length;
      const cursor = stop
        ? ctx.cursors.encodeState(StateSchema, {
            v: 1,
            tool: 'search_code',
            instance,
            pattern,
            ...(explicit ? { tables: explicit } : {}),
            target: targetIndex,
            pos: position,
            limit,
            seen,
          })
        : undefined;
      if (cursor && stop) {
        omitted.unshift(
          moreOmission(
            'search_code',
            id,
            cursor,
            stop,
            `${tablesTotal - done.size} of ${tablesTotal} tables are not finished. Follow next.`,
          ),
        );
      }
      if (!state && !explicit && targets.length > TABLES_PER_CALL) {
        hints.push(
          `Searching ${tablesTotal} tables with script fields takes several calls. Pass tables to narrow it.`,
        );
      }
      if (omitted.some((o) => 'table' in o && String(o.table).startsWith('var__m_'))) {
        hints.push(
          "`var__m_` tables hold Flow Designer variables. ServiceNow lists them in the dictionary but can't query or count them, so retrying won't help.",
        );
      }
      omitted.push(...fieldOmissions);
      return dataResponse({
        provenance: sn.provenance('script-type fields from the dictionary'),
        data: {
          pattern,
          matches,
          tables_searched: done.size,
          tables_remaining: tablesTotal - done.size,
          tables_total: tablesTotal,
        },
        omitted,
        page: {
          returned: matches.length,
          returned_total: seen,
          ...(cursor ? { next_cursor: cursor } : {}),
        },
        hints,
        untrusted: UNTRUSTED_NOTE,
        requestsUsed: sn.requests,
      });
    },
  );
}
