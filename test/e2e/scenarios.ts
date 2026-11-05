/**
 * The T-034 scenarios: every tool against a real instance. They take a `call` function, so the
 * same code runs live (`live.ts`) and in a mocked check of its own logic (never evidence of
 * connectivity; rule 11).
 *
 * Results hold only shapes, counts and sizes: no record content, sys_ids or field values, so the
 * evidence file can be committed.
 */

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
class Skip extends Error {}

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

/** Tables named in skills/servicenow-troubleshooting/references (T-038). */
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
  'reconciliation_definition',
  'sys_object_source',
  'cmdb_datasource',
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
      const seen: string[] = [];
      for (const search of ['x_', 'u_']) {
        const r = ok(
          await call('discover_tables', { scope_id: scope, search, limit: 25 }),
          'search',
        );
        seen.push(...r.data.records.map((t: { name: string }) => t.name));
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
      const target = 2500;
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
          return rows >= target;
        },
      );
      if (rows < 2100) throw new Skip(`syslog has only ${rows} readable rows`);
      expectThat(ids.size === rows, `${rows - ids.size} duplicate rows`);
      return { rows, pages };
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
      const started = Date.now();
      const { pages, last } = await walk(
        call,
        'get_related_records',
        { table: 'cmdb_ci', sys_id: ci.data.records[0].sys_id, samples: 1 },
        scope,
        (r) => {
          relations += r.data.relations.length;
          withRecords += r.data.relations.filter((x: { count: number }) => x.count > 0).length;
          return false;
        },
      );
      const unreadable = (last.omitted ?? []).filter(
        (o: { kind: string }) => o.kind === 'relation',
      );
      return {
        relation_count: last.data.relation_count,
        relations_returned: relations,
        with_records: withRecords,
        pages,
        unreadable_on_last_page: unreadable.length,
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
      return { checked: SKILL_TABLES.length, missing };
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
        [
          { table: 'incident', encoded_query: 'short_descriptionLIKEjavascript:gs.log(1)' },
          'UNSAFE_QUERY',
        ],
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
];

export async function runScenarios(
  call: Call,
  scope: string,
  log: (line: string) => void = () => {},
): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
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
