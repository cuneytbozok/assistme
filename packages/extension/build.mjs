/**
 * Builds the unpacked extension into dist/ (load this folder in chrome://extensions).
 *   node build.mjs
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    background: join(root, 'src/background/index.ts'),
    popup: join(root, 'src/popup/popup.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  sourcemap: 'linked',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});

for (const [from, to] of [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
]) {
  copyFileSync(join(root, from), join(out, to));
}
console.log(`Built unpacked extension in ${out}`);
