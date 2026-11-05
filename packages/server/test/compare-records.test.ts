/**
 * T-032: compare_records, with one in-memory fake per instance (mock only).
 */
import { describe, expect, it } from 'vitest';
import { applyUnified, diffLines, unifiedDiff } from '../src/mcp/line-diff.js';
import { describePayload, parseUpdatePayload } from '../src/mcp/update-payload.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, claimCompare, type Harness, harness } from './mcp-harness.js';

function instanceWithScripts(scripts: Record<string, string>): FakeServiceNow {
  const sn = dictionaryFixture();
  sn.insert('sys_db_object', { name: 'sys_script_include', label: 'SI', super_class: '' });
  const dict = (element: string, type: string, display = 'false') =>
    sn.insert('sys_dictionary', {
      name: 'sys_script_include',
      element,
      column_label: element,
      internal_type: type,
      reference: '',
      max_length: '8000000',
      mandatory: 'false',
      display,
    });
  dict('name', 'string', 'true');
  dict('script', 'script_plain');
  dict('active', 'boolean');
  dict('sys_updated_on', 'glide_date_time');
  for (const [name, script] of Object.entries(scripts)) {
    sn.insert('sys_script_include', { name, script, active: 'true', sys_updated_on: 'x' });
  }
  return sn;
}

async function walk(h: Harness, scope: string, first: Record<string, unknown>) {
  const pages: any[] = [];
  let r = await h.call('compare_records', { scope_id: scope, ...first });
  for (;;) {
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    pages.push(r);
    if (!r.page.next_cursor) return pages;
    expect(r.complete).toBe(false);
    const more = r.omitted.find((o: { kind: string }) => o.kind === 'rows');
    r = await h.call(more.next.tool, {
      ...more.next.args,
      ...(first.max_chars ? { max_chars: first.max_chars } : {}),
    });
  }
}

/** All diff lines of a field across pages. */
const linesOf = (pages: any[], field: string) =>
  pages.flatMap((p) =>
    (p.data.diffs ?? [])
      .filter((d: { field: string }) => d.field === field)
      .flatMap((d: { lines: string[] }) => d.lines),
  );

describe('T-032 compare_records', () => {
  it('with no scope, nothing is read', async () => {
    const h = await harness();
    expect(
      (await h.call('compare_records', { table: 'incident', match_a: { number: 'X' } })).error.code,
    ).toBe('SCOPE_REQUIRED');
    expect(h.dataRequests).toEqual([]);
    await h.close();
  });

  it('field diff, script diff, ignored system fields and provenance for both sides', async () => {
    const dev = instanceWithScripts({ MyUtil: 'var a = 1;\nvar b = 2;\nreturn a;' });
    const prod = instanceWithScripts({ MyUtil: 'var a = 1;\nvar b = 3;\nreturn a;' });
    (prod.tables.get('sys_script_include') as { active: string }[])[0].active = 'false';
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'MyUtil' },
    });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.data.identical).toBe(false);
    expect(r.data.different_fields).toEqual([{ field: 'active', a: 'true', b: 'false' }]);
    expect(r.data.diffs[0].field).toBe('script');
    expect(r.data.diffs[0].lines).toEqual([
      '@@ -1,3 +1,3 @@',
      ' var a = 1;',
      '-var b = 2;',
      '+var b = 3;',
      ' return a;',
    ]);
    expect(r.data.ignored_fields).toContain('sys_updated_on');
    expect(r.data.a).toMatchObject({ instance: 'dev', host: 'dev.service-now.com' });
    expect(r.data.b).toMatchObject({ instance: 'prod', host: 'prod.service-now.com' });
    expect(r.data.a.link).toContain('dev.service-now.com');
    expect(r.data.b.link).toContain('prod.service-now.com');
    expect(r.provenance.instance).toBe('dev,prod');
    expect(r.requests_used).toBeGreaterThanOrEqual(4);
    await h.close();
  });

  it('identical records say so; match_b can differ; sys_id works directly', async () => {
    const dev = instanceWithScripts({ A: 'same' });
    const prod = instanceWithScripts({ B: 'same' });
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
      match_b: { name: 'B' },
      fields: ['script', 'active'],
    });
    expect(r.data.identical).toBe(true);
    expect(r.data.equal_fields).toBe(2);
    expect(r.data.ignored_fields).toBeUndefined();
    const id = dev.tables.get('sys_script_include')?.[0]?.sys_id as string;
    const pid = prod.tables.get('sys_script_include')?.[0]?.sys_id as string;
    const direct = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { sys_id: id },
      match_b: { sys_id: pid },
    });
    expect(direct.data.a.sys_id).toBe(id);
    expect(direct.data.b.sys_id).toBe(pid);
    const bad = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { sys_id: 'nope' },
    });
    expect(bad.error.code).toBe('INVALID_INPUT');
    await h.close();
  });

  it('ambiguity and absence are reported per side, never guessed', async () => {
    const dev = instanceWithScripts({ One: 'x' });
    const prod = instanceWithScripts({ One: 'y' });
    prod.insert('sys_script_include', { name: 'One', script: 'z', active: 'true' });
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    const amb = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'One' },
    });
    expect(amb.error.code).toBe('AMBIGUOUS_MATCH');
    expect(amb.error.side).toBe('b');
    expect(amb.error.candidates).toHaveLength(2);
    expect(amb.error.list_all.args.instance).toBe('prod');
    const all = await h.call(amb.error.list_all.tool, amb.error.list_all.args);
    expect(all.data.records).toHaveLength(2);
    const none = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'Absent' },
    });
    expect(none.error.code).toBe('NOT_FOUND');
    expect(none.error.side).toBe('a');
    await h.close();
  });

  it('a 5,000-line script diff is fully retrievable through cursors and applies exactly', async () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i} of the script`).join('\n');
    const b = a
      .split('\n')
      .map((l, i) => (i % 40 === 0 ? `${l} changed` : l))
      .filter((_, i) => i % 333 !== 7)
      .join('\n');
    const dev = instanceWithScripts({ Big: a });
    const prod = instanceWithScripts({ Big: b });
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    const before = h.dataRequests.length;
    const pages = await walk(h, scope, {
      table: 'sys_script_include',
      match_a: { name: 'Big' },
      max_chars: 8000,
    });
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) expect(JSON.stringify(p).length).toBeLessThan(9000);
    expect(pages.at(-1).complete).toBe(true);
    const lines = linesOf(pages, 'script');
    expect(lines.filter((l: string) => l.startsWith('@@')).length).toBeGreaterThan(50);
    expect(applyUnified(a, lines)).toBe(b);
    // Later pages come from the snapshot: only the first call reads records.
    const gets = h.dataRequests.slice(before).filter((d) => d.kind === 'table.get');
    expect(gets).toHaveLength(2);
    await h.close();
  });

  it('a revoked scope gets no more pages from the snapshot; another instance pair is refused', async () => {
    const a = Array.from({ length: 2000 }, (_, i) => `a ${i}`).join('\n');
    const b = Array.from({ length: 2000 }, (_, i) => `b ${i}`).join('\n');
    const dev = instanceWithScripts({ Big: a });
    const prod = instanceWithScripts({ Big: b });
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    const first = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'Big' },
    });
    expect(first.page.next_cursor).toBeTruthy();
    const mixed = await h.call('compare_records', {
      scope_id: scope,
      cursor: first.page.next_cursor,
      table: 'incident',
    });
    expect(mixed.error.code).toBe('INVALID_INPUT');
    const tampered = await h.call('compare_records', { scope_id: scope, cursor: 'x.y' });
    expect(tampered.error.code).toBe('INVALID_INPUT');
    const one = await claim(h, 'dev');
    const single = await h.call('compare_records', {
      scope_id: one,
      cursor: first.page.next_cursor,
    });
    expect(single.error.code).toBe('INVALID_INPUT');
    h.revoke(scope);
    const denied = await h.call('compare_records', {
      scope_id: scope,
      cursor: first.page.next_cursor,
    });
    expect(denied.error.code).toBe('SCOPE_UNKNOWN');
    await h.close();
  });

  it('credential tables and fields are refused or stripped; fields only on one side are listed', async () => {
    const dev = dictionaryFixture();
    const prod = dictionaryFixture();
    prod.insert('sys_dictionary', {
      name: 'u_api_config',
      element: 'u_extra',
      column_label: 'x',
      internal_type: 'string',
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
    dev.insert('u_api_config', { u_label: 'c', u_endpoint: 'dev', u_auth: 'dev-secret' });
    prod.insert('u_api_config', {
      u_label: 'c',
      u_endpoint: 'prod',
      u_auth: 'prod-secret',
      u_extra: 'e',
    });
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'u_api_config',
      match_a: { u_label: 'c' },
    });
    expect(JSON.stringify(r)).not.toMatch(/dev-secret|prod-secret/);
    expect(r.omitted.find((o: { reason: string }) => o.reason === 'sensitive').fields).toEqual([
      'u_auth',
    ]);
    expect(r.data.only_on_b).toEqual([{ field: 'u_extra', value: 'e' }]);
    expect(r.data.different_fields[0].field).toBe('u_endpoint');
    const denied = await h.call('compare_records', {
      scope_id: scope,
      table: 'discovery_credentials',
      match_a: { name: 'x' },
    });
    expect(denied.error.code).toBe('TABLE_DENIED');
    const pwd = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_user',
      match_a: { user_name: 'x' },
      fields: ['user_password'],
    });
    expect(pwd.error.code).toBe('FORBIDDEN_OPERATION');
    await h.close();
  });

  it('a named field that exists on only one side is reported, not an error', async () => {
    const dev = dictionaryFixture();
    const prod = dictionaryFixture();
    prod.insert('sys_dictionary', {
      name: 'u_api_config',
      element: 'u_extra',
      column_label: 'x',
      internal_type: 'string',
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
    dev.insert('u_api_config', { u_label: 'c' });
    prod.insert('u_api_config', { u_label: 'c', u_extra: 'e' });
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'u_api_config',
      match_a: { u_label: 'c' },
      fields: ['u_extra'],
    });
    expect(r.ok).toBe(true);
    expect(r.data.only_on_b).toEqual([{ field: 'u_extra', value: 'e' }]);
    const neither = await h.call('compare_records', {
      scope_id: scope,
      table: 'u_api_config',
      match_a: { u_label: 'c' },
      fields: ['zz_nope'],
    });
    expect(neither.error.code).toBe('INVALID_FIELD');
    await h.close();
  });

  it('with no snapshot held, pages continue from a new read and say if it changed', async () => {
    const pad = 'x'.repeat(400);
    const a = Array.from({ length: 2000 }, (_, i) => `a ${i} ${pad}`).join('\n');
    const b = Array.from({ length: 2000 }, (_, i) => `b ${i} ${pad}`).join('\n');
    const dev = instanceWithScripts({ Big: a });
    const prod = instanceWithScripts({ Big: b });
    // This snapshot is larger than a 1 MB cache, so it is never held.
    const h = await harness({ snByInstance: { dev, prod }, env: { SN_MCP_FIELD_CACHE_MB: '1' } });
    const scope = await claimCompare(h);
    const first = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'Big' },
    });
    const before = h.dataRequests.filter((d) => d.kind === 'table.get').length;
    const same = await h.call('compare_records', {
      scope_id: scope,
      cursor: first.page.next_cursor,
    });
    expect(same.ok).toBe(true);
    expect(same.hints).toBeUndefined();
    expect(h.dataRequests.filter((d) => d.kind === 'table.get').length).toBe(before + 2);
    (prod.tables.get('sys_script_include') as { script: string }[])[0].script = 'changed';
    const changed = await h.call('compare_records', {
      scope_id: scope,
      cursor: first.page.next_cursor,
    });
    expect(changed.hints.join(' ')).toMatch(/newer read/);
    await h.close();
  });

  it('marks references that differ only by sys_id across instances', async () => {
    const dev = dictionaryFixture();
    const prod = dictionaryFixture();
    dev.insert('incident', { number: 'I1', assigned_to: 'a'.repeat(32) });
    prod.insert('incident', { number: 'I1', assigned_to: 'b'.repeat(32) });
    const h = await harness({ snByInstance: { dev, prod } });
    const scope = await claimCompare(h);
    for (const sn of [dev, prod]) {
      const get = sn.get.bind(sn);
      sn.get = (req) => {
        const row = get(req);
        if (row?.assigned_to) row.assigned_to = { value: row.assigned_to, display_value: 'Beth' };
        return row;
      };
    }
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'incident',
      match_a: { number: 'I1' },
      fields: ['assigned_to'],
    });
    expect(r.data.different_fields[0]).toMatchObject({ field: 'assigned_to', same_display: true });
    await h.close();
  });
});

describe('T-042 compare_records on a single-instance scope', () => {
  /** `prod` holds a different record under the same name: any read of it would show. */
  async function oneInstance(scripts: Record<string, string>) {
    const dev = instanceWithScripts(scripts);
    const prod = instanceWithScripts({ A: 'FROM PROD' });
    prod.calls.length = 0;
    const h = await harness({ snByInstance: { dev, prod } });
    return { h, dev, prod, scope: await claim(h, 'dev') };
  }

  it('match_b is required, before any read; the hint says how to compare two instances', async () => {
    const { h, scope } = await oneInstance({ A: 'x' });
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
    });
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(r.error.message).toMatch(/match_b is required/);
    expect(r.error.hint).toMatch(/instances/);
    expect(h.dataRequests).toEqual([]);
    await h.close();
  });

  it('compares two records, naming one instance, and never touches another', async () => {
    const { h, prod, scope } = await oneInstance({
      A: 'var a = 1;\nvar b = 2;\nreturn a;',
      B: 'var a = 1;\nvar b = 3;\nreturn a;',
    });
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
      match_b: { name: 'B' },
    });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.data.identical).toBe(false);
    expect(r.data.different_fields).toEqual([{ field: 'name', a: 'A', b: 'B' }]);
    expect(r.data.diffs[0].lines).toEqual([
      '@@ -1,3 +1,3 @@',
      ' var a = 1;',
      '-var b = 2;',
      '+var b = 3;',
      ' return a;',
    ]);
    expect(r.data.a).toMatchObject({ instance: 'dev', host: 'dev.service-now.com' });
    expect(r.data.b).toMatchObject({ instance: 'dev', host: 'dev.service-now.com' });
    expect(r.data.a.sys_id).not.toBe(r.data.b.sys_id);
    expect(r.provenance.instance).toBe('dev');
    expect(r.provenance.source).toBe('table sys_script_include');
    // Two lookups and two reads of the records: each counted once, not per side twice.
    expect(r.requests_used).toBeGreaterThanOrEqual(4);
    expect(r.requests_used).toBeLessThan(12);
    expect(prod.calls).toEqual([]);
    await h.close();
  });

  it('a single-instance scope can never name or reach another instance', async () => {
    const { h, prod, scope } = await oneInstance({ A: 'x', B: 'y' });
    const r = await h
      .call('compare_records', {
        scope_id: scope,
        instance: 'prod',
        table: 'sys_script_include',
        match_a: { name: 'A' },
        match_b: { name: 'B' },
      })
      .catch(() => undefined);
    expect(r?.ok).not.toBe(true);
    expect(prod.calls).toEqual([]);
    await h.close();
  });

  it('ambiguity and absence are reported per side, on that one instance', async () => {
    const { h, dev, scope } = await oneInstance({ A: 'x', B: 'y' });
    dev.insert('sys_script_include', { name: 'B', script: 'z', active: 'true' });
    const amb = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
      match_b: { name: 'B' },
    });
    expect(amb.error.code).toBe('AMBIGUOUS_MATCH');
    expect(amb.error.side).toBe('b');
    expect(amb.error.candidates).toHaveLength(2);
    expect(amb.error.list_all.args.instance).toBe('dev');
    const all = await h.call(amb.error.list_all.tool, amb.error.list_all.args);
    expect(all.data.records).toHaveLength(2);
    const noA = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'Absent' },
      match_b: { name: 'A' },
    });
    expect(noA.error.code).toBe('NOT_FOUND');
    expect(noA.error.side).toBe('a');
    const noB = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
      match_b: { name: 'Absent' },
    });
    expect(noB.error.code).toBe('NOT_FOUND');
    expect(noB.error.side).toBe('b');
    const missingId = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
      match_b: { sys_id: 'f'.repeat(32) },
    });
    expect(missingId.error.code).toBe('NOT_FOUND');
    expect(missingId.error.side).toBe('b');
    await h.close();
  });

  it('a record compared with itself is refused, however it was found, not called identical', async () => {
    const { h, dev, scope } = await oneInstance({ A: 'x' });
    const id = dev.tables.get('sys_script_include')?.[0]?.sys_id as string;
    for (const match_b of [{ name: 'A' }, { sys_id: id }]) {
      const r = await h.call('compare_records', {
        scope_id: scope,
        table: 'sys_script_include',
        match_a: { sys_id: id },
        match_b,
      });
      expect(r.error.code).toBe('INVALID_INPUT');
      expect(r.error.message).toMatch(/same record/);
    }
    await h.close();
  });

  it('a long diff is fully retrievable through cursors, from one snapshot', async () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i} of the script`).join('\n');
    const b = a
      .split('\n')
      .map((l, i) => (i % 40 === 0 ? `${l} changed` : l))
      .join('\n');
    const { h, scope } = await oneInstance({ A: a, B: b });
    const before = h.dataRequests.length;
    const pages = await walk(h, scope, {
      table: 'sys_script_include',
      match_a: { name: 'A' },
      match_b: { name: 'B' },
      max_chars: 8000,
    });
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.at(-1).complete).toBe(true);
    expect(applyUnified(a, linesOf(pages, 'script'))).toBe(b);
    const gets = h.dataRequests.slice(before).filter((d) => d.kind === 'table.get');
    expect(gets).toHaveLength(2);
    await h.close();
  });

  it('cursors stay with their instances; a revoked scope gets no more pages', async () => {
    const big = (p: string) => Array.from({ length: 2000 }, (_, i) => `${p} ${i}`).join('\n');
    const dev = instanceWithScripts({ A: big('a'), B: big('b') });
    const prod = instanceWithScripts({ A: big('c'), B: big('d') });
    const h = await harness({ snByInstance: { dev, prod } });
    const devScope = await claim(h, 'dev');
    const prodScope = await claim(h, 'prod');
    const pairScope = await claimCompare(h);
    const first = await h.call('compare_records', {
      scope_id: devScope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
      match_b: { name: 'B' },
    });
    expect(first.page.next_cursor).toBeTruthy();
    for (const scope_id of [prodScope, pairScope]) {
      const other = await h.call('compare_records', {
        scope_id,
        cursor: first.page.next_cursor,
      });
      expect(other.error.code).toBe('INVALID_INPUT');
    }
    const pairFirst = await h.call('compare_records', {
      scope_id: pairScope,
      table: 'sys_script_include',
      match_a: { name: 'A' },
    });
    const widen = await h.call('compare_records', {
      scope_id: devScope,
      cursor: pairFirst.page.next_cursor,
    });
    expect(widen.error.code).toBe('INVALID_INPUT');
    h.revoke(devScope);
    const denied = await h.call('compare_records', {
      scope_id: devScope,
      cursor: first.page.next_cursor,
    });
    expect(denied.error.code).toBe('SCOPE_UNKNOWN');
    await h.close();
  });

  it('credential tables and fields stay refused and stripped', async () => {
    const dev = dictionaryFixture();
    dev.insert('u_api_config', { u_label: 'c', u_endpoint: 'one', u_auth: 'first-secret' });
    dev.insert('u_api_config', { u_label: 'd', u_endpoint: 'two', u_auth: 'second-secret' });
    const h = await harness({ sn: dev });
    const scope = await claim(h, 'dev');
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'u_api_config',
      match_a: { u_label: 'c' },
      match_b: { u_label: 'd' },
    });
    expect(JSON.stringify(r)).not.toMatch(/first-secret|second-secret/);
    expect(r.complete).toBe(false);
    expect(r.omitted.find((o: { reason: string }) => o.reason === 'sensitive').fields).toEqual([
      'u_auth',
    ]);
    const denied = await h.call('compare_records', {
      scope_id: scope,
      table: 'discovery_credentials',
      match_a: { name: 'x' },
      match_b: { name: 'y' },
    });
    expect(denied.error.code).toBe('TABLE_DENIED');
    await h.close();
  });
});

describe('T-042 two versions of a record (assumed payload format; mock only)', () => {
  /** The format assumed until a live run confirms it: docs/TASKS.md, T-042. */
  const payload = (script: string, o: { active?: string; mod?: string; extra?: string } = {}) =>
    `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><active>${o.active ?? 'true'}</active><name>MyUtil &amp; co</name><script><![CDATA[${script}]]></script><sys_id>abc</sys_id><sys_mod_count>${o.mod ?? '1'}</sys_mod_count><sys_updated_on>2026-01-0${o.mod ?? '1'}</sys_updated_on>${o.extra ?? ''}</sys_script_include></record_update>`;

  function versions(rows: { payload?: string; state?: string }[]) {
    const sn = dictionaryFixture();
    sn.insert('sys_db_object', { name: 'sys_update_version', label: 'V', super_class: '' });
    for (const element of ['name', 'payload', 'state', 'source', 'sys_updated_on'])
      sn.insert('sys_dictionary', {
        name: 'sys_update_version',
        element,
        column_label: element,
        internal_type: element === 'payload' ? 'xml' : 'string',
        reference: '',
        max_length: '8000000',
        mandatory: 'false',
        display: element === 'name' ? 'true' : 'false',
      });
    const ids = rows.map(
      (r, i) =>
        sn.insert('sys_update_version', {
          name: 'sys_script_include_abc',
          state: r.state ?? (i === rows.length - 1 ? 'current' : 'previous'),
          source: 'x',
          sys_updated_on: `2026-01-0${i + 1}`,
          ...(r.payload === undefined ? {} : { payload: r.payload }),
        }).sys_id as string,
    );
    // Like the real API with sysparm_display_value=all.
    const get = sn.get.bind(sn);
    sn.get = (req) => {
      const row = get(req);
      if (!row) return row;
      return Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, { value: v, display_value: v }]),
      ) as typeof row;
    };
    return { sn, ids };
  }

  async function compare(rows: { payload?: string; state?: string }[], extra = {}) {
    const { sn, ids } = versions(rows);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const first = {
      table: 'sys_update_version',
      match_a: { sys_id: ids[0] },
      match_b: { sys_id: ids[1] },
      ...extra,
    };
    return { h, scope, first, ids };
  }

  const scriptA = 'var a = 1;\nvar b = "<x>&amp;";\nreturn a;\n';
  const scriptB = 'var a = 1;\nvar b = "<y>&amp;";\nvar c;\nreturn a;\n';

  it('two versions diff element by element, and the script diff applies back exactly', async () => {
    const { h, scope, first } = await compare([
      { payload: payload(scriptA, { mod: '1' }) },
      { payload: payload(scriptB, { active: 'false', mod: '2' }) },
    ]);
    const r = await h.call('compare_records', { scope_id: scope, ...first });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.data.different_fields).toEqual(
      expect.arrayContaining([
        { field: 'payload.active', a: 'true', b: 'false' },
        { field: 'state', a: 'previous', b: 'current' },
      ]),
    );
    const diff = r.data.diffs.find((d: { field: string }) => d.field === 'payload.script');
    expect(diff.lines).toContain('+var c;');
    expect(applyUnified(scriptA, diff.lines)).toBe(scriptB);
    expect(r.data.diffs.map((d: { field: string }) => d.field)).toEqual(['payload.script']);
    // Bookkeeping is listed, not silently dropped; so is what element mode leaves out.
    expect(r.data.ignored_fields).toEqual(
      expect.arrayContaining(['payload.sys_mod_count', 'payload.sys_updated_on', 'sys_updated_on']),
    );
    expect(r.hints.join(' ')).toMatch(/element by element.*get_field_content.*payload/);
    expect(JSON.stringify(r.data)).not.toContain('<record_update');
    await h.close();
  });

  it('naming payload in fields gives the same element diff, and only that', async () => {
    const { h, scope, first } = await compare(
      [{ payload: payload(scriptA) }, { payload: payload(scriptB) }],
      { fields: ['payload'] },
    );
    const r = await h.call('compare_records', { scope_id: scope, ...first });
    expect(r.data.different_fields).toBeUndefined();
    expect(r.data.diffs.map((d: { field: string }) => d.field)).toEqual(['payload.script']);
    expect(r.data.equal_fields).toBe(3); // @action, active, name
    expect(r.data.ignored_fields).toContain('payload.sys_mod_count');
    await h.close();
  });

  it('a changed action, or an element on one side, is shown', async () => {
    const del = payload(scriptA).replace('INSERT_OR_UPDATE', 'DELETE');
    const { h, scope, first } = await compare(
      [
        { payload: payload(scriptA) },
        { payload: del.replace('</sys_script_include>', '<u_x>1</u_x></sys_script_include>') },
      ],
      { fields: ['payload'] },
    );
    const r = await h.call('compare_records', { scope_id: scope, ...first });
    expect(r.data.different_fields).toEqual([
      { field: 'payload.@action', a: 'INSERT_OR_UPDATE', b: 'DELETE' },
    ]);
    expect(r.data.only_on_b).toEqual([{ field: 'payload.u_x', value: '1' }]);
    await h.close();
  });

  it('two versions with the same payload are identical, and not reported as anything else', async () => {
    const same = payload(scriptA);
    const { h, scope, first } = await compare([{ payload: same }, { payload: same }], {
      fields: ['payload'],
    });
    const r = await h.call('compare_records', { scope_id: scope, ...first });
    expect(r.data.identical).toBe(true);
    expect(r.data.equal_fields).toBe(1);
    expect(r.hints).toBeUndefined();
    await h.close();
  });

  it.each([
    ['not XML', 'just some\ntext', 'other\ntext'],
    ['another root', '<unload><a>1</a></unload>', '<unload><a>2</a></unload>'],
    [
      'several records',
      '<record_update><x><a>1</a></x><y><a>1</a></y></record_update>',
      '<record_update><x><a>2</a></x><y><a>1</a></y></record_update>',
    ],
    [
      'a repeated element',
      '<record_update><x><a>1</a><a>2</a></x></record_update>',
      '<record_update><x><a>1</a><a>3</a></x></record_update>',
    ],
    [
      'different tables',
      '<record_update><x><a>1</a></x></record_update>',
      '<record_update><y><a>1</a></y></record_update>',
    ],
    ['cut off', '<record_update><x><a>1</a></x>', '<record_update><x><a>2</a></x>'],
    ['one side empty', '', payload('x')],
    [
      'a DTD',
      '<!DOCTYPE x [<!ENTITY e "boom">]><record_update><x><a>&e;</a></x></record_update>',
      payload('x'),
    ],
  ])('%s: compared as raw text, with a hint, and still exact', async (_name, a, b) => {
    const { h, scope, first } = await compare([{ payload: a }, { payload: b }], {
      fields: ['payload'],
    });
    const r = await h.call('compare_records', { scope_id: scope, ...first });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.hints.join(' ')).toMatch(/raw text/);
    const inline = r.data.different_fields?.[0];
    if (inline) {
      expect(inline).toMatchObject({ field: 'payload', a, b });
    } else {
      expect(applyUnified(a, r.data.diffs[0].lines)).toBe(b);
    }
    await h.close();
  });

  it('no payload field at all still compares what exists', async () => {
    const { h, scope, first } = await compare([{ state: 'previous' }, { state: 'current' }]);
    const r = await h.call('compare_records', { scope_id: scope, ...first });
    expect(r.ok).toBe(true);
    expect(r.data.different_fields).toEqual([{ field: 'state', a: 'previous', b: 'current' }]);
    expect(r.hints).toBeUndefined();
    await h.close();
  });

  it('a very long line is cut and reported, with a read of the whole payload on each side', async () => {
    const long = (c: string) => c.repeat(30_000);
    const { h, scope, first, ids } = await compare(
      [{ payload: payload(long('a')) }, { payload: payload(long('b')) }],
      { fields: ['payload'], max_chars: 4000 },
    );
    const pages = await walk(h, scope, first);
    const cuts = pages.flatMap((p) =>
      p.omitted.filter((o: { kind: string }) => o.kind === 'field'),
    );
    // One for the old line and one for the new line of the script.
    expect(cuts.map((c) => c.field)).toEqual(['payload.script', 'payload.script']);
    const cut = cuts[0];
    expect(cut.next.map((n: any) => n.args.sys_id)).toEqual(ids);
    for (const n of cut.next) {
      expect(n.args.field).toBe('payload');
      const read = await h.call(n.tool, n.args);
      expect(read.ok, JSON.stringify(read).slice(0, 300)).toBe(true);
    }
    await h.close();
  });

  it('versions of a record found by field values use the usual per-side checks', async () => {
    const { h, scope } = await compare([
      { payload: payload(scriptA), state: 'previous' },
      { payload: payload(scriptB), state: 'previous' },
      { payload: payload(scriptB), state: 'current' },
    ]);
    const amb = await h.call('compare_records', {
      scope_id: scope,
      table: 'sys_update_version',
      match_a: { state: 'previous' },
      match_b: { state: 'current' },
    });
    expect(amb.error.code).toBe('AMBIGUOUS_MATCH');
    expect(amb.error.side).toBe('a');
    await h.close();
  });

  it('element names are not filtered by name: the user accepted this for payloads', async () => {
    const extra = (v: string) => ({ extra: `<u_password>${v}</u_password>` });
    const { h, scope, first } = await compare(
      [{ payload: payload('x', extra('one')) }, { payload: payload('x', extra('two')) }],
      { fields: ['payload'] },
    );
    const r = await h.call('compare_records', { scope_id: scope, ...first });
    expect(r.data.different_fields).toEqual([{ field: 'payload.u_password', a: 'one', b: 'two' }]);
    await h.close();
  });
});

describe('describePayload', () => {
  it.each([
    ['text', { failed_at: 'root' }],
    ['<a/>', { failed_at: 'root', roots: ['a'] }],
    [
      '<record_update>loose</record_update>',
      { failed_at: 'root_content', roots: ['record_update'] },
    ],
    [
      '<record_update><x action="DELETE"/><y action="a b"/></record_update>',
      {
        failed_at: 'records',
        roots: ['record_update'],
        records: [{ name: 'x', action: 'DELETE' }, { name: 'y' }],
      },
    ],
    [
      '<record_update><x><a>secret</a>loose</x></record_update>',
      {
        failed_at: 'record_content',
        roots: ['record_update'],
        records: [{ name: 'x' }],
        elements: 1,
        near: 'a',
      },
    ],
    [
      '<record_update><x><a>1</a><a>2</a></x></record_update>',
      {
        failed_at: 'repeated',
        roots: ['record_update'],
        records: [{ name: 'x' }],
        elements: 2,
        near: 'a',
      },
    ],
    [
      '<record_update><x><a>1</a></x></record_update>',
      { roots: ['record_update'], records: [{ name: 'x' }], elements: 1 },
    ],
  ])('%s', (xml, shape) => {
    expect(describePayload(xml)).toEqual(shape);
    expect(shape.failed_at === undefined).toBe(parseUpdatePayload(xml) !== undefined);
  });
});

describe('parseUpdatePayload', () => {
  const wrap = (inner: string, attrs = ' action="INSERT"') =>
    `<record_update table="t"><t${attrs}>${inner}</t></record_update>`;
  const fieldsOf = (xml: string) => Object.fromEntries(parseUpdatePayload(xml)?.fields ?? []);

  it('reads the assumed shape, with or without line breaks and a declaration', () => {
    const multi = `<?xml version="1.0"?>\n<record_update sys_domain="global" table="t">\n  <t action="INSERT">\n    <a>1</a>\n    <b/>\n    <c></c>\n  </t>\n</record_update>\n`;
    expect(parseUpdatePayload(multi)?.table).toBe('t');
    expect(fieldsOf(multi)).toEqual({ '@action': 'INSERT', a: '1', b: '', c: '' });
    expect(fieldsOf(wrap('<a>1</a>', ''))).toEqual({ a: '1' });
    expect(fieldsOf(wrap('<a>1</a>', " action='X'"))).toEqual({ '@action': 'X', a: '1' });
  });

  it('decodes entities once, keeps CDATA as is, and keeps line breaks', () => {
    expect(
      fieldsOf(wrap('<a>x &amp;lt; &lt;y&gt; &quot;&apos; &#65;&#x42; &nope; &#xFFFFFF;</a>', ''))
        .a,
    ).toBe(`x &lt; <y> "' AB &nope; &#xFFFFFF;`);
    expect(fieldsOf(wrap('<a><![CDATA[if (a < b && c) {\n</a>\n}]]></a>', '')).a).toBe(
      'if (a < b && c) {\n</a>\n}',
    );
    expect(fieldsOf(wrap('<a><![CDATA[x]]]]><![CDATA[>y]]> &amp;</a>', '')).a).toBe('x]]>y &');
    expect(fieldsOf(wrap('<a>  spaced\n</a>', '')).a).toBe('  spaced\n');
  });

  it('keeps nested markup as text, with attributes and same-named elements', () => {
    const f = fieldsOf(
      wrap('<a x="1"><a>in</a><b/></a><c display_value="C">id</c><!-- n --><d>e</d>', ''),
    );
    expect(f.a).toBe('<a>in</a><b/>');
    expect(f.c).toBe('id');
    expect(f.d).toBe('e');
    const odd = parseUpdatePayload(
      wrap('<__proto__>x</__proto__><constructor>y</constructor>', ''),
    );
    expect(odd?.fields.get('__proto__')).toBe('x');
    expect(odd?.fields.get('constructor')).toBe('y');
  });

  it.each([
    [''],
    ['text'],
    ['<a>1</a>'],
    ['<record_update/>'],
    ['<record_update></record_update>'],
    ['<record_update><t>loose text</t></record_update>'],
    ['<record_update><t><a>1</a></t>'],
    ['<record_update><t><a>1</t></record_update>'],
    ['<record_update><t><![CDATA[x]]></t></record_update>'],
    ['<record_update><t><a><![CDATA[x</a></t></record_update>'],
    ['<record_update><t><a>1</a></t><t><a>2</a></t></record_update>'],
    ['<record_update><t/></record_update><record_update/>'],
    ['<!DOCTYPE d><record_update><t><a>1</a></t></record_update>'],
    ['<record_update><t a="1><a>1</a></t></record_update>'],
  ])('refuses %j rather than guessing', (xml) => {
    expect(parseUpdatePayload(xml)).toBeUndefined();
  });

  it('stays fast on large and on hostile input', () => {
    const started = Date.now();
    const big = 'line of a script < with & marks\n'.repeat(300_000);
    expect(fieldsOf(wrap(`<s><![CDATA[${big}]]></s>`, '')).s).toBe(big);
    parseUpdatePayload(wrap(`<s>${'<s '.repeat(200_000)}</s>`, ''));
    parseUpdatePayload(wrap(`<s>${'<s a="'.repeat(200_000)}</s>`, ''));
    parseUpdatePayload(wrap(`<s>${'<s>'.repeat(200_000)}</s>`, ''));
    parseUpdatePayload(`<record_update>${'<![CDATA['.repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('line diff', () => {
  const rnd = (() => {
    let seed = 3;
    return (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
  })();

  it('fuzz: a diff always applies back exactly', () => {
    for (let t = 0; t < 400; t++) {
      const words = ['a', 'b', 'c', '', ' x'];
      const a = Array.from({ length: rnd(40) }, () => words[rnd(5)]).join('\n');
      const lines = a.split('\n');
      for (let e = rnd(8); e > 0; e--) {
        const at = rnd(lines.length + 1);
        if (rnd(2)) lines.splice(at, 1);
        else lines.splice(at, 0, words[rnd(5)] as string);
      }
      const b = lines.join('\n');
      const d = unifiedDiff(a, b);
      expect(applyUnified(a, d.lines), JSON.stringify({ a, b, d })).toBe(b);
      if (a === b) expect(d.lines).toEqual([]);
    }
  });

  it('fuzz: the diff is minimal (matches the longest common subsequence)', () => {
    const lcs = (x: string[], y: string[]) => {
      let prev = new Array(y.length + 1).fill(0) as number[];
      for (const line of x) {
        const row = [0];
        for (let j = 1; j <= y.length; j++) {
          row[j] =
            line === y[j - 1]
              ? (prev[j - 1] as number) + 1
              : Math.max(prev[j] as number, row[j - 1] as number);
        }
        prev = row;
      }
      return prev[y.length] as number;
    };
    for (let t = 0; t < 300; t++) {
      const x = Array.from({ length: rnd(25) }, () => 'abcd'[rnd(4)] as string);
      const y = Array.from({ length: rnd(25) }, () => 'abcd'[rnd(4)] as string);
      const { ops } = diffLines(x, y);
      expect(ops.filter((o) => o.t === ' ').length, JSON.stringify({ x, y })).toBe(lcs(x, y));
    }
  });

  it('is minimal for small edits and bounded for very different inputs', () => {
    const { ops, minimal } = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(minimal).toBe(true);
    expect(ops.filter((o) => o.t !== ' ')).toEqual([
      { t: '-', line: 'b' },
      { t: '+', line: 'x' },
    ]);
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join('\n');
    const started = Date.now();
    const d = unifiedDiff(a, b);
    expect(d.minimal).toBe(false);
    expect(applyUnified(a, d.lines)).toBe(b);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
