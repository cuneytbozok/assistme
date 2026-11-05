/**
 * npm run uninstall: stops the native host and removes its Chrome manifest and the sn-mcp folder
 * (program files, socket, key, logs). Lists what only the user can remove. Safe to run again.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = (file: string) =>
  import(pathToFileURL(join(ROOT, file)).href).catch(() => {
    console.error('The project is not built. Run: npm run build');
    process.exit(1);
  });
const { defaultInstallPaths, uninstallAll } = await built(
  'packages/server/dist/install/installer.js',
);
const { defaultRuntimeDir } = await built('packages/server/dist/native-host/socket-guard.js');

const paths = defaultInstallPaths(join(ROOT, 'packages/server/dist/bin/native-host.js'));
const { removed, stoppedHost } = await uninstallAll(paths, defaultRuntimeDir());

if (stoppedHost) console.log('Stopped the native host.');
console.log(removed.length > 0 ? `Removed:\n  ${removed.join('\n  ')}` : 'Nothing to remove.');
console.log(`
Only you can remove these:
- The extension: chrome://extensions → sn-mcp → Remove.
- Claude Desktop: Settings → Extensions → remove sn-mcp (or its entry in
  claude_desktop_config.json).
- Claude Code: claude mcp remove sn-mcp
- ChatGPT Desktop: Settings → MCP servers → remove sn-mcp.`);
