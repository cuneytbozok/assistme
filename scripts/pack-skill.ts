/**
 * npm run pack:skill: zips each skill for upload to Claude Desktop, with SKILL.md's folder at the
 * top of the archive. Output: dist-skill/<skill>.zip (git-ignored).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.OUT_DIR ?? join(ROOT, 'dist-skill');

mkdirSync(out, { recursive: true });
for (const skill of ['servicenow-readonly-troubleshooting', 'servicenow-development-guide']) {
  const zip = join(out, `${skill}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', zip, skill, '-x', '*.DS_Store', '-x', '*__pycache__*'], {
    cwd: join(ROOT, 'skills'),
    stdio: 'inherit',
  });
  console.log(`Wrote ${zip}`);
}
