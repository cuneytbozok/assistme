/**
 * The check on returned rows: it must catch an ignored filter, and it must not raise false alarms
 * on ServiceNow's normal matching (mock; the live run checks real queries).
 */
import { describe, expect, it } from 'vitest';
import { buildFilterCheck } from '../src/mcp/filter-check.js';
import type { FieldInfo } from '../src/mcp/metadata.js';
import { dictionaryFixture } from './fake-sn.js';
import { claim, harness, withIncidents } from './mcp-harness.js';

const f = (name: string, type: string): [string, FieldInfo] => [
  name,
  { name, type, definedOn: 't', label: name, mandatory: false, display: false },
];
const KNOWN = new Map([
  f('text', 'string'),
  f('other', 'string'),
  f('num', 'integer'),
  f('flag', 'boolean'),
  f('ref', 'reference'),
  f('when', 'glide_date_time'),
  f('code', 'script'),
]);
const ID = 'a'.repeat(32);
const bad = (query: string, row: Record<string, unknown>) =>
  buildFilterCheck(query, KNOWN, undefined).contradiction(row);

describe('buildFilterCheck: catches rows that certainly do not match', () => {
  it.each([
    ['text=abc', { text: 'xyz' }, 'text'],
    ['textLIKEabc', { text: 'xyz' }, 'text'],
    ['textSTARTSWITHabc', { text: 'xabc' }, 'text'],
    ['textENDSWITHabc', { text: 'abcx' }, 'text'],
    ['textINa,b', { text: 'c' }, 'text'],
    ['num=1', { num: '2' }, 'num'],
    ['flag=true', { flag: 'false' }, 'flag'],
    [`ref=${ID}`, { ref: 'b'.repeat(32) }, 'ref'],
    ['codeLIKEneedle', { code: 'nothing here' }, 'code'],
    ['text=a^other=b', { text: 'a', other: 'x' }, 'other'],
    ['text=a^ORother=b', { text: 'x', other: 'y' }, 'text'],
    ['text=a^NQother=b', { text: 'x', other: 'y' }, 'text'],
  ])('%s with %j', (q, row, field) => {
    expect(bad(q, row)).toBe(field);
  });

  it('reads the raw value from {value, display_value}', () => {
    expect(bad('num=1', { num: { value: '2', display_value: '1' } })).toBe('num');
  });
});

describe('buildFilterCheck: no false alarms', () => {
  it.each([
    ['case differs', 'text=ABC', { text: 'abc' }],
    ['case in contains', 'textLIKEEMAIL', { text: 'my email' }],
    ['case in a list', 'textINA,B', { text: 'b' }],
    ['spaces', 'text=abc', { text: ' abc ' }],
    ['boolean as a number', 'flag=1', { flag: 'true' }],
    ['number format', 'num=1', { num: '1.0' }],
    ['reference by display value', 'ref=Joe', { ref: ID }],
    ['reference contains', 'refLIKEJoe', { ref: ID }],
    ['date in another time zone', 'when=2020-01-01 10:00:00', { when: '2020-01-01 02:00:00' }],
    ['relative date', 'whenRELATIVEGE@day@ago@1', { when: '2000-01-01 00:00:00' }],
    ['not-equal', 'text!=abc', { text: 'abc' }],
    ['dot-walk', 'ref.name=x', { ref: ID, 'ref.name': 'y' }],
    ['blank value, maybe a field ACL', 'text=abc', { text: '' }],
    ['field not returned', 'text=abc', { other: 'x' }],
    ['unknown type', 'text=abc^when=x', { text: 'abc', when: 'y' }],
    ['one OR side matches', 'text=a^ORother=b', { text: 'x', other: 'b' }],
    ['one NQ group matches', 'text=a^NQother=b', { text: 'x', other: 'b' }],
    ['OR with an unknown side', 'text=a^ORref=Joe', { text: 'x', ref: ID }],
    ['no conditions', 'ORDERBYtext', { text: 'x' }],
    ['a wildcard in the value', 'textLIKE50%', { text: 'other' }],
    ['matching rows', 'text=abc^num=1', { text: 'abc', num: '1' }],
  ])('%s', (_name, q, row) => {
    expect(bad(q, row)).toBeUndefined();
  });

  it('asks for fields missing from a projection, within the request limit', () => {
    expect(buildFilterCheck('text=a^num=1', KNOWN, ['other']).fields).toEqual(['text', 'num']);
    expect(buildFilterCheck('text=a', KNOWN, ['text']).fields).toEqual([]);
    expect(buildFilterCheck('ref.name=a', KNOWN, ['other']).fields).toEqual([]);
    const full = Array.from({ length: 50 }, (_, i) => `f${i}`);
    expect(buildFilterCheck('text=a', KNOWN, full).fields).toEqual([]);
    expect(buildFilterCheck('text=a', KNOWN, undefined).fields).toEqual([]);
  });
});

describe('through the tools, when ServiceNow ignores a filter', () => {
  const where = [{ field: 'priority', op: '=', value: 1 }];

  it('query_records withholds the rows and says why', async () => {
    const h = await harness({ sn: withIncidents(10), ignoreFiltersOn: ['incident'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: scope, table: 'incident', where });
    expect(r.error.code).toBe('FILTER_NOT_APPLIED');
    expect(r.error.message).toMatch(/priority/);
    expect(JSON.stringify(r)).not.toContain('INC0000');
    await h.close();
  });

  it("works when the filter field is not in the projection, and doesn't return it", async () => {
    const h = await harness({ sn: withIncidents(10), ignoreFiltersOn: ['incident'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      where,
      fields: ['number'],
    });
    expect(r.error.code).toBe('FILTER_NOT_APPLIED');
    await h.close();

    const ok = await harness({ sn: withIncidents(10) });
    const s2 = await claim(ok, 'dev');
    const good = await ok.call('query_records', {
      scope_id: s2,
      table: 'incident',
      where,
      fields: ['number'],
    });
    expect(good.ok).toBe(true);
    expect(good.data.records.length).toBeGreaterThan(0);
    for (const rec of good.data.records) {
      expect(Object.keys(rec).sort()).toEqual(['number', 'sys_id']);
    }
    await ok.close();
  });

  it('a normal filtered walk is unaffected, over many pages', async () => {
    const h = await harness({ sn: withIncidents(1000) });
    const scope = await claim(h, 'dev');
    let r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      where,
      limit: 400,
    });
    let rows = 0;
    for (;;) {
      expect(r.ok).toBe(true);
      rows += r.data.records.length;
      if (!r.page.next_cursor) break;
      r = await h.call('query_records', { scope_id: scope, cursor: r.page.next_cursor });
    }
    expect(rows).toBe(250);
    await h.close();
  });

  it('get_record never turns an unmatched record into "the unique match"', async () => {
    const sn = dictionaryFixture();
    sn.insert('incident', { number: 'INC1', short_description: 'only row' });
    const h = await harness({ sn, ignoreFiltersOn: ['incident'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      match: { number: 'INC999' },
    });
    expect(r.error.code).toBe('FILTER_NOT_APPLIED');
    expect(JSON.stringify(r)).not.toContain('only row');
    await h.close();
  });

  it('search_code reports the table and carries on', async () => {
    const sn = dictionaryFixture();
    for (const t of ['u_a', 'u_b']) {
      sn.insert('sys_db_object', { name: t, label: t, super_class: '' });
      sn.insert('sys_dictionary', {
        name: t,
        element: 'script',
        column_label: 's',
        internal_type: 'script',
        reference: '',
        max_length: '4000',
        mandatory: 'false',
        display: 'false',
      });
    }
    sn.insert('u_a', { script: 'nothing relevant' });
    sn.insert('u_b', { script: 'has the needle' });
    const h = await harness({ sn, ignoreFiltersOn: ['u_a'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'needle' });
    expect(r.data.matches.map((m: { table: string }) => m.table)).toEqual(['u_b']);
    expect(r.complete).toBe(false);
    expect(r.omitted).toContainEqual(
      expect.objectContaining({ table: 'u_a', reason: 'filter_not_applied' }),
    );
    expect(JSON.stringify(r)).not.toContain('nothing relevant');
    await h.close();
  });

  it("get_record_history never shows another record's history", async () => {
    const sn = dictionaryFixture();
    const dict = (name: string, element: string) =>
      sn.insert('sys_dictionary', {
        name,
        element,
        column_label: element,
        internal_type: 'string',
        reference: '',
        max_length: '4000',
        mandatory: 'false',
        display: 'false',
      });
    for (const t of ['sys_audit', 'sys_journal_field']) {
      sn.insert('sys_db_object', { name: t, label: t, super_class: '' });
    }
    for (const e of ['documentkey', 'user', 'fieldname', 'oldvalue', 'newvalue', 'sys_created_on'])
      dict('sys_audit', e);
    for (const e of ['element_id', 'sys_created_by', 'element', 'value', 'sys_created_on'])
      dict('sys_journal_field', e);
    sn.insert('sys_audit', {
      documentkey: 'b'.repeat(32),
      user: 'x',
      fieldname: 'state',
      oldvalue: 'secret-old',
      newvalue: '2',
      sys_created_on: '2020-01-01 00:00:00',
    });
    const h = await harness({ sn, ignoreFiltersOn: ['sys_audit'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incident',
      sys_id: 'a'.repeat(32),
    });
    expect(r.error.code).toBe('FILTER_NOT_APPLIED');
    expect(JSON.stringify(r)).not.toContain('secret-old');
    await h.close();
  });
});
