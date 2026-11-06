/**
 * T-018: dictionary-aware validation and cost-aware defaults (mocked dictionary).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGH_VOLUME_TABLES, isHighVolume, loadConfig } from '../src/config.js';
import { type MetaContext, MetadataService } from '../src/mcp/metadata.js';
import { planQuery, type QueryRequest } from '../src/mcp/query-guard.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';

function withSyslog(sn: FakeServiceNow): FakeServiceNow {
  sn.insert('sys_db_object', { name: 'syslog', label: 'System Log', super_class: '' });
  for (const [element, type] of [
    ['message', 'string'],
    ['source', 'string'],
    ['level', 'integer'],
    ['sys_created_on', 'glide_date_time'],
    ['sys_id', 'GUID'],
  ] as const) {
    sn.insert('sys_dictionary', {
      name: 'syslog',
      element,
      internal_type: type,
      column_label: element,
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
  }
  return sn;
}

function setup() {
  const sn = withSyslog(dictionaryFixture());
  const ctx: MetaContext = {
    instanceKey: 'dev',
    fetch: async (req) => ({ ok: true, rows: sn.list(req).rows }),
  };
  const meta = new MetadataService();
  const plan = (req: QueryRequest, allowTextSearch = true) =>
    planQuery(meta, ctx, req, { highVolumeTables: DEFAULT_HIGH_VOLUME_TABLES, allowTextSearch });
  const dataCalls = () =>
    sn.calls.filter(
      (c) =>
        !c.table.startsWith('sys_db_object') &&
        c.table !== 'sys_dictionary' &&
        c.table !== 'sys_choice',
    );
  return { sn, plan, dataCalls };
}

describe('AC1: an invalid field that "would return all rows" is rejected before any data call', () => {
  it.each<[string, QueryRequest]>([
    [
      'structured where',
      { table: 'incident', where: [{ field: 'zz_no_such_field_zz', op: '=', value: '1' }] },
    ],
    [
      'raw encoded_query (the T-005 case)',
      { table: 'incident', encoded_query: 'zz_no_such_field_zz=1' },
    ],
    ['inside an OR term', { table: 'incident', encoded_query: 'active=true^ORzz_bad=1' }],
    ['in fields', { table: 'incident', fields: ['number', 'nmber'] }],
    [
      'in order_by',
      { table: 'incident', order_by: [{ field: 'sys_crated_on', direction: 'desc' }] },
    ],
    [
      'in a dot-walk hop',
      { table: 'incident', where: [{ field: 'caller_id.departmnt.name', op: '=', value: 'x' }] },
    ],
    [
      'an any_of group',
      {
        table: 'incident',
        any_of: [
          [{ field: 'priority', op: '=', value: 1 }],
          [{ field: 'prioity', op: '=', value: 2 }],
        ],
      },
    ],
  ])('%s', async (_n, req) => {
    const s = setup();
    await expect(s.plan(req)).rejects.toMatchObject({ code: 'INVALID_FIELD' });
    expect(s.dataCalls()).toEqual([]);
  });

  it('lists every unknown field and suggests close matches', async () => {
    const s = setup();
    const err = await s
      .plan({ table: 'incident', fields: ['nmber', 'caller_id.departmnt'] })
      .catch((e) => e);
    expect(err.message).toContain('nmber');
    expect(err.message).toContain('caller_id.departmnt');
    expect(err.message).toMatch(/unfiltered rows/);
    expect(err.hint).toContain('number');
    expect(err.hint).toContain('caller_id.department');
  });

  it('unknown table → NOT_FOUND with suggestions; too many hops → INVALID_FIELD', async () => {
    const s = setup();
    await expect(s.plan({ table: 'incidnt' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      suggestions: ['incident', 'incident_task'],
    });
    await expect(
      s.plan({ table: 'incident', fields: ['caller_id.manager.manager.manager.name'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_FIELD',
      message: expect.stringMatching(/more than 3/),
    });
  });

  it('valid fields, including dot-walks and inherited ones, pass', async () => {
    const s = setup();
    const p = await s.plan({
      table: 'incident',
      where: [
        { field: 'caller_id.department.name', op: '=', value: 'IT' },
        { field: 'priority', op: 'in', value: [1, 2] },
      ],
      fields: ['number', 'assigned_to.user_name'],
      order_by: [{ field: 'number', direction: 'asc' }],
    });
    expect(p.query).toBe('caller_id.department.name=IT^priorityIN1,2^ORDERBYnumber');
    expect(p.highVolume).toBe(false);
    expect(p.hints).toEqual([]);
  });
});

describe('raw queries vs internal conditions', () => {
  it('internal conditions are never combined with a raw query', async () => {
    const s = setup();
    await expect(
      s.plan({
        table: 'incident',
        encoded_query: 'priority=1',
        internal: [{ field: 'caller_id', op: '=', value: 'a'.repeat(32) }],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/own conditions/),
    });
  });

  it('internal conditions are ANDed into structured filters (also into each any_of group)', async () => {
    const s = setup();
    const id = 'a'.repeat(32);
    const internal = [{ field: 'caller_id', op: '=' as const, value: id }];
    expect(
      (
        await s.plan({
          table: 'incident',
          where: [{ field: 'priority', op: '=', value: 1 }],
          internal,
        })
      ).query,
    ).toBe(`caller_id=${id}^priority=1`);
    expect(
      (
        await s.plan({
          table: 'incident',
          any_of: [
            [{ field: 'priority', op: '=', value: 1 }],
            [{ field: 'state', op: '=', value: 2 }],
          ],
          internal,
        })
      ).query,
    ).toBe(`caller_id=${id}^priority=1^NQcaller_id=${id}^state=2`);
    expect((await s.plan({ table: 'incident', internal })).query).toBe(`caller_id=${id}`);
  });

  it('where and any_of together are refused (never one silently dropped)', async () => {
    const s = setup();
    await expect(
      s.plan({
        table: 'incident',
        where: [{ field: 'state', op: '=', value: 1 }],
        any_of: [
          [{ field: 'priority', op: '=', value: 1 }],
          [{ field: 'priority', op: '=', value: 2 }],
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/not both/) });
  });

  it('structured and raw input are exclusive; raw input follows the shared rules', async () => {
    const s = setup();
    await expect(
      s.plan({
        table: 'incident',
        encoded_query: 'priority=1',
        where: [{ field: 'state', op: '=', value: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // T-047: code text is inert without the javascript: prefix, so a literal search passes.
    await expect(
      s.plan({ table: 'incident', encoded_query: 'short_descriptionLIKEgs.getUser()' }),
    ).resolves.toMatchObject({
      query: expect.stringMatching(/^short_descriptionLIKEgs\.getUser\(\)/),
    });
    await expect(
      s.plan({ table: 'incident', encoded_query: 'short_descriptionLIKEjavascript:gs.getUser()' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_QUERY' });
    await expect(
      s.plan({
        table: 'incident',
        encoded_query: 'priority=1',
        order_by: [{ field: 'number', direction: 'asc' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('AC2–AC5: cost-aware defaults, never rejection', () => {
  it('AC2: syslog with no conditions is accepted, newest first, with a hint', async () => {
    const s = setup();
    const p = await s.plan({ table: 'syslog' });
    expect(p.query).toBe('ORDERBYDESCsys_created_on');
    expect(p).toMatchObject({ defaultedOrder: true, highVolume: true });
    expect(p.hints.join(' ')).toMatch(/No selective condition/);
  });

  it('AC2: syslog filtered to records from two years ago is accepted', async () => {
    const s = setup();
    const p = await s.plan({
      table: 'syslog',
      where: [
        {
          field: 'sys_created_on',
          op: 'between',
          value: ['2024-11-01 00:00:00', '2024-11-30 23:59:59'],
        },
      ],
    });
    expect(p.query).toBe(
      'sys_created_onBETWEEN2024-11-01 00:00:00@2024-11-30 23:59:59^ORDERBYDESCsys_created_on',
    );
    expect(p.hints.join(' ')).not.toMatch(/No selective condition/);
    const older = await s.plan({
      table: 'syslog',
      where: [{ field: 'sys_created_on', op: 'older_than', value: { amount: 2, unit: 'year' } }],
    });
    expect(older.query).toMatch(/^sys_created_onRELATIVELT@year@ago@2/);
  });

  it('AC3: contains on a high-volume table is accepted, with a hint', async () => {
    const s = setup();
    const p = await s.plan({
      table: 'syslog',
      where: [{ field: 'message', op: 'contains', value: 'timeout' }],
    });
    expect(p.query).toBe('messageLIKEtimeout^ORDERBYDESCsys_created_on');
    expect(p.hints.join(' ')).toMatch(/contains/);
    const text = await s.plan({ table: 'syslog', text: 'timeout' });
    expect(text.hints.join(' ')).toMatch(/contains/);
  });

  it('AC4: an empty query is accepted (pagination arrives with T-023)', async () => {
    const s = setup();
    const p = await s.plan({ table: 'incident' });
    expect(p).toMatchObject({ query: '', noCount: true, hints: [] });
  });

  it('AC5: a user-specified order_by is never overridden (structured or raw)', async () => {
    const s = setup();
    const asc = await s.plan({
      table: 'syslog',
      order_by: [{ field: 'sys_created_on', direction: 'asc' }],
    });
    expect(asc.query).toBe('ORDERBYsys_created_on');
    expect(asc.defaultedOrder).toBe(false);
    const bySource = await s.plan({
      table: 'syslog',
      order_by: [{ field: 'source', direction: 'asc' }],
    });
    expect(bySource.query).toBe('ORDERBYsource');
    const raw = await s.plan({ table: 'syslog', encoded_query: 'level=2^ORDERBYsource' });
    expect(raw.query).toBe('level=2^ORDERBYsource');
  });

  it('counts are opt-in', async () => {
    const s = setup();
    expect((await s.plan({ table: 'incident' })).noCount).toBe(true);
    expect((await s.plan({ table: 'incident', include_total: true })).noCount).toBe(false);
  });

  it('text search follows the tool policy', async () => {
    const s = setup();
    await expect(s.plan({ table: 'incident', text: 'printer' }, false)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('high-volume configuration', () => {
  it('matches the default patterns', () => {
    const hv = DEFAULT_HIGH_VOLUME_TABLES;
    for (const t of [
      'syslog',
      'syslog_transaction',
      'sys_audit',
      'sys_rest_log',
      'ecc_queue',
      'sys_email',
    ]) {
      expect(isHighVolume(t, hv), t).toBe(true);
    }
    for (const t of ['incident', 'sys_user', 'sys_audit_delete', 'login'])
      expect(isHighVolume(t, hv), t).toBe(false);
  });

  it('SN_MCP_HIGH_VOLUME_TABLES replaces the list; bad entries are dropped; other settings validated', () => {
    const c = loadConfig({
      SN_MCP_HIGH_VOLUME_TABLES: 'u_big_table, x_*_events,bad pattern;drop, *_events',
      SN_MCP_PAGE_SIZE: '5000',
      SN_MCP_RESPONSE_CHARS: '8000',
    });
    expect(c.highVolumeTables).toEqual(['u_big_table', '*_events']);
    expect(c.pageSize).toBe(100); // out of range → default
    expect(c.responseChars).toBe(8000);
    expect(loadConfig({}).highVolumeTables).toEqual([...DEFAULT_HIGH_VOLUME_TABLES]);
  });
});
