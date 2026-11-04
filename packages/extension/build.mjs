/**
 * Builds the unpacked extension (load the output folder in chrome://extensions).
 *   node build.mjs                       → dist/           (release: no diagnostics)
 *   DEV_DIAGNOSTICS=1 node build.mjs     → dist/ with the T-005 session diagnostics page
 *   OUT_DIR=/some/dir node build.mjs     → custom output folder (used by tests)
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.OUT_DIR ?? join(root, 'dist'));
const diagnostics = process.env.DEV_DIAGNOSTICS === '1';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entryPoints = {
  background: join(root, 'src/background/index.ts'),
  popup: join(root, 'src/popup/popup.ts'),
};
if (diagnostics) entryPoints.diagnostics = join(root, 'src/diagnostics/diagnostics.ts');

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
  define: { __DEV_DIAGNOSTICS__: diagnostics ? 'true' : 'false' },
  legalComments: 'none',
  logLevel: 'warning',
});

const files = [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
];
if (diagnostics) files.push(['src/diagnostics/diagnostics.html', 'diagnostics.html']);
for (const [from, to] of files) copyFileSync(join(root, from), join(out, to));
console.log(`Built unpacked extension in ${out}${diagnostics ? ' (with DEV diagnostics)' : ''}`);
