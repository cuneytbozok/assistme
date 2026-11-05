/**
 * npm run setup: checks Node, builds everything, installs the native host, and prints the next
 * steps with this machine's paths. Runs TypeScript directly, which needs Node 22.18 or newer. Safe to run again. `--skip-build` skips the build (tests).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MINIMUM_NODE = 22;

const major = Number.parseInt(process.versions.node, 10);
if (major < MINIMUM_NODE) {
  console.error(`sn-mcp needs Node ${MINIMUM_NODE} or newer; this is ${process.version}.`);
  process.exit(1);
}
if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.error('sn-mcp setup supports macOS and Windows.');
  process.exit(1);
}

if (!process.argv.includes('--skip-build')) {
  console.log('Building…');
  try {
    // On Windows npm is a .cmd, which only a shell can start. The command is fixed text.
    execFileSync('npm', ['run', 'build'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    });
  } catch {
    console.error('The build failed. Did you run npm install?');
    process.exit(1);
  }
}

// Imported only now: the build creates these files.
// As a URL: import() refuses a Windows path, reading "C:" as a URL scheme.
const built = (file: string) => import(pathToFileURL(join(ROOT, file)).href);
const { applyInstall, defaultInstallPaths, InstallError, planInstall } = await built(
  'packages/server/dist/install/installer.js',
);
const { currentUid } = await built('packages/server/dist/native-host/auth.js');

const hostScript = join(ROOT, 'packages/server/dist/bin/native-host.js');
const uid = currentUid();
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
const {
  chatGptDesktopConfig,
  mistralVibeConfig,
  renderConfigToml,
  renderStdioForm,
  renderVibeConfigToml,
} = await built('packages/server/dist/install/client-config.js');
const chatgpt = chatGptDesktopConfig(ROOT);
const vibe = mistralVibeConfig(ROOT);
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

4. Or connect ChatGPT Desktop, for use in its Codex chats (normal chats don't use local
   servers): Settings → MCP servers → add a server, with these values:

${renderStdioForm(chatgpt)
  .split('\n')
  .map((line: string) => `     ${line}`)
  .join('\n')}

   Or add this to ~/.codex/config.toml, which also sets longer timeouts:

${renderConfigToml(chatgpt)
  .trimEnd()
  .split('\n')
  .map((line: string) => `     ${line}`)
  .join('\n')}

5. Or connect Mistral Vibe: add this to the end of ~/.vibe/config.toml, then start a new session.
   Already added? Replace the old sn-mcp block. If the file has a "mcp_servers = []" line, delete it.

${renderVibeConfigToml(vibe)
  .trimEnd()
  .split('\n')
  .map((line: string) => `     ${line}`)
  .join('\n')}
`);
