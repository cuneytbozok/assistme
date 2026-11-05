/**
 * npm run uninstall: stops the native host and removes its Chrome manifest and the sn-mcp folder
 * (program files, socket, key, logs). Lists what only the user can remove. Safe to run again.
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(ROOT, 'packages/server/dist/install/installer.js');
const { defaultInstallPaths, uninstallAll } = await import(installer).catch(() => {
  console.error('The project is not built. Run: npm run build');
  process.exit(1);
});

const paths = defaultInstallPaths(join(ROOT, 'packages/server/dist/bin/native-host.js'));
const runtimeDir = join(homedir(), 'Library', 'Application Support', 'sn-mcp');
const { removed, stoppedHost } = await uninstallAll(paths, runtimeDir);

if (stoppedHost) console.log('Stopped the native host.');
console.log(removed.length > 0 ? `Removed:\n  ${removed.join('\n  ')}` : 'Nothing to remove.');
console.log(`
Only you can remove these:
- The extension: chrome://extensions → sn-mcp → Remove.
- Claude Desktop: Settings → Extensions → remove sn-mcp (or its entry in
  claude_desktop_config.json).
- Claude Code: claude mcp remove sn-mcp`);
