/**
 * docs/TASKS.md is the source of truth (CLAUDE.md), so its structure is checked: each task appears
 * once, the summary table agrees with each section, and no two tasks share the same evidence.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../../../docs/TASKS.md', import.meta.url), 'utf8');
const sections = text.split(/^(?=### T-\d{3} )/m).slice(1);
const idOf = (s: string) => s.slice(4, 9);
const table = new Map(
  [...text.matchAll(/^\| (T-\d{3}) \|.*\| (\S+) +\|$/gm)].map((m) => [m[1], m[2]]),
);
const evidence = (s: string) => {
  const i = s.search(/^- \*\*Evidence/m);
  return i < 0
    ? ''
    : s
        .slice(i)
        .replace(/\n## Phase[\s\S]*/, '')
        .trim();
};

describe('docs/TASKS.md', () => {
  it('has each task exactly once, in order, matching the summary table', () => {
    const ids = sections.map(idOf);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual([...table.keys()]);
  });

  it('each section status matches the summary table', () => {
    for (const s of sections) {
      expect(/- \*\*Status:\*\* (\S+)/.exec(s)?.[1], idOf(s)).toBe(table.get(idOf(s)));
    }
  });

  it('a done task has evidence, and no two tasks share the same evidence', () => {
    const seen = new Map<string, string>();
    for (const s of sections) {
      const ev = evidence(s);
      if (table.get(idOf(s)) === 'DONE') expect(ev, idOf(s)).toMatch(/^- \*\*Evidence \(/);
      if (ev && ev !== '- **Evidence:** —') {
        expect(seen.get(ev), `${idOf(s)} repeats ${seen.get(ev)}`).toBeUndefined();
        seen.set(ev, idOf(s));
      }
    }
  });

  it('spot checks of the evidence that was once misplaced', () => {
    const body = (id: string) => sections.find((s) => idOf(s) === id) ?? '';
    expect(body('T-031')).toContain('tools/search-code.ts');
    expect(body('T-032')).toContain('line-diff.ts');
    expect(body('T-033')).toContain('docs/TOOLS.md');
    expect(body('T-034')).toContain('14 passed');
    expect(body('T-035')).toContain('.mcp.json.example');
    expect(body('T-036')).toContain('mcpb/manifest.json');
    expect(body('T-037')).toContain('scripts/setup.ts');
    expect(body('T-038')).toContain('Bug found by installing');
    expect(body('T-039')).toContain('Dropped');
    expect(body('T-040')).toContain('- **Evidence:** —');
  });
});
