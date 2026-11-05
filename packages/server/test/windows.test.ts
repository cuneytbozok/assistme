/**
 * T-044. The first part runs on every platform and only checks our own logic. The second needs real
 * Windows, and changes the registry and the home folder, so it runs only in the CI job.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ORIGIN } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { connectToBroker } from '../src/bridge/handshake.js';
import { assertSafeAncestors, InstallError } from '../src/install/installer.js';
import { encodeFrame } from '../src/native-host/framing.js';
import { defaultRuntimeDir } from '../src/native-host/socket-guard.js';
import {
  aclProblem,
  aclsProblem,
  ancestorsBelowRoot,
  currentUserSid,
  type PathAcl,
  parseWhoamiSid,
  pipeName,
  readAcls,
  registerHostArgs,
  renderCmdWrapper,
  restrictToCurrentUser,
  windowsRuntimeDir,
} from '../src/native-host/windows.js';
import { FrameReader, LABEL } from './helpers.js';

const USER = 'S-1-5-21-1-2-3-1001';
const acl = (aces: PathAcl['aces'], owner = USER): PathAcl => ({ path: 'C:\\x', owner, aces });
const ace = (sid: string, rights: number, allow = true, inheritOnly = false) => ({
  sid,
  allow,
  rights,
  inheritOnly,
});
const MODIFY = 0x1301bf;
const READ = 0x1200a9;
const USERS = 'S-1-5-32-545';

describe('T-044 Windows logic', () => {
  it('accepts a folder only this user, SYSTEM and administrators can change', () => {
    expect(
      aclProblem(
        acl([
          ace(USER, 0x1f01ff),
          ace('S-1-5-18', 0x1f01ff),
          ace('S-1-5-32-544', 0x1f01ff),
          ace(USERS, READ),
        ]),
        USER,
      ),
    ).toBeUndefined();
  });

  it('refuses a folder others can write to, as in any folder under C:\\ by default', () => {
    expect(aclProblem(acl([ace('S-1-5-11', MODIFY)]), USER)).toContain('can be written');
    expect(aclProblem(acl([ace('S-1-1-0', 0x40000)]), USER)).toContain('can be written');
    expect(aclProblem(acl([ace(USERS, 0x10000000)]), USER)).toContain('can be written');
    expect(aclProblem(acl([ace(USERS, 0x40000000)]), USER)).toContain('can be written');
    // PowerShell's int32: generic read and write, with the top bit making it negative.
    expect(aclProblem(acl([ace(USERS, 0xc0000000 | 0)]), USER)).toContain('can be written');
    expect(aclProblem(acl([ace(USERS, 0x80000000 | 0)]), USER)).toBeUndefined();
  });

  it('ignores deny rules, and rights that only apply to new children', () => {
    expect(aclProblem(acl([ace(USERS, MODIFY, false)]), USER)).toBeUndefined();
    expect(aclProblem(acl([ace('S-1-3-0', MODIFY, true, true)]), USER)).toBeUndefined();
  });

  it("refuses another user's folder", () => {
    expect(aclProblem(acl([], 'S-1-5-21-9-9-9-1002'), USER)).toContain('owned by another user');
  });

  it('treats a folder it could not read as a problem, never as safe', () => {
    const dirs = ['C:\\a', 'C:\\a\\b'];
    const row = (path: string) => ({ ...acl([ace(USER, MODIFY)]), path });
    expect(aclsProblem(dirs, [], USER)).toContain('Could not read');
    expect(aclsProblem(dirs, [row('C:\\a')], USER)).toContain('C:\\a\\b');
    expect(aclsProblem(dirs, [row('C:\\a'), row('C:\\a\\b')], USER)).toBeUndefined();
    expect(aclsProblem([], [], USER)).toBeUndefined();
  });

  it('checks each folder above a path, and not the drive root', () => {
    expect(ancestorsBelowRoot('C:\\Users\\me\\a.js')).toEqual(['C:\\Users\\me', 'C:\\Users']);
    expect(ancestorsBelowRoot('C:\\a.js')).toEqual([]);
  });

  it('names the pipe after the runtime folder, ignoring case as Windows does', () => {
    const a = pipeName('C:\\Users\\me\\AppData\\Local\\sn-mcp');
    expect(a).toMatch(/^\\\\\.\\pipe\\sn-mcp-[0-9a-f]{32}$/);
    expect(pipeName('c:\\users\\ME\\appdata\\local\\sn-mcp')).toBe(a);
    expect(pipeName('C:\\Users\\other\\AppData\\Local\\sn-mcp')).not.toBe(a);
  });

  it('keeps runtime files in the per-user local folder', () => {
    expect(windowsRuntimeDir('C:\\Users\\me')).toBe('C:\\Users\\me\\AppData\\Local\\sn-mcp');
  });

  it('writes a wrapper Chrome can start, with paths safe in a batch file', () => {
    const w = renderCmdWrapper('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a%b\\host.js');
    expect(w.startsWith('@echo off\r\n')).toBe(true);
    expect(w).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a%%b\\host.js" %*\r\n');
    expect(w).not.toContain('SN_MCP_CAPTURE');
    expect(renderCmdWrapper('C:\\n.exe', 'C:\\h.js', true)).toContain('SN_MCP_CAPTURE');
    expect(() => renderCmdWrapper('C:\\n"&calc&".exe', 'C:\\h.js')).toThrow('Unsupported');
    expect(() => renderCmdWrapper('C:\\n.exe', 'C:\\h\r\ncalc.js')).toThrow('Unsupported');
  });

  it('registers the host only for this user', () => {
    const args = registerHostArgs('C:\\m.json');
    expect(args[1]).toBe('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.snmcp.bridge');
    expect(args.slice(2)).toEqual(['/ve', '/t', 'REG_SZ', '/d', 'C:\\m.json', '/f']);
  });

  it('reads the SID from whoami, whatever the language', () => {
    expect(parseWhoamiSid('"PC\\kullanıcı","S-1-5-21-1-2-3-1001"\r\n')).toBe(USER);
    expect(() => parseWhoamiSid('nonsense')).toThrow();
  });

  it('allows Windows in the Desktop bundle', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../mcpb/manifest.json', import.meta.url), 'utf8'),
    );
    expect(manifest.compatibility.platforms).toEqual(['darwin', 'win32']);
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOT_LIKE = ['S-1-5-18', 'S-1-5-32-544']; // SYSTEM and Administrators
const realWindows = process.platform === 'win32' && process.env.CI === 'true';

describe.runIf(realWindows)('T-044 on real Windows (CI only)', () => {
  const script = (name: string, ...args: string[]) =>
    execFileSync(process.execPath, [join(ROOT, 'scripts', name), ...args], { encoding: 'utf8' });
  const manifestPath = join(windowsRuntimeDir(homedir()), 'host', 'com.snmcp.bridge.json');
  const key = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.snmcp.bridge';

  it('setup, host start through the registered wrapper, handshake, uninstall', async () => {
    expect(script('setup.ts', '--skip-build')).toContain('Native host installed');

    // Chrome's own lookup: registry → manifest → wrapper.
    const registered = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8' });
    expect(registered).toContain(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.allowed_origins).toEqual([EXTENSION_ORIGIN]);
    expect(manifest.path.endsWith('native-host.cmd')).toBe(true);

    const host = spawn('cmd.exe', ['/d', '/s', '/c', `"${manifest.path}" ${EXTENSION_ORIGIN}`], {
      windowsVerbatimArguments: true,
    });
    const reader = new FrameReader();
    host.stdout.on('data', (c: Buffer) => reader.feed(c));
    expect(await reader.next((m) => m.kind === 'broker.status', 20_000)).toMatchObject({
      state: 'ready',
    });

    // Only this user can use the folder that holds the key.
    const dir = defaultRuntimeDir();
    const [folder] = readAcls([dir]);
    const sid = currentUserSid();
    console.log('runtime folder ACL', execFileSync('icacls', [dir], { encoding: 'utf8' }));
    expect(new Set(folder?.aces.map((a) => a.sid))).toEqual(new Set([sid, ...ROOT_LIKE]));
    expect(aclProblem(folder as PathAcl, sid)).toBeUndefined();

    // The MCP server's real handshake, over the real pipe.
    const conn = await connectToBroker(dir, { clientKey: randomBytes(16), label: LABEL });
    const got = new Promise<unknown>((resolve) => conn.onMessage(resolve));
    conn.send({ v: 1, id: 'c1', kind: 'registry.get' });
    const forwarded = await reader.next((m) => m.kind === 'forward', 10_000);
    const id = (forwarded.request as { id: string }).id;
    host.stdin.write(
      encodeFrame({
        v: 1,
        kind: 'response',
        id,
        ok: true,
        result: { type: 'registry.get', instances: [] },
      }),
    );
    expect(await got).toMatchObject({ kind: 'response', id: 'c1', ok: true });
    conn.close();

    // Chrome closing stdin ends the host and removes the key.
    const exited = new Promise((resolve) => host.once('exit', resolve));
    host.stdin.end();
    await exited;
    for (let i = 0; i < 40 && existsSync(join(dir, 'broker.key')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(join(dir, 'broker.key'))).toBe(false);

    script('uninstall.ts');
    expect(existsSync(dir)).toBe(false);
    expect(() => execFileSync('reg', ['query', key], { stdio: 'pipe' })).toThrow();
  }, 120_000);

  it('restricting a folder removes what others could already read', () => {
    const open = join(homedir(), `sn-mcp-open-${process.pid}`);
    mkdirSync(open);
    try {
      execFileSync('icacls', [open, '/grant', '*S-1-5-32-545:(OI)(CI)RX'], { stdio: 'pipe' });
      restrictToCurrentUser(open);
      console.log('restricted folder ACL', execFileSync('icacls', [open], { encoding: 'utf8' }));
      const sids = readAcls([open])[0]?.aces.map((a) => a.sid) ?? [];
      expect(sids).toContain(currentUserSid());
      expect(sids).not.toContain('S-1-5-32-545');
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a folder other users can write to, and accepts the home folder', () => {
    const shared = join(homedir(), `sn-mcp-shared-${process.pid}`);
    mkdirSync(shared);
    try {
      expect(() => assertSafeAncestors(join(shared, 'host.js'), -1)).not.toThrow();
      execFileSync('icacls', [shared, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { stdio: 'pipe' });
      expect(() => assertSafeAncestors(join(shared, 'host.js'), -1)).toThrow(InstallError);
      expect(() => assertSafeAncestors(join(shared, 'host.js'), -1)).toThrow('can be written');
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  }, 60_000);
});
