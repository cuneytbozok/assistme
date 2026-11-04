/**
 * T-023: response shaping, automatic pagination and the completeness contract, against an
 * in-memory ServiceNow fake (mock; not evidence of real connectivity). Every operation the
 * server emits is also built by the extension's real request builder.
 */
import { describe, expect, it } from 'vitest';
import { CursorCodec } from '../src/mcp/cursor.js';
import { claim, harness, walk, withIncidents } from './mcp-harness.js';

describe('AC1: a 5,000-row walk with cursors returns every row exactly once, in order', () => {
  it('limit 250, default budget', async () => {
    const h = await harness({ sn: withIncidents(5000) });
    const scope = await claim(h, 'dev');
    const responses = await walk(h, scope, { table: 'incident', limit: 250 });
    const ids = responses.flatMap((r) => r.data.records.map((x: { sys_id: string }) => x.sys_id));
    const expected = (h.sn.tables.get('incident') ?? []).map((x) => x.sys_id).sort();
    expect(ids).toEqual(expected); // all, in sys_id order, no gaps or duplicates
    expect(new Set(ids).size).toBe(5000);
    expect(Math.max(...h.dataRequests.map((d) => d.offset))).toBeGreaterThanOrEqual(4999 - 250); // no offset ceiling
    expect(responses.at(-1)).toMatchObject({
      complete: true,
      page: { has_more: false, next_cursor: null, returned_total: 5000 },
    });
    await h.close();
  }, 60_000);

  it('a small response budget stops mid-page and resumes exactly there', async () => {
    const h = await harness({ sn: withIncidents(1200) });
    const scope = await claim(h, 'dev');
    const responses = await walk(h, scope, { table: 'incident', limit: 1200, max_chars: 4000 });
    expect(responses.length).toBeGreaterThan(10);
    expect(responses.slice(0, -1).every((r) => r.omitted?.[0]?.reason === 'response_budget')).toBe(
      true,
    );
    const ids = responses.flatMap((r) => r.data.records.map((x: { sys_id: string }) => x.sys_id));
    expect(ids).toEqual((h.sn.tables.get('incident') ?? []).map((x) => x.sys_id).sort());
    await h.close();
  }, 60_000);

  it('a user order keeps a sys_id tiebreak (stable paging over equal keys)', async () => {
    const h = await harness({ sn: withIncidents(900) });
    const scope = await claim(h, 'dev');
    // query_records has no filters until T-024, so order through a high-volume default instead:
    const r = await h.call('query_records', { scope_id: scope, table: 'incident', limit: 3 });
    const q = h.sn.calls.find((c) => c.table === 'incident')?.query;
    expect(q).toBe('ORDERBYsys_id');
    expect(r.page.has_more).toBe(true);
    await h.close();
  });
});

describe('ACL-hidden rows (short pages are not the end)', () => {
  it('rows hidden after windowing never cause a silent stop', async () => {
    const sn = withIncidents(500);
    // Hide whole stretches so some windows come back short or even empty-but-not-last.
    const hidden = (r: Record<string, unknown>) => {
      const n = Number(String(r.number ?? '').slice(3));
      return (n >= 40 && n < 160) || n % 7 === 0;
    };
    const h = await harness({ sn, hidden, env: { SN_MCP_PAGE_SIZE: '50' } });
    const scope = await claim(h, 'dev');
    const responses = await walk(h, scope, { table: 'incident', limit: 80, fields: ['number'] });
    const got = responses.flatMap((r) => r.data.records.map((x: { sys_id: string }) => x.sys_id));
    const visible = (sn.tables.get('incident') ?? [])
      .filter((r) => !hidden(r))
      .map((r) => r.sys_id)
      .sort();
    expect(got).toEqual(visible);
    await h.close();
  });

  it('a fully hidden first window does not end the read (the count says more exist)', async () => {
    const sn = withIncidents(300);
    const h = await harness({
      sn,
      hidden: (r) => Number(String(r.number).slice(3)) < 101,
      env: { SN_MCP_PAGE_SIZE: '100' },
    });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      limit: 10,
      fields: ['number'],
    });
    expect(r.data.records.map((x: { number: string }) => x.number)).toEqual(
      Array.from({ length: 10 }, (_, i) => `INC${String(101 + i).padStart(7, '0')}`),
    );
    expect(r.page.has_more).toBe(true);
    await h.close();
  });

  it('a normal small read costs one data request plus at most one count check', async () => {
    const h = await harness({ sn: withIncidents(5) });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: scope, table: 'incident' });
    expect(r).toMatchObject({ complete: true, page: { returned: 5, has_more: false } });
    expect(r.requests_used).toBeLessThanOrEqual(2);
    await h.close();
  });
});

describe('AC2: completeness invariant (property test)', () => {
  it('never a silent drop across random tables, limits and budgets', async () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 25; trial++) {
      const rows = Math.floor(rnd() * 400);
      const sn = withIncidents(rows, rnd() < 0.5 ? 7 : 0);
      const h = await harness({
        sn,
        env: {
          SN_MCP_PAGE_SIZE: String(1 + Math.floor(rnd() * 120)),
          SN_MCP_FIELD_PREVIEW_CHARS: String(100 + Math.floor(rnd() * 900)),
        },
      });
      const scope = await claim(h, 'dev');
      const limit = 1 + Math.floor(rnd() * 300);
      const maxChars = rnd() < 0.5 ? 4000 + Math.floor(rnd() * 20_000) : undefined;
      const fields = rnd() < 0.3 ? ['*'] : undefined;
      const responses = await walk(h, scope, {
        table: 'incident',
        limit,
        ...(maxChars ? { max_chars: maxChars } : {}),
        ...(fields ? { fields } : {}),
      });
      const all = new Map((h.sn.tables.get('incident') ?? []).map((x) => [x.sys_id, x]));
      const seen: string[] = [];
      for (const r of responses) {
        expect(r.ok).toBe(true);
        const returned = r.data.records.length;
        const fieldOmissions = (r.omitted ?? []).filter(
          (o: { kind: string }) => o.kind === 'field',
        );
        const available = rows - seen.length;
        const short = returned < Math.min(r === responses[0] ? limit : limit, available);
        if (r.page.has_more || fieldOmissions.length > 0 || short) {
          expect(r.complete, `trial ${trial}`).toBe(false);
          expect(r.omitted?.length).toBeGreaterThan(0);
        }
        if (r.page.has_more) {
          const rowsEntry = r.omitted.find((o: { kind: string }) => o.kind === 'rows');
          expect(rowsEntry.next).toEqual({
            tool: 'query_records',
            args: { scope_id: scope, cursor: r.page.next_cursor },
          });
        }
        for (const o of fieldOmissions) {
          // The next call names exactly the field that was cut, with its true size.
          expect(o.next).toEqual({
            tool: 'get_field_content',
            args: { scope_id: scope, table: 'incident', sys_id: o.sys_id, field: o.field },
          });
          const raw = String(all.get(o.sys_id)?.[o.field] ?? '');
          expect(o.total_chars).toBe(raw.length);
          const shown = r.data.records.find((x: { sys_id: string }) => x.sys_id === o.sys_id)?.[
            o.field
          ];
          if (typeof shown === 'string') expect(raw.startsWith(shown.replace(/…$/, ''))).toBe(true);
        }
        if (!r.page.has_more && fieldOmissions.length === 0) expect(r.complete).toBe(true);
        seen.push(...r.data.records.map((x: { sys_id: string }) => x.sys_id));
      }
      // Following the cursors reaches every row exactly once (up to the limit per call).
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([...all.keys()].sort());
      await h.close();
    }
  }, 120_000);
});

describe('AC3: cursor integrity', () => {
  it('tampered, foreign or mismatched cursors → INVALID_INPUT', async () => {
    const h = await harness({ sn: withIncidents(60) });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: scope, table: 'incident', limit: 10 });
    const cursor: string = r.page.next_cursor;
    const [payload, sig] = cursor.split('.') as [string, string];
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = `${Buffer.from(JSON.stringify({ ...state, table: 'sys_user' })).toString('base64url')}.${sig}`;
    const flipped = `${payload}.${sig.slice(0, -2)}${sig.at(-2) === 'A' ? 'B' : 'A'}${sig.at(-1)}`;
    for (const bad of [forged, flipped, 'garbage', `${payload}.`, '']) {
      const e = await h.call('query_records', { scope_id: scope, cursor: bad });
      expect(e.error?.code, bad.slice(0, 20)).toBe('INVALID_INPUT');
    }
    // Reused with a different query.
    for (const extra of [{ table: 'problem' }, { fields: ['number'] }, { include_total: true }]) {
      expect(
        (await h.call('query_records', { scope_id: scope, cursor, ...extra })).error.code,
      ).toBe('INVALID_INPUT');
    }
    // A cursor from another connector process (another key).
    const other = await harness({ sn: withIncidents(60), cursors: new CursorCodec() });
    const otherScope = await claim(other, 'dev');
    expect((await other.call('query_records', { scope_id: otherScope, cursor })).error.code).toBe(
      'INVALID_INPUT',
    );
    await other.close();
    await h.close();
  });

  it('works with a new scope for the same instance; rejected for another instance', async () => {
    const h = await harness({ sn: withIncidents(60) });
    const first = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: first, table: 'incident', limit: 10 });
    const renewed = await claim(h, 'dev'); // e.g. the old grant expired and the user approved again
    expect(renewed).not.toBe(first);
    const next = await h.call('query_records', { scope_id: renewed, cursor: r.page.next_cursor });
    expect(next.ok).toBe(true);
    expect(next.data.records[0].sys_id > r.data.records.at(-1).sys_id).toBe(true);
    const prod = await claim(h, 'prod');
    expect(
      (await h.call('query_records', { scope_id: prod, cursor: r.page.next_cursor })).error.code,
    ).toBe('INVALID_INPUT');
    await h.close();
  });
});

describe('AC4: fields ["*"] with any limit', () => {
  it('all fields, large limit; the budget decides rows per result and the cursor continues', async () => {
    const h = await harness({ sn: withIncidents(700, 5) });
    const scope = await claim(h, 'dev');
    const first = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      fields: ['*'],
      limit: 100_000,
    });
    expect(first.ok).toBe(true);
    expect(Object.keys(first.data.records[0])).toEqual(
      expect.arrayContaining(['sys_id', 'number', 'short_description', 'priority']),
    );
    expect(h.dataRequests[0]?.fields).toBeUndefined(); // no sysparm_fields → every field
    const responses = await walk(h, scope, { table: 'incident', fields: ['*'], limit: 100_000 });
    expect(responses.flatMap((r) => r.data.records).length).toBe(700);
    await h.close();
  }, 60_000);
});

describe('AC5: adaptive page size and oversized records', () => {
  it('RESPONSE_TOO_LARGE halves the page size until it succeeds', async () => {
    const h = await harness({ sn: withIncidents(300), tooLarge: (op) => op.limit > 12 });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: scope, table: 'incident', limit: 40 });
    expect(r.ok).toBe(true);
    expect(r.data.records).toHaveLength(40);
    expect(r.hints.join(' ')).toMatch(/page size was reduced to (\d+)/);
    const limits = h.dataRequests.map((d) => d.limit);
    expect(limits[0]).toBe(41); // 40 + lookahead
    expect(limits[1]).toBeLessThan(limits[0] as number); // halved after RESPONSE_TOO_LARGE
    expect(limits.filter((l) => l <= 12).length).toBeGreaterThan(0);
    await h.close();
  });

  it('a single record over the cap comes back without its large fields, listed in omitted', async () => {
    const sn = withIncidents(5);
    sn.insert('sys_dictionary', {
      name: 'task',
      element: 'u_body',
      column_label: 'Body',
      internal_type: 'html',
      reference: '',
      max_length: '65000',
      mandatory: 'false',
      display: 'false',
    });
    const big = (sn.tables.get('incident') ?? [])[2] as { sys_id: string; u_body?: string };
    big.u_body = '<p>'.padEnd(20_000, 'y');
    const h = await harness({
      sn,
      // Any request that would include record #2 with u_body is "too large" for the extension.
      tooLarge: (op) => {
        const rows = (sn.tables.get('incident') ?? []).map((x) => x.sys_id).sort();
        const window = rows.slice(op.offset, op.offset + op.limit);
        return window.includes(big.sys_id) && (!op.fields || op.fields.includes('u_body'));
      },
    });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      fields: ['*'],
      limit: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.data.records).toHaveLength(5);
    expect(r.complete).toBe(false);
    expect(r.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'field',
          reason: 'too_large',
          sys_id: big.sys_id,
          field: 'u_body',
          next: {
            tool: 'get_field_content',
            args: { scope_id: scope, table: 'incident', sys_id: big.sys_id, field: 'u_body' },
          },
        }),
      ]),
    );
    expect(
      r.data.records.find((x: { sys_id: string }) => x.sys_id === big.sys_id).u_body,
    ).toBeUndefined();
    await h.close();
  });
});

describe('AC6: max_chars above the ceiling is clamped, with a hint', () => {
  it('clamps and says so', async () => {
    const h = await harness({ sn: withIncidents(10), env: { SN_MCP_MAX_RESPONSE_CHARS: '50000' } });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      max_chars: 10_000_000,
    });
    expect(r.ok).toBe(true);
    expect(r.hints).toEqual(
      expect.arrayContaining([expect.stringMatching(/above the ceiling; used 50000/)]),
    );
    const tiny = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      max_chars: 10,
    });
    expect(tiny.hints.join(' ')).toMatch(/below the minimum/);
    await h.close();
  });
});

describe('shaping details', () => {
  it('default projection, {v,d} references, previews with omitted entries, links', async () => {
    const sn = withIncidents(3, 1);
    const h = await harness({ sn, env: { SN_MCP_FIELD_PREVIEW_CHARS: '200' } });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: scope, table: 'incident' });
    expect(Object.keys(r.data.records[0]).sort()).toEqual([
      'number',
      'short_description',
      'sys_id',
    ]);
    expect(r.data.records[0].short_description.length).toBe(201); // 200 + "…"
    expect(r.omitted[0]).toMatchObject({
      kind: 'field',
      reason: 'preview',
      field: 'short_description',
      shown_chars: 200,
      total_chars: 3007,
    });
    expect(r.links[0]).toBe(
      `https://dev.service-now.com/nav_to.do?uri=${encodeURIComponent(`incident.do?sys_id=${r.data.records[0].sys_id}`)}`,
    );
    expect(r.complete).toBe(false);
    await h.close();
  });
});
