/**
 * npm run pack:skill: zips the skill for upload to Claude Desktop, with SKILL.md's folder at the
 * top of the archive. Output: dist-skill/servicenow-troubleshooting.zip (git-ignored).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.OUT_DIR ?? join(ROOT, 'dist-skill');
const zip = join(out, 'servicenow-troubleshooting.zip');

mkdirSync(out, { recursive: true });
rmSync(zip, { force: true });
execFileSync('zip', ['-q', '-r', '-X', zip, 'servicenow-troubleshooting', '-x', '*.DS_Store'], {
  cwd: join(ROOT, 'skills'),
  stdio: 'inherit',
});
console.log(`Wrote ${zip}`);
