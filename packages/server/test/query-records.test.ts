/**
 * T-024: query_records with structured filters, raw queries, text search, ordering and display
 * modes, on top of T-023 paging (in-memory ServiceNow fake; mock only).
 */
import { describe, expect, it } from 'vitest';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness, walk, withIncidents } from './mcp-harness.js';

const ids = (r: { data: { records: { sys_id: string }[] } }) => r.data.records.map((x) => x.sys_id);

function withSyslog(sn: FakeServiceNow, rows: number): FakeServiceNow {
  sn.insert('sys_db_object', { name: 'syslog', label: 'System Log', super_class: '' });
  for (const [element, type] of [
    ['message', 'string'],
    ['source', 'string'],
    ['level', 'integer'],
    ['sys_created_on', 'glide_date_time'],
  ] as const) {
    sn.insert('sys_dictionary', {
      name: 'syslog',
      element,
      internal_type: type,
      column_label: element,
      reference: '',
      max_length: '4000',
      mandatory: 'false',
      display: 'false',
    });
  }
  for (let i = 0; i < rows; i++) {
    sn.insert('syslog', {
      message: `event ${i}${i % 10 === 0 ? ' timeout' : ''}`,
      source: i % 2 ? 'sync' : 'mail',
      level: String(i % 3),
      sys_created_on: `2024-11-${String(1 + (i % 28)).padStart(2, '0')} 10:00:00`,
    });
  }
  return sn;
}

describe('AC1: all T-018 validation and defaults apply through the tool', () => {
  it('invalid fields anywhere are rejected before any data read', async () => {
    const h = await harness({ sn: withIncidents(10) });
    const scope = await claim(h, 'dev');
    for (const args of [
      { where: [{ field: 'zz_no_such_field_zz', op: '=', value: '1' }] },
      { encoded_query: 'zz_no_such_field_zz=1' },
      { order_by: [{ field: 'prioriti', direction: 'asc' }] },
      { where: [{ field: 'caller_id.departmnt.name', op: '=', value: 'x' }] },
    ]) {
      const r = await h.call('query_records', { scope_id: scope, table: 'incident', ...args });
      expect(r.error?.code, JSON.stringify(args)).toBe('INVALID_FIELD');
    }
    expect(h.dataRequests).toEqual([]);
    await h.close();
  });

  it('unsafe raw queries, mixed inputs and raw+order are refused', async () => {
    const h = await harness({ sn: withIncidents(10) });
    const scope = await claim(h, 'dev');
    const bad = [
      [{ encoded_query: 'priority=1^RLQUERYsys_user' }, 'UNSAFE_QUERY'],
      [
        { encoded_query: 'priority=1', where: [{ field: 'priority', op: '=', value: 1 }] },
        'INVALID_INPUT',
      ],
      [
        { encoded_query: 'priority=1', order_by: [{ field: 'number', direction: 'asc' }] },
        'INVALID_INPUT',
      ],
      [
        {
          where: [{ field: 'priority', op: '=', value: 1 }],
          any_of: [
            [{ field: 'priority', op: '=', value: 1 }],
            [{ field: 'priority', op: '=', value: 2 }],
          ],
        },
        'INVALID_INPUT',
      ],
      [{ where: [{ field: 'priority', op: '=', value: 'a^ORpriority=2' }] }, 'UNSAFE_QUERY'],
    ] as const;
    for (const [args, code] of bad) {
      const r = await h.call('query_records', { scope_id: scope, table: 'incident', ...args });
      expect(r.error?.code ?? 'ok', JSON.stringify(args)).toMatch(
        code === 'UNSAFE_QUERY' ? /^(UNSAFE_QUERY|INVALID_INPUT)$/ : new RegExp(`^${code}$`),
      );
    }
    expect(h.dataRequests).toEqual([]);
    await h.close();
  });

  it('high-volume defaults: newest first and hints, never refused; a user order wins', async () => {
    const h = await harness({ sn: withSyslog(dictionaryFixture(), 50) });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'syslog',
      fields: ['message', 'sys_created_on'],
    });
    expect(r.ok).toBe(true);
    expect(r.hints.join(' ')).toMatch(/newest first/);
    expect(r.hints.join(' ')).toMatch(/No selective condition/);
    const dates = r.data.records.map((x: { sys_created_on: string }) => x.sys_created_on);
    expect([...dates].sort().reverse()).toEqual(dates);
    const contains = await h.call('query_records', {
      scope_id: scope,
      table: 'syslog',
      where: [{ field: 'message', op: 'contains', value: 'timeout' }],
    });
    expect(contains.ok).toBe(true);
    expect(contains.hints.join(' ')).toMatch(/contains/);
    const old = await h.call('query_records', {
      scope_id: scope,
      table: 'syslog',
      where: [
        {
          field: 'sys_created_on',
          op: 'between',
          value: ['2024-11-01 00:00:00', '2024-11-05 23:59:59'],
        },
      ],
      order_by: [{ field: 'sys_created_on', direction: 'asc' }],
    });
    expect(old.ok).toBe(true);
    const asc = old.data.records.map((x: { sys_created_on: string }) => x.sys_created_on);
    expect([...asc].sort()).toEqual(asc);
    expect(h.sn.calls.filter((c) => c.table === 'syslog').at(-1)?.query).toMatch(
      /ORDERBYsys_created_on\^ORDERBYsys_id$/,
    );
    await h.close();
  });

  it('text search: the `text` parameter, or 123TEXTQUERY321 in encoded_query (T-047)', async () => {
    const h = await harness({ sn: withSyslog(dictionaryFixture(), 40) });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'syslog',
      text: 'timeout',
      fields: ['message'],
    });
    expect(r.ok).toBe(true);
    expect(r.data.records.length).toBe(4);
    expect(h.sn.calls.find((c) => c.table === 'syslog')?.query).toMatch(/^123TEXTQUERY321=timeout/);
    const raw = await h.call('query_records', {
      scope_id: scope,
      table: 'syslog',
      encoded_query: '123TEXTQUERY321=timeout',
    });
    expect(raw.ok).toBe(true);
    expect(raw.data.records.length).toBe(4);
    const both = await h.call('query_records', {
      scope_id: scope,
      table: 'syslog',
      text: 'timeout',
      encoded_query: 'level=2',
    });
    expect(both.error.code).toBe('INVALID_INPUT');
    expect(both.error.hint).toMatch(/123TEXTQUERY321=<words>\^/);
    // aggregate_records has no text search, also not through encoded_query.
    const agg = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'syslog',
      encoded_query: '123TEXTQUERY321=timeout',
    });
    expect(agg.error.code).toBe('UNSAFE_QUERY');
    await h.close();
  });
});

describe('AC2: continuing needs only {scope_id, cursor}; limit 1000 is delivered in budget-sized results', () => {
  it('1,000 rows', async () => {
    const h = await harness({ sn: withIncidents(1500) });
    const scope = await claim(h, 'dev');
    const responses = await walk(h, scope, {
      table: 'incident',
      limit: 1000,
      where: [{ field: 'priority', op: 'in', value: ['1', '2', '3', '4'] }],
      fields: ['number', 'short_description', 'priority'],
    });
    expect(responses.length).toBeGreaterThan(1); // budget-sized results
    for (const r of responses.slice(0, -1)) expect(JSON.stringify(r).length).toBeLessThan(26_000);
    const all = responses.flatMap((r) => ids(r));
    // The first call's limit is 1000: rows keep coming until 1000 per cursor chain call... then
    // the next call with the cursor continues with the same limit. Count the first 1000.
    expect(new Set(all).size).toBe(all.length);
    expect(all.slice(0, 1000)).toEqual(
      (h.sn.tables.get('incident') ?? [])
        .map((x) => x.sys_id)
        .sort()
        .slice(0, 1000),
    );
    expect(responses.every((r) => r.ok)).toBe(true);
    await h.close();
  }, 60_000);
});

describe('AC3: include_total adds total', () => {
  it('total only when asked', async () => {
    const h = await harness({ sn: withIncidents(30) });
    const scope = await claim(h, 'dev');
    const without = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      where: [{ field: 'priority', op: '=', value: '1' }],
    });
    expect(without.page.total).toBeNull();
    const withTotal = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      where: [{ field: 'priority', op: '=', value: '1' }],
      include_total: true,
      limit: 2,
    });
    expect(withTotal.page).toMatchObject({ total: 8, returned: 2, has_more: true });
    await h.close();
  });
});

describe('AC4: completeness invariant across filtered queries', () => {
  it('random filters, limits and budgets', async () => {
    let seed = 5;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const filters = [
      { where: [{ field: 'priority', op: '=', value: '2' }] },
      {
        where: [
          {
            or: [
              { field: 'priority', op: '=', value: '1' },
              { field: 'priority', op: '=', value: '4' },
            ],
          },
        ],
      },
      {
        any_of: [
          [{ field: 'priority', op: '=', value: '3' }],
          [{ field: 'number', op: 'ends_with', value: '7' }],
        ],
      },
      { encoded_query: 'priority!=1^short_descriptionLIKEIncident' },
      { where: [{ field: 'short_description', op: 'contains', value: 'Long' }] },
      {},
    ];
    for (let t = 0; t < 12; t++) {
      const sn = withIncidents(Math.floor(rnd() * 300), 9);
      const h = await harness({
        sn,
        env: { SN_MCP_PAGE_SIZE: String(1 + Math.floor(rnd() * 60)) },
      });
      const scope = await claim(h, 'dev');
      const f = filters[t % filters.length] as Record<string, unknown>;
      const responses = await walk(h, scope, {
        table: 'incident',
        limit: 1 + Math.floor(rnd() * 120),
        max_chars: 4000 + Math.floor(rnd() * 12000),
        ...f,
      });
      for (const r of responses) {
        expect(r.ok).toBe(true);
        const missing = r.page.has_more || (r.omitted ?? []).length > 0;
        expect(r.complete).toBe(!missing);
        if (r.page.has_more)
          expect(r.omitted.find((o: { kind: string }) => o.kind === 'rows').next.args).toEqual({
            scope_id: scope,
            cursor: r.page.next_cursor,
          });
      }
      const got = responses.flatMap((r) => ids(r));
      expect(new Set(got).size).toBe(got.length);
      await h.close();
    }
  }, 120_000);
});

describe('AC5: structured and raw inputs give equivalent results', () => {
  const pairs: [string, Record<string, unknown>, string][] = [
    ['equals', { where: [{ field: 'priority', op: '=', value: '1' }] }, 'priority=1'],
    ['not equals', { where: [{ field: 'priority', op: '!=', value: '1' }] }, 'priority!=1'],
    [
      'or group',
      {
        where: [
          {
            or: [
              { field: 'priority', op: '=', value: '1' },
              { field: 'priority', op: '=', value: '3' },
            ],
          },
        ],
      },
      'priority=1^ORpriority=3',
    ],
    ['in', { where: [{ field: 'priority', op: 'in', value: ['2', '4'] }] }, 'priorityIN2,4'],
    [
      'contains',
      { where: [{ field: 'short_description', op: 'contains', value: 'nt 1' }] },
      'short_descriptionLIKEnt 1',
    ],
    [
      'starts_with',
      { where: [{ field: 'number', op: 'starts_with', value: 'INC000001' }] },
      'numberSTARTSWITHINC000001',
    ],
    [
      'and',
      {
        where: [
          { field: 'priority', op: '=', value: '2' },
          { field: 'number', op: 'ends_with', value: '5' },
        ],
      },
      'priority=2^numberENDSWITH5',
    ],
    [
      'any_of',
      {
        any_of: [
          [{ field: 'priority', op: '=', value: '1' }],
          [{ field: 'number', op: '=', value: 'INC0000003' }],
        ],
      },
      'priority=1^NQnumber=INC0000003',
    ],
    [
      'order desc',
      {
        where: [{ field: 'priority', op: '=', value: '1' }],
        order_by: [{ field: 'number', direction: 'desc' }],
      },
      'priority=1^ORDERBYDESCnumber',
    ],
  ];
  it.each(pairs)('%s', async (_n, structured, raw) => {
    const h = await harness({ sn: withIncidents(120) });
    const scope = await claim(h, 'dev');
    const a = await walk(h, scope, {
      table: 'incident',
      limit: 500,
      fields: ['number'],
      ...structured,
    });
    const b = await walk(h, scope, {
      table: 'incident',
      limit: 500,
      fields: ['number'],
      encoded_query: raw,
    });
    expect(a.flatMap(ids).length).toBeGreaterThan(0);
    expect(a.flatMap(ids)).toEqual(b.flatMap(ids));
    await h.close();
  });
});

describe('display_value and cursors', () => {
  it('display_value false returns raw values; a cursor rejects query inputs', async () => {
    const h = await harness({ sn: withIncidents(30) });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      display_value: 'false',
      limit: 5,
    });
    expect(r.ok).toBe(true);
    expect(h.dataRequests.every((d) => d.displayValue === 'false')).toBe(true);
    const def = await harness({ sn: withIncidents(3) });
    const s2 = await claim(def, 'dev');
    await def.call('query_records', { scope_id: s2, table: 'incident' });
    expect(def.dataRequests[0]?.displayValue).toBe('all');
    await def.close();
    for (const extra of [
      { where: [{ field: 'priority', op: '=', value: '1' }] },
      { encoded_query: 'priority=1' },
      { text: 'x' },
      { order_by: [{ field: 'number', direction: 'asc' }] },
      { display_value: 'true' },
    ]) {
      expect(
        (await h.call('query_records', { scope_id: scope, cursor: r.page.next_cursor, ...extra }))
          .error.code,
      ).toBe('INVALID_INPUT');
    }
    const next = await h.call('query_records', { scope_id: scope, cursor: r.page.next_cursor });
    expect(next.ok).toBe(true);
    await h.close();
  });
});
