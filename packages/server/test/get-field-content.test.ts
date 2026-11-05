/**
 * T-027: get_field_content reads any field completely in chunks (in-memory fake; mock only).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FieldCache, indexLines } from '../src/mcp/field-cache.js';
import { readWindow } from '../src/mcp/tools/get-field-content.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';
import { claim, type Harness, harness } from './mcp-harness.js';

function withScript(value: string): { sn: FakeServiceNow; id: string } {
  const sn = dictionaryFixture();
  sn.insert('sys_db_object', {
    name: 'sys_script_include',
    label: 'Script Include',
    super_class: '',
  });
  sn.insert('sys_dictionary', {
    name: 'sys_script_include',
    element: 'script',
    column_label: 'Script',
    internal_type: 'script_plain',
    reference: '',
    max_length: '8000000',
    mandatory: 'false',
    display: 'false',
  });
  return { sn, id: sn.insert('sys_script_include', { script: value }).sys_id };
}

/** Follows `next` to the end, reassembling the value exactly as the tool description says. */
async function readAll(h: Harness, scope: string, id: string, extra: Record<string, unknown> = {}) {
  let out = '';
  let calls = 0;
  let args: Record<string, unknown> = {
    scope_id: scope,
    table: 'sys_script_include',
    sys_id: id,
    field: 'script',
    ...extra,
  };
  for (;;) {
    const r = await h.call('get_field_content', args);
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    calls++;
    for (const l of r.data.lines) {
      out += l.text;
      if (!l.more && l.n < r.data.total_lines) out += '\n';
    }
    if (r.complete) {
      expect(r.data.next).toBeUndefined();
      expect(r.omitted).toBeUndefined();
      return { out, calls, last: r };
    }
    expect(r.omitted[0].next.tool).toBe('get_field_content');
    args = r.omitted[0].next.args;
  }
}

describe('AC1: chunks reassemble the original exactly', () => {
  it('a 20,000-line script', async () => {
    const value = Array.from({ length: 20_000 }, (_, i) => `var line${i} = "${i % 7}";`).join('\n');
    const { sn, id } = withScript(value);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const { out, calls } = await readAll(h, scope, id);
    expect(out).toBe(value);
    expect(calls).toBeGreaterThanOrEqual(50); // at most 400 lines per call
    await h.close();
  });

  it('a 2 MB single line, with characters JSON must escape', async () => {
    const value = `${'a"\\\n'.replace('\n', '\t').repeat(200_000)}${'é😀'.repeat(300_000)}`;
    const { sn, id } = withScript(value);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const { out, calls, last } = await readAll(h, scope, id, { max_chars: 50_000 });
    expect(out === value).toBe(true);
    expect(calls).toBeGreaterThan(10);
    expect(last.data.total_lines).toBe(1);
    expect(last.data.total_chars).toBe(value.length);
    await h.close();
  });

  it('edges: empty, trailing newlines, blank lines, CRLF, and every result stays in budget', async () => {
    for (const value of ['', '\n', 'a\n', '\n\n\na', 'x\r\ny\r\n', `${'z'.repeat(9000)}\n\nq`]) {
      const { sn, id } = withScript(value);
      const h = await harness({ sn });
      const scope = await claim(h, 'dev');
      expect((await readAll(h, scope, id, { max_chars: 4000 })).out).toBe(value);
      await h.close();
    }
    const value = 'y'.repeat(200_000);
    const { sn, id } = withScript(value);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('get_field_content', {
      scope_id: scope,
      table: 'sys_script_include',
      sys_id: id,
      field: 'script',
      max_chars: 8000,
    });
    expect(JSON.stringify(r).length).toBeLessThan(8000);
    await h.close();
  });

  it('never splits a surrogate pair across results', () => {
    const f = indexLines('😀'.repeat(5000));
    for (let budget = 100; budget < 400; budget += 7) {
      let char = 0;
      for (;;) {
        const w = readWindow(f, 1, char, 10, budget);
        for (const l of w.lines) expect(l.text).not.toMatch(/[\ud800-\udbff]$/);
        if (!w.next) break;
        char = w.next.start_char ?? 0;
      }
    }
  });

  it('readWindow: fuzzed values and budgets always make progress and reassemble', () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let t = 0; t < 200; t++) {
      const parts: string[] = [];
      for (let i = rnd(30); i >= 0; i--)
        parts.push('ab"\\é😀\t '.repeat(rnd(40)).slice(0, rnd(300)));
      const value = parts.join('\n');
      const f = indexLines(value);
      let out = '';
      let line = 1;
      let char = 0;
      for (let guard = 0; ; guard++) {
        expect(guard).toBeLessThan(20_000);
        const w = readWindow(f, line, char, 1 + rnd(5), 60 + rnd(400));
        for (const l of w.lines) {
          out += l.text;
          if (!l.more && l.n < f.lineStarts.length) out += '\n';
        }
        if (!w.next) break;
        expect(w.lines.length).toBeGreaterThan(0);
        line = w.next.start_line;
        char = w.next.start_char ?? 0;
      }
      expect(out).toBe(value);
    }
  });
});

describe('AC2: one upstream read, then the local copy', () => {
  it('chunked reading issues one request; refresh fetches again', async () => {
    const value = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const { sn, id } = withScript(value);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const { calls } = await readAll(h, scope, id);
    expect(calls).toBeGreaterThan(1);
    expect(h.dataRequests).toHaveLength(1);
    expect(h.dataRequests[0]).toMatchObject({
      kind: 'table.get',
      fields: ['script'],
      displayValue: 'false',
    });
    const args = { scope_id: scope, table: 'sys_script_include', sys_id: id, field: 'script' };
    const hit = await h.call('get_field_content', args);
    expect(hit.requests_used).toBe(0);
    expect(hit.data.from_local_copy).toBe(true);

    (sn.tables.get('sys_script_include') as { script: unknown }[])[0].script = 'changed';
    const stale = await h.call('get_field_content', args);
    expect(stale.data.lines[0].text).toBe('line 0');
    const fresh = await h.call('get_field_content', { ...args, refresh: true });
    expect(fresh.data.lines[0].text).toBe('changed');
    expect(fresh.requests_used).toBe(1);
    expect(h.dataRequests).toHaveLength(2);
    await h.close();
  });

  it('a revoked scope gets nothing from the local copy; another scope has its own', async () => {
    const value = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const { sn, id } = withScript(value);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const args = { table: 'sys_script_include', sys_id: id, field: 'script' };
    const first = await h.call('get_field_content', { scope_id: scope, ...args });
    expect(first.ok).toBe(true);

    const other = await claim(h, 'dev');
    const separate = await h.call('get_field_content', { scope_id: other, ...args });
    expect(separate.requests_used).toBe(1);

    h.revoke(scope);
    const denied = await h.call('get_field_content', { scope_id: scope, ...args, start_line: 500 });
    expect(denied.error.code).toBe('SCOPE_UNKNOWN');
    expect(JSON.stringify(denied)).not.toContain('line 499');
    await h.close();
  });
});

describe('AC3: the cache', () => {
  const f = (n: number) => indexLines('x'.repeat(n));

  it('evicts least recently used at its size limit, and refuses a value above it', () => {
    const c = new FieldCache({ maxBytes: 1000, ttlMs: 1000 });
    expect(c.set('s|a', f(200))).toBe(true);
    expect(c.set('s|b', f(200))).toBe(true);
    c.get('s|a');
    expect(c.set('s|c', f(200))).toBe(true); // evicts b, the least recently used
    expect(c.get('s|a')).toBeDefined();
    expect(c.get('s|b')).toBeUndefined();
    expect(c.usedBytes).toBeLessThanOrEqual(1000);
    expect(c.set('s|big', f(5000))).toBe(false);
    expect(c.get('s|big')).toBeUndefined();
  });

  it('expires by TTL and forgets a scope', () => {
    let t = 0;
    const c = new FieldCache({ maxBytes: 10_000, ttlMs: 100 }, () => t);
    c.set('s1|a', f(10));
    c.set('s2|a', f(10));
    c.forgetScope('s1');
    expect(c.get('s1|a')).toBeUndefined();
    expect(c.get('s2|a')).toBeDefined();
    t = 101;
    expect(c.get('s2|a')).toBeUndefined();
    expect(c.usedBytes).toBe(0);
  });

  it('never touches the disk', () => {
    const src = readFileSync(new URL('../src/mcp/field-cache.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bimport\b/);
    expect(src).not.toMatch(/require\(|writeFile|node:fs/);
  });

  it('a value bigger than the cache still reads completely, and says so', async () => {
    const value = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const { sn, id } = withScript(value);
    const h = await harness({ sn, env: { SN_MCP_FIELD_CACHE_MB: '1' } });
    const scope = await claim(h, 'dev');
    expect((await readAll(h, scope, id)).out).toBe(value);
    await h.close();
  });
});

describe('AC4 and validation', () => {
  it('password and denied tables are refused; unknown fields too', async () => {
    const { sn, id } = withScript('x');
    const u = sn.insert('u_api_config', { u_label: 'l', u_auth: 'secret-value' });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const args = { scope_id: scope, sys_id: u.sys_id };
    for (const [a, code] of [
      [{ table: 'u_api_config', field: 'u_auth' }, 'FORBIDDEN_OPERATION'],
      [{ table: 'sys_user', field: 'user_password' }, 'FORBIDDEN_OPERATION'],
      [{ table: 'discovery_credentials', field: 'name' }, 'TABLE_DENIED'],
      [{ table: 'u_api_config', field: 'zz_nope' }, 'INVALID_FIELD'],
    ] as const) {
      const r = await h.call('get_field_content', { ...args, ...a });
      expect(r.error?.code, JSON.stringify(a)).toBe(code);
    }
    expect(h.dataRequests).toEqual([]);
    const missing = await h.call('get_field_content', {
      scope_id: scope,
      table: 'sys_script_include',
      sys_id: 'f'.repeat(32),
      field: 'script',
    });
    expect(missing.error.code).toBe('NOT_FOUND');
    const past = await h.call('get_field_content', {
      scope_id: scope,
      table: 'sys_script_include',
      sys_id: id,
      field: 'script',
      start_line: 2,
    });
    expect(past.error.code).toBe('INVALID_INPUT');
    expect(
      (await h.call('get_field_content', { table: 'x', sys_id: id, field: 'y' })).error?.code,
    ).toBe('SCOPE_REQUIRED');
    await h.close();
  });

  it('the preview omission from get_record works as given', async () => {
    const value = 'n'.repeat(5000);
    const { sn, id } = withScript(value);
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const rec = await h.call('get_record', {
      scope_id: scope,
      table: 'sys_script_include',
      sys_id: id,
    });
    const entry = rec.omitted.find((o: { field?: string }) => o.field === 'script');
    const r = await h.call(entry.next.tool, entry.next.args);
    expect(r.data.lines[0].text).toBe(value);
    expect(r.complete).toBe(true);
    await h.close();
  });

  it('journal fields read their display value (the API has no raw text for them)', async () => {
    const sn = dictionaryFixture();
    sn.insert('sys_dictionary', {
      name: 'task',
      element: 'work_notes',
      column_label: 'Work notes',
      internal_type: 'journal_input',
      reference: '',
      max_length: '4000',
      mandatory: 'false',
      display: 'false',
    });
    const inc = sn.insert('incident', { number: 'I', work_notes: 'note' });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    await h.call('get_field_content', {
      scope_id: scope,
      table: 'incident',
      sys_id: inc.sys_id,
      field: 'work_notes',
    });
    expect(h.dataRequests[0]?.displayValue).toBe('true');
    await h.close();
  });
});
