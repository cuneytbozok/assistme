/**
 * T-028: aggregate_records through the Stats API (in-memory fake; mock only). Every operation
 * also passes the extension's real request builder (see mcp-harness).
 */
import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../extension/src/background/request-builder.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness } from './mcp-harness.js';

function withIncidents(): FakeServiceNow {
  const sn = dictionaryFixture();
  const rows: [string, string][] = [
    ['1', 'db'],
    ['1', 'db'],
    ['1', 'net'],
    ['2', 'db'],
    ['3', 'net'],
    ['3', 'net'],
    ['3', 'net'],
    ['3', 'hw'],
  ];
  rows.forEach(([priority, category], i) => {
    sn.insert('incident', { number: `I${i}`, priority, category, state: String(i) });
  });
  return sn;
}

describe('T-028 aggregate_records', () => {
  it('a plain count, with a filter, reads no rows', async () => {
    const h = await harness({ sn: withIncidents() });
    const scope = await claim(h, 'dev');
    const all = await h.call('aggregate_records', { scope_id: scope, table: 'incident' });
    expect(all).toMatchObject({ ok: true, complete: true });
    expect(all.data.count).toBe(8);
    expect(all.provenance.source).toBe('stats incident');
    const some = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      where: [{ field: 'category', op: '=', value: 'db' }],
    });
    expect(some.data.count).toBe(3);
    const again = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      where: [{ field: 'category', op: '=', value: 'db' }],
    });
    expect(again.requests_used).toBe(1); // the dictionary is cached by now
    expect(h.dataRequests.every((r) => r.kind === 'stats.aggregate')).toBe(true);
    await h.close();
  });

  it('groups are compact and sorted by count; two group fields work', async () => {
    const h = await harness({ sn: withIncidents() });
    const scope = await claim(h, 'dev');
    const r = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      group_by: ['priority'],
    });
    expect(r.complete).toBe(true);
    expect(r.data.groups).toEqual([
      { group: { priority: '3' }, count: 4 },
      { group: { priority: '1' }, count: 3 },
      { group: { priority: '2' }, count: 1 },
    ]);
    const two = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      group_by: ['priority', 'category'],
    });
    expect(two.data.group_count).toBe(5);
    expect(two.data.groups[0]).toEqual({ group: { priority: '3', category: 'net' }, count: 3 });
    await h.close();
  });

  it('aggregates come back as numbers, per group and overall', async () => {
    const h = await harness({ sn: withIncidents() });
    const scope = await claim(h, 'dev');
    const r = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      aggregates: [
        { fn: 'max', field: 'state' },
        { fn: 'avg', field: 'state' },
      ],
    });
    expect(r.data).toMatchObject({ count: 8, max: { state: 7 }, avg: { state: 3.5 } });
    const g = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      group_by: ['category'],
      aggregates: [{ fn: 'sum', field: 'state' }],
    });
    expect(
      g.data.groups.find((x: { group: { category: string } }) => x.group.category === 'hw'),
    ).toEqual({
      group: { category: 'hw' },
      count: 1,
      sum: { state: 7 },
    });
    await h.close();
  });

  it('shows display values when the API gives them', async () => {
    const h = await harness({ sn: withIncidents() });
    const scope = await claim(h, 'dev');
    const stats = h.sn.stats.bind(h.sn);
    h.sn.stats = (req) =>
      (stats(req) as { groupby_fields: { value: string }[] }[]).map((row) => ({
        ...row,
        groupby_fields: row.groupby_fields.map((g) => ({ ...g, display_value: `P${g.value}` })),
      }));
    const r = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      group_by: ['priority'],
    });
    expect(r.data.groups[0].group).toEqual({ priority: { v: '3', d: 'P3' } });
    await h.close();
  });

  it('2,000 groups are fully retrievable through cursors, in order, each exactly once', async () => {
    const sn = dictionaryFixture();
    for (let g = 0; g < 2000; g++) {
      for (let k = 0; k < (g % 5) + 1; k++)
        sn.insert('incident', { number: `n${g}`, category: `c${g}` });
    }
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const seen: { group: { category: string }; count: number }[] = [];
    let r = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      group_by: ['category'],
    });
    let calls = 1;
    for (;;) {
      seen.push(...r.data.groups);
      expect(JSON.stringify(r).length).toBeLessThan(24_000);
      if (!r.page.next_cursor) break;
      expect(r.complete).toBe(false);
      expect(r.omitted[0]).toMatchObject({
        kind: 'groups',
        reason: 'response_budget',
        next: { tool: 'aggregate_records', args: { scope_id: scope, cursor: r.page.next_cursor } },
      });
      r = await h.call(r.omitted[0].next.tool, r.omitted[0].next.args);
      calls++;
    }
    expect(calls).toBeGreaterThan(1);
    expect(r.complete).toBe(true);
    expect(seen).toHaveLength(2000);
    expect(new Set(seen.map((x) => x.group.category)).size).toBe(2000);
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i - 1] as { count: number }).count).toBeGreaterThanOrEqual(
        (seen[i] as { count: number }).count,
      );
    }
    await h.close();
  });

  it('validation: unknown, password and denied are refused before any read; cursors are strict', async () => {
    const h = await harness({ sn: withIncidents() });
    const scope = await claim(h, 'dev');
    for (const [args, code] of [
      [{ table: 'incident', group_by: ['zz_nope'] }, 'INVALID_FIELD'],
      [{ table: 'incident', aggregates: [{ fn: 'sum', field: 'zz_nope' }] }, 'INVALID_FIELD'],
      [{ table: 'incident', where: [{ field: 'zz_nope', op: '=', value: 1 }] }, 'INVALID_FIELD'],
      [{ table: 'sys_user', group_by: ['user_password'] }, 'FORBIDDEN_OPERATION'],
      [{ table: 'discovery_credentials' }, 'TABLE_DENIED'],
      [{ table: 'incident', encoded_query: 'priority=1^RLQUERYx' }, 'UNSAFE_QUERY'],
      [{}, 'INVALID_INPUT'],
    ] as const) {
      const r = await h.call('aggregate_records', { scope_id: scope, ...args });
      expect(r.error?.code ?? 'ok', JSON.stringify(args)).toBe(code);
    }
    expect(h.dataRequests).toEqual([]);
    const tampered = await h.call('aggregate_records', { scope_id: scope, cursor: 'a.b' });
    expect(tampered.error.code).toBe('INVALID_INPUT');
    await h.close();
  });

  it('high-volume tables get no default ORDERBY: aggregates read no rows', async () => {
    const sn = dictionaryFixture();
    sn.insert('sys_db_object', { name: 'syslog', label: 'Log', super_class: '' });
    sn.insert('sys_dictionary', {
      name: 'syslog',
      element: 'sys_created_on',
      column_label: 'c',
      internal_type: 'glide_date_time',
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('aggregate_records', { scope_id: scope, table: 'syslog' });
    expect(r.ok).toBe(true);
    expect(r.hints).toBeUndefined();
    const call = sn.calls.filter((c) => c.table === 'syslog').at(-1);
    expect(call?.query).toBe('');
    await h.close();
  });

  it('the extension builds a stats GET with exactly the allowlisted parameters', () => {
    const b = buildRequest(
      'dev.service-now.com',
      {
        kind: 'stats.aggregate',
        table: 'incident',
        query: 'priority=1',
        groupBy: ['category'],
        aggregates: [{ fn: 'avg', field: 'state' }],
        displayValue: 'all',
      },
      'tok',
    );
    const u = new URL(b.url);
    expect(b.init.method).toBe('GET');
    expect(u.pathname).toBe('/api/now/stats/incident');
    expect(u.searchParams.get('sysparm_group_by')).toBe('category');
    expect(u.searchParams.get('sysparm_avg_fields')).toBe('state');
    expect(u.searchParams.get('sysparm_count')).toBe('true');
  });
});
