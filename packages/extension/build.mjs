/**
 * Builds the unpacked extension (load the output folder in chrome://extensions).
 *   node build.mjs                     → dist/
 *   OUT_DIR=/some/dir node build.mjs   → custom output folder
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.OUT_DIR ?? join(root, 'dist'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entryPoints = {
  background: join(root, 'src/background/index.ts'),
  popup: join(root, 'src/popup/popup.ts'),
};

await build({
  entryPoints,
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  sourcemap: 'linked',
  minify: false,
  treeShaking: true,
  legalComments: 'none',
  logLevel: 'warning',
});

const files = [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ...[16, 32, 48, 128].map((n) => [`icons/icon${n}.png`, `icons/icon${n}.png`]),
];
mkdirSync(join(out, 'icons'), { recursive: true });
for (const [from, to] of files) copyFileSync(join(root, from), join(out, to));
console.log(`Built unpacked extension in ${out}`);
