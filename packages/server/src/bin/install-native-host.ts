#!/usr/bin/env node
/**
 *   npm run install-native-host -- [--dry-run] [--uninstall] [--node /abs/path/to/node]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyInstall,
  defaultInstallPaths,
  InstallError,
  planInstall,
  uninstall,
} from '../install/installer.js';
import { currentUid } from '../native-host/auth.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const nodeIdx = args.indexOf('--node');
const nodePath = nodeIdx >= 0 ? args[nodeIdx + 1] : undefined;

const hostScript = join(dirname(fileURLToPath(import.meta.url)), 'native-host.js');
const paths = defaultInstallPaths(hostScript, nodePath ?? process.execPath);

try {
  if (flag('--uninstall')) {
    const removed = flag('--dry-run') ? [] : uninstall(paths);
    console.log(
      flag('--dry-run')
        ? 'Dry run: would remove the manifest and wrapper.'
        : `Removed: ${removed.join(', ') || 'nothing'}`,
    );
    process.exit(0);
  }
  const plan = planInstall(paths, currentUid());
  console.log(`Wrapper:  ${plan.wrapperPath}\n${plan.wrapperContent}`);
  console.log(`Manifest: ${plan.manifestPath}\n${JSON.stringify(plan.manifest, null, 2)}`);
  if (flag('--dry-run')) {
    console.log('\nDry run: nothing written.');
  } else {
    applyInstall(plan);
    console.log('\nInstalled. Reload the extension on chrome://extensions to connect.');
  }
} catch (e) {
  console.error(e instanceof InstallError ? `Refusing to install: ${e.message}` : String(e));
  process.exit(1);
}
