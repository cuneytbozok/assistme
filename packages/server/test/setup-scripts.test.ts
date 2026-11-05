/**
 * T-037: setup and uninstall under a throwaway HOME, so they never touch the real install.
 * Uses the built server code (`npm test` builds first).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeIsSupported, uninstallAll } from '../src/install/installer.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sn-setup-')));
  expect(home).not.toBe(realpathSync(homedir()));
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

const appSupport = () => join(home, 'Library/Application Support');
const manifest = () =>
  join(appSupport(), 'Google/Chrome/NativeMessagingHosts/com.snmcp.bridge.json');
const runtime = () => join(appSupport(), 'sn-mcp');
const run = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, [join(REPO, 'scripts', script), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home },
    encoding: 'utf8',
  });

/** Every file under HOME, relative to it. */
function listing(): string[] {
  return (readdirSync(home, { recursive: true }) as string[]).sort();
}

describe('T-037 setup and uninstall', () => {
  it('setup is idempotent; uninstall leaves no files; setup works again', () => {
    const first = run('setup.ts', '--skip-build');
    expect(first).toContain('Native host installed');
    expect(first).toContain('Load unpacked');
    expect(first).toContain(
      readFileSync(join(REPO, 'packages/extension/EXTENSION_ID'), 'utf8').trim(),
    );
    expect(first).toContain('claude mcp add');
    expect(first).toContain('[[mcp_servers]]');
    expect(first).toContain('Install Extension');
    const before = readFileSync(manifest(), 'utf8');
    const files = listing();

    run('setup.ts', '--skip-build');
    expect(readFileSync(manifest(), 'utf8')).toBe(before);
    expect(listing()).toEqual(files);
    expect(JSON.parse(before).allowed_origins).toHaveLength(1);

    const out = run('uninstall.ts');
    expect(out).toContain('Removed');
    expect(out).toContain('chrome://extensions');
    expect(existsSync(manifest())).toBe(false);
    expect(existsSync(runtime())).toBe(false);
    // Only the empty parent folders remain, and no file.
    const left = listing().filter((f) => /\.\w+$/.test(f) || f.includes('sn-mcp'));
    expect(left).toEqual([]);

    expect(run('uninstall.ts')).toContain('Nothing to remove');
    run('setup.ts', '--skip-build');
    expect(readFileSync(manifest(), 'utf8')).toBe(before);
  });

  it('removes the socket, key and logs, and stops a running host', async () => {
    run('setup.ts', '--skip-build');
    for (const f of ['broker.sock', 'broker.key', 'broker.log', 'broker.capture.jsonl']) {
      writeFileSync(join(runtime(), f), 'x');
    }
    const host = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '/x/dist/bin/native-host.js'],
      {
        stdio: 'ignore',
      },
    );
    children.push(host);
    await new Promise((f) => setTimeout(f, 200));
    writeFileSync(join(runtime(), 'broker.pid'), String(host.pid));
    const exited = new Promise((f) => host.once('exit', f));
    expect(run('uninstall.ts')).toContain('Stopped the native host');
    await exited;
    expect(existsSync(runtime())).toBe(false);
  });

  it('a stale lock naming another process never signals it', async () => {
    run('setup.ts', '--skip-build');
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(other);
    await new Promise((f) => setTimeout(f, 200));
    writeFileSync(join(runtime(), 'broker.pid'), String(other.pid));
    expect(run('uninstall.ts')).not.toContain('Stopped');
    await new Promise((f) => setTimeout(f, 200));
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
  });

  it('only signals our own host: not an unrelated process, nor one with a similar name', async () => {
    const paths = { installDir: join(home, 'x'), manifestDir: join(home, 'y') };
    for (const arg of ['unrelated', '/Applications/Claude.app/Helpers/chrome-native-host']) {
      const dir = join(home, arg.length > 10 ? 'a' : 'b', 'sn-mcp');
      mkdirSync(dir, { recursive: true });
      const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', arg], {
        stdio: 'ignore',
      });
      children.push(other);
      await new Promise((f) => setTimeout(f, 200));
      writeFileSync(join(dir, 'broker.pid'), String(other.pid));
      const r = await uninstallAll(paths, dir);
      expect(r.stoppedHost, arg).toBe(false);
      await new Promise((f) => setTimeout(f, 100));
      expect(other.signalCode, arg).toBeNull();
    }
  });

  it('uninstallAll refuses anything but an sn-mcp folder, and never follows a symlink', async () => {
    const paths = { installDir: join(home, 'x'), manifestDir: join(home, 'y') };
    const keep = join(home, 'precious');
    mkdirSync(keep);
    writeFileSync(join(keep, 'file'), 'keep me');
    await expect(uninstallAll(paths, keep)).rejects.toThrow(/not an sn-mcp folder/);
    expect(existsSync(join(keep, 'file'))).toBe(true);

    mkdirSync(join(home, 'parent'));
    const link = join(home, 'parent/sn-mcp');
    symlinkSync(keep, link);
    await uninstallAll(paths, link);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(keep, 'file'), 'utf8')).toBe('keep me');
  });

  it('checks the Node version', () => {
    expect(nodeIsSupported('v24.21.0')).toBe(true);
    expect(nodeIsSupported('v22.0.0')).toBe(true);
    expect(nodeIsSupported('v20.19.0')).toBe(false);
    expect(nodeIsSupported('nonsense')).toBe(false);
  });
});

describe('docs/INSTALL.md', () => {
  const doc = readFileSync(join(REPO, 'docs/INSTALL.md'), 'utf8');

  it('covers every step and the required troubleshooting', () => {
    for (const text of [
      'npm run setup',
      'Load unpacked',
      'clipfeocpiljpcngmjpdbegciimchbol',
      'claude mcp add',
      'npm run pack:mcpb',
      'npm run uninstall',
      'BROKER_CONFLICT',
      'SESSION_EXPIRED',
      'broker.log',
      'host is not found',
    ]) {
      expect(doc, text).toContain(text);
    }
  });

  it('names only scripts that exist, here and in the README and next steps', () => {
    const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts;
    for (const file of ['docs/INSTALL.md', 'README.md', 'docs/NEXT_STEPS.md']) {
      const text = readFileSync(join(REPO, file), 'utf8');
      for (const [, name] of text.matchAll(/npm run ([a-z:0-9-]+)/g)) {
        expect(scripts, `${file}: ${name}`).toHaveProperty(name as string);
      }
    }
  });

  it('the README covers a first-time user, and says this is not a ServiceNow product', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
    for (const text of [
      'npm run setup',
      'Load unpacked',
      'clipfeocpiljpcngmjpdbegciimchbol',
      'approval code',
      'Read-only',
      'not affiliated',
      'docs/INSTALL.md',
    ]) {
      expect(readme, text).toContain(text);
    }
  });
});
