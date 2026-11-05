/**
 * T-031: search_code finds matches from the dictionary with no hard-coded tables
 * (in-memory fake; mock only).
 */
import { describe, expect, it } from 'vitest';
import { buildTargets, makeSnippets } from '../src/mcp/tools/search-code.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, type Harness, harness } from './mcp-harness.js';

function scriptTable(sn: FakeServiceNow, table: string, type = 'script_plain', field = 'script') {
  if (!sn.tables.get('sys_db_object')?.some((r) => r.name === table)) {
    sn.insert('sys_db_object', { name: table, label: table, super_class: '' });
    sn.insert('sys_dictionary', {
      name: table,
      element: 'name',
      column_label: 'Name',
      internal_type: 'string',
      reference: '',
      max_length: '100',
      mandatory: 'false',
      display: 'true',
    });
  }
  sn.insert('sys_dictionary', {
    name: table,
    element: field,
    column_label: field,
    internal_type: type,
    reference: '',
    max_length: '8000000',
    mandatory: 'false',
    display: 'false',
  });
}

const SCRIPT = [
  'function run() {',
  '  var gr = new GlideRecord("incident");',
  '  gr.query();',
  '  // set the close code',
  '  current.u_close_code = "done";',
  '  current.update();',
  '  gs.info("finished");',
  '  return true;',
  '}',
].join('\n');

function fixture(): FakeServiceNow {
  const sn = dictionaryFixture();
  scriptTable(sn, 'sys_script');
  scriptTable(sn, 'sys_script_include');
  scriptTable(sn, 'x_acme_custom_rule', 'script_server');
  sn.insert('sys_script', { name: 'Close rule', script: SCRIPT });
  sn.insert('sys_script', { name: 'Other rule', script: 'var a = 1;' });
  sn.insert('sys_script_include', { name: 'CloseUtil', script: `x\nu_close_code\ny` });
  sn.insert('x_acme_custom_rule', { name: 'Custom', script: 'U_CLOSE_CODE in capitals' });
  return sn;
}

async function walk(h: Harness, scope: string, first: Record<string, unknown>) {
  const pages: any[] = [];
  let r = await h.call('search_code', { scope_id: scope, ...first });
  for (;;) {
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    pages.push(r);
    if (!r.page.next_cursor) return pages;
    expect(r.complete).toBe(false);
    const more = r.omitted.find((o: { kind: string }) => o.kind === 'rows');
    expect(more.next.args.cursor).toBe(r.page.next_cursor);
    r = await h.call(more.next.tool, {
      ...more.next.args,
      ...(first.max_chars ? { max_chars: first.max_chars } : {}),
      ...(first.limit ? { limit: first.limit } : {}),
    });
  }
}

describe('T-031 search_code', () => {
  it('finds matches in business rules, script includes and custom tables, with snippets', async () => {
    const h = await harness({ sn: fixture() });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'u_close_code' });
    expect(r.complete).toBe(true);
    expect(r.data).toMatchObject({ tables_searched: 3, tables_remaining: 0, tables_total: 3 });
    expect(r.data.matches.map((m: { table: string; name: string }) => [m.table, m.name])).toEqual([
      ['sys_script', 'Close rule'],
      ['sys_script_include', 'CloseUtil'],
      ['x_acme_custom_rule', 'Custom'],
    ]);
    const hit = r.data.matches[0].hits[0];
    expect(hit.field).toBe('script');
    expect(hit.matches).toBe(1);
    expect(hit.snippets).toEqual([
      {
        start_line: 2,
        lines: [
          '  var gr = new GlideRecord("incident");',
          '  gr.query();',
          '  // set the close code',
          '  current.u_close_code = "done";',
          '  current.update();',
          '  gs.info("finished");',
          '  return true;',
        ],
      },
    ]);
    expect(typeof r.requests_used).toBe('number');
    await h.close();
  });

  it('is driven by the dictionary: a brand-new script field is searched', async () => {
    const sn = fixture();
    scriptTable(sn, 'u_brand_new', 'script', 'u_logic');
    sn.insert('u_brand_new', { name: 'N', u_logic: 'needle_here' });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'needle_here' });
    expect(r.data.matches).toHaveLength(1);
    expect(r.data.matches[0]).toMatchObject({ table: 'u_brand_new', name: 'N' });
    expect(r.data.matches[0].hits[0].field).toBe('u_logic');
    await h.close();
  });

  it('following the cursor covers every table; complete only after the last', async () => {
    const sn = dictionaryFixture();
    const expected: string[] = [];
    for (let t = 0; t < 70; t++) {
      const table = `u_t_${String(t).padStart(2, '0')}`;
      scriptTable(sn, table);
      for (let k = 0; k < t % 4; k++) {
        const row = sn.insert(table, { name: `r${k}`, script: `a\nFINDME ${t} ${k}\nb` });
        expected.push(row.sys_id);
      }
      sn.insert(table, { name: 'miss', script: 'nothing' });
    }
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    for (const first of [
      { pattern: 'findme' },
      { pattern: 'findme', limit: 7 },
      { pattern: 'findme', max_chars: 4000 },
    ]) {
      const pages = await walk(h, scope, first);
      const ids = pages.flatMap((p) => p.data.matches.map((m: { sys_id: string }) => m.sys_id));
      expect(ids.sort(), JSON.stringify(first)).toEqual([...expected].sort());
      expect(pages.length).toBeGreaterThan(1);
      for (const p of pages.slice(0, -1)) {
        expect(p.complete).toBe(false);
        expect(p.data.tables_remaining).toBeGreaterThan(0);
      }
      const last = pages.at(-1);
      expect(last.complete).toBe(true);
      expect(last.data).toMatchObject({ tables_searched: 70, tables_remaining: 0 });
      expect(pages[0].data.tables_total).toBe(70);
    }
    await h.close();
  });

  it('the pattern goes through value validation; nothing is sent', async () => {
    const h = await harness({ sn: fixture() });
    const scope = await claim(h, 'dev');
    for (const pattern of ['a^ORb', 'javascript:alert(1)', 'x^NQy']) {
      const r = await h.call('search_code', { scope_id: scope, pattern });
      expect(['INVALID_INPUT', 'UNSAFE_QUERY'], pattern).toContain(r.error?.code);
    }
    expect(h.dataRequests).toEqual([]);
    const code = await h.call('search_code', { scope_id: scope, pattern: 'gs.info(' });
    expect(code.ok).toBe(true); // literal code is fine in a structured filter
    expect(code.data.matches).toHaveLength(1);
    expect(h.sn.calls.at(-1)?.query).toContain('LIKE');
    await h.close();
  });

  it('tables narrows the search; denied and unreadable tables are reported, the rest still run', async () => {
    const sn = fixture();
    scriptTable(sn, 'sys_credentials_x');
    sn.insert('sys_credentials_x', { name: 's', script: 'u_close_code' });
    const h = await harness({ sn, denyTables: ['sys_script_include'] });
    const scope = await claim(h, 'dev');
    const only = await h.call('search_code', {
      scope_id: scope,
      pattern: 'u_close_code',
      tables: ['sys_script'],
    });
    expect(only.data.tables_total).toBe(1);
    expect(only.data.matches).toHaveLength(1);

    const all = await h.call('search_code', { scope_id: scope, pattern: 'u_close_code' });
    expect(all.complete).toBe(false);
    expect(all.page.has_more).toBe(false);
    expect(all.omitted).toContainEqual(
      expect.objectContaining({
        kind: 'table',
        reason: 'table_denied',
        table: 'sys_credentials_x',
      }),
    );
    expect(all.omitted).toContainEqual(
      expect.objectContaining({
        kind: 'table',
        reason: 'acl_denied',
        table: 'sys_script_include',
        next: {
          tool: 'search_code',
          args: { scope_id: scope, pattern: 'u_close_code', tables: ['sys_script_include'] },
        },
      }),
    );
    expect(all.data.matches.map((m: { table: string }) => m.table)).toEqual([
      'sys_script',
      'x_acme_custom_rule',
    ]);
    expect(h.dataRequests.some((d) => d.table === 'sys_credentials_x')).toBe(false);
    await h.close();
  });

  it('more matches than snippets: says so and names the call to read it all', async () => {
    const sn = dictionaryFixture();
    scriptTable(sn, 'sys_script');
    const lines = Array.from({ length: 200 }, (_, i) => (i % 20 === 0 ? `hit ${i}` : `line ${i}`));
    const row = sn.insert('sys_script', { name: 'Many', script: lines.join('\n') });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'hit ' });
    expect(r.data.matches[0].hits[0].matches).toBe(10);
    expect(r.data.matches[0].hits[0].snippets).toHaveLength(3);
    expect(r.complete).toBe(false);
    const om = r.omitted.find((o: { kind: string }) => o.kind === 'field');
    expect(om.next).toEqual({
      tool: 'get_field_content',
      args: { scope_id: scope, table: 'sys_script', sys_id: row.sys_id, field: 'script' },
    });
    const full = await h.call(om.next.tool, om.next.args);
    expect(full.data.lines.filter((l: { text: string }) => l.text.startsWith('hit '))).toHaveLength(
      10,
    );
    await h.close();
  });

  it('a record too large to read with its scripts is named, not lost; smaller pages adapt', async () => {
    const sn = dictionaryFixture();
    scriptTable(sn, 'sys_script');
    const rows = Array.from({ length: 10 }, (_, i) =>
      sn.insert('sys_script', { name: `r${i}`, script: `needle ${i}` }),
    );
    const big = rows[4]?.sys_id as string;
    // Windows containing the 5th row are too large, even alone; id-only reads are fine.
    const h = await harness({
      sn,
      tooLarge: (op) =>
        op.fields?.includes('script') === true && op.offset <= 4 && op.offset + op.limit > 4,
    });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'needle' });
    expect(r.data.matches.map((m: { sys_id: string }) => m.sys_id).sort()).toEqual(
      rows
        .map((x) => x.sys_id)
        .filter((x) => x !== big)
        .sort(),
    );
    expect(r.omitted).toContainEqual(
      expect.objectContaining({
        kind: 'field',
        reason: 'too_large',
        sys_id: big,
        field: 'script',
        total_chars: null,
      }),
    );
    expect(r.complete).toBe(false);
    await h.close();
  });

  it('ACL-hidden rows: nothing lost or repeated across small pages', async () => {
    const sn = dictionaryFixture();
    scriptTable(sn, 'sys_script');
    const rows = Array.from({ length: 150 }, (_, i) =>
      sn.insert('sys_script', { name: `r${i}`, script: `needle ${i}` }),
    );
    const hidden = (r: Record<string, unknown>) =>
      String(r.name ?? '').match(/^r\d*[05]$/) !== null;
    const visible = rows.filter((r) => !hidden(r)).map((r) => r.sys_id);
    const h = await harness({ sn, hidden });
    const scope = await claim(h, 'dev');
    const pages = await walk(h, scope, { pattern: 'needle', limit: 11 });
    const ids = pages.flatMap((p) => p.data.matches.map((m: { sys_id: string }) => m.sys_id));
    expect(ids).toHaveLength(visible.length);
    expect(ids.sort()).toEqual([...visible].sort());
    await h.close();
  });

  it('one call searches a batch of tables, and says how to continue', async () => {
    const sn = dictionaryFixture();
    for (let t = 0; t < 70; t++) scriptTable(sn, `u_t_${String(t).padStart(2, '0')}`);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'absent' });
    expect(r.data).toMatchObject({ tables_searched: 25, tables_remaining: 45, tables_total: 70 });
    expect(r.omitted[0]).toMatchObject({ kind: 'rows', reason: 'batch' });
    expect(r.hints.join(' ')).toMatch(/Pass tables/);
    await h.close();
  });

  it('a table with several query groups is not counted done until the last group ran', async () => {
    const sn = dictionaryFixture();
    scriptTable(sn, 'u_wide');
    for (let i = 0; i < 25; i++)
      scriptTable(sn, 'u_wide', 'script', `u_s${String(i).padStart(2, '0')}`);
    sn.insert('u_wide', { name: 'a', script: 'none', u_s00: 'needle' });
    sn.insert('u_wide', { name: 'b', script: 'none', u_s15: 'needle' });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const first = await h.call('search_code', { scope_id: scope, pattern: 'needle', limit: 1 });
    expect(first.data.tables_searched).toBe(0);
    const second = await h.call('search_code', {
      scope_id: scope,
      cursor: first.page.next_cursor,
    });
    expect(second.data.tables_searched).toBe(0);
    expect(second.data.tables_remaining).toBe(1);
    expect(second.page.next_cursor).toBeTruthy();
    await h.close();
  });

  it('nothing is skipped silently: unusable names and credential fields are reported', async () => {
    const sn = fixture();
    // A field name outside the connector's rules, next to a usable one on the same table.
    scriptTable(sn, 'sys_script', 'script', 'u_Mixed_Case');
    scriptTable(sn, 'sys_script', 'script', 'u_other');
    sn.insert('sys_script', { name: 'Other field', u_other: 'u_close_code' });
    // A table with only a credential-named script field.
    scriptTable(sn, 'u_vault', 'script', 'u_api_key');
    // A dictionary row for a table name the connector can't query.
    sn.insert('sys_dictionary', {
      name: 'Bad-Table',
      element: 'script',
      column_label: 's',
      internal_type: 'script',
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'u_close_code' });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    // The usable fields of the same table were still searched.
    expect(r.data.matches.map((m: { name: string }) => m.name)).toContain('Other field');
    expect(r.omitted).toContainEqual(
      expect.objectContaining({
        kind: 'fields',
        reason: 'unsupported_name',
        fields: ['sys_script.u_Mixed_Case'],
      }),
    );
    expect(r.omitted).toContainEqual(
      expect.objectContaining({ kind: 'table', reason: 'unsupported_name', table: 'Bad-Table' }),
    );
    expect(r.omitted).toContainEqual(
      expect.objectContaining({
        kind: 'fields',
        reason: 'sensitive',
        table: 'u_vault',
        fields: ['u_api_key'],
      }),
    );
    await h.close();
  });

  it('explains var__m_ tables, which the live run showed are listed but not queryable', async () => {
    const sn = fixture();
    sn.insert('sys_dictionary', {
      name: 'var__m_abc',
      element: 'script',
      column_label: 's',
      internal_type: 'script',
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'u_close_code' });
    expect(r.omitted).toContainEqual(
      expect.objectContaining({ table: 'var__m_abc', reason: 'not_found' }),
    );
    expect(r.hints.join(' ')).toMatch(/var__m_/);
    await h.close();
  });

  it('an unreadable table says why', async () => {
    const h = await harness({ sn: fixture(), denyTables: ['sys_script'] });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'u_close_code' });
    const om = r.omitted.find((o: { table?: string }) => o.table === 'sys_script');
    expect(om).toMatchObject({ reason: 'acl_denied', code: 'ACL_DENIED' });
    expect(om.message).toMatch(/Insufficient rights/);
    await h.close();
  });

  it('the word javascript is searchable, finds javascript: lines, and the prefix is refused', async () => {
    const sn = fixture();
    sn.insert('sys_script', {
      name: 'Qualifier',
      script: 'x\nvar q = "javascript:gs.getUserID()";\ny',
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'javascript' });
    expect(r.ok).toBe(true);
    expect(r.data.matches[0].name).toBe('Qualifier');
    expect(r.data.matches[0].hits[0].snippets[0].lines.join('\n')).toContain('javascript:gs');
    const refused = await h.call('search_code', { scope_id: scope, pattern: 'javascript:' });
    expect(refused.error.code).toBe('UNSAFE_QUERY');
    expect(refused.error.hint).toMatch(/without the colon/);
    await h.close();
  });

  it('a table named with javascript can be searched and described', async () => {
    const sn = fixture();
    scriptTable(sn, 'automation_pipeline_transformer_javascript');
    sn.insert('automation_pipeline_transformer_javascript', { name: 'T', script: 'needle' });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'needle' });
    expect(r.complete).toBe(true);
    expect(r.data.matches[0].table).toBe('automation_pipeline_transformer_javascript');
    const d = await h.call('describe_table', {
      scope_id: scope,
      table: 'automation_pipeline_transformer_javascript',
    });
    expect(d.ok).toBe(true);
    await h.close();
  });

  it('hitting the limit exactly on the last match is complete, with no empty extra call', async () => {
    const h = await harness({ sn: fixture() });
    const scope = await claim(h, 'dev');
    const r = await h.call('search_code', { scope_id: scope, pattern: 'u_close_code', limit: 3 });
    expect(r.data.matches).toHaveLength(3);
    expect(r.complete).toBe(true);
    expect(r.page.next_cursor).toBeNull();
    await h.close();
  });

  it('a session failure stops; a mixed cursor is refused', async () => {
    const h = await harness({ sn: fixture() });
    const scope = await claim(h, 'dev');
    const first = await h.call('search_code', {
      scope_id: scope,
      pattern: 'u_close_code',
      limit: 1,
    });
    expect(first.page.next_cursor).toBeTruthy();
    const mixed = await h.call('search_code', {
      scope_id: scope,
      cursor: first.page.next_cursor,
      pattern: 'other',
    });
    expect(mixed.error.code).toBe('INVALID_INPUT');
    h.revoke(scope);
    const after = await h.call('search_code', { scope_id: scope, cursor: first.page.next_cursor });
    expect(after.error.code).toBe('SCOPE_UNKNOWN');
    await h.close();
  });
});

describe('snippet and target helpers', () => {
  it('merges overlapping context, counts every match, cuts long lines to the match', () => {
    const s = makeSnippets('a\nx1\nb\nx2\nc\nd\ne\nf\ng\nh\ni\nj\nx3', 'x');
    expect(s.matches).toBe(3);
    expect(s.shownMatches).toBe(3);
    expect(s.snippets.map((p) => p.start_line)).toEqual([1, 10]);
    const long = makeSnippets(`${'a'.repeat(5000)}NEEDLE${'b'.repeat(5000)}`, 'needle');
    expect(long.snippets[0]?.lines[0]).toContain('NEEDLE');
    expect(long.snippets[0]?.lines[0]?.length ?? 0).toBeLessThan(260);
    expect(makeSnippets('nothing', 'x')).toEqual({ matches: 0, shownMatches: 0, snippets: [] });
  });

  it('splits tables with many script fields so each query stays valid', () => {
    const fields = Array.from({ length: 25 }, (_, i) => ({
      table: 't',
      field: `u_a_long_script_field_name_${i}`,
    }));
    const targets = buildTargets(fields, 'p'.repeat(200));
    expect(targets.length).toBeGreaterThan(2);
    expect(targets.flatMap((t) => t.fields)).toHaveLength(25);
    for (const t of targets) {
      expect(t.fields.length).toBeLessThanOrEqual(10);
      const size = t.fields.reduce((n, f) => n + f.length + 200 + 10, 0);
      expect(size).toBeLessThan(2048);
    }
  });
});
