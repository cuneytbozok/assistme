/**
 * The T-034 scenarios: every tool against a real instance. They take a `call` function, so the
 * same code runs live (`live.ts`) and in a mocked check of its own logic (never evidence of
 * connectivity; rule 11).
 *
 * Results hold only shapes, counts and sizes: no record content, sys_ids or field values, so the
 * evidence file can be committed.
 */

import { readFileSync } from 'node:fs';
import { applyUnified } from '../../packages/server/src/mcp/line-diff.ts';
import {
  describePayload,
  parseUpdatePayload,
} from '../../packages/server/src/mcp/update-payload.ts';

// biome-ignore lint/suspicious/noExplicitAny: tool results are checked field by field at run time
export type Result = any;
export type Call = (tool: string, args: Record<string, unknown>) => Promise<Result>;

export interface Measure {
  calls: number;
  max_result_chars: number;
  requests_used: number;
}

export interface ScenarioResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  note?: string;
  metrics?: Record<string, unknown>;
  measure: Measure;
}

class Check extends Error {}
// No parameter properties here: `npm run e2e:live` runs this file in Node's strip-only mode.
class Skip extends Error {
  metrics?: Record<string, unknown>;
  constructor(message: string, metrics?: Record<string, unknown>) {
    super(message);
    this.metrics = metrics;
  }
}

function expectThat(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Check(message);
}

/** Wraps `call` to record how much each scenario cost and to check the completeness contract. */
function metered(call: Call, m: Measure): Call {
  return async (tool, args) => {
    const r = await call(tool, args);
    m.calls++;
    m.max_result_chars = Math.max(m.max_result_chars, JSON.stringify(r).length);
    m.requests_used += r?.requests_used ?? 0;
    if (r?.ok === true && r.complete === false) {
      // A partial result must say what's missing, and more rows must come with a call.
      expectThat((r.omitted?.length ?? 0) > 0, `${tool}: complete:false with nothing in omitted`);
      if (r.page?.has_more) {
        expectThat(r.page.next_cursor, `${tool}: has_more with no next_cursor`);
        const more = r.omitted.some((o: { next?: unknown }) => o.next);
        expectThat(more, `${tool}: has_more with no next call in omitted`);
      }
    }
    return r;
  };
}

function ok(r: Result, what: string): Result {
  const err = r?.error ? `${r.error.code}: ${r.error.message}` : 'no result';
  expectThat(r?.ok === true, `${what} failed (${err})`);
  return r;
}

/** Follows cursors to the end, or until `stop` says enough. */
async function walk(
  call: Call,
  tool: string,
  first: Record<string, unknown>,
  scope: string,
  onPage: (r: Result) => boolean | undefined,
): Promise<{ pages: number; last: Result }> {
  let r = ok(await call(tool, { scope_id: scope, ...first }), tool);
  let pages = 1;
  while (onPage(r) !== true && r.page?.next_cursor) {
    r = ok(await call(tool, { scope_id: scope, cursor: r.page.next_cursor }), tool);
    pages++;
  }
  return { pages, last: r };
}

const rawOf = (v: unknown): unknown =>
  v && typeof v === 'object' && 'v' in v ? (v as { v: unknown }).v : v;

/** A whole field, reassembled from get_field_content. */
async function readField(call: Call, args: Record<string, unknown>): Promise<string> {
  let text = '';
  let next = args;
  for (;;) {
    const r = ok(await call('get_field_content', next), 'read field');
    for (const l of r.data.lines) {
      text += l.text;
      if (!l.more && l.n < r.data.total_lines) text += '\n';
    }
    if (r.complete) return text;
    next = r.omitted[0].next.args;
  }
}

/** Every compare_records page gathered: diff lines per field, and how many lines were cut. */
async function compareAll(call: Call, scope: string, first: Record<string, unknown>) {
  const lines = new Map<string, string[]>();
  const inline: { field: string }[] = [];
  const only: { field: string }[] = [];
  const ignored = new Set<string>();
  let cut = 0;
  const firstPage: { r?: Result } = {};
  const { pages, last } = await walk(call, 'compare_records', first, scope, (r) => {
    firstPage.r ??= r;
    for (const d of r.data.diffs ?? []) {
      lines.set(d.field, [...(lines.get(d.field) ?? []), ...d.lines]);
    }
    inline.push(...(r.data.different_fields ?? []));
    only.push(...(r.data.only_on_a ?? []), ...(r.data.only_on_b ?? []));
    for (const f of r.data.ignored_fields ?? []) ignored.add(f);
    cut += r.omitted?.filter((o: { kind: string }) => o.kind === 'field').length ?? 0;
    return false;
  });
  expectThat(!last.page?.next_cursor, 'the diff did not reach its end');
  return { first: firstPage.r as Result, last, pages, lines, inline, only, ignored, cut };
}

/** Field names the T-042 code and docs assume on sys_update_version: reported by the live run. */
const MAX_VERSION_PAIRS = 25;
const ASSUMED_VERSION_FIELDS = [
  'name',
  'payload',
  'state',
  'source',
  'source_table',
  'type',
  'action',
  'record_name',
  'application',
  'sys_recorded_at',
];

/** Tables named in plugin/skills/servicenow-readonly-troubleshooting/references (T-038). */
const SKILL_TABLES = [
  'syslog',
  'syslog_transaction',
  'sys_email',
  'sysevent',
  'sys_trigger',
  'sys_script',
  'sys_script_include',
  'sys_script_client',
  'sys_data_policy2',
  'sys_ui_policy',
  'discovery_status',
  'discovery_device_history',
  'discovery_log',
  'ecc_queue',
  'ecc_agent',
  'discovery_schedule',
  'cmdb_ci',
  'cmdb_rel_ci',
  'cmdb_rel_type',
  'cmdb_identifier',
  'cmdb_identifier_entry',
  'cmdb_reconciliation_definition',
  'sys_object_source',
  'cmdb_datasource_last_update',
  'sys_hub_flow',
  'sys_hub_action_type_definition',
  'sys_hub_trigger_instance',
  'sys_flow_context',
  'sys_flow_log',
  'sys_security_acl',
  'sys_security_acl_role',
  'sys_user_has_role',
  'sys_user_grmember',
  'sys_user_role_contains',
];

export const SCENARIOS: {
  name: string;
  run: (call: Call, scope: string) => Promise<Record<string, unknown>>;
}[] = [
  {
    name: 'discover_tables finds a custom table (AC-10)',
    run: async (call, scope) => {
      // `search` means contains, and results are sorted by name, so walk every match.
      const seen: string[] = [];
      for (const search of ['x_', 'u_']) {
        await walk(call, 'discover_tables', { search, limit: 200 }, scope, (r) => {
          seen.push(...r.data.records.map((t: { name: string }) => t.name));
          return false;
        });
      }
      const custom = seen.filter((n) => /^(x|u)_/.test(n));
      if (custom.length === 0) throw new Skip('no custom table on this instance');
      const d = ok(
        await call('describe_table', { scope_id: scope, table: custom[0] }),
        'describe custom',
      );
      expectThat(d.data.field_count > 0, 'custom table has no fields');
      return { custom_tables_found: custom.length, fields: d.data.field_count };
    },
  },
  {
    name: 'describe_table incident: inheritance and choices (AC-11)',
    run: async (call, scope) => {
      const fields: { inherited_from?: string; choices?: unknown[] }[] = [];
      const { pages, last } = await walk(
        call,
        'describe_table',
        { table: 'incident', include_choices: true },
        scope,
        (r) => {
          fields.push(...r.data.fields);
          return false;
        },
      );
      expectThat(last.data.chain.includes('task'), 'incident should extend task');
      expectThat(fields.length === last.data.field_count, 'field count mismatch');
      expectThat(
        fields.some((f) => f.inherited_from === 'task'),
        'no field inherited from task',
      );
      expectThat(
        fields.some((f) => (f.choices?.length ?? 0) > 0),
        'no choices returned',
      );
      return { fields: fields.length, pages };
    },
  },
  {
    name: 'query syslog with no time window, past offset 2,000, by cursor (AC-12)',
    run: async (call, scope) => {
      const ids = new Set<string>();
      let rows = 0;
      let moved = 0;
      const target = 2500;
      const countRows = async () =>
        ok(await call('aggregate_records', { scope_id: scope, table: 'syslog' }), 'count').data
          .count as number;
      const before = await countRows();
      const { pages } = await walk(
        call,
        'query_records',
        { table: 'syslog', fields: ['level'], limit: target },
        scope,
        (r) => {
          for (const x of r.data.records) {
            rows++;
            ids.add(x.sys_id);
          }
          for (const h of r.hints ?? []) {
            const m = /changed while being read: (\d+) row/.exec(h);
            if (m) moved += Number(m[1]);
          }
          return rows >= target;
        },
      );
      if (rows < 2100) throw new Skip(`syslog has only ${rows} readable rows`);
      expectThat(ids.size === rows, `${rows - ids.size} duplicate rows`);
      // Is the table being written to while it's read? That's what moves rows between pages.
      const after = await countRows();
      // Skipped rows must be real repeats. Far more than the table grew means rows are being lost.
      expectThat(
        moved <= after - before + 50,
        `${moved} rows skipped as repeats, but the table grew by only ${after - before}`,
      );
      return { rows, pages, rows_added_during_walk: after - before, rows_moved_and_skipped: moved };
    },
  },
  {
    name: 'query records older than one year (AC-12)',
    run: async (call, scope) => {
      const r = ok(
        await call('query_records', {
          scope_id: scope,
          table: 'incident',
          where: [
            { field: 'sys_created_on', op: 'older_than', value: { amount: 1, unit: 'year' } },
          ],
          limit: 5,
          include_total: true,
        }),
        'query',
      );
      if (r.data.records.length === 0) throw new Skip('no incidents older than a year');
      return { rows: r.data.records.length, total: r.page.total };
    },
  },
  {
    name: 'read the largest of 50 script includes completely, in chunks (AC-11, AC-12)',
    run: async (call, scope) => {
      const list = ok(
        await call('query_records', {
          scope_id: scope,
          table: 'sys_script_include',
          fields: ['script'],
          limit: 50,
          max_chars: 100_000,
        }),
        'list',
      );
      const previews = (list.omitted ?? []).filter(
        (o: { kind: string; field?: string }) => o.kind === 'field' && o.field === 'script',
      );
      if (previews.length === 0) throw new Skip('no long script include in the first 50');
      const biggest = previews.reduce((a: Result, b: Result) =>
        (b.total_chars ?? 0) > (a.total_chars ?? 0) ? b : a,
      );
      let text = '';
      let args = biggest.next.args;
      let chunks = 0;
      let requests = 0;
      for (;;) {
        const r = ok(await call('get_field_content', args), 'read');
        chunks++;
        requests += r.requests_used;
        for (const l of r.data.lines) {
          text += l.text;
          if (!l.more && l.n < r.data.total_lines) text += '\n';
        }
        if (r.complete) {
          expectThat(text.length === r.data.total_chars, 'reassembled length differs');
          break;
        }
        args = r.omitted[0].next.args;
      }
      expectThat(requests <= 3, `chunked read made ${requests} requests`);
      return { total_chars: text.length, chunks, upstream_requests: requests };
    },
  },
  {
    name: 'search_code for a field name in scripts (AC-11)',
    run: async (call, scope) => {
      let matches = 0;
      const { pages, last } = await walk(
        call,
        'search_code',
        { pattern: 'short_description', tables: ['sys_script', 'sys_script_include'] },
        scope,
        (r) => {
          matches += r.data.matches.length;
          return matches >= 60;
        },
      );
      const started = Date.now();
      const whole = ok(
        await call('search_code', { scope_id: scope, pattern: 'zz_no_such_text_zz' }),
        'whole-instance batch',
      );
      return {
        matches,
        pages,
        tables_total_narrow: last.data.tables_total,
        tables_total_instance: whole.data.tables_total,
        first_batch_seconds: Math.round((Date.now() - started) / 1000),
      };
    },
  },
  {
    name: 'search_code across the whole instance: every table, through cursors (AC-11, AC-12)',
    run: async (call, scope) => {
      const reasons: Record<string, number> = {};
      const byReason: Record<string, string[]> = {};
      const fieldsLeftOut: string[] = [];
      const started = Date.now();
      let maxBatch = 0;
      const { pages, last } = await walk(
        call,
        'search_code',
        { pattern: 'zz_no_such_text_zz' },
        scope,
        (r) => {
          for (const o of r.omitted ?? []) {
            if (o.kind !== 'table') continue;
            const key = `${o.reason}:${o.code ?? ''}`;
            reasons[key] = (reasons[key] ?? 0) + 1;
            if (o.reason !== 'acl_denied' && o.reason !== 'table_denied') {
              const list = byReason[key] ?? [];
              byReason[key] = list;
              if (list.length < 15)
                list.push(`${o.table}: ${String(o.message ?? '').slice(0, 100)}`);
            }
          }
          for (const o of r.omitted ?? []) {
            if (o.kind === 'fields') fieldsLeftOut.push(...o.fields);
          }
          maxBatch = Math.max(maxBatch, r.requests_used);
          return false;
        },
      );
      expectThat(last.data.tables_remaining === 0, 'tables remain after the last page');
      return {
        tables_total: last.data.tables_total,
        tables_searched: last.data.tables_searched,
        tables_not_searched: reasons,
        examples: byReason,
        fields_left_out: fieldsLeftOut,
        pages,
        most_requests_in_one_call: maxBatch,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    },
  },
  {
    name: 'get_related_records for a CI: every relation, through cursors (AC-11)',
    run: async (call, scope) => {
      const ci = ok(
        await call('query_records', {
          scope_id: scope,
          table: 'cmdb_ci',
          fields: ['name'],
          limit: 1,
        }),
        'find CI',
      );
      if (ci.data.records.length === 0) throw new Skip('no CI on this instance');
      let relations = 0;
      let withRecords = 0;
      const unreadable: Record<string, number> = {};
      const details: string[] = [];
      const started = Date.now();
      const { pages, last } = await walk(
        call,
        'get_related_records',
        { table: 'cmdb_ci', sys_id: ci.data.records[0].sys_id, samples: 1 },
        scope,
        (r) => {
          relations += r.data.relations.length;
          withRecords += r.data.relations.filter((x: { count: number }) => x.count > 0).length;
          for (const o of r.omitted ?? []) {
            if (o.kind !== 'relation') continue;
            const key = `${o.reason}:${o.code ?? ''}`;
            unreadable[key] = (unreadable[key] ?? 0) + 1;
            details.push(`${o.table}.${o.field}: ${String(o.message ?? '').slice(0, 120)}`);
          }
          return false;
        },
      );
      const unreadableTotal = Object.values(unreadable).reduce((x, y) => x + y, 0);
      expectThat(
        relations + unreadableTotal >= last.data.relation_count,
        `${last.data.relation_count - relations - unreadableTotal} relations unaccounted for`,
      );
      return {
        relation_count: last.data.relation_count,
        relations_returned: relations,
        with_records: withRecords,
        pages,
        unreadable,
        details,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    },
  },
  {
    name: 'get_record_history of an incident (AC-11)',
    run: async (call, scope) => {
      const inc = ok(
        await call('get_record', {
          scope_id: scope,
          table: 'incident',
          match: { number: 'INC0000060' },
          fields: ['number'],
        }).catch(() => undefined),
        'find incident',
      );
      const times: string[] = [];
      let journal = 0;
      let audit = 0;
      const { pages, last } = await walk(
        call,
        'get_record_history',
        { table: 'incident', sys_id: inc.data.record.sys_id, order: 'asc', limit: 100 },
        scope,
        (r) => {
          for (const e of r.data.timeline) {
            times.push(e.at);
            if (e.journal !== undefined) journal++;
            else audit++;
          }
          return false;
        },
      );
      expectThat(
        times.every((t, i) => i === 0 || (times[i - 1] as string) <= t),
        'timeline out of order',
      );
      return { entries: times.length, audit, journal, pages, complete: last.complete };
    },
  },
  {
    name: 'aggregate_records: by state, with display values (AC-12)',
    run: async (call, scope) => {
      const total = ok(
        await call('aggregate_records', { scope_id: scope, table: 'incident' }),
        'count',
      );
      expectThat(typeof total.data.count === 'number', 'count is not a number');
      const r = ok(
        await call('aggregate_records', {
          scope_id: scope,
          table: 'incident',
          group_by: ['state'],
          aggregates: [{ fn: 'max', field: 'priority' }],
        }),
        'group',
      );
      const counts = r.data.groups.map((g: { count: number }) => g.count);
      expectThat(
        counts.every((c: number, i: number) => i === 0 || counts[i - 1] >= c),
        'groups not sorted',
      );
      const sum = counts.reduce((a: number, b: number) => a + b, 0);
      expectThat(sum === total.data.count, `groups sum to ${sum}, count is ${total.data.count}`);
      const shown = r.data.groups[0]?.group?.state;
      return {
        count: total.data.count,
        groups: counts.length,
        // Live question from T-028: does the Stats API give display values with display_value=all?
        group_value_shape: typeof shown === 'object' ? 'value+display' : 'value only',
        aggregate_shape: typeof r.data.groups[0]?.max?.priority,
      };
    },
  },
  {
    name: 'an ambiguous get_record never guesses, and list_all works (AC-13)',
    run: async (call, scope) => {
      const r = await call('get_record', {
        scope_id: scope,
        table: 'incident',
        match: { active: 'true' },
      });
      expectThat(r?.error?.code === 'AMBIGUOUS_MATCH', 'expected AMBIGUOUS_MATCH');
      expectThat(r.error.candidates.length >= 2, 'expected candidates');
      const all = ok(await call(r.error.list_all.tool, r.error.list_all.args), 'list_all');
      expectThat(all.page.total === r.error.total, 'list_all total differs');
      return { total: r.error.total, candidates: r.error.candidates.length };
    },
  },
  {
    name: 'get_record: expand_references, and a journal field by display value',
    run: async (call, scope) => {
      const r = ok(
        await call('get_record', {
          scope_id: scope,
          table: 'incident',
          match: { number: 'INC0000060' },
          expand_references: ['caller_id'],
        }),
        'get',
      );
      const refs = r.data.references ?? [];
      const j = ok(
        await call('get_field_content', {
          scope_id: scope,
          table: 'incident',
          sys_id: r.data.record.sys_id,
          field: 'comments_and_work_notes',
        }).catch(() => undefined),
        'journal field',
      );
      return {
        references: refs.length,
        reference_has_summary: refs.length > 0 && Object.keys(refs[0].summary).length > 1,
        journal_chars: j.data.total_chars,
      };
    },
  },
  {
    name: 'the tables the skill names exist here (reported, not required: plugins vary)',
    run: async (call, scope) => {
      const missing: string[] = [];
      for (const table of SKILL_TABLES) {
        const r = await call('describe_table', { scope_id: scope, table, max_chars: 4000 });
        if (r?.error?.code === 'NOT_FOUND') missing.push(table);
        else if (!r?.ok) expectThat(false, `${table}: ${r?.error?.code}`);
      }
      // Are the missing ones misnamed in the skill? Table names only.
      const similar: Record<string, string[]> = {};
      for (const search of ['discovery_sched', 'reconcil', 'datasource', 'data_source']) {
        const r = await call('discover_tables', { scope_id: scope, search, limit: 15 });
        similar[search] = r?.ok ? r.data.records.map((t: { name: string }) => t.name) : [];
      }
      return { checked: SKILL_TABLES.length, missing, similar };
    },
  },
  {
    name: 'the word javascript works: a table named with it, and searching for it (ADR-005)',
    run: async (call, scope) => {
      const d = await call('describe_table', {
        scope_id: scope,
        table: 'automation_pipeline_transformer_javascript',
        max_chars: 4000,
      });
      // The table comes with a plugin; NOT_FOUND on another instance isn't a failure.
      if (d?.error?.code !== 'NOT_FOUND') ok(d, 'describe');
      const found = ok(
        await call('search_code', {
          scope_id: scope,
          pattern: 'javascript',
          tables: ['sys_script_include'],
          limit: 5,
        }),
        'search',
      );
      return { table_described: d?.ok === true, matches: found.data.matches.length };
    },
  },
  {
    name: 'the filter check raises no false alarms on ordinary queries',
    run: async (call, scope) => {
      const closed = ok(
        await call('query_records', {
          scope_id: scope,
          table: 'incident',
          where: [{ field: 'number', op: '=', value: 'INC0000060' }],
          fields: ['caller_id', 'assignment_group', 'category'],
        }),
        'seed',
      );
      const rec = closed.data.records[0];
      const raw = (v: unknown) =>
        v && typeof v === 'object' && 'v' in v ? (v as { v: string }).v : (v as string);
      const filters: unknown[][] = [
        [{ field: 'state', op: '=', value: 7 }],
        [{ field: 'state', op: 'in', value: [6, 7] }],
        [{ field: 'active', op: '=', value: true }],
        [{ field: 'active', op: '=', value: 'false' }],
        [{ field: 'number', op: 'starts_with', value: 'inc' }],
        [{ field: 'number', op: 'in', value: ['inc0000060', 'INC0000055'] }],
        [{ field: 'short_description', op: 'contains', value: 'EMAIL' }],
        [{ field: 'caller_id', op: '=', value: raw(rec.caller_id) }],
        [{ field: 'caller_id', op: 'contains', value: 'Joe' }],
        [{ field: 'assignment_group', op: '=', value: raw(rec.assignment_group) }],
        [{ field: 'category', op: '=', value: raw(rec.category) }],
        [{ field: 'sys_created_on', op: 'older_than', value: { amount: 1, unit: 'year' } }],
        [{ field: 'caller_id.name', op: 'contains', value: 'joe' }],
        [
          {
            or: [
              { field: 'priority', op: '=', value: 1 },
              { field: 'short_description', op: 'contains', value: 'network' },
            ],
          },
        ],
      ];
      let rows = 0;
      for (const where of filters) {
        const r = ok(
          await call('query_records', {
            scope_id: scope,
            table: 'incident',
            where,
            limit: 200,
            max_chars: 100_000,
          }),
          JSON.stringify(where),
        );
        rows += r.data.records.length;
      }
      for (const [table, where] of [
        ['sys_user', [{ field: 'active', op: '=', value: true }]],
        ['sys_user', [{ field: 'name', op: 'contains', value: 'a' }]],
        ['sys_script', [{ field: 'collection', op: '=', value: 'incident' }]],
        ['sys_script', [{ field: 'script', op: 'contains', value: 'CURRENT' }]],
        ['sys_dictionary', [{ field: 'name', op: '=', value: 'incident' }]],
      ] as const) {
        const r = ok(
          await call('query_records', {
            scope_id: scope,
            table,
            where,
            limit: 100,
            max_chars: 100_000,
          }),
          `${table} ${JSON.stringify(where)}`,
        );
        rows += r.data.records.length;
      }
      return { queries: filters.length + 5, rows_checked: rows };
    },
  },
  {
    name: 'unsafe and broadening queries are refused before any read (AC-14)',
    run: async (call, scope) => {
      const cases: [Record<string, unknown>, string][] = [
        [
          { table: 'incident', where: [{ field: 'zz_no_field_zz', op: '=', value: 1 }] },
          'INVALID_FIELD',
        ],
        [{ table: 'incident', encoded_query: 'priority=1^RLQUERYsys_user' }, 'UNSAFE_QUERY'],
        [{ table: 'sys_user_token' }, 'TABLE_DENIED'],
        [{ table: 'sys_user', fields: ['user_password'] }, 'FORBIDDEN_OPERATION'],
      ];
      for (const [args, code] of cases) {
        const r = await call('query_records', { scope_id: scope, ...args });
        expectThat(r?.error?.code === code, `expected ${code}, got ${r?.error?.code ?? 'data'}`);
      }
      return { refused: cases.length };
    },
  },
  {
    name: 'native encoded queries: UI and SDK forms, diagnostics (T-047)',
    run: async (call, scope) => {
      const total = async (args: Record<string, unknown>, what: string): Promise<number> => {
        const r = ok(
          await call('query_records', {
            scope_id: scope,
            table: 'incident',
            fields: ['sys_id'],
            limit: 1,
            include_total: true,
            ...args,
          }),
          what,
        );
        expectThat(typeof r.page.total === 'number', `${what}: no total`);
        return r.page.total;
      };
      // Each native form must select exactly the rows its canonical form does.
      const pairs: [string, Record<string, unknown>, Record<string, unknown>][] = [
        ['^EQ', { encoded_query: 'active=true^EQ' }, { encoded_query: 'active=true' }],
        [
          'NOTLIKE',
          { encoded_query: 'short_descriptionNOTLIKEemail' },
          { where: [{ field: 'short_description', op: 'not_contains', value: 'email' }] },
        ],
        [
          'CONTAINS',
          { encoded_query: 'short_descriptionCONTAINSemail' },
          { where: [{ field: 'short_description', op: 'contains', value: 'email' }] },
        ],
        [
          'empty =',
          { encoded_query: 'assignment_group=' },
          { where: [{ field: 'assignment_group', op: 'is_empty' }] },
        ],
        [
          'empty !=',
          { encoded_query: 'assignment_group!=' },
          { where: [{ field: 'assignment_group', op: 'is_not_empty' }] },
        ],
      ];
      const totals: Record<string, [number, number]> = {};
      for (const [name, native, canonical] of pairs) {
        const a = await total(native, name);
        const b = await total(canonical, `${name} (canonical)`);
        totals[name] = [a, b];
        expectThat(a === b, `${name}: ${a} rows, canonical form ${b}`);
      }
      const all = await total({}, 'all incidents');
      expectThat(
        totals['empty =']?.[0] !== all,
        'empty = matched every incident: ServiceNow may have ignored it',
      );

      // Keyword search inside encoded_query.
      ok(
        await call('query_records', {
          scope_id: scope,
          table: 'incident',
          encoded_query: '123TEXTQUERY321=email^active=true',
          fields: ['number'],
          limit: 5,
        }),
        'text search in encoded_query',
      );

      // Relative dates select the rows they say (T-049). A call that merely succeeds proves
      // nothing: `@day@` also succeeded, and matched no rows. Expected counts come from the dates
      // of the rows themselves, with a margin for rows near the boundary.
      const created: number[] = [];
      await walk(
        call,
        'query_records',
        { table: 'incident', fields: ['sys_created_on'], limit: 10_000 },
        scope,
        (r) => {
          for (const row of r.data.records) {
            created.push(Date.parse(`${String(rawOf(row.sys_created_on)).replace(' ', 'T')}Z`));
          }
          return undefined;
        },
      );
      const cutoff = (unit: string, n: number): number => {
        const d = new Date();
        if (unit === 'minute') d.setUTCMinutes(d.getUTCMinutes() - n);
        if (unit === 'hour') d.setUTCHours(d.getUTCHours() - n);
        if (unit === 'day') d.setUTCDate(d.getUTCDate() - n);
        if (unit === 'week') d.setUTCDate(d.getUTCDate() - n * 7);
        if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - n);
        if (unit === 'quarter') d.setUTCMonth(d.getUTCMonth() - n * 3);
        if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() - n);
        return d.getTime();
      };
      const MARGIN_MS = 2 * 24 * 3_600_000;
      const relative: Record<string, { rows: number; lo: number; hi: number }> = {};
      for (const [unit, n] of [
        ['minute', 9000],
        ['hour', 9000],
        ['day', 60],
        ['week', 20],
        ['month', 2],
        ['quarter', 1],
        ['year', 1],
      ] as const) {
        const window = { amount: n, unit };
        const field = 'sys_created_on';
        const rows = await total(
          { where: [{ field, op: 'within_last', value: window }] },
          `within_last ${n} ${unit}`,
        );
        const older = await total(
          { where: [{ field, op: 'older_than', value: window }] },
          `older_than ${n} ${unit}`,
        );
        const at = cutoff(unit, n);
        const lo = created.filter((t) => t >= at + MARGIN_MS).length;
        const hi = created.filter((t) => t >= at - MARGIN_MS).length;
        relative[`${n} ${unit}`] = { rows, lo, hi };
        expectThat(
          rows >= lo && rows <= hi,
          `within_last ${n} ${unit}: ${rows} rows, the dates say ${lo}-${hi}`,
        );
        expectThat(
          rows + older === created.length,
          `${n} ${unit}: ${rows}+${older} of ${created.length}`,
        );
      }
      // The date forms the UI and the SDK guide write (ADR-018), checked against the rows.
      const scripted: Record<string, { rows: number; lo: number; hi: number }> = {};
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const DAY_MS = 86_400_000;
      for (const [name, query, from, to] of [
        [
          'daysAgoStart(60)',
          'sys_created_on>=javascript:gs.daysAgoStart(60)',
          Date.now() - 60 * DAY_MS,
          Infinity,
        ],
        [
          'older than 1 day',
          'sys_created_on<javascript:gs.daysAgoStart(1)',
          0,
          Date.now() - DAY_MS,
        ],
        [
          'ON Today',
          'sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()',
          start.getTime(),
          start.getTime() + DAY_MS,
        ],
        [
          'ON Last 3 months',
          'sys_created_onONLast 3 months@javascript:gs.beginningOfLast3Months()@javascript:gs.endOfLast3Months()',
          Date.now() - 95 * DAY_MS,
          Infinity,
        ],
      ] as const) {
        const rows = await total({ encoded_query: query }, name);
        const lo = created.filter((t) => t >= from + MARGIN_MS && t < to - MARGIN_MS).length;
        const hi = created.filter((t) => t >= from - MARGIN_MS && t < to + MARGIN_MS).length;
        scripted[name] = { rows, lo, hi };
        expectThat(rows >= lo && rows <= hi, `${name}: ${rows} rows, the dates say ${lo}-${hi}`);
      }
      const atUser = await call('query_records', {
        scope_id: scope,
        table: 'incident',
        encoded_query: 'assigned_to=javascript:gs.getUserID()',
        fields: ['sys_id'],
        limit: 1,
      });
      expectThat(
        (ok(atUser, 'script value').hints ?? []).some((h: string) => /server-side script/.test(h)),
        'a script value gave no warning',
      );

      // ServiceNow's own `@quarter@`: sent as written, its meaning only reported.
      const nativeQuarter = await total(
        { encoded_query: 'sys_created_onRELATIVEGE@quarter@ago@1' },
        'raw @quarter@',
      );

      // The spelling that failed silently is translated, and says so.
      const rawDay = ok(
        await call('query_records', {
          scope_id: scope,
          table: 'incident',
          encoded_query: 'sys_created_onRELATIVEGE@day@ago@60',
          fields: ['sys_id'],
          limit: 1,
          include_total: true,
        }),
        'raw @day@',
      );
      expectThat(
        rawDay.page.total === relative['60 day']?.rows,
        `raw @day@: ${rawDay.page.total}, structured ${relative['60 day']?.rows}`,
      );
      expectThat(
        (rawDay.hints ?? []).some((h: string) => h.includes('@dayofweek@ago@60')),
        'raw @day@: no hint about the rewrite',
      );

      // An empty result explains a choice label used instead of its value.
      const byLabel = ok(
        await call('query_records', {
          scope_id: scope,
          table: 'incident',
          encoded_query: 'state=Closed',
          limit: 1,
        }),
        'state=Closed',
      );
      const labelHint =
        byLabel.data.records.length === 0 &&
        (byLabel.hints ?? []).some((h: string) => /label of state choice/.test(h));

      // How long an IN list ServiceNow really accepts. The URL limit is ServiceNow's, not ours:
      // measure it instead of assuming one, and check that going over it is explained.
      const inQuery = (items: number) =>
        `sys_idIN${Array.from({ length: items }, (_, i) => i.toString(16).padStart(32, 'f')).join(',')}`;
      const inAccepted = async (items: number): Promise<boolean> => {
        const r = await call('query_records', {
          scope_id: scope,
          table: 'incident',
          encoded_query: inQuery(items),
          fields: ['sys_id'],
          limit: 1,
        });
        if (!r?.error) return true;
        expectThat(
          r.error.code === 'SN_API_ERROR' && /HTTP 414.*Split long IN lists/.test(r.error.message),
          `IN list of ${items} sys_ids: ${r.error.code}: ${r.error.message}`,
        );
        return false;
      };
      // 239 sys_ids is the most the raw query bound lets through.
      let accepted = 100;
      let refused414: number | null = 240;
      expectThat(await inAccepted(accepted), `IN list of ${accepted} sys_ids was refused`);
      if (await inAccepted(239)) {
        accepted = 239;
        refused414 = null;
      } else {
        refused414 = 239;
        while (refused414 - accepted > 1) {
          const middle = Math.floor((accepted + refused414) / 2);
          if (await inAccepted(middle)) accepted = middle;
          else refused414 = middle;
        }
      }

      // ref_ downcast: every row must really have the downcast field set.
      const os = 'cmdb_ci.ref_cmdb_ci_computer.os';
      const down = await call('query_records', {
        scope_id: scope,
        table: 'incident',
        encoded_query: `${os}ISNOTEMPTY`,
        fields: [os],
        limit: 50,
      });
      // Not every instance has the table or incident.cmdb_ci: report it, don't fail on it.
      const downcastAvailable = down?.error?.code !== 'INVALID_FIELD';
      if (downcastAvailable) ok(down, 'ref_ downcast');
      const rows = (downcastAvailable ? down.data.records : []) as Record<string, unknown>[];
      const value = (v: unknown) =>
        v && typeof v === 'object' && 'v' in v ? (v as { v: unknown }).v : v;
      expectThat(
        rows.every((r) => value(r[os]) !== '' && value(r[os]) !== undefined),
        'ref_ downcast returned rows without the field: ServiceNow may have ignored it',
      );
      return {
        totals,
        all_incidents: all,
        relative,
        scripted,
        native_quarter_rows: nativeQuarter,
        label_hint: labelHint,
        long_in_accepted_items: accepted,
        long_in_accepted_query_chars: inQuery(accepted).length,
        long_in_accepted_encoded_chars: new URLSearchParams({
          sysparm_query: inQuery(accepted),
        }).toString().length,
        long_in_refused_items: refused414,
        downcast_available: downcastAvailable,
        downcast_rows: rows.length,
      };
    },
  },
  {
    name: 'every query the condition builder writes runs (T-049)',
    run: async (call, scope) => {
      const { rows } = JSON.parse(
        readFileSync(
          new URL('../../packages/shared/test/fixtures/ui-queries.json', import.meta.url),
          'utf8',
        ),
      ) as { rows: { category: string; condition: string; query: string }[] };
      const count = async (encoded_query?: string): Promise<Result> =>
        call('query_records', {
          scope_id: scope,
          table: 'cmdb_ci',
          ...(encoded_query ? { encoded_query } : {}),
          fields: ['sys_id'],
          limit: 1,
          include_total: true,
        });
      const described = await call('describe_table', { scope_id: scope, table: 'cmdb_ci' });
      const hasField = (described?.data?.fields ?? []).some(
        (f: { name?: string }) => f.name === 'first_discovered',
      );
      if (!hasField) return { skipped: 'no cmdb_ci.first_discovered here' };
      const all = ok(await count(), 'all rows').page.total as number;
      const results: Record<string, number> = {};
      const failures: string[] = [];
      for (const r of rows) {
        const res = await count(r.query);
        if (res?.ok === true) results[r.query] = res.page.total;
        else failures.push(`${r.query}: ${res?.error?.code} ${res?.error?.message}`);
      }
      expectThat(
        failures.length === 0,
        `${failures.length} refused: ${failures.slice(0, 5).join(' | ')}`,
      );
      // Pairs whose counts must add up, so that a term ServiceNow ignores or misreads shows.
      const pairs: [string, string][] = [
        ['first_discoveredISEMPTY', 'first_discoveredISNOTEMPTY'],
        ['assigned_toISEMPTY', 'assigned_toISNOTEMPTY'],
      ];
      for (const [a, b] of pairs) {
        expectThat(
          results[a] !== undefined && results[b] !== undefined && results[a] + results[b] === all,
          `${a} + ${b}: ${results[a]} + ${results[b]} of ${all}`,
        );
      }
      expectThat(results.first_discoveredANYTHING === all, 'ANYTHING must match every row');
      return { queries: rows.length, all_rows: all, counts: results };
    },
  },
  {
    name: 'compare_records: two records on one instance (T-042)',
    run: async (call, scope) => {
      const table = 'sys_script_include';
      const listed = ok(
        await call('query_records', {
          scope_id: scope,
          table,
          where: [{ field: 'active', op: '=', value: true }],
          fields: ['name'],
          limit: 2,
        }),
        'list',
      );
      expectThat(listed.data.records.length === 2, 'needs two active script includes');
      const [x, y] = listed.data.records.map((r: { sys_id: string }) => r.sys_id) as string[];
      expectThat(x !== y, 'the list returned one record twice');
      const base = { scope_id: scope, table };

      const noB = await call('compare_records', { ...base, match_a: { sys_id: x } });
      expectThat(noB?.error?.code === 'INVALID_INPUT', `no match_b: ${noB?.error?.code ?? 'data'}`);
      const self = await call('compare_records', {
        ...base,
        match_a: { sys_id: x },
        match_b: { sys_id: x },
      });
      expectThat(self?.error?.code === 'INVALID_INPUT', `itself: ${self?.error?.code ?? 'data'}`);
      const amb = await call('compare_records', {
        ...base,
        match_a: { sys_id: x },
        match_b: { active: true },
      });
      expectThat(
        amb?.error?.code === 'AMBIGUOUS_MATCH' && amb.error.side === 'b',
        `ambiguous side b: ${amb?.error?.code ?? 'data'} ${amb?.error?.side}`,
      );
      const none = await call('compare_records', {
        ...base,
        match_a: { name: 'zz_no_such_script_include_zz' },
        match_b: { sys_id: y },
      });
      expectThat(
        none?.error?.code === 'NOT_FOUND' && none.error.side === 'a',
        `absent side a: ${none?.error?.code ?? 'data'} ${none?.error?.side}`,
      );

      const c = await compareAll(call, scope, {
        table,
        match_a: { sys_id: x },
        match_b: { sys_id: y },
        fields: ['name', 'script', 'active'],
      });
      const { a, b } = c.first.data;
      expectThat(a.sys_id === x && b.sys_id === y, 'the sides are not the records asked for');
      expectThat(a.instance === b.instance && a.host === b.host, 'the sides differ in instance');
      expectThat(
        !String(c.first.provenance.instance).includes(','),
        'provenance names more than one instance',
      );
      expectThat(c.last.complete === true || c.cut > 0, 'incomplete with nothing cut');
      const scriptLines = c.lines.get('script');
      let applied = false;
      if (scriptLines && c.cut === 0) {
        const read = (sys_id: string) =>
          readField(call, { scope_id: scope, table, sys_id, field: 'script' });
        expectThat(
          applyUnified(await read(x as string), scriptLines) === (await read(y as string)),
          'the script diff does not apply back',
        );
        applied = true;
      }
      return {
        pages: c.pages,
        script_diff_lines: scriptLines?.length ?? 0,
        script_diff_applied: applied,
        inline_fields: c.inline.length,
        lines_cut: c.cut,
      };
    },
  },
  {
    // Read the metrics. A pass needs a script that really changed, and a diff that applied back
    // exactly: the first live run passed with no diff, and the second with a raw diff that may not
    // have touched the script. An element diff is preferred; `mode` "raw" means the payload isn't
    // in the expected form, and `raw_shapes` says why, with names only.
    name: 'compare_records: two versions from sys_update_version (T-042)',
    run: async (call, scope) => {
      const table = 'sys_update_version';
      const dictionary: { name: string; type?: string }[] = [];
      await walk(call, 'describe_table', { table }, scope, (r) => {
        dictionary.push(...r.data.fields);
        return false;
      });
      const names = new Set(dictionary.map((f) => f.name));
      const missing = ASSUMED_VERSION_FIELDS.filter((f) => !names.has(f));
      for (const needed of ['name', 'payload']) {
        expectThat(names.has(needed), `${table} has no ${needed} field`);
      }

      const payloadInfo = dictionary.find((f) => f.name === 'payload');
      const comparePair = async (name: unknown, versions: number) => {
        const rows = ok(
          await call('query_records', {
            scope_id: scope,
            table,
            where: [{ field: 'name', op: '=', value: name }],
            order_by: [{ field: 'sys_created_on', direction: 'desc' }],
            fields: ['name'],
            limit: 2,
          }),
          'versions',
        ).data.records as { sys_id: string }[];
        expectThat(rows.length === 2, `counted ${versions} versions, listed ${rows.length}`);
        const older = (rows[1] as { sys_id: string }).sys_id;
        const newer = (rows[0] as { sys_id: string }).sys_id;

        const c = await compareAll(call, scope, {
          table,
          match_a: { sys_id: older },
          match_b: { sys_id: newer },
        });
        const read = (sys_id: string) =>
          readField(call, { scope_id: scope, table, sys_id, field: 'payload' });
        const rawA = await read(older);
        const rawB = await read(newer);
        const a = parseUpdatePayload(rawA);
        const b = parseUpdatePayload(rawB);

        const compared = [...c.lines.keys(), ...c.inline.map((f) => f.field)];
        const fromElements = (f: string) => f.startsWith('payload.');
        const mode =
          compared.some(fromElements) || [...c.ignored].some(fromElements)
            ? 'elements'
            : compared.includes('payload')
              ? 'raw'
              : 'payload_equal';
        expectThat(
          mode !== 'raw' || !a || !b || a.table !== b.table,
          'the payloads parse here, but were compared as raw text',
        );
        expectThat(
          mode !== 'elements' || (a !== undefined && b !== undefined),
          'compared by element, but the payloads do not parse here',
        );

        // Every diff must rebuild the newer value from the older one. A cut line can't.
        let applied = 0;
        if (c.cut === 0) {
          for (const [field, lines] of c.lines) {
            const [before, after] =
              field === 'payload'
                ? [rawA, rawB]
                : fromElements(field)
                  ? [a?.fields.get(field.slice(8)), b?.fields.get(field.slice(8))]
                  : [undefined, undefined];
            if (before === undefined || after === undefined) continue;
            expectThat(
              applyUnified(before, lines) === after,
              `the ${field} diff does not apply back`,
            );
            applied++;
          }
        }

        const metrics = {
          mode,
          versions_of_record: versions,
          record_table: a?.table,
          assumed_fields_missing: missing,
          payload_type: payloadInfo?.type,
          payload_chars: [rawA.length, rawB.length],
          payload_lines: [rawA.split('\n').length, rawB.split('\n').length],
          payload_root: /^(?:<\?[^>]*\?>)?\s*<([\w.:-]+)/.exec(rawA)?.[1],
          payload_has_cdata: rawA.includes('<![CDATA['),
          payload_elements: a?.fields.size,
          pages: c.pages,
          diff_fields: c.lines.size,
          diffs_applied: applied,
          script_diff_lines: c.lines.get('payload.script')?.length ?? 0,
          inline_fields: c.inline.length,
          inline_field_names: c.inline.map((f) => f.field),
          only_on_one_side: c.only.length,
          ignored_fields: c.ignored.size,
          lines_cut: c.cut,
        };
        // Whether a raw diff includes a script change, read from the XML itself.
        const scriptOf = (xml: string) => /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(xml)?.[1];
        const rawScriptChanged = mode === 'raw' && scriptOf(rawA) !== scriptOf(rawB);
        return {
          metrics: {
            ...metrics,
            ...(mode === 'raw' ? { raw_script_changed: rawScriptChanged } : {}),
          },
          byElement: c.lines.has('payload.script') && applied > 0,
          byRaw: c.lines.has('payload') && applied > 0 && rawScriptChanged,
          shapes: mode === 'raw' ? [describePayload(rawA), describePayload(rawB)] : undefined,
        };
      };

      const seen = new Set<unknown>();
      let checked = 0;
      let last: Record<string, unknown> | undefined;
      let rawProof: Record<string, unknown> | undefined;
      const rawShapes: unknown[] = [];
      const summary = () => ({
        pairs_checked: checked,
        pairs_raw: rawShapes.length,
        raw_shapes: rawShapes.slice(0, 5),
      });
      for (const prefix of ['sys_script_include_', 'sys_script_', 'sys_']) {
        const r = ok(
          await call('aggregate_records', {
            scope_id: scope,
            table,
            where: [{ field: 'name', op: 'starts_with', value: prefix }],
            group_by: ['name'],
          }),
          'versions per record',
        );
        // Largest first, so the first count under 2 ends this page's candidates.
        for (const g of r.data.groups) {
          if (g.count < 2 || checked >= MAX_VERSION_PAIRS) break;
          const name = rawOf(g.group.name);
          // A record under the first prefix is also under the wider ones.
          if (seen.has(name)) continue;
          seen.add(name);
          const pair = await comparePair(name, g.count);
          checked++;
          last = pair.metrics;
          if (pair.shapes) rawShapes.push(pair.shapes);
          if (pair.byElement) return { ...pair.metrics, ...summary() };
          if (pair.byRaw) rawProof ??= pair.metrics;
        }
      }
      if (!last) {
        throw new Skip(
          'No record has two versions yet. Save a script include twice on this instance, then run this again.',
        );
      }
      if (rawProof) return { ...rawProof, ...summary() };
      throw new Skip(
        `Compared the newest two versions of ${checked} records, and none changed a script. Change a script include's script on this instance, save it, then run this again.`,
        { ...last, ...summary() },
      );
    },
  },
];

export async function runScenarios(
  call: Call,
  scope: string,
  log: (line: string) => void = () => {},
  only?: string,
): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of SCENARIOS.filter(
    (x) => !only || only.split(',').some((o) => x.name.includes(o)),
  )) {
    const measure: Measure = { calls: 0, max_result_chars: 0, requests_used: 0 };
    let result: ScenarioResult;
    try {
      const metrics = await s.run(metered(call, measure), scope);
      result = { name: s.name, status: 'pass', metrics, measure };
    } catch (e) {
      const skip = e instanceof Skip;
      result = {
        name: s.name,
        status: skip ? 'skip' : 'fail',
        note: (e as Error).message.slice(0, 400),
        ...(e instanceof Skip && e.metrics ? { metrics: e.metrics } : {}),
        measure,
      };
    }
    out.push(result);
    log(
      `${result.status.toUpperCase().padEnd(5)} ${s.name}${result.note ? ` — ${result.note}` : ''}`,
    );
  }
  return out;
}
