/**
 * npm run codex-skills: copies this project's skills to ~/.agents/skills, where Codex and Codex
 * chats in ChatGPT Desktop find them. `-- --uninstall` removes them. Safe to run again. They add
 * no tools and no access.
 *
 * A folder with the same name is replaced only if it holds the skill of that name: other skills in
 * that folder are the user's.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../plugin/skills');
const TARGET = join(homedir(), '.agents', 'skills');
const uninstall = process.argv.includes('--uninstall');

const isSkillNamed = (dir: string, name: string): boolean => {
  try {
    return new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(
      readFileSync(join(dir, 'SKILL.md'), 'utf8'),
    );
  } catch {
    return false;
  }
};

const skills = readdirSync(SOURCE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const name of skills) {
  const dest = join(TARGET, name);
  if (existsSync(dest) && !isSkillNamed(dest, name)) {
    console.error(`Refusing to change ${dest}: it isn't the ${name} skill. Nothing was changed.`);
    process.exit(1);
  }
}

for (const name of skills) {
  const dest = join(TARGET, name);
  if (uninstall) {
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      console.log(`Removed ${dest}`);
    }
    continue;
  }
  mkdirSync(TARGET, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(SOURCE, name), dest, {
    recursive: true,
    filter: (p) => !['.DS_Store', '__pycache__'].includes(basename(p)),
  });
  console.log(`Installed ${dest}`);
}
if (!uninstall) console.log('\nStart a new Codex chat to use them. Normal chats do not use them.');
