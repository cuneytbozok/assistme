/**
 * T-026: discover_tables and describe_table on the in-memory fake (mock only).
 */
import { describe, expect, it } from 'vitest';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness } from './mcp-harness.js';

function withCustom(): FakeServiceNow {
  const sn = dictionaryFixture();
  const task = sn.tables.get('sys_db_object')?.find((r) => r.name === 'task');
  sn.insert('sys_db_object', {
    name: 'x_acme_vendor_task',
    label: 'Vendor Task',
    super_class: sn.ref('sys_db_object', task as never),
  });
  sn.insert('sys_db_object', { name: 'u_widget', label: 'Widget', super_class: '' });
  const dict = (name: string, element: string, type: string, extra = {}) =>
    sn.insert('sys_dictionary', {
      name,
      element,
      column_label: element,
      internal_type: type,
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
      ...extra,
    });
  dict('x_acme_vendor_task', 'x_acme_vendor', 'reference', { reference: 'sys_user' });
  dict('u_widget', 'u_size', 'integer');
  return sn;
}

const names = (r: { data: { records: { name: string }[] } }) => r.data.records.map((x) => x.name);

describe('T-026 discover_tables', () => {
  it('finds custom tables by name and by label', async () => {
    const h = await harness({ sn: withCustom() });
    const scope = await claim(h, 'dev');
    const byName = await h.call('discover_tables', { scope_id: scope, search: 'x_acme' });
    expect(names(byName)).toEqual(['x_acme_vendor_task']);
    expect(byName.data.records[0]).toEqual({
      name: 'x_acme_vendor_task',
      label: 'Vendor Task',
      extends: 'task',
    });
    expect(byName.complete).toBe(true);
    const byLabel = await h.call('discover_tables', { scope_id: scope, search: 'widget' });
    expect(names(byLabel)).toEqual(['u_widget']);
    await h.close();
  });

  it('walks every table through cursors; blocked tables stay listed and marked', async () => {
    const sn = withCustom();
    for (let i = 0; i < 300; i++)
      sn.insert('sys_db_object', {
        name: `u_t_${String(i).padStart(3, '0')}`,
        label: `T ${i}`,
        super_class: '',
      });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const seen: string[] = [];
    let r = await h.call('discover_tables', { scope_id: scope, limit: 75 });
    for (;;) {
      seen.push(...names(r));
      if (!r.page.next_cursor) break;
      expect(r.complete).toBe(false);
      expect(r.omitted[0].next).toEqual({
        tool: 'discover_tables',
        args: { scope_id: scope, cursor: r.page.next_cursor },
      });
      r = await h.call('discover_tables', { scope_id: scope, cursor: r.page.next_cursor });
    }
    const total = sn.tables.get('sys_db_object')?.length as number;
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...seen].sort());
    expect(r.complete).toBe(true);
    const creds = await h.call('discover_tables', { scope_id: scope, search: 'discovery_cred' });
    expect(creds.data.records[0]).toMatchObject({ name: 'discovery_credentials', blocked: true });
    expect(creds.hints.join(' ')).toMatch(/never reads/);
    await h.close();
  });

  it('refuses unsafe search text and foreign cursors', async () => {
    const h = await harness({ sn: withCustom() });
    const scope = await claim(h, 'dev');
    const bad = await h.call('discover_tables', { scope_id: scope, search: 'a^ORname=b' });
    expect(['UNSAFE_QUERY', 'INVALID_INPUT']).toContain(bad.error.code);
    const q = await h.call('query_records', { scope_id: scope, table: 'sys_user', limit: 1 });
    expect(q.ok).toBe(true);
    const foreign = await h.call('discover_tables', { scope_id: scope, cursor: 'abc.def' });
    expect(foreign.error.code).toBe('INVALID_INPUT');
    await h.close();
  });
});

describe('T-026 describe_table', () => {
  it('a custom table: own and inherited fields, with their source table', async () => {
    const h = await harness({ sn: withCustom() });
    const scope = await claim(h, 'dev');
    const r = await h.call('describe_table', { scope_id: scope, table: 'x_acme_vendor_task' });
    expect(r.complete).toBe(true);
    expect(r.data.chain).toEqual(['x_acme_vendor_task', 'task']);
    const byName = Object.fromEntries(
      r.data.fields.map((f: { name: string }) => [f.name, f]),
    ) as Record<string, Record<string, unknown>>;
    expect(byName.x_acme_vendor).toMatchObject({ type: 'reference', reference: 'sys_user' });
    expect(byName.x_acme_vendor).not.toHaveProperty('inherited_from');
    expect(byName.number).toMatchObject({ inherited_from: 'task', display: true });

    const own = await h.call('describe_table', {
      scope_id: scope,
      table: 'x_acme_vendor_task',
      include_inherited: false,
    });
    expect(own.data.fields.map((f: { name: string }) => f.name)).toEqual(['x_acme_vendor']);
    await h.close();
  });

  it('the child definition wins; include_choices uses the most specific table', async () => {
    const h = await harness({ sn: withCustom() });
    const scope = await claim(h, 'dev');
    const r = await h.call('describe_table', {
      scope_id: scope,
      table: 'incident',
      include_choices: true,
    });
    const state = r.data.fields.find((f: { name: string }) => f.name === 'state');
    expect(state).not.toHaveProperty('inherited_from');
    expect(state.choices.map((c: { label: string }) => c.label)).toEqual([
      'New',
      'In Progress',
      'Closed',
    ]);
    const priority = r.data.fields.find((f: { name: string }) => f.name === 'priority');
    expect(priority).toMatchObject({
      inherited_from: 'task',
      choices: [{ value: '1', label: 'Critical' }],
    });
    await h.close();
  });

  it('is compact: well under the row it describes, and metadata is cached', async () => {
    const h = await harness({ sn: withCustom() });
    const scope = await claim(h, 'dev');
    const a = await h.call('describe_table', { scope_id: scope, table: 'incident' });
    expect(JSON.stringify(a.data.fields[0]).length).toBeLessThan(150);
    expect(a.requests_used).toBeGreaterThan(0);
    const b = await h.call('describe_table', { scope_id: scope, table: 'incident' });
    expect(b.requests_used).toBe(0);
    await h.close();
  });

  it('NOT_FOUND has suggestions; credential tables are refused; sensitive fields are marked', async () => {
    const h = await harness({ sn: withCustom() });
    const scope = await claim(h, 'dev');
    const r = await h.call('describe_table', { scope_id: scope, table: 'incidnt' });
    expect(r.error.code).toBe('NOT_FOUND');
    expect(r.error.hint).toMatch(/incident/);
    const d = await h.call('describe_table', { scope_id: scope, table: 'discovery_credentials' });
    expect(d.error.code).toBe('TABLE_DENIED');
    const u = await h.call('describe_table', { scope_id: scope, table: 'u_api_config' });
    expect(u.data.fields.find((f: { name: string }) => f.name === 'u_auth').sensitive).toBe(true);
    await h.close();
  });

  it('pages by cursor when it does not fit one result, losing no field', async () => {
    const sn = withCustom();
    for (let i = 0; i < 400; i++)
      sn.insert('sys_dictionary', {
        name: 'u_widget',
        element: `u_field_${String(i).padStart(3, '0')}`,
        column_label: `A long enough label for field ${i}`,
        internal_type: 'string',
        reference: '',
        max_length: '40',
        mandatory: 'false',
        display: 'false',
      });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const seen: string[] = [];
    let r = await h.call('describe_table', { scope_id: scope, table: 'u_widget', max_chars: 8000 });
    let calls = 1;
    for (;;) {
      seen.push(...r.data.fields.map((f: { name: string }) => f.name));
      expect(JSON.stringify(r).length).toBeLessThan(9000);
      if (!r.page.next_cursor) break;
      expect(r.complete).toBe(false);
      r = await h.call('describe_table', {
        scope_id: scope,
        cursor: r.page.next_cursor,
        max_chars: 8000,
      });
      calls++;
    }
    expect(calls).toBeGreaterThan(1);
    expect(seen).toHaveLength(401);
    expect(new Set(seen).size).toBe(401);
    expect(r.complete).toBe(true);
    await h.close();
  });
});
