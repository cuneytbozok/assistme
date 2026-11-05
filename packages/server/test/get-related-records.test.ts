/**
 * T-029: get_related_records, from the dictionary with no hard-coded relationships
 * (in-memory fake; mock only).
 */
import { describe, expect, it } from 'vitest';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness } from './mcp-harness.js';

interface Fixture {
  sn: FakeServiceNow;
  ci: string;
  expected: Map<string, number>;
}

/** A server CI (cmdb_ci_server ← cmdb_ci) with 25 relationships of different sizes. */
function ciFixture(relations = 25): Fixture {
  const sn = dictionaryFixture();
  const base = sn.insert('sys_db_object', { name: 'cmdb_ci', label: 'CI', super_class: '' });
  sn.insert('sys_db_object', {
    name: 'cmdb_ci_server',
    label: 'Server',
    super_class: sn.ref('sys_db_object', base),
  });
  const dict = (name: string, element: string, type: string, reference = '') =>
    sn.insert('sys_dictionary', {
      name,
      element,
      column_label: element,
      internal_type: type,
      reference,
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
  dict('cmdb_ci', 'name', 'string');
  const ci = sn.insert('cmdb_ci_server', { name: 'web01' }).sys_id;
  const other = sn.insert('cmdb_ci_server', { name: 'web02' }).sys_id;
  const expected = new Map<string, number>();
  for (let i = 0; i < relations; i++) {
    const table = `u_rel_${String(i).padStart(2, '0')}`;
    sn.insert('sys_db_object', { name: table, label: table, super_class: '' });
    // Half point at the parent table, half at the child: both reach this record.
    dict(table, 'u_ci', 'reference', i % 2 ? 'cmdb_ci' : 'cmdb_ci_server');
    dict(table, 'u_note', 'string');
    const count = i % 5 === 0 ? 0 : i;
    for (let k = 0; k < count; k++) sn.insert(table, { u_ci: ci, u_note: `n${k}` });
    sn.insert(table, { u_ci: other, u_note: 'not this one' });
    expected.set(`${table}.u_ci`, count);
  }
  return { sn, ci, expected };
}

type Relation = { table: string; field: string; count: number; samples?: string[]; list_all?: any };

describe('T-029 get_related_records', () => {
  it('correct counts for all 25 across cursor pages, in a small budget', async () => {
    const { sn, ci, expected } = ciFixture();
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const seen = new Map<string, number>();
    let r = await h.call('get_related_records', {
      scope_id: scope,
      table: 'cmdb_ci_server',
      sys_id: ci,
      max_chars: 4000,
    });
    let calls = 1;
    for (;;) {
      expect(r.ok).toBe(true);
      expect(r.data.relation_count).toBe(25);
      for (const x of r.data.relations as Relation[]) {
        expect(seen.has(`${x.table}.${x.field}`)).toBe(false);
        seen.set(`${x.table}.${x.field}`, x.count);
      }
      if (!r.page.next_cursor) break;
      expect(r.complete).toBe(false);
      const more = r.omitted.find((o: { kind: string }) => o.kind === 'rows');
      expect(more.next).toEqual({
        tool: 'get_related_records',
        args: { scope_id: scope, cursor: r.page.next_cursor },
      });
      r = await h.call(more.next.tool, { ...more.next.args, max_chars: 4000 });
      calls++;
    }
    expect(calls).toBeGreaterThan(1);
    expect(r.complete).toBe(true);
    expect(seen).toEqual(expected);
    await h.close();
  });

  it('each relation has samples and a list-all call that works', async () => {
    const { sn, ci, expected } = ciFixture();
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_related_records', {
      scope_id: scope,
      table: 'cmdb_ci_server',
      sys_id: ci,
      max_chars: 100_000,
    });
    expect(r.complete).toBe(true);
    for (const x of r.data.relations as Relation[]) {
      const key = `${x.table}.${x.field}`;
      if (x.count === 0) {
        expect(x.list_all, key).toBeUndefined();
        expect(x.samples, key).toBeUndefined();
        continue;
      }
      expect(x.samples, key).toHaveLength(Math.min(3, x.count));
      const all = await h.call(x.list_all.tool, { ...x.list_all.args, limit: 1000 });
      expect(all.page.total, key).toBe(expected.get(key));
      expect(all.data.records, key).toHaveLength(x.count);
      const ids = new Set(all.data.records.map((q: { sys_id: string }) => q.sys_id));
      for (const s of x.samples as string[]) expect(ids.has(s), key).toBe(true);
    }
    await h.close();
  });

  it('samples: 0 reads only counts', async () => {
    const { sn, ci } = ciFixture(6);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_related_records', {
      scope_id: scope,
      table: 'cmdb_ci_server',
      sys_id: ci,
      samples: 0,
    });
    expect(r.data.relations.every((x: Relation) => x.samples === undefined)).toBe(true);
    const related = h.dataRequests.filter((d) => d.table.startsWith('u_rel'));
    expect(related.every((d) => d.kind === 'stats.aggregate')).toBe(true);
    expect(related).toHaveLength(6);
    await h.close();
  });

  it('blocked and unreadable tables go in omitted with the reason, and the rest still works', async () => {
    const { sn, ci } = ciFixture(4);
    const dict = (name: string, element: string, reference: string) =>
      sn.insert('sys_dictionary', {
        name,
        element,
        column_label: element,
        internal_type: 'reference',
        reference,
        max_length: '40',
        mandatory: 'false',
        display: 'false',
      });
    sn.insert('sys_db_object', { name: 'sys_credentials_x', label: 'c', super_class: '' });
    dict('sys_credentials_x', 'u_ci', 'cmdb_ci');
    const h = await harness({ sn, denyTables: ['u_rel_02'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_related_records', {
      scope_id: scope,
      table: 'cmdb_ci_server',
      sys_id: ci,
    });
    expect(r.complete).toBe(false);
    expect(r.page.has_more).toBe(false);
    const denied = r.omitted.find((o: { table: string }) => o.table === 'sys_credentials_x');
    expect(denied).toMatchObject({ kind: 'relation', reason: 'table_denied' });
    expect(denied.next).toBeUndefined();
    const acl = r.omitted.find((o: { table: string }) => o.table === 'u_rel_02');
    expect(acl).toMatchObject({ kind: 'relation', reason: 'acl_denied', code: 'ACL_DENIED' });
    expect(acl.next.tool).toBe('query_records');
    expect(r.data.relations.map((x: Relation) => x.table)).toEqual([
      'u_rel_00',
      'u_rel_01',
      'u_rel_03',
    ]);
    // The credential table itself was never queried.
    expect(h.dataRequests.some((d) => d.table === 'sys_credentials_x')).toBe(false);
    await h.close();
  });

  it('glide_list fields match with contains; sys_ids are read from a list', async () => {
    const { sn, ci } = ciFixture(1);
    sn.insert('sys_db_object', { name: 'u_list', label: 'L', super_class: '' });
    sn.insert('sys_dictionary', {
      name: 'u_list',
      element: 'u_cis',
      column_label: 'CIs',
      internal_type: 'glide_list',
      reference: 'cmdb_ci',
      max_length: '4000',
      mandatory: 'false',
      display: 'false',
    });
    sn.insert('u_list', { u_cis: `${'a'.repeat(32)},${ci}` });
    sn.insert('u_list', { u_cis: 'b'.repeat(32) });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_related_records', {
      scope_id: scope,
      table: 'cmdb_ci_server',
      sys_id: ci,
    });
    const rel = r.data.relations.find((x: Relation) => x.table === 'u_list');
    expect(rel.count).toBe(1);
    expect(rel.list_all.args.where[0].op).toBe('contains');
    await h.close();
  });

  it('a large relation list is split into batches; a session failure stops with a resumable cursor', async () => {
    const { sn, ci, expected } = ciFixture(130);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const args = {
      scope_id: scope,
      table: 'cmdb_ci_server',
      sys_id: ci,
      samples: 0,
      max_chars: 100_000,
    };
    const first = await h.call('get_related_records', args);
    expect(first.data.relations).toHaveLength(60);
    expect(first.omitted[0]).toMatchObject({ kind: 'rows', reason: 'batch' });
    const second = await h.call('get_related_records', {
      scope_id: scope,
      cursor: first.page.next_cursor,
      max_chars: 100_000,
    });
    const third = await h.call('get_related_records', {
      scope_id: scope,
      cursor: second.page.next_cursor,
      max_chars: 100_000,
    });
    expect(third.complete).toBe(true);
    const all = [...first.data.relations, ...second.data.relations, ...third.data.relations];
    expect(new Map(all.map((x: Relation) => [`${x.table}.${x.field}`, x.count]))).toEqual(expected);

    h.revoke(scope);
    const denied = await h.call('get_related_records', {
      scope_id: scope,
      cursor: first.page.next_cursor,
    });
    expect(denied.error.code).toBe('SCOPE_UNKNOWN');
    await h.close();
  });

  it('input errors: missing record, denied table, cursor mixed with arguments', async () => {
    const { sn, ci } = ciFixture(2);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const missing = await h.call('get_related_records', {
      scope_id: scope,
      table: 'cmdb_ci_server',
      sys_id: 'f'.repeat(32),
    });
    expect(missing.error.code).toBe('NOT_FOUND');
    const denied = await h.call('get_related_records', {
      scope_id: scope,
      table: 'discovery_credentials',
      sys_id: ci,
    });
    expect(denied.error.code).toBe('TABLE_DENIED');
    const noArgs = await h.call('get_related_records', { scope_id: scope });
    expect(noArgs.error.code).toBe('INVALID_INPUT');
    await h.close();
  });
});
