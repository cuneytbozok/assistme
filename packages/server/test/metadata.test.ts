/**
 * T-017: metadata service against a mocked dictionary fixture (not evidence of connectivity).
 */
import { describe, expect, it } from 'vitest';
import {
  closeMatches,
  editDistance,
  type MetaContext,
  MetadataError,
  MetadataService,
} from '../src/mcp/metadata.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';

function ctxFor(
  sn: FakeServiceNow,
  key = 'dev.service-now.com',
): MetaContext & { fetches: () => number } {
  let n = 0;
  return {
    instanceKey: key,
    fetches: () => n,
    fetch: async (req) => {
      n++;
      return { ok: true, rows: sn.list(req).rows };
    },
  };
}

describe('AC1: inherited fields (incident ← task)', () => {
  it('resolves the super_class chain', async () => {
    const m = new MetadataService();
    const ctx = ctxFor(dictionaryFixture());
    expect(await m.table(ctx, 'incident')).toEqual({
      name: 'incident',
      label: 'Incident',
      chain: ['incident', 'task'],
    });
    expect((await m.table(ctx, 'task')).chain).toEqual(['task']);
  });

  it('includes inherited fields; the child definition overrides the parent', async () => {
    const m = new MetadataService();
    const fields = await m.fields(ctxFor(dictionaryFixture()), 'incident');
    expect([...fields.keys()].sort()).toEqual(
      [
        'assigned_to',
        'caller_id',
        'category',
        'number',
        'priority',
        'short_description',
        'state',
        'sys_created_on',
        'sys_id',
        'u_cred_ref',
      ].sort(),
    );
    expect(fields.get('state')).toMatchObject({
      definedOn: 'incident',
      label: 'Incident state',
      type: 'integer',
    });
    expect(fields.get('number')).toMatchObject({ definedOn: 'task', display: true, maxLength: 40 });
    expect(fields.get('caller_id')).toMatchObject({ reference: 'sys_user', mandatory: true });
    // The collection row (element empty) is not a field.
    expect(fields.has('')).toBe(false);
  });

  it('pages through large dictionaries (no cap)', async () => {
    const sn = dictionaryFixture();
    for (let i = 0; i < 2100; i++) {
      sn.insert('sys_dictionary', {
        name: 'task',
        element: `u_f${i}`,
        internal_type: 'string',
        column_label: `F${i}`,
        reference: '',
        max_length: '40',
        mandatory: 'false',
        display: 'false',
      });
    }
    const fields = await new MetadataService().fields(ctxFor(sn), 'incident');
    expect(fields.size).toBe(10 + 2100);
    expect(sn.calls.filter((c) => c.table === 'sys_dictionary').map((c) => c.offset)).toEqual([
      0, 1000, 2000,
    ]);
  });
});

describe('AC2: dot-walk resolution across references', () => {
  it('follows reference fields to the final field', async () => {
    const m = new MetadataService();
    const ctx = ctxFor(dictionaryFixture());
    expect(await m.resolvePath(ctx, 'incident', 'caller_id.department.name')).toMatchObject({
      field: { name: 'name', definedOn: 'cmn_department' },
      tables: ['incident', 'sys_user', 'cmn_department'],
    });
    expect((await m.resolvePath(ctx, 'incident', 'assigned_to.manager.user_name')).tables).toEqual([
      'incident',
      'sys_user',
      'sys_user',
    ]);
    expect((await m.resolvePath(ctx, 'incident', 'number')).field.definedOn).toBe('task');
  });

  it('rejects unknown segments with suggestions, and walks through non-references', async () => {
    const m = new MetadataService();
    const ctx = ctxFor(dictionaryFixture());
    await expect(m.resolvePath(ctx, 'incident', 'caller_id.departmnt.name')).rejects.toMatchObject({
      code: 'INVALID_FIELD',
      suggestions: expect.arrayContaining(['department']),
      hint: expect.stringContaining('caller_id.department'),
    });
    await expect(m.resolvePath(ctx, 'incident', 'short_description.name')).rejects.toMatchObject({
      code: 'INVALID_FIELD',
      message: expect.stringMatching(/not a reference/),
    });
  });
});

describe('AC3: cache', () => {
  it('a cache hit avoids bridge calls; TTL expiry refetches; instances are separate', async () => {
    const clock = { t: 0 };
    const m = new MetadataService(() => clock.t);
    const sn = dictionaryFixture();
    const ctx = ctxFor(sn);
    await m.fields(ctx, 'incident');
    const after = ctx.fetches();
    await m.fields(ctx, 'incident');
    await m.table(ctx, 'incident');
    await m.resolvePath(ctx, 'incident', 'caller_id.department.name');
    const afterWalk = ctx.fetches();
    await m.resolvePath(ctx, 'incident', 'caller_id.department.name');
    expect(ctx.fetches()).toBe(afterWalk);
    expect(afterWalk).toBeGreaterThan(after); // the walk loaded sys_user and cmn_department once

    clock.t += 15 * 60_000 + 1;
    await m.fields(ctx, 'incident');
    expect(ctx.fetches()).toBeGreaterThan(afterWalk);

    const other = ctxFor(sn, 'prod.service-now.com');
    await m.fields(other, 'incident');
    expect(other.fetches()).toBeGreaterThan(0);
  });

  it('single-flight: concurrent callers share one fetch; failures are not cached', async () => {
    const m = new MetadataService();
    const sn = dictionaryFixture();
    const ctx = ctxFor(sn);
    await Promise.all(Array.from({ length: 10 }, () => m.fields(ctx, 'incident')));
    expect(sn.calls.filter((c) => c.table === 'sys_dictionary')).toHaveLength(1);

    let fail = true;
    const flaky: MetaContext = {
      instanceKey: 'flaky',
      fetch: async (req) =>
        fail ? { ok: false, code: 'TIMEOUT', message: 't' } : { ok: true, rows: sn.list(req).rows },
    };
    await expect(m.table(flaky, 'incident')).rejects.toMatchObject({ code: 'TIMEOUT' });
    fail = false;
    expect((await m.table(flaky, 'incident')).chain).toEqual(['incident', 'task']);
  });

  it('invalidate drops one instance only', async () => {
    const m = new MetadataService();
    const sn = dictionaryFixture();
    const a = ctxFor(sn, 'a');
    const b = ctxFor(sn, 'b');
    await m.table(a, 'incident');
    await m.table(b, 'incident');
    m.invalidate('a');
    const [na, nb] = [a.fetches(), b.fetches()];
    await m.table(a, 'incident');
    await m.table(b, 'incident');
    expect(a.fetches()).toBeGreaterThan(na);
    expect(b.fetches()).toBe(nb);
  });
});

describe('AC4: unknown table → NOT_FOUND with close matches', () => {
  it.each([
    ['incidnt', 'incident'],
    ['incident_tsk', 'incident_task'],
    ['sys_usr', 'sys_user'],
  ])('%s → suggests %s', async (bad, good) => {
    const err = await new MetadataService().table(ctxFor(dictionaryFixture()), bad).catch((e) => e);
    expect(err).toBeInstanceOf(MetadataError);
    expect(err).toMatchObject({ code: 'NOT_FOUND' });
    expect((err as MetadataError).suggestions?.[0]).toBe(good);
    expect((err as MetadataError).hint).toContain(good);
  });

  it('no matches → hint to discover_tables', async () => {
    const err = await new MetadataService()
      .table(ctxFor(dictionaryFixture()), 'zzzqqq')
      .catch((e) => e);
    expect(err).toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('discover_tables'),
    });
  });
});

describe('choices', () => {
  it('uses the most specific table, active English choices only, in sequence order', async () => {
    const m = new MetadataService();
    const ctx = ctxFor(dictionaryFixture());
    expect(await m.choices(ctx, 'incident', 'state')).toEqual([
      { value: '1', label: 'New', sequence: 1 },
      { value: '2', label: 'In Progress', sequence: 2 },
      { value: '7', label: 'Closed', sequence: 7 },
    ]);
    expect(await m.choices(ctx, 'incident', 'priority')).toEqual([
      { value: '1', label: 'Critical', sequence: 1 },
    ]); // inherited
    expect(await m.choices(ctx, 'incident', 'category')).toEqual([]);
  });

  it('builds queries with the shared compiler only (no raw concatenation)', async () => {
    const sn = dictionaryFixture();
    await new MetadataService().choices(ctxFor(sn), 'incident', 'state');
    expect(sn.calls.map((c) => c.query)).toEqual(
      expect.arrayContaining([
        'name=incident',
        expect.stringMatching(
          /^nameINincident,task\^element=state\^inactive=false\^ORDERBYsequence$/,
        ),
      ]),
    );
  });
});

describe('helpers', () => {
  it('edit distance and ranking', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(closeMatches('incidnt', ['problem', 'incident', 'incident_task', 'x'])[0]).toBe(
      'incident',
    );
  });
});
