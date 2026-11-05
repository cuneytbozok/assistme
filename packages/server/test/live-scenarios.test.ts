/**
 * Checks the logic of the T-034 live scenarios against the in-memory fake, so the first live run
 * tests the connector and not the script. A mock: never evidence of real connectivity (rule 11).
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runScenarios, SCENARIOS } from '../../../test/e2e/scenarios.ts';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness } from './mcp-harness.js';

/** The assumed format of a version's payload: unconfirmed until a live run (T-042). */
const xml = (script: string) =>
  `<?xml version="1.0"?><record_update table="sys_script_include"><sys_script_include action="INSERT"><active>true</active><script><![CDATA[${script}]]></script><sys_mod_count>1</sys_mod_count></sys_script_include></record_update>`;

function instance(
  payloads: string[] = [xml('var v = 1;'), xml('var v = 2;\nvar w;')],
): FakeServiceNow {
  const sn = dictionaryFixture();
  const dict = (name: string, element: string, type = 'string', extra = {}) =>
    sn.insert('sys_dictionary', {
      name,
      element,
      column_label: element,
      internal_type: type,
      reference: '',
      max_length: '4000',
      mandatory: 'false',
      display: 'false',
      ...extra,
    });
  for (const t of [
    'syslog',
    'sys_script',
    'sys_script_include',
    'sys_audit',
    'sys_journal_field',
    'cmdb_ci',
    'x_acme_app',
    'sys_update_version',
  ]) {
    sn.insert('sys_db_object', { name: t, label: t, super_class: '' });
  }
  dict('x_acme_app', 'x_name');
  dict('syslog', 'level');
  dict('syslog', 'sys_created_on', 'glide_date_time');
  dict('sys_script', 'script', 'script');
  dict('sys_script_include', 'script', 'script_plain');
  dict('sys_script_include', 'name', 'string', { display: 'true' });
  dict('sys_script_include', 'active', 'boolean');
  dict('sys_update_version', 'name', 'string', { display: 'true' });
  dict('sys_update_version', 'payload', 'xml');
  dict('sys_update_version', 'state');
  dict('sys_update_version', 'sys_created_on', 'glide_date_time');
  payloads.forEach((payload, i) => {
    sn.insert('sys_update_version', {
      name: 'sys_script_include_abc',
      payload,
      state: i === payloads.length - 1 ? 'current' : 'previous',
      sys_created_on: `2026-01-0${i + 1} 00:00:00`,
    });
  });
  dict('cmdb_ci', 'name', 'string', { display: 'true' });
  for (const f of ['documentkey', 'user', 'fieldname', 'oldvalue', 'newvalue', 'sys_created_on'])
    dict('sys_audit', f);
  for (const f of ['element_id', 'sys_created_by', 'element', 'value', 'sys_created_on'])
    dict('sys_journal_field', f);
  dict('task', 'active', 'boolean');
  dict('sys_user', 'active', 'boolean');
  sn.insert('sys_db_object', { name: 'sys_dictionary', label: 'Dictionary', super_class: '' });
  dict('sys_dictionary', 'name');
  dict('task', 'assignment_group', 'reference', { reference: 'sys_user' });
  for (const f of ['collection', 'active']) dict('sys_script', f);
  dict('task', 'comments_and_work_notes', 'journal_list');
  dict('task', 'cmdb_ci', 'reference', { reference: 'cmdb_ci' });
  for (let i = 0; i < 2600; i++)
    sn.insert('syslog', { level: String(i % 3), sys_created_on: '2020-01-01 00:00:00' });
  sn.insert('sys_script_include', {
    name: 'Small',
    active: 'true',
    script: 'var small;\nvar different;',
  });
  sn.insert('sys_script_include', {
    name: 'Big',
    active: 'true',
    script: Array.from({ length: 3000 }, (_, i) => `var short_description${i};`).join('\n'),
  });
  sn.insert('sys_script', { script: 'current.short_description = 1;' });
  const ci = sn.insert('cmdb_ci', { name: 'web01' });
  const user = sn.insert('sys_user', { user_name: 'beth' });
  const inc = sn.insert('incident', {
    number: 'INC0000060',
    active: 'true',
    category: 'network',
    short_description: 'email',
    assignment_group: 'a'.repeat(32),
    state: '1',
    priority: '2',
    caller_id: sn.ref('sys_user', user),
    cmdb_ci: sn.ref('cmdb_ci', ci),
    comments_and_work_notes: 'a note',
    sys_created_on: '2020-01-01 00:00:00',
  });
  sn.insert('incident', {
    number: 'INC2',
    active: 'true',
    state: '2',
    priority: '3',
    sys_created_on: '2020-01-02 00:00:00',
  });
  sn.insert('sys_audit', {
    documentkey: inc.sys_id,
    user: 'a',
    fieldname: 'state',
    oldvalue: '1',
    newvalue: '2',
    sys_created_on: '2021-01-01 00:00:00',
  });
  sn.insert('sys_journal_field', {
    element_id: inc.sys_id,
    sys_created_by: 'a',
    element: 'comments',
    value: 'hi',
    sys_created_on: '2021-01-02 00:00:00',
  });
  return sn;
}

describe('T-034 scenario logic (mock)', () => {
  it('the scenarios load in plain Node, as npm run e2e:live runs them', () => {
    // Vitest compiles TypeScript that Node's strip-only mode refuses, so only this shows it.
    const url = new URL('../../../test/e2e/scenarios.ts', import.meta.url).href;
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(url)}); console.log(m.SCENARIOS.length);`,
      ],
      { encoding: 'utf8' },
    );
    expect(Number(out.trim())).toBe(SCENARIOS.length);
  });

  it('every scenario passes against the fake, with no record content in the results', async () => {
    const h = await harness({ sn: instance() });
    const scope = await claim(h, 'dev');
    const results = await runScenarios(
      (tool, args) =>
        h.call(tool, args).catch((e: Error) => ({
          ok: false,
          error: { code: 'INVALID_INPUT', message: e.message },
        })),
      scope,
    );
    const notPassed = results.filter((r) => r.status !== 'pass');
    expect(notPassed.map((r) => `${r.name}: ${r.note}`)).toEqual([]);
    expect(results).toHaveLength(SCENARIOS.length);
    const text = JSON.stringify(results);
    expect(text).not.toMatch(/INC0000060|beth|web01|short_description\d|var v =|abc/);
    await h.close();
  });

  const versions = async (payloads: string[]) => {
    const h = await harness({ sn: instance(payloads) });
    const scope = await claim(h, 'dev');
    const [r] = await runScenarios(h.call, scope, undefined, 'two versions');
    await h.close();
    return r;
  };

  it('T-042 versions: reads by element in the assumed format, and rebuilds the script', async () => {
    const r = await versions([xml('var v = 1;\nend'), xml('var v = 2;\nvar w;\nend')]);
    expect(r?.status).toBe('pass');
    expect(r?.metrics).toMatchObject({
      mode: 'elements',
      versions_of_record: 2,
      record_table: 'sys_script_include',
      payload_root: 'record_update',
      payload_has_cdata: true,
      diffs_applied: 1,
    });
    expect(r?.metrics?.assumed_fields_missing).toContain('source');
    expect(Number(r?.metrics?.script_diff_lines)).toBeGreaterThan(0);
  });

  it('T-042 versions: a raw diff with no script change is a skip, with the shapes', async () => {
    const r = await versions(['a\nb\nc', 'a\nB\nc']);
    expect(r?.status).toBe('skip');
    expect(r?.metrics).toMatchObject({
      mode: 'raw',
      diffs_applied: 1,
      payload_lines: [3, 3],
      raw_script_changed: false,
      pairs_raw: 1,
      raw_shapes: [[{ failed_at: 'root' }, { failed_at: 'root' }]],
    });
    expect(r?.metrics?.payload_elements).toBeUndefined();
  });

  /** Several records, and a root that doesn't say which is the main one. */
  const twoRecords = (script: string) =>
    xml(script)
      .replace(' table="sys_script_include"', '')
      .replace(
        '</record_update>',
        '<sys_translated_text action="delete_multiple" query="SECRET_VALUE"/></record_update>',
      );

  it('T-042 versions: the several-record form seen live is read by element', async () => {
    const seenLive = (script: string, extra = '') =>
      xml(script).replace(
        '</record_update>',
        `${extra}<sys_es_latest_script action="INSERT_OR_UPDATE"><id>x</id></sys_es_latest_script></record_update>`,
      );
    const r = await versions([
      seenLive('var v = 1;\nend'),
      seenLive('var v = 2;\nend', '<sys_translated_text action="delete_multiple" query="q"/>'),
    ]);
    expect(r?.status).toBe('pass');
    expect(r?.metrics).toMatchObject({ mode: 'elements', pairs_raw: 0, only_on_one_side: 1 });
    expect(Number(r?.metrics?.script_diff_lines)).toBeGreaterThan(0);
  });

  it('T-042 versions: a raw diff with a script change passes, and says why it was raw', async () => {
    const r = await versions([twoRecords('var v = 1;\nend'), twoRecords('var v = 2;\nend')]);
    expect(r?.status).toBe('pass');
    expect(r?.metrics).toMatchObject({ mode: 'raw', raw_script_changed: true, diffs_applied: 1 });
    expect(r?.metrics?.raw_shapes).toEqual([
      [0, 1].map(() => ({
        failed_at: 'records',
        roots: ['record_update'],
        records: [
          { name: 'sys_script_include', action: 'INSERT' },
          { name: 'sys_translated_text', action: 'delete_multiple' },
        ],
      })),
    ]);
    expect(JSON.stringify(r)).not.toContain('SECRET_VALUE');
  });

  it('T-042 versions: an element diff is preferred to a raw one found first', async () => {
    const sn = instance([twoRecords('var v = 1;\nend'), twoRecords('var v = 2;\nend')]);
    for (const script of ['var e = 1;\nend', 'var e = 2;\nend']) {
      sn.insert('sys_update_version', {
        name: 'sys_script_include_def',
        payload: xml(script),
        state: 'previous',
        sys_created_on: script.includes('1') ? '2026-01-01 00:00:00' : '2026-01-02 00:00:00',
      });
    }
    const h = await harness({ sn });
    const [r] = await runScenarios(h.call, await claim(h, 'dev'), undefined, 'two versions');
    await h.close();
    expect(r?.status).toBe('pass');
    expect(r?.metrics).toMatchObject({ mode: 'elements', pairs_checked: 2, pairs_raw: 1 });
    expect(Number(r?.metrics?.script_diff_lines)).toBeGreaterThan(0);
  });

  it('T-042 versions: versions with the same script are a skip, not a pass, with the metrics', async () => {
    const r = await versions([xml('same\nscript'), xml('same\nscript').replace('true', 'false')]);
    expect(r?.status).toBe('skip');
    expect(r?.note).toMatch(/none changed a script/);
    expect(r?.metrics).toMatchObject({ mode: 'elements', pairs_checked: 1, script_diff_lines: 0 });
    expect(r?.metrics?.inline_field_names).toContain('payload.active');
  });

  it('T-042 versions: no record with two versions is a skip that says what to do', async () => {
    const r = await versions([xml('only one')]);
    expect(r?.status).toBe('skip');
    expect(r?.note).toMatch(/Save a script include twice/);
  });

  it('a scenario failure is reported, not thrown; a partial result with no omitted fails', async () => {
    const results = await runScenarios(
      async () => ({ ok: true, complete: false, data: {} }),
      'scp',
    );
    expect(results.every((r) => r.status === 'fail')).toBe(true);
    expect(results[0]?.note).toMatch(/nothing in omitted/);
  });
});
