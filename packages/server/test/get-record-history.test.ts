/**
 * T-030: get_record_history, a merged audit + journal timeline (in-memory fake; mock only).
 */
import { describe, expect, it } from 'vitest';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, type Harness, harness } from './mcp-harness.js';

const RECORD = 'a'.repeat(32);

function historyTables(sn: FakeServiceNow) {
  const dict = (name: string, element: string, type = 'string') =>
    sn.insert('sys_dictionary', {
      name,
      element,
      column_label: element,
      internal_type: type,
      reference: '',
      max_length: '4000',
      mandatory: 'false',
      display: 'false',
    });
  sn.insert('sys_db_object', { name: 'sys_audit', label: 'Audit', super_class: '' });
  sn.insert('sys_db_object', { name: 'sys_journal_field', label: 'Journal', super_class: '' });
  for (const f of ['documentkey', 'user', 'fieldname', 'oldvalue', 'newvalue', 'sys_created_on'])
    dict('sys_audit', f);
  for (const f of ['element_id', 'sys_created_by', 'element', 'value', 'sys_created_on'])
    dict('sys_journal_field', f);
}

/** A timestamp `i` hours after the start of 2023: three years spread over the fixture. */
const at = (i: number, step = 17) =>
  new Date(Date.UTC(2023, 0, 1) + i * step * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

function fixture(entries: number): { sn: FakeServiceNow; expected: string[] } {
  const sn = dictionaryFixture();
  historyTables(sn);
  const expected: string[] = [];
  for (let i = 0; i < entries; i++) {
    // An uneven mix, with some shared timestamps, so page boundaries fall everywhere.
    const when = at(i - (i % 7 === 0 && i > 0 ? 1 : 0));
    if (i % 3 === 0) {
      sn.insert('sys_journal_field', {
        element_id: RECORD,
        sys_created_on: when,
        sys_created_by: 'beth',
        element: 'work_notes',
        value: `note ${i}`,
      });
    } else {
      sn.insert('sys_audit', {
        documentkey: RECORD,
        sys_created_on: when,
        user: 'adam',
        fieldname: 'state',
        oldvalue: String(i - 1),
        newvalue: String(i),
      });
    }
    expected.push(when);
  }
  // Another record's history must never appear.
  sn.insert('sys_audit', {
    documentkey: 'b'.repeat(32),
    sys_created_on: at(1),
    user: 'x',
    fieldname: 'decoy',
    oldvalue: '',
    newvalue: '',
  });
  return { sn, expected };
}

async function walk(h: Harness, scope: string, first: Record<string, unknown>) {
  const entries: { at: string; field: string; journal?: string; new?: string }[] = [];
  const pages: any[] = [];
  let r = await h.call('get_record_history', {
    scope_id: scope,
    table: 'incident',
    sys_id: RECORD,
    ...first,
  });
  for (;;) {
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    pages.push(r);
    entries.push(...r.data.timeline);
    if (!r.page.next_cursor) return { entries, pages };
    expect(r.complete).toBe(false);
    r = await h.call('get_record_history', {
      scope_id: scope,
      cursor: r.page.next_cursor,
      ...(first.max_chars ? { max_chars: first.max_chars } : {}),
    });
  }
}

const key = (e: { journal?: string; new?: string }) => e.journal ?? `new ${e.new}`;

describe('T-030 get_record_history', () => {
  it('a 3-year, 1,500-entry history is fully retrievable, every entry once', async () => {
    const { sn, expected } = fixture(1500);
    expect(expected.at(-1)?.slice(0, 4)).toBe('2025');
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const { entries, pages } = await walk(h, scope, { limit: 100 });
    expect(entries).toHaveLength(1500);
    expect(new Set(entries.map(key)).size).toBe(1500);
    expect(entries.some((e) => e.field === 'decoy')).toBe(false);
    expect(pages.length).toBeGreaterThan(10);
    expect(pages.at(-1).complete).toBe(true);
    expect(pages[0].page.total).toBe(1500);
    await h.close();
  });

  it('merged order is correct across page boundaries, both ways, at any page size', async () => {
    for (const [order, limit, max_chars] of [
      ['desc', 7, undefined],
      ['asc', 13, undefined],
      ['asc', 1000, 4000],
      ['desc', 1, undefined],
    ] as const) {
      const { sn } = fixture(120);
      const h = await harness({ sn });
      const scope = await claim(h, 'dev');
      const { entries } = await walk(h, scope, {
        order,
        limit,
        ...(max_chars ? { max_chars } : {}),
      });
      expect(entries, `${order} ${limit}`).toHaveLength(120);
      expect(new Set(entries.map(key)).size).toBe(120);
      const times = entries.map((e) => e.at);
      const sorted = [...times].sort();
      expect(times).toEqual(order === 'asc' ? sorted : sorted.reverse());
      await h.close();
    }
  });

  it('entries are compact and of both kinds', async () => {
    const { sn } = fixture(4);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incident',
      sys_id: RECORD,
      order: 'asc',
    });
    expect(r.complete).toBe(true);
    expect(r.data.timeline[0]).toEqual({
      at: at(0),
      user: 'beth',
      field: 'work_notes',
      journal: 'note 0',
    });
    expect(r.data.timeline[1]).toEqual({
      at: at(1),
      user: 'adam',
      field: 'state',
      old: '0',
      new: '1',
    });
    await h.close();
  });

  it('since and until narrow it; there is no default window', async () => {
    const { sn } = fixture(100);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incident',
      sys_id: RECORD,
      since: at(10),
      until: at(20),
      order: 'asc',
      limit: 1000,
    });
    expect(r.complete).toBe(true);
    expect(r.data.timeline.length).toBeGreaterThan(5);
    for (const e of r.data.timeline) {
      expect(e.at >= at(10)).toBe(true);
      expect(e.at <= at(20)).toBe(true);
    }
    await expect(
      h.call('get_record_history', {
        scope_id: scope,
        table: 'incident',
        sys_id: RECORD,
        since: "2020'; DROP",
      }),
    ).rejects.toThrow(/Input vali/);
    await h.close();
  });

  it('one source denied gives complete:false with an omitted entry; the other still reads', async () => {
    const { sn } = fixture(30);
    const h = await harness({ sn, denyTables: ['sys_audit'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incident',
      sys_id: RECORD,
    });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.page.has_more).toBe(false);
    expect(r.omitted).toEqual([
      { kind: 'source', source: 'sys_audit', reason: 'acl_denied', code: 'ACL_DENIED' },
    ]);
    expect(r.data.timeline.length).toBe(10);
    expect(r.data.timeline.every((e: { journal?: string }) => e.journal)).toBe(true);
    await h.close();
  });

  it('both sources denied is an ACL_DENIED error', async () => {
    const { sn } = fixture(5);
    const h = await harness({ sn, denyTables: ['sys_audit', 'sys_journal_field'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incident',
      sys_id: RECORD,
    });
    expect(r.error.code).toBe('ACL_DENIED');
    await h.close();
  });

  it('long journal entries follow the field contract, and the next call reads them', async () => {
    const sn = dictionaryFixture();
    historyTables(sn);
    const long = `start ${'x'.repeat(4000)} end`;
    const j = sn.insert('sys_journal_field', {
      element_id: RECORD,
      sys_created_on: at(1),
      sys_created_by: 'beth',
      element: 'comments',
      value: long,
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incident',
      sys_id: RECORD,
    });
    expect(r.complete).toBe(false);
    expect(r.data.timeline[0].journal.length).toBeLessThan(1100);
    const om = r.omitted[0];
    expect(om).toMatchObject({
      kind: 'field',
      reason: 'preview',
      sys_id: j.sys_id,
      field: 'value',
      total_chars: long.length,
    });
    const full = await h.call(om.next.tool, om.next.args);
    expect(full.data.lines[0].text).toBe(long);
    await h.close();
  });

  it('audit values of credential fields are never returned', async () => {
    const sn = dictionaryFixture();
    historyTables(sn);
    sn.insert('sys_audit', {
      documentkey: RECORD,
      sys_created_on: at(1),
      user: 'adam',
      fieldname: 'user_password',
      oldvalue: 'old-secret',
      newvalue: 'new-secret',
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record_history', {
      scope_id: scope,
      table: 'sys_user',
      sys_id: RECORD,
    });
    expect(JSON.stringify(r)).not.toMatch(/old-secret|new-secret/);
    expect(r.data.timeline[0]).toEqual({
      at: at(1),
      user: 'adam',
      field: 'user_password',
      redacted: true,
    });
    expect(r.omitted[0]).toMatchObject({ reason: 'sensitive', fields: ['user_password'] });
    await h.close();
  });

  it('ACL-hidden entries lose and repeat nothing across pages', async () => {
    const { sn } = fixture(300);
    // Hide every 5th note and every 4th change: windows come back short.
    const hidden = (r: Record<string, unknown>) =>
      (typeof r.value === 'string' && Number(r.value.split(' ')[1]) % 5 === 0) ||
      (typeof r.newvalue === 'string' && Number(r.newvalue) % 4 === 0);
    const visible = [
      ...(sn.tables.get('sys_journal_field') ?? []),
      ...(sn.tables.get('sys_audit') ?? []).filter((r) => r.documentkey === RECORD),
    ].filter((r) => !hidden(r));
    const h = await harness({ sn, hidden });
    const scope = await claim(h, 'dev');
    const { entries } = await walk(h, scope, { limit: 37, order: 'asc' });
    expect(new Set(entries.map(key)).size).toBe(entries.length);
    expect(entries).toHaveLength(visible.length);
    await h.close();
  });

  it('input errors; a revoked scope stops continuing', async () => {
    const { sn } = fixture(200);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const denied = await h.call('get_record_history', {
      scope_id: scope,
      table: 'discovery_credentials',
      sys_id: RECORD,
    });
    expect(denied.error.code).toBe('TABLE_DENIED');
    const unknown = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incidnt',
      sys_id: RECORD,
    });
    expect(unknown.error.code).toBe('NOT_FOUND');
    const missing = await h.call('get_record_history', { scope_id: scope });
    expect(missing.error.code).toBe('INVALID_INPUT');
    const first = await h.call('get_record_history', {
      scope_id: scope,
      table: 'incident',
      sys_id: RECORD,
      limit: 5,
    });
    const mixed = await h.call('get_record_history', {
      scope_id: scope,
      cursor: first.page.next_cursor,
      table: 'problem',
    });
    expect(mixed.error.code).toBe('INVALID_INPUT');
    h.revoke(scope);
    const after = await h.call('get_record_history', {
      scope_id: scope,
      cursor: first.page.next_cursor,
    });
    expect(after.error.code).toBe('SCOPE_UNKNOWN');
    await h.close();
  });
});
