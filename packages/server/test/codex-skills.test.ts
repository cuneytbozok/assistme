/** T-045: `npm run codex-skills` under a throwaway home, so it never touches the real folder. */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const OURS = ['servicenow-development-guide', 'servicenow-readonly-troubleshooting'];
let home: string;
const skills = () => join(home, '.agents', 'skills');
const run = (...args: string[]) =>
  execFileSync(process.execPath, [join(REPO, 'scripts/codex-skills.ts'), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    stdio: 'pipe',
  });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sn-skills-')));
  expect(home).not.toBe(realpathSync(homedir()));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('T-045 Codex skills', () => {
  it('installs both skills with their references, and can run again', () => {
    run();
    run();
    expect(readdirSync(skills()).sort()).toEqual(OURS);
    for (const name of OURS) {
      const source = join(REPO, 'plugin/skills', name);
      expect(readFileSync(join(skills(), name, 'SKILL.md'), 'utf8')).toBe(
        readFileSync(join(source, 'SKILL.md'), 'utf8'),
      );
      expect(readdirSync(join(skills(), name, 'references')).sort()).toEqual(
        readdirSync(join(source, 'references'))
          .filter((f) => f !== '.DS_Store')
          .sort(),
      );
    }
  });

  it("uninstalling removes only this project's skills", () => {
    mkdirSync(join(skills(), 'someone-elses'), { recursive: true });
    writeFileSync(join(skills(), 'someone-elses', 'SKILL.md'), '---\nname: someone-elses\n---\n');
    run();
    run('--uninstall');
    expect(readdirSync(skills())).toEqual(['someone-elses']);
    run('--uninstall');
  });

  it('refuses to replace a different folder of the same name, and changes nothing', () => {
    const taken = join(skills(), OURS[1] as string);
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'notes.txt'), 'mine');
    expect(() => run()).toThrow();
    expect(() => run('--uninstall')).toThrow();
    expect(readFileSync(join(taken, 'notes.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(skills(), OURS[0] as string))).toBe(false);
  });
});
