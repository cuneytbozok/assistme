/**
 * npm run setup: checks Node, builds everything, installs the native host, and prints the next
 * steps with this machine's paths. Safe to run again. `--skip-build` skips the build (tests).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MINIMUM_NODE = 22;

const major = Number.parseInt(process.versions.node, 10);
if (major < MINIMUM_NODE) {
  console.error(`sn-mcp needs Node ${MINIMUM_NODE} or newer; this is ${process.version}.`);
  process.exit(1);
}
if (process.platform !== 'darwin') {
  console.error('sn-mcp setup supports macOS only for now.');
  process.exit(1);
}

if (!process.argv.includes('--skip-build')) {
  console.log('Building…');
  try {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    console.error('The build failed. Did you run npm install?');
    process.exit(1);
  }
}

// Imported only now: the build creates these files.
const installer = join(ROOT, 'packages/server/dist/install/installer.js');
const { applyInstall, defaultInstallPaths, InstallError, planInstall } = await import(installer);

const hostScript = join(ROOT, 'packages/server/dist/bin/native-host.js');
const uid = process.getuid?.() as number;
try {
  const plan = planInstall(defaultInstallPaths(hostScript), uid);
  applyInstall(plan);
  console.log(`Native host installed:\n  ${plan.manifestPath}\n  ${plan.wrapperPath}`);
} catch (e) {
  if (e instanceof InstallError) {
    console.error(`Refusing to install: ${(e as Error).message}`);
    process.exit(1);
  }
  throw e;
}

const extensionId = readFileSync(join(ROOT, 'packages/extension/EXTENSION_ID'), 'utf8').trim();
const server = join(ROOT, 'packages/server/dist/bin/mcp-server.js');
console.log(`
Next steps (details in docs/INSTALL.md):

1. Chrome extension: open chrome://extensions, turn on Developer mode, click Load unpacked and
   choose:
     ${join(ROOT, 'packages/extension/dist')}
   The ID must be ${extensionId}.
   Already loaded? Press its reload icon.

2. Register your instance in the extension popup.

3. Connect Claude.
   Claude Desktop: run "npm run pack:mcpb", then Settings → Extensions → Advanced →
   Install Extension, and choose:
     ${join(ROOT, 'packages/server/sn-mcp.mcpb')}
   Claude Code:
     claude mcp add --scope user sn-mcp --env SN_MCP_CLIENT_NAME="Claude Code" -- node "${server}"
`);
