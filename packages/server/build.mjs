/**
 * Builds the `.mcpb` staging folder: the manifest plus the MCP server as one bundled file.
 *   node build.mjs              → mcpb-build/
 *   OUT_DIR=/some/dir node …    → custom folder
 *
 * The native host isn't in the bundle: Chrome launches it separately (`npm run setup`).
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.OUT_DIR ?? join(root, 'mcpb-build'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'server'), { recursive: true });
copyFileSync(join(root, 'mcpb/manifest.json'), join(out, 'manifest.json'));

await build({
  entryPoints: [join(root, 'src/bin/mcp-server.ts')],
  outfile: join(out, 'server/index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Some dependencies are CommonJS and call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`Built the .mcpb folder in ${out}`);
