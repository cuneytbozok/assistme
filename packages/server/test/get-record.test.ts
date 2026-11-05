/**
 * T-025: get_record finds exactly one record and never guesses (in-memory fake; mock only).
 */
import { describe, expect, it } from 'vitest';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness } from './mcp-harness.js';

function fixture(): { sn: FakeServiceNow; id: string; userId: string; deptId: string } {
  const sn = dictionaryFixture();
  const dept = sn.insert('cmn_department', { name: 'IT' });
  const user = sn.insert('sys_user', {
    user_name: 'beth',
    name: 'Beth',
    department: sn.ref('cmn_department', dept),
  });
  const inc = sn.insert('incident', {
    number: 'INC0000001',
    short_description: 'unique one',
    category: 'network',
    caller_id: sn.ref('sys_user', user),
    assigned_to: '',
  });
  sn.insert('incident', { number: 'INC0000002', short_description: 'twin', category: 'db' });
  sn.insert('incident', { number: 'INC0000003', short_description: 'twin', category: 'db' });
  return { sn, id: inc.sys_id, userId: user.sys_id, deptId: dept.sys_id };
}

describe('T-025 get_record', () => {
  it('unique: by sys_id and by match, both report provenance and requests_used', async () => {
    const { sn, id } = fixture();
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const a = await h.call('get_record', { scope_id: scope, table: 'incident', sys_id: id });
    expect(a).toMatchObject({ ok: true, complete: true, requests_used: 1 });
    expect(a.data.record).toMatchObject({ sys_id: id, number: 'INC0000001' });
    expect(a.provenance).toMatchObject({ instance: 'dev', source: 'table incident' });
    expect(a.links[0]).toContain(id);

    const b = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      match: { number: 'INC0000001' },
    });
    expect(b.data.record.sys_id).toBe(id);
    expect(b.requests_used).toBe(2); // one candidates window, one read
    await h.close();
  });

  it('not found: by sys_id and by match', async () => {
    const h = await harness({ sn: fixture().sn });
    const scope = await claim(h, 'dev');
    const a = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      sys_id: 'f'.repeat(32),
    });
    expect(a.error.code).toBe('NOT_FOUND');
    const b = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      match: { number: 'NOPE' },
    });
    expect(b.error.code).toBe('NOT_FOUND');
    await h.close();
  });

  it('ambiguous: candidates, the total, and a list_all call that really lists them all', async () => {
    const sn = dictionaryFixture();
    for (let i = 0; i < 9; i++)
      sn.insert('incident', { number: `INC${i}`, short_description: 'same', category: 'db' });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      match: { category: 'db' },
    });
    expect(r.error.code).toBe('AMBIGUOUS_MATCH');
    expect(r.error.total).toBe(9);
    expect(r.error.candidates).toHaveLength(5);
    expect(r.error.candidates[0]).toHaveProperty('sys_id');
    expect(r.error.untrusted_content).toBeTruthy();
    expect(r.error.list_all.tool).toBe('query_records');
    const all = await h.call(r.error.list_all.tool, {
      ...r.error.list_all.args,
      limit: r.error.total,
    });
    expect(all.ok).toBe(true);
    expect(all.data.records).toHaveLength(9);
    expect(all.page.total).toBe(9);
    await h.close();
  });

  it('never guesses from a window of mostly hidden rows', async () => {
    const sn = dictionaryFixture();
    for (let i = 0; i < 14; i++)
      sn.insert('incident', { number: `INC${i}`, short_description: 'same', category: 'db' });
    // Only the 1st and 13th are readable: the first window alone looks unique.
    const readable = new Set(['INC0', 'INC12']);
    const h = await harness({
      sn,
      hidden: (r) => r.number !== undefined && !readable.has(String(r.number)),
    });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      match: { category: 'db' },
    });
    expect(r.error.code).toBe('AMBIGUOUS_MATCH');
    expect(r.error.candidates).toHaveLength(2);
    await h.close();
  });

  it('one readable match among hidden ones is returned, and says so', async () => {
    const sn = dictionaryFixture();
    for (let i = 0; i < 3; i++)
      sn.insert('incident', { number: `INC${i}`, short_description: 'same', category: 'db' });
    const h = await harness({ sn, hidden: (r) => r.number !== undefined && r.number !== 'INC1' });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      match: { category: 'db' },
      fields: ['number'],
    });
    expect(r.data.record.number).toBe('INC1');
    expect(r.hints.join(' ')).toMatch(/counted 3/);
    await h.close();
  });

  it('input and validation errors are refused before any read', async () => {
    const h = await harness({ sn: fixture().sn });
    const scope = await claim(h, 'dev');
    const bad: [Record<string, unknown>, string][] = [
      [{ table: 'incident' }, 'INVALID_INPUT'],
      [{ table: 'incident', sys_id: 'a'.repeat(32), match: { number: 'x' } }, 'INVALID_INPUT'],
      [{ table: 'incident', match: {} }, 'INVALID_INPUT'],
      [{ table: 'incident', match: { zz_no_field: 'x' } }, 'INVALID_FIELD'],
      [{ table: 'incident', sys_id: 'a'.repeat(32), fields: ['zz_no_field'] }, 'INVALID_FIELD'],
      [{ table: 'sys_user', match: { user_password: 'x' } }, 'FORBIDDEN_OPERATION'],
      [{ table: 'discovery_credentials', sys_id: 'a'.repeat(32) }, 'TABLE_DENIED'],
    ];
    for (const [args, code] of bad) {
      const r = await h.call('get_record', { scope_id: scope, ...args });
      expect(r.error?.code, JSON.stringify(args)).toBe(code);
    }
    expect(h.dataRequests).toEqual([]);
    expect((await h.call('get_record', { table: 'incident' })).error.code).toBe('SCOPE_REQUIRED');
    await h.close();
  });

  it('long fields follow the preview contract; password fields are stripped and reported', async () => {
    const sn = dictionaryFixture();
    const u = sn.insert('sys_user', {
      user_name: 'x',
      name: 'n'.repeat(5000),
      user_password: 'hunter2',
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record', { scope_id: scope, table: 'sys_user', sys_id: u.sys_id });
    expect(r.complete).toBe(false);
    const field = r.omitted.find((o: { field?: string }) => o.field === 'name');
    expect(field).toMatchObject({ reason: 'preview', total_chars: 5000 });
    expect(field.next).toEqual({
      tool: 'get_field_content',
      args: { scope_id: scope, table: 'sys_user', sys_id: u.sys_id, field: 'name' },
    });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(r.omitted.find((o: { reason?: string }) => o.reason === 'sensitive').fields).toEqual([
      'user_password',
    ]);
    await h.close();
  });

  it('expand_references: compact summaries with provenance; denied and unreadable are reported', async () => {
    const { sn, id, userId } = fixture();
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      sys_id: id,
      expand_references: true,
    });
    expect(r.complete).toBe(true);
    expect(r.requests_used).toBe(2);
    expect(r.data.references).toEqual([
      expect.objectContaining({
        field: 'caller_id',
        table: 'sys_user',
        sys_id: userId,
        source: 'table sys_user',
        summary: expect.objectContaining({ sys_id: userId, user_name: 'beth' }),
      }),
    ]);
    expect(r.data.references[0].link).toContain(userId);
    await h.close();

    // A reference to a credential table is refused; an unreadable one gets a retry call.
    const sn2 = dictionaryFixture();
    const cred = sn2.insert('discovery_credentials', { name: 'c' });
    const user = sn2.insert('sys_user', { user_name: 'x' });
    const inc = sn2.insert('incident', {
      number: 'INC1',
      u_cred_ref: sn2.ref('discovery_credentials', cred),
      caller_id: sn2.ref('sys_user', user),
    });
    const h2 = await harness({ sn: sn2, denyTables: ['sys_user'] });
    const s2 = await claim(h2, 'dev');
    const r2 = await h2.call('get_record', {
      scope_id: s2,
      table: 'incident',
      sys_id: inc.sys_id,
      expand_references: true,
    });
    expect(r2.complete).toBe(false);
    expect(r2.omitted).toContainEqual(
      expect.objectContaining({ reason: 'table_denied', field: 'u_cred_ref' }),
    );
    expect(r2.omitted).toContainEqual(
      expect.objectContaining({
        reason: 'acl_denied',
        field: 'caller_id',
        next: {
          tool: 'get_record',
          args: { scope_id: s2, table: 'sys_user', sys_id: user.sys_id },
        },
      }),
    );
    await h2.close();
  });

  it('expand_references: document_id fields need an explicit table; a list is honored', async () => {
    const sn = dictionaryFixture();
    sn.insert('sys_dictionary', {
      name: 'incident',
      element: 'u_doc',
      column_label: 'Doc',
      internal_type: 'document_id',
      reference: '',
      max_length: '32',
      mandatory: 'false',
      display: 'false',
    });
    const u = sn.insert('sys_user', { user_name: 'x' });
    const inc = sn.insert('incident', {
      number: 'INC1',
      u_doc: 'a'.repeat(32),
      caller_id: sn.ref('sys_user', u),
      assigned_to: sn.ref('sys_user', u),
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const all = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      sys_id: inc.sys_id,
      expand_references: true,
    });
    expect(all.hints.join(' ')).toMatch(/u_doc is a document_id/);
    expect(all.data.references.map((x: { field: string }) => x.field).sort()).toEqual([
      'assigned_to',
      'caller_id',
    ]);
    const one = await h.call('get_record', {
      scope_id: scope,
      table: 'incident',
      sys_id: inc.sys_id,
      expand_references: ['caller_id', 'number'],
    });
    expect(one.data.references.map((x: { field: string }) => x.field)).toEqual(['caller_id']);
    expect(one.hints.join(' ')).toMatch(/number is not a reference/);
    await h.close();
  });
});
