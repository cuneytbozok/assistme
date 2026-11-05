import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compileFilter,
  conditionCount,
  containsScriptLikePattern,
  containsScriptMarker,
  normalizeForInspection,
  parseEncodedQuery,
  type QueryProfile,
  serializeQuery,
  validateValue,
} from '../src/index.js';

interface AttackCase {
  name: string;
  query: string;
  expect: 'UNSAFE_QUERY' | 'INVALID_INPUT';
  profile: QueryProfile;
  allowTextSearch: boolean;
}
interface ValidCase {
  query: string;
  profiles: QueryProfile[];
  allowTextSearch: boolean;
  referencedFields?: string[];
}

const load = <T>(f: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as T;
const ATTACKS = load<AttackCase[]>('attack-corpus.json');
const VALID = load<ValidCase[]>('valid-corpus.json');

describe('attack corpus', () => {
  it('has at least 60 cases and 30 valid queries', () => {
    expect(ATTACKS.length).toBeGreaterThanOrEqual(60);
    expect(VALID.length).toBeGreaterThanOrEqual(30);
  });

  it.each(ATTACKS.map((c) => [c.name, c] as const))('rejects: %s', (_n, c) => {
    const r = parseEncodedQuery(c.query, {
      profile: c.profile,
      allowTextSearch: c.allowTextSearch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(c.expect);
  });

  it('enforce-profile attacks are also rejected by the strict profile', () => {
    for (const c of ATTACKS.filter((x) => x.profile === 'enforce')) {
      const r = parseEncodedQuery(c.query, {
        profile: 'strict',
        allowTextSearch: c.allowTextSearch,
      });
      expect(r.ok, c.name).toBe(false);
    }
  });

  it('strict-only cases are legitimate literal searches in the enforce profile', () => {
    for (const c of ATTACKS.filter((x) => x.profile === 'strict')) {
      expect(parseEncodedQuery(c.query, { profile: 'enforce' }).ok, c.name).toBe(true);
    }
  });
});

describe('valid corpus', () => {
  it.each(VALID.map((c) => [c.query, c] as const))('accepts and round-trips: %s', (_q, c) => {
    for (const profile of c.profiles) {
      const r = parseEncodedQuery(c.query, { profile, allowTextSearch: c.allowTextSearch });
      expect(r.ok, `${profile}: ${r.ok ? '' : r.error.message}`).toBe(true);
      if (!r.ok) continue;
      expect(serializeQuery(r.value)).toBe(c.query);
      if (c.referencedFields) {
        expect([...r.value.referencedFields].sort()).toEqual([...c.referencedFields].sort());
      }
    }
  });

  it('parses structure correctly', () => {
    const r = parseEncodedQuery('a=1^ORb=2^c=3^NQd=4^ORDERBYDESCe', { profile: 'enforce' });
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
    const twenty = Array.from({ length: 20 }, (_, i) => `f${i}=1`).join('^');
    expect(parseEncodedQuery(twenty, { profile: 'enforce' }).ok).toBe(true);
    expect(parseEncodedQuery('a=1^NQb=1^NQc=1', { profile: 'enforce' }).ok).toBe(true);
    const list = `stateIN${Array.from({ length: 100 }, (_, i) => i).join(',')}`;
    expect(parseEncodedQuery(list, { profile: 'enforce' }).ok).toBe(true);
    expect(parseEncodedQuery(`descriptionLIKE${'x'.repeat(500)}`, { profile: 'enforce' }).ok).toBe(
      true,
    );
  });

  it('moves ORDERBY to the end when serializing', () => {
    const r = parseEncodedQuery('ORDERBYnumber^active=true', { profile: 'enforce' });
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
    expect(containsScriptLikePattern('settings.json')).toBe(false);
    expect(containsScriptLikePattern('renew license')).toBe(false);
    expect(containsScriptLikePattern('new laptop')).toBe(true);
  });

  it('ignores out-of-range code points', () => {
    expect(normalizeForInspection('&#99999999;x')).toBe('x');
  });
});

describe('validateValue', () => {
  it('rejects unknown operators and ^ in values', () => {
    expect(validateValue('DYNAMIC', 'x', 'enforce').ok).toBe(false);
    expect(validateValue('=', 'a^NQb=1', 'enforce').ok).toBe(false);
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
        '^sys_created_onRELATIVEGE@hour@ago@24^sys_updated_onRELATIVELT@day@ago@30',
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

  it('allows literal code searches that the strict raw profile refuses', () => {
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
    [
      'javascript value',
      { where: [{ field: 'a', op: '=', value: 'javascript:gs.x()' }] },
      'UNSAFE_QUERY',
    ],
    [
      'encoded javascript',
      { where: [{ field: 'a', op: 'contains', value: '%6Aavascript:x' }] },
      'UNSAFE_QUERY',
    ],
    ['newline', { where: [{ field: 'a', op: '=', value: 'x\ny' }] }, 'INVALID_INPUT'],
    ['comma in list item', { where: [{ field: 'a', op: 'in', value: ['1,2'] }] }, 'INVALID_INPUT'],
    [
      '@ in between',
      { where: [{ field: 'a', op: 'between', value: ['1@2', '3'] }] },
      'INVALID_INPUT',
    ],
    [
      'js in between',
      { where: [{ field: 'a', op: 'between', value: ['javascript:x', '3'] }] },
      'UNSAFE_QUERY',
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
      { where: Array.from({ length: 21 }, (_, i) => ({ field: `f${i}`, op: '=', value: 1 })) },
      'INVALID_INPUT',
    ],
    [
      'too many any_of groups',
      { any_of: Array.from({ length: 4 }, () => [{ field: 'a', op: '=', value: 1 }]) },
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

  it('rejects javascript in text search', () => {
    const r = compile({ text: 'javascript:gs.x()' }, true);
    expect(!r.ok && r.error.code).toBe('UNSAFE_QUERY');
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
      const p = parseEncodedQuery(r.value.query, { profile: 'enforce' });
      expect(p.ok && serializeQuery(p.value)).toBe(r.value.query);
    }
  });
});
