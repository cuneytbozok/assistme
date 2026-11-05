/**
 * T-039: the example permission rules deny every mutating SDK command in every spelling we
 * document, and allow only `explain`. They are matched here as text; that Claude Code really
 * enforces them is a manual check (T-039).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const settings = JSON.parse(readFileSync(join(REPO, '.claude/settings.example.json'), 'utf8'));
const doc = readFileSync(join(REPO, 'docs/SKILLS.md'), 'utf8');
const MUTATING = [
  'auth',
  'init',
  'build',
  'install',
  'deploy',
  'transform',
  'dependencies',
  'download',
];
const PREFIXES = ['npx @servicenow/sdk', 'npx now-sdk', 'now-sdk'];

describe('T-039 settings example', () => {
  it('denies every mutating command, alone and with arguments', () => {
    for (const p of PREFIXES) {
      for (const c of MUTATING) {
        expect(settings.permissions.deny, `${p} ${c}`).toContain(`Bash(${p} ${c})`);
        expect(settings.permissions.deny, `${p} ${c} *`).toContain(`Bash(${p} ${c} *)`);
      }
    }
  });

  it('allows only explain', () => {
    expect(settings.permissions.allow.length).toBeGreaterThan(0);
    for (const rule of settings.permissions.allow) expect(rule).toMatch(/ explain \*\)$/);
  });

  it('the doc says it is not used and that the rules are only a guardrail', () => {
    expect(doc).toMatch(/not used/);
    expect(doc).toMatch(/not a security boundary/);
    expect(doc).toMatch(/haven't been tested/);
  });
});
