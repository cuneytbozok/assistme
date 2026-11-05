/**
 * T-032: compare_records, with one in-memory fake per instance (mock only).
 */
import { describe, expect, it } from 'vitest';
import { applyUnified, diffLines, unifiedDiff } from '../src/mcp/line-diff.js';
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
  it('a single-instance scope is refused, before any read', async () => {
    const h = await harness();
    const scope = await claim(h, 'dev');
    const r = await h.call('compare_records', {
      scope_id: scope,
      table: 'incident',
      match_a: { number: 'X' },
    });
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(r.error.hint).toMatch(/instances/);
    expect(h.dataRequests).toEqual([]);
    expect(
      (await h.call('compare_records', { table: 'incident', match_a: { number: 'X' } })).error.code,
    ).toBe('SCOPE_REQUIRED');
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
