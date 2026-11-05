/**
 * Checks the logic of the T-034 live scenarios against the in-memory fake, so the first live run
 * tests the connector and not the script. A mock: never evidence of real connectivity (rule 11).
 */
import { describe, expect, it } from 'vitest';
import { runScenarios, SCENARIOS } from '../../../test/e2e/scenarios.ts';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness } from './mcp-harness.js';

function instance(): FakeServiceNow {
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
  ]) {
    sn.insert('sys_db_object', { name: t, label: t, super_class: '' });
  }
  dict('x_acme_app', 'x_name');
  dict('syslog', 'level');
  dict('syslog', 'sys_created_on', 'glide_date_time');
  dict('sys_script', 'script', 'script');
  dict('sys_script_include', 'script', 'script_plain');
  dict('sys_script_include', 'name', 'string', { display: 'true' });
  dict('cmdb_ci', 'name', 'string', { display: 'true' });
  for (const f of ['documentkey', 'user', 'fieldname', 'oldvalue', 'newvalue', 'sys_created_on'])
    dict('sys_audit', f);
  for (const f of ['element_id', 'sys_created_by', 'element', 'value', 'sys_created_on'])
    dict('sys_journal_field', f);
  dict('task', 'active', 'boolean');
  dict('task', 'comments_and_work_notes', 'journal_list');
  dict('task', 'cmdb_ci', 'reference', { reference: 'cmdb_ci' });
  for (let i = 0; i < 2600; i++)
    sn.insert('syslog', { level: String(i % 3), sys_created_on: '2020-01-01 00:00:00' });
  sn.insert('sys_script_include', {
    name: 'Big',
    script: Array.from({ length: 3000 }, (_, i) => `var short_description${i};`).join('\n'),
  });
  sn.insert('sys_script', { script: 'current.short_description = 1;' });
  const ci = sn.insert('cmdb_ci', { name: 'web01' });
  const user = sn.insert('sys_user', { user_name: 'beth' });
  const inc = sn.insert('incident', {
    number: 'INC0000060',
    active: 'true',
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
    expect(text).not.toMatch(/INC0000060|beth|web01|short_description\d/);
    await h.close();
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
