import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AnyOfSchema,
  compileFilter,
  conditionCount,
  containsScriptMarker,
  formatQueryError,
  normalizeForInspection,
  PublishedAnyOfSchema,
  PublishedWhereSchema,
  parseEncodedQuery,
  type QueryError,
  RELATIVE_UNITS,
  serializeQuery,
  validateValue,
  WhereSchema,
} from '../src/index.js';

interface AttackCase {
  name: string;
  query: string;
  expect: 'UNSAFE_QUERY' | 'INVALID_INPUT';
  allowTextSearch: boolean;
}
interface ValidCase {
  query: string;
  allowTextSearch: boolean;
  /** Canonical form when it differs from the input (^EQ removed, operator aliases). */
  canonical?: string;
  referencedFields?: string[];
}

const load = <T>(f: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as T;
const ATTACKS = load<AttackCase[]>('attack-corpus.json');
const VALID = load<ValidCase[]>('valid-corpus.json');

describe('attack corpus', () => {
  it('has at least 50 cases and 30 valid queries', () => {
    expect(ATTACKS.length).toBeGreaterThanOrEqual(50);
    expect(VALID.length).toBeGreaterThanOrEqual(30);
  });

  it.each(ATTACKS.map((c) => [c.name, c] as const))('rejects: %s', (_n, c) => {
    const r = parseEncodedQuery(c.query, { allowTextSearch: c.allowTextSearch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(c.expect);
      expect(r.error.reason, c.name).toBeDefined();
    }
  });
});

describe('valid corpus', () => {
  it.each(VALID.map((c) => [c.query.slice(0, 80), c] as const))(
    'accepts and round-trips: %s',
    (_q, c) => {
      const r = parseEncodedQuery(c.query, { allowTextSearch: c.allowTextSearch });
      expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
      if (!r.ok) return;
      expect(serializeQuery(r.value)).toBe(c.canonical ?? c.query);
      expect(r.value.normalizations.length > 0).toBe(
        c.canonical !== undefined &&
          !c.query.startsWith('123TEXTQUERY321') &&
          c.query.includes('EQ')
          ? true
          : r.value.normalizations.length > 0,
      );
      if (c.referencedFields) {
        expect([...r.value.referencedFields].sort()).toEqual([...c.referencedFields].sort());
      }
      // The canonical form is a fixed point.
      const again = parseEncodedQuery(serializeQuery(r.value), {
        allowTextSearch: c.allowTextSearch,
      });
      expect(again.ok && serializeQuery(again.value)).toBe(serializeQuery(r.value));
      expect(again.ok && again.value.normalizations).toEqual([]);
    },
  );

  it('parses structure correctly', () => {
    const r = parseEncodedQuery('a=1^ORb=2^c=3^NQd=4^ORDERBYDESCe');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.groups).toEqual([
      [
        { field: 'a', operator: '=', value: '1', join: 'AND' },
        { field: 'b', operator: '=', value: '2', join: 'OR' },
        { field: 'c', operator: '=', value: '3', join: 'AND' },
      ],
      [{ field: 'd', operator: '=', value: '4', join: 'AND' }],
    ]);
    expect(r.value.orderBy).toEqual([{ field: 'e', descending: true }]);
    expect(conditionCount(r.value)).toBe(4);
  });

  it('accepts exactly the limits', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `f${i}=1`).join('^');
    expect(parseEncodedQuery(hundred).ok).toBe(true);
    const ten = Array.from({ length: 10 }, (_, i) => `f${i}=1`).join('^NQ');
    expect(parseEncodedQuery(ten).ok).toBe(true);
    const list = `stateIN${Array.from({ length: 1000 }, (_, i) => i).join(',')}`;
    expect(parseEncodedQuery(list).ok).toBe(true);
    // The length bound applies to each IN item, not to the whole list.
    const long = `nameIN${'a'.repeat(500)},${'b'.repeat(500)}`;
    expect(parseEncodedQuery(long).ok).toBe(true);
    expect(parseEncodedQuery(`descriptionLIKE${'x'.repeat(500)}`).ok).toBe(true);
  });

  it('moves ORDERBY to the end when serializing', () => {
    const r = parseEncodedQuery('ORDERBYnumber^active=true');
    expect(r.ok && serializeQuery(r.value)).toBe('active=true^ORDERBYnumber');
  });
});

describe('normalization', () => {
  it('decodes and lowercases for inspection', () => {
    expect(normalizeForInspection('%256A')).toBe('j');
    expect(normalizeForInspection('&#x4A;&#65;')).toBe('ja');
    expect(normalizeForInspection('Ｊ​A')).toBe('ja');
    expect(normalizeForInspection('%E0%A4%A')).toContain('%a');
  });

  it('detects script markers without false positives on ordinary text', () => {
    expect(containsScriptMarker('Java runtime update')).toBe(false);
    expect(containsScriptMarker('scripting guide')).toBe(false);
    // The word alone is fine; only the prefix runs script (ADR-005 addendum).
    expect(containsScriptMarker('JavaScript guide')).toBe(false);
    expect(containsScriptMarker('automation_pipeline_transformer_javascript')).toBe(false);
    expect(containsScriptMarker('javascript error at 10:30')).toBe(false);
    expect(containsScriptMarker('JavaScript: the good parts')).toBe(true); // can't tell it apart
    // Separators other than spaces before the colon are still caught.
    expect(containsScriptMarker('javascript.:x')).toBe(true);
    expect(containsScriptMarker('javascript-_:x')).toBe(true);
  });

  it('ignores out-of-range code points', () => {
    expect(normalizeForInspection('&#99999999;x')).toBe('x');
  });
});

describe('validateValue', () => {
  it('rejects unknown operators and ^ in values', () => {
    expect(validateValue('NOPE', 'x').ok).toBe(false);
    expect(validateValue('=', 'a^NQb=1').ok).toBe(false);
  });
});

describe('structured filter compiler', () => {
  const compile = (input: unknown, allowTextSearch = false) =>
    compileFilter(input, { allowTextSearch });
  const q = (input: unknown, allowTextSearch = false) => {
    const r = compile(input, allowTextSearch);
    if (!r.ok) throw new Error(r.error.message);
    return r.value.query;
  };

  it('compiles every operator', () => {
    expect(
      q({
        where: [
          { field: 'active', op: '=', value: true },
          { field: 'priority', op: '<=', value: 2 },
          { field: 'state', op: '!=', value: 7 },
          { field: 'impact', op: '>', value: 1 },
          { field: 'urgency', op: '>=', value: 1 },
          { field: 'severity', op: '<', value: 3 },
          { field: 'short_description', op: 'contains', value: 'email' },
          { field: 'description', op: 'not_contains', value: 'test' },
          { field: 'name', op: 'starts_with', value: 'Disc' },
          { field: 'name', op: 'ends_with', value: '.js' },
          { field: 'state', op: 'in', value: [1, 2, '3'] },
          { field: 'state', op: 'not_in', value: [6] },
          { field: 'assigned_to', op: 'is_empty' },
          { field: 'caller_id', op: 'is_not_empty' },
          { field: 'reassignment_count', op: 'between', value: [1, 5] },
          { field: 'sys_created_on', op: 'within_last', value: { amount: 24, unit: 'hour' } },
          { field: 'sys_updated_on', op: 'older_than', value: { amount: 30, unit: 'day' } },
        ],
      }),
    ).toBe(
      'active=true^priority<=2^state!=7^impact>1^urgency>=1^severity<3^short_descriptionLIKEemail' +
        '^descriptionNOT LIKEtest^nameSTARTSWITHDisc^nameENDSWITH.js^stateIN1,2,3^stateNOT IN6' +
        '^assigned_toISEMPTY^caller_idISNOTEMPTY^reassignment_countBETWEEN1@5' +
        '^sys_created_onRELATIVEGE@hour@ago@24^sys_updated_onRELATIVELT@dayofweek@ago@30',
    );
  });

  it('compiles or-groups, any_of, order_by and text', () => {
    expect(
      q({
        where: [
          { field: 'active', op: '=', value: true },
          {
            or: [
              { field: 'priority', op: '=', value: 1 },
              { field: 'priority', op: '=', value: 2 },
            ],
          },
        ],
        order_by: [
          { field: 'sys_updated_on', direction: 'desc' },
          { field: 'number', direction: 'asc' },
        ],
      }),
    ).toBe('active=true^priority=1^ORpriority=2^ORDERBYDESCsys_updated_on^ORDERBYnumber');
    expect(
      q({
        any_of: [
          [{ field: 'state', op: '=', value: 1 }],
          [
            { field: 'state', op: '=', value: 2 },
            { field: 'active', op: '=', value: false },
          ],
        ],
      }),
    ).toBe('state=1^NQstate=2^active=false');
    expect(q({ text: 'disk full', where: [{ field: 'active', op: '=', value: true }] }, true)).toBe(
      '123TEXTQUERY321=disk full^active=true',
    );
    expect(q({ order_by: [{ field: 'number', direction: 'asc' }] })).toBe('ORDERBYnumber');
    expect(q({})).toBe('');
  });

  it('reports referenced fields including dot-walks and order fields', () => {
    const r = compile({
      where: [{ field: 'caller_id.manager.name', op: '=', value: 'Ann' }],
      order_by: [{ field: 'opened_at', direction: 'desc' }],
    });
    expect(r.ok && r.value.referencedFields).toEqual(['caller_id.manager.name', 'opened_at']);
  });

  it('allows literal code searches', () => {
    expect(q({ where: [{ field: 'script', op: 'contains', value: 'gs.addErrorMessage(' }] })).toBe(
      'scriptLIKEgs.addErrorMessage(',
    );
    expect(q({ where: [{ field: 'script', op: 'contains', value: 'new GlideRecord' }] })).toBe(
      'scriptLIKEnew GlideRecord',
    );
  });

  it.each([
    [
      'caret injection',
      { where: [{ field: 'a', op: '=', value: 'x^NQsys_id!=y' }] },
      'INVALID_INPUT',
    ],
    ['newline', { where: [{ field: 'a', op: '=', value: 'x\ny' }] }, 'INVALID_INPUT'],
    ['comma in list item', { where: [{ field: 'a', op: 'in', value: ['1,2'] }] }, 'INVALID_INPUT'],
    [
      '@ in between',
      { where: [{ field: 'a', op: 'between', value: ['1@2', '3'] }] },
      'INVALID_INPUT',
    ],
    ['invalid field', { where: [{ field: 'A;b', op: '=', value: 1 }] }, 'INVALID_INPUT'],
    ['deep dot-walk', { where: [{ field: 'a.b.c.d.e', op: '=', value: 1 }] }, 'INVALID_INPUT'],
    ['unknown op', { where: [{ field: 'a', op: 'DYNAMIC', value: 'x' }] }, 'INVALID_INPUT'],
    ['empty string value', { where: [{ field: 'a', op: '=', value: '' }] }, 'INVALID_INPUT'],
    ['NaN value', { where: [{ field: 'a', op: '=', value: Number.NaN }] }, 'INVALID_INPUT'],
    ['extra key', { where: [{ field: 'a', op: '=', value: 1, raw: 'x' }] }, 'INVALID_INPUT'],
    [
      'where and any_of',
      { where: [{ field: 'a', op: 'is_empty' }], any_of: [[], []] },
      'INVALID_INPUT',
    ],
    ['empty where', { where: [] }, 'INVALID_INPUT'],
    [
      'too many terms',
      { where: Array.from({ length: 101 }, (_, i) => ({ field: `f${i}`, op: '=', value: 1 })) },
      'INVALID_INPUT',
    ],
    [
      'too many any_of groups',
      { any_of: Array.from({ length: 11 }, () => [{ field: 'a', op: '=', value: 1 }]) },
      'INVALID_INPUT',
    ],
    ['single-item or', { where: [{ or: [{ field: 'a', op: '=', value: 1 }] }] }, 'INVALID_INPUT'],
    [
      'relative zero',
      { where: [{ field: 'a', op: 'within_last', value: { amount: 0, unit: 'day' } }] },
      'INVALID_INPUT',
    ],
    ['text not allowed', { text: 'foo' }, 'INVALID_INPUT'],
    ['not an object', 'active=true', 'INVALID_INPUT'],
  ])('rejects %s', (_n, input, code) => {
    const r = compile(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('compiled output always passes the authoritative validator (round-trip)', () => {
    const inputs = [
      { where: [{ field: 'a', op: '=', value: 'x y' }] },
      {
        where: [{ field: 'a.b', op: 'in', value: ['x', 2] }],
        order_by: [{ field: 'c', direction: 'desc' }],
      },
      { any_of: [[{ field: 'a', op: 'is_empty' }], [{ field: 'b', op: 'contains', value: '%' }]] },
    ];
    for (const input of inputs) {
      const r = compile(input);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const p = parseEncodedQuery(r.value.query);
      expect(p.ok && serializeQuery(p.value)).toBe(r.value.query);
    }
  });
});

describe('native compatibility (T-047)', () => {
  const parse = (q: string, allowTextSearch = false) => {
    const r = parseEncodedQuery(q, { allowTextSearch });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };

  it('reports each normalization', () => {
    expect(parse('active=true^EQ').normalizations).toEqual(['removed the ^EQ end marker']);
    expect(parse('aNOTLIKEx^bCONTAINSy^cCONTAINSz').normalizations).toEqual([
      'operator NOTLIKE → NOT LIKE',
      'operator CONTAINS → LIKE',
    ]);
    expect(parse('active=true').normalizations).toEqual([]);
  });

  it('keeps empty = and != as native empty tests', () => {
    const v = parse('assignment_group=^ORassigned_to!=');
    expect(v.groups[0]).toEqual([
      { field: 'assignment_group', operator: '=', value: '', join: 'AND' },
      { field: 'assigned_to', operator: '!=', value: '', join: 'OR' },
    ]);
  });

  it('structured filters keep requiring a value (is_empty exists)', () => {
    const r = compileFilter({ where: [{ field: 'a', op: '=', value: '' }] });
    expect(r.ok).toBe(false);
  });

  it('structured in-lists longer than 500 characters compile', () => {
    const ids = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(32, '0'));
    const r = compileFilter({ where: [{ field: 'sys_id', op: 'in', value: ids }] });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
  });
});

describe('diagnostics (T-047)', () => {
  const error = (q: string, allowTextSearch = false): QueryError => {
    const r = parseEncodedQuery(q, { allowTextSearch });
    if (r.ok) throw new Error(`accepted: ${q}`);
    return r.error;
  };

  it('locates the condition', () => {
    const e = error('active=true^ORpriority~1');
    expect(e.position).toBe(2);
    expect(e.term).toBe('ORpriority~1');
    expect(formatQueryError(e)).toMatch(/^Condition 2 \(`ORpriority~1`\): Unknown operator/);
  });

  it.each([
    ['stateVALCHANGES', 'get_record_history'],
    ['RLQUERYtask_sla.task,>=1^ENDRLQUERY', 'sys_idIN'],
    ['IR_AND_OR_QUERY=foo', '`text` parameter'],
    ['GOTOnumber=INC0010001', 'Remove it: number=INC0010001'],
    ['active=true^GROUPBYstate', 'aggregate_records'],
    ['priority = 2', 'priority=2'],
    ['short_description LIKE disk full', 'short_descriptionLIKEdisk full'],
    ['priority==2', 'priority=2'],
    ['priority<>2', 'priority!=2'],
    ['Priority=1', 'priority=1'],
    ['active=true^EQ^priority=1', 'before ^EQ'],
  ])('suggests a rewrite for %s', (q, expected) => {
    const e = error(q);
    expect(e.suggestion ?? '').toContain(expected);
  });

  it('suggestions with a native rewrite pass the validator', () => {
    for (const q of ['priority = 2', 'Priority=1']) {
      const rewrite = (error(q).suggestion ?? '').replace(/ \(.*\)$/, '');
      expect(parseEncodedQuery(rewrite).ok, `${q} → ${rewrite}`).toBe(true);
    }
  });

  it('explains a missing operator', () => {
    expect(error('short_descriptionlikefoo').message).toMatch(/Operators are uppercase/);
  });

  it('warns about valid conditions that are probably mistakes, without refusing them', () => {
    const w = (q: string) => {
      const r = parseEncodedQuery(q);
      expect(r.ok).toBe(true);
      return r.ok ? r.value.warnings : [];
    };
    expect(w('active=true AND priority=1')[0]).toMatch(
      /joins conditions with \^|join conditions with \^/,
    );
    expect(w('short_descriptionLIKE"disk full"')[0]).toMatch(/quotes/);
    expect(w('short_descriptionLIKE disk')[0]).toMatch(/spaces/);
    expect(w('active=true^short_descriptionLIKEdisk full')).toEqual([]);
  });
});

describe('published filter schema (T-048)', () => {
  const conditions: unknown[] = [
    { field: 'active', op: '=', value: true },
    { field: 'priority', op: '<=', value: 2 },
    { field: 'short_description', op: 'contains', value: 'email' },
    { field: 'name', op: 'ends_with', value: '.js' },
    { field: 'state', op: 'in', value: [1, 2, '3'] },
    { field: 'state', op: 'not_in', value: [6] },
    { field: 'assigned_to', op: 'is_empty' },
    { field: 'caller_id.name', op: 'is_not_empty' },
    { field: 'reassignment_count', op: 'between', value: [1, 5] },
    { field: 'sys_created_on', op: 'within_last', value: { amount: 24, unit: 'hour' } },
    { field: 'sys_updated_on', op: 'older_than', value: { amount: 30, unit: 'day' } },
  ];

  it('accepts everything the validation schema accepts', () => {
    const where = [...conditions, { or: conditions.slice(0, 3) }];
    expect(WhereSchema.safeParse(where).success).toBe(true);
    expect(PublishedWhereSchema.safeParse(where).success).toBe(true);
    for (const c of conditions) {
      expect(PublishedWhereSchema.safeParse([c]).success, JSON.stringify(c)).toBe(true);
    }
    const anyOf = [where, [conditions[0]]];
    expect(AnyOfSchema.safeParse(anyOf).success).toBe(true);
    expect(PublishedAnyOfSchema.safeParse(anyOf).success).toBe(true);
    // ...and passes it on unchanged: nothing stripped before the strict validation runs.
    expect(PublishedWhereSchema.parse(where)).toEqual(where);
    expect(PublishedAnyOfSchema.parse(anyOf)).toEqual(anyOf);
  });

  it('has the same operators as the validation schema', () => {
    const json = JSON.stringify(z.toJSONSchema(PublishedWhereSchema));
    const real = JSON.stringify(z.toJSONSchema(WhereSchema));
    const ops = (s: string) =>
      new Set([...s.matchAll(/"enum":\[([^\]]*)\]/g)].flatMap((m) => JSON.parse(`[${m[1]}]`)));
    const lit = (s: string) => [...s.matchAll(/"const":"([^"]+)"/g)].map((m) => m[1]);
    const realOps = new Set([...ops(real), ...lit(real)]);
    for (const u of ['minute', 'hour', 'day', 'week', 'month', 'year']) realOps.delete(u);
    for (const d of ['asc', 'desc']) realOps.delete(d);
    expect(
      [...realOps].every((o) => ops(json).has(o)),
      [...realOps].join(' '),
    ).toBe(true);
  });
});

describe('a condition that fits no form says what was expected (T-048)', () => {
  const days = [
    { field: 'sys_created_on', op: 'within_last', value: { amount: 30, unit: 'days' } },
  ];

  it.each([
    ['published', PublishedWhereSchema],
    ['validated', WhereSchema],
  ])('%s schema', (_name, schema) => {
    const r = schema.safeParse(days);
    expect(r.success).toBe(false);
    const message = r.error?.issues[0]?.message ?? '';
    expect(message).not.toBe('Invalid input');
    for (const unit of RELATIVE_UNITS) expect(message).toContain(unit);
    expect(message).toContain('within_last');
  });

  it('the singular unit it asks for is accepted', () => {
    const fixed = [{ ...days[0], value: { amount: 30, unit: 'day' } }];
    expect(PublishedWhereSchema.safeParse(fixed).success).toBe(true);
    expect(WhereSchema.safeParse(fixed).success).toBe(true);
  });
});

describe('relative dates reach ServiceNow in its own units (T-049)', () => {
  const compiled = (unit: string, amount: number) =>
    compileFilter({
      where: [{ field: 'sys_created_on', op: 'within_last', value: { amount, unit } }],
    } as never);

  it.each([
    ['minute', 5, '@minute@ago@5'],
    ['hour', 5, '@hour@ago@5'],
    ['day', 30, '@dayofweek@ago@30'],
    ['week', 2, '@dayofweek@ago@14'],
    ['month', 2, '@month@ago@2'],
    ['quarter', 1, '@month@ago@3'],
    ['year', 1, '@year@ago@1'],
  ])('structured %s', (unit, amount, native) => {
    const r = compiled(unit, amount);
    expect(r.ok && r.value.query).toContain(`sys_created_onRELATIVEGE${native}`);
  });

  it.each([
    ['sys_created_onRELATIVEGE@day@ago@7', 'sys_created_onRELATIVEGE@dayofweek@ago@7'],
    ['due_dateRELATIVELE@week@ahead@2', 'due_dateRELATIVELE@dayofweek@ahead@14'],
    ['sys_updated_onRELATIVELT@dayofweek@ago@1', 'sys_updated_onRELATIVELT@dayofweek@ago@1'],
    ['sys_created_onRELATIVEGE@quarter@ago@1', 'sys_created_onRELATIVEGE@quarter@ago@1'],
  ])('raw %s', (raw, sent) => {
    const r = parseEncodedQuery(raw);
    if (!r.ok) throw new Error(r.error.message);
    expect(serializeQuery(r.value)).toBe(sent);
    if (raw !== sent) expect(r.value.normalizations.join()).toContain('→');
  });

  it('a week count too large for ServiceNow is refused, not sent', () => {
    expect(parseEncodedQuery('aRELATIVEGE@week@ago@9999').ok).toBe(false);
    expect(compiled('week', 9999).ok).toBe(false);
  });

  it('other units stay refused', () => {
    for (const unit of ['days', 'fortnight', 'DAY']) {
      expect(parseEncodedQuery(`aRELATIVEGE@${unit}@ago@1`).ok, unit).toBe(false);
    }
  });
});

describe('script values and the date operators ServiceNow writes (ADR-018)', () => {
  it.each([
    'sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()',
    'sys_created_onNOTONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()',
    'sys_created_on>=javascript:gs.daysAgoStart(7)',
    'sys_created_on<javascript:gs.beginningOfToday()',
    "sys_created_onBETWEENjavascript:gs.dateGenerate('2026-11-01','start')@javascript:gs.dateGenerate('2026-11-02','end')",
    "sys_created_onDATEPARTMonday@javascript:gs.datePart('dayofweek','monday','EE')",
    'assigned_to=javascript:gs.getUserID()',
    'assignment_groupINjavascript:getMyGroups()',
    'sys_updated_onMORETHANsys_created_on@hour@before@1',
    'sys_updated_onMORETHANsys_created_on@year@after@1',
    'sys_updated_onLESSTHANassigned@hour@before@0',
    'sys_updated_onLESSTHANassigned@week@before@1',
    'sys_updated_onLESSTHANassigned@day@before@1',
    "sys_updated_onDATEPARTWeek1@javascript:gs.datePart('week','1','EE')",
    "sys_updated_onDATEPARTMay@javascript:gs.datePart('month','may','EE')",
    'sys_updated_onONLast quarter@javascript:gs.beginningOfLastQuarter()@javascript:gs.endOfLastQuarter()',
    'assigned_to.nameNOT LIKEbozok',
    'assigned_to.nameINbozok, cuneyt, admin, beth',
  ])('%s is sent as written', (q) => {
    const r = parseEncodedQuery(q);
    if (!r.ok) throw new Error(r.error.message);
    expect(serializeQuery(r.value)).toBe(q);
  });

  it('a script value or DYNAMIC warns that it runs as script; other conditions do not', () => {
    const warnings = (q: string) => {
      const r = parseEncodedQuery(q);
      if (!r.ok) throw new Error(r.error.message);
      return r.value.warnings.join(' ');
    };
    expect(warnings('assigned_to=javascript:gs.getUserID()')).toMatch(/server-side script/);
    expect(warnings('assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe')).toMatch(/server-side/);
    expect(warnings('short_descriptionLIKEjavascript')).toBe('');
  });

  it('structured values and text search may hold a script value too', () => {
    const r = compileFilter({ where: [{ field: 'a', op: '=', value: 'javascript:gs.x()' }] });
    expect(r.ok).toBe(true);
  });

  it('sub-queries, UI keywords and ^ in a value stay refused', () => {
    for (const q of [
      'RLQUERYtask_sla.task,>=1^ENDRLQUERY',
      'SUBQUERYx',
      'JOINincident.a=b.c',
      'GOTOnumber=1',
      'stateVALCHANGES',
    ]) {
      expect(parseEncodedQuery(q).ok, q).toBe(false);
    }
  });
});

describe('MORETHAN / LESSTHAN and RELATIVEEE (T-049, found live)', () => {
  it('the other field is returned for dictionary validation', () => {
    const r = parseEncodedQuery('sys_updated_onMORETHANsys_created_on@hour@after@1');
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.referencedFields).toContain('sys_created_on');
  });

  it.each([
    'aMORETHANb',
    'aMORETHANb@hour@after',
    'aMORETHANb@fortnight@after@1',
    'aMORETHANb@hour@ago@1',
    'aLESSTHANB@hour@after@1',
    'aMORETHANjavascript:gs.x()@hour@after@1',
  ])('%s is refused', (q) => {
    expect(parseEncodedQuery(q).ok).toBe(false);
  });

  it('RELATIVEEE is refused with a rewrite, since it matched no rows live', () => {
    const r = parseEncodedQuery('sys_created_onRELATIVEEE@dayofweek@ago@47');
    if (r.ok) throw new Error('accepted');
    expect(r.error.reason).toBe('UNRELIABLE_OPERATOR');
    expect(r.error.suggestion).toContain('RELATIVEGE@dayofweek@ago@');
  });
});

describe('queries the condition builder writes (T-049)', () => {
  const { rows } = JSON.parse(
    readFileSync(new URL('./fixtures/ui-queries.json', import.meta.url), 'utf8'),
  ) as { rows: { category: string; condition: string; query: string }[] };

  it('the list is complete', () => {
    expect(rows).toHaveLength(256);
  });

  it.each(rows.map((r) => [r.condition, r.query] as const))('%s', (_condition, query) => {
    const r = parseEncodedQuery(query);
    if (!r.ok) throw new Error(`${query}: ${r.error.message}`);
    expect(serializeQuery(r.value)).toBe(query);
  });

  it('IN_HIERARCHY is its own operator, not IN with a strange value', () => {
    for (const [q, op] of [
      ['aIN_HIERARCHY1667a6feeb4112101e31e5b26b52283f@x@0@true', 'IN_HIERARCHY'],
      ['aIN_HIERARCHY_DYNAMIC1667a6feeb4112101e31e5b26b52283f@x@0@true', 'IN_HIERARCHY_DYNAMIC'],
    ] as const) {
      const r = parseEncodedQuery(q);
      expect(r.ok && r.value.groups[0]?.[0]?.operator, q).toBe(op);
    }
  });

  it('the other field of SAMEAS and of "before or after" reaches dictionary validation', () => {
    for (const q of ['aSAMEASb@day', 'aMORETHANb@hour@before or after@2']) {
      const r = parseEncodedQuery(q);
      expect(r.ok && r.value.referencedFields, q).toContain('b');
    }
    expect(parseEncodedQuery('aSAMEASb@fortnight').ok).toBe(false);
  });
});
