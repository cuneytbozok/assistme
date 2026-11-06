/**
 * T-047: native encoded-query compatibility and query diagnostics (mocked instance).
 * Mocks show the connector's own behaviour, not ServiceNow's (rule 11).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGH_VOLUME_TABLES } from '../src/config.js';
import { type MetaContext, MetadataService } from '../src/mcp/metadata.js';
import { planQuery, type QueryRequest } from '../src/mcp/query-guard.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, harness, withIncidents } from './mcp-harness.js';

function withCmdb(sn: FakeServiceNow): FakeServiceNow {
  const ci = sn.insert('sys_db_object', { name: 'cmdb_ci', label: 'CI', super_class: '' });
  sn.insert('sys_db_object', {
    name: 'cmdb_ci_server',
    label: 'Server',
    super_class: sn.ref('sys_db_object', ci),
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
  dict('cmdb_ci_server', 'os', 'string');
  dict('incident', 'cmdb_ci', 'reference', 'cmdb_ci');
  return sn;
}

function setup() {
  const sn = withCmdb(dictionaryFixture());
  const ctx: MetaContext = {
    instanceKey: 'dev',
    fetch: async (req) => ({ ok: true, rows: sn.list(req).rows }),
  };
  const meta = new MetadataService();
  const plan = (req: QueryRequest, allowTextSearch = true) =>
    planQuery(meta, ctx, req, { highVolumeTables: DEFAULT_HIGH_VOLUME_TABLES, allowTextSearch });
  return { sn, meta, ctx, plan };
}

describe('T-047: UI-copied and SDK-style queries are accepted and sent in canonical form', () => {
  it.each([
    ['priority=1^EQ', 'priority=1', /removed the \^EQ end marker/],
    ['short_descriptionNOTLIKEtest', 'short_descriptionNOT LIKEtest', /NOTLIKE → NOT LIKE/],
    ['short_descriptionCONTAINSdisk', 'short_descriptionLIKEdisk', /CONTAINS → LIKE/],
    ['priority=1^EQ^ORDERBYnumber', 'priority=1^ORDERBYnumber', /\^EQ/],
  ])('%s', async (input, sent, note) => {
    const s = setup();
    const p = await s.plan({ table: 'incident', encoded_query: input });
    expect(p.query).toBe(sent);
    expect(p.hints.join(' ')).toMatch(note);
    expect(p.hints.join(' ')).toContain(`Sent: ${sent}`);
  });

  it('an already canonical query gets no normalization hint', async () => {
    const p = await setup().plan({ table: 'incident', encoded_query: 'priority=1' });
    expect(p.hints.join(' ')).not.toMatch(/canonical/);
  });

  it('empty = and != are sent as written', async () => {
    const p = await setup().plan({
      table: 'incident',
      encoded_query: 'assigned_to=^ORcaller_id!=',
    });
    expect(p.query).toBe('assigned_to=^ORcaller_id!=');
  });

  it('literal code text is no longer refused in raw queries', async () => {
    const template = ['$', '{number}'].join(''); // a literal "${number}", as in a mail template
    const q = `short_descriptionLIKEnew laptop^ORshort_descriptionLIKE${template}`;
    const p = await setup().plan({ table: 'incident', encoded_query: q });
    expect(p.query).toBe(q);
  });

  it('a likely mistake is a hint, not a refusal', async () => {
    const p = await setup().plan({
      table: 'incident',
      encoded_query: 'category=network AND priority=1',
    });
    expect(p.hints.join(' ')).toMatch(/Check the query: .*\^ \(AND\)/);
  });
});

describe('T-047: refusals say which condition, why, and the native rewrite', () => {
  it.each([['priority = 1', /no spaces/, /Try: priority=1/]])('%s', async (q, message, hint) => {
    const err = await setup()
      .plan({ table: 'incident', encoded_query: q })
      .catch((e) => e);
    expect(err.message).toMatch(message);
    expect(err.hint).toMatch(hint);
  });

  it('a wrong field in MORETHAN / LESSTHAN gets INVALID_FIELD, not an empty result', async () => {
    const err = await setup()
      .plan({ table: 'incident', encoded_query: 'sys_updated_onMORETHANzz_no_field@hour@after@1' })
      .catch((e) => e);
    expect(err.code).toBe('INVALID_FIELD');
  });

  it('a script value is sent, and the result warns that it runs as script (ADR-018)', async () => {
    const p = await setup().plan({
      table: 'incident',
      encoded_query: 'assigned_to=javascript:gs.getUserID()',
    });
    expect(p.query).toContain('assigned_to=javascript:gs.getUserID()');
    expect(p.hints.join(' ')).toMatch(/server-side script/);
  });
});

describe('T-047: ref_<table> downcasts in dot-walks', () => {
  it('resolves a child table field through ref_', async () => {
    const s = setup();
    const p = await s.plan({
      table: 'incident',
      encoded_query: 'cmdb_ci.ref_cmdb_ci_server.os=Linux',
    });
    expect(p.referencedFields).toContain('cmdb_ci.ref_cmdb_ci_server.os');
    const r = await s.meta.resolvePath(s.ctx, 'incident', 'cmdb_ci.ref_cmdb_ci_server.os');
    expect(r.tables).toEqual(['incident', 'cmdb_ci', 'cmdb_ci_server']);
  });

  it.each([
    ['cmdb_ci.ref_sys_user.name=x', /doesn't extend cmdb_ci/],
    ['cmdb_ci.ref_no_such_table.name=x', /no table no_such_table/],
    ['cmdb_ci.ref_cmdb_ci_server=x', /name a field of cmdb_ci_server/],
    ['cmdb_ci.ref_cmdb_ci_server.zz_nope=x', /does not exist on cmdb_ci_server/],
  ])('refuses %s', async (q, message) => {
    const err = await setup()
      .plan({ table: 'incident', encoded_query: q })
      .catch((e) => e);
    expect(err.code).toBe('INVALID_FIELD');
    expect(err.message).toMatch(message);
  });
});

describe('T-047: an empty result explains likely causes', () => {
  it('a choice label instead of its value, and a display value on a reference', async () => {
    const h = await harness({ sn: withIncidents(5) });
    const scope = await claim(h, 'dev');
    const byLabel = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      encoded_query: 'state=In Progress',
    });
    expect(byLabel.ok).toBe(true);
    expect(byLabel.data.records).toEqual([]);
    expect(byLabel.hints.join(' ')).toMatch(
      /"In Progress" is the label of state choice 2\. .*use state=2/,
    );

    const unknownValue = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      where: [{ field: 'state', op: '=', value: 42 }],
    });
    expect(unknownValue.hints.join(' ')).toMatch(
      /state has no choice value "42"\. Its values: 1 \(New\)/,
    );

    const byName = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      encoded_query: 'assigned_to=Beth Anglin',
    });
    expect(byName.hints.join(' ')).toMatch(
      /assigned_to is a reference to sys_user.*assigned_to\.name=Beth Anglin/,
    );
    await h.close();
  });

  it('aggregate_records reports the rewrite too', async () => {
    const h = await harness({ sn: withIncidents(5) });
    const scope = await claim(h, 'dev');
    const r = await h.call('aggregate_records', {
      scope_id: scope,
      table: 'incident',
      encoded_query: 'priority=1^EQ',
    });
    expect(r.ok).toBe(true);
    expect(r.hints.join(' ')).toMatch(/removed the \^EQ end marker.*Sent: priority=1/);
    await h.close();
  });

  it('no diagnostic when rows are found', async () => {
    const h = await harness({ sn: withIncidents(5) });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      encoded_query: 'priority=1',
    });
    expect(r.data.records.length).toBeGreaterThan(0);
    expect((r.hints ?? []).join(' ')).not.toMatch(/label of|is a reference/);
    await h.close();
  });
});
