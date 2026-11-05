/**
 * What Windows needs in place of POSIX modes and Unix sockets (ADR-015). Pure functions are tested
 * on every platform; the ones that call Windows tools only run in the Windows CI job.
 *
 * Tools are called by full path, with no shell, and paths travel in an env var, never in a script.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { NATIVE_HOST_NAME } from '@sn-mcp/shared';

export const isWindows = (platform: NodeJS.Platform = process.platform) => platform === 'win32';

/** From the home folder, not %LOCALAPPDATA%: Chrome and each AI client must agree on it. */
export function windowsRuntimeDir(home: string): string {
  return win32.join(home, 'AppData', 'Local', 'sn-mcp');
}

/** Pipes have no folder to protect them, so the name comes from the (per-user) runtime folder. */
export function pipeName(dir: string): string {
  const id = createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\sn-mcp-${id}`;
}

function systemTool(...parts: string[]): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
}

function run(tool: string, args: string[], env?: Record<string, string>): string {
  return execFileSync(tool, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

export function parseWhoamiSid(output: string): string {
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(output.trim())?.[1];
  if (!sid) throw new Error('could not read the current user SID');
  return sid;
}

export function currentUserSid(): string {
  return parseWhoamiSid(run(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']));
}

/** Only this user may use the folder and what's in it: the job of 0700 on macOS. */
export function restrictToCurrentUser(dir: string): void {
  run(systemTool('icacls.exe'), [
    dir,
    '/inheritance:r',
    '/grant:r',
    `*${currentUserSid()}:(OI)(CI)F`,
    '/q',
  ]);
}

export interface PathAcl {
  path: string;
  owner: string;
  aces: { sid: string; allow: boolean; rights: number; inheritOnly: boolean }[];
}

const SYSTEM_SIDS = new Set([
  'S-1-5-18', // SYSTEM
  'S-1-5-32-544', // Administrators, which can already become SYSTEM
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', // TrustedInstaller
]);

/** Rights that let someone replace what's in a folder, or give themselves that right. */
const WRITE_RIGHTS =
  0x2 | // create files
  0x4 | // create folders
  0x40 | // delete children
  0x10000 | // delete
  0x40000 | // change permissions
  0x80000 | // take ownership
  0x10000000 | // generic all
  0x40000000; // generic write

/** Why another user could change this path, or undefined. The same rule as ancestors on macOS. */
export function aclProblem(acl: PathAcl, userSid: string): string | undefined {
  const trusted = (sid: string) => sid === userSid || SYSTEM_SIDS.has(sid);
  if (!trusted(acl.owner)) return `${acl.path} is owned by another user (${acl.owner})`;
  for (const ace of acl.aces) {
    if (!ace.allow || ace.inheritOnly || trusted(ace.sid)) continue;
    if ((ace.rights >>> 0) & WRITE_RIGHTS) {
      return `${acl.path} can be written by another user or group (${ace.sid})`;
    }
  }
  return undefined;
}

const READ_ACLS = `
$rows = foreach ($p in ($env:SN_MCP_ACL_PATHS | ConvertFrom-Json)) {
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $acl = Get-Acl -LiteralPath $p
  $sid = [System.Security.Principal.SecurityIdentifier]
  [pscustomobject]@{
    path = $p
    owner = $acl.GetOwner($sid).Value
    aces = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {
      [pscustomobject]@{
        sid = $_.IdentityReference.Value
        allow = $_.AccessControlType -eq 'Allow'
        rights = [int]$_.FileSystemRights
        inheritOnly = ($_.PropagationFlags -band 2) -ne 0
      }
    })
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
`;

export function readAcls(paths: string[]): PathAcl[] {
  const out = run(
    systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', READ_ACLS],
    { SN_MCP_ACL_PATHS: JSON.stringify(paths) },
  );
  return JSON.parse(out) as PathAcl[];
}

/** Every folder above `path`, without the drive root: on C:\ anyone may create new folders. */
export function ancestorsBelowRoot(path: string): string[] {
  const root = win32.parse(path).root;
  const out: string[] = [];
  for (let d = win32.dirname(path); d !== root && d !== win32.dirname(d); d = win32.dirname(d)) {
    out.push(d);
  }
  return out;
}

const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

/** How Chrome finds a native host on Windows: this key's default value is the manifest's path. */
export function registerHostArgs(manifestPath: string): string[] {
  return ['add', REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}

export function registerHost(manifestPath: string): void {
  run(systemTool('reg.exe'), registerHostArgs(manifestPath));
}

export function unregisterHost(): boolean {
  try {
    run(systemTool('reg.exe'), ['delete', REGISTRY_KEY, '/f']);
    return true;
  } catch {
    return false; // wasn't registered
  }
}

/**
 * What Chrome starts. `%` is the one character still special inside quotes in a batch file, and
 * CR or LF would end the command, so they're refused rather than escaped.
 */
export function renderCmdWrapper(nodePath: string, hostScript: string, capture = false): string {
  for (const p of [nodePath, hostScript]) {
    if (/[\r\n"]/.test(p)) throw new Error(`Unsupported character in path: ${p}`);
  }
  const quote = (p: string) => `"${p.replace(/%/g, '%%')}"`;
  return [
    '@echo off',
    'rem sn-mcp native messaging host (generated by install-native-host)',
    ...(capture
      ? [
          'rem DEV ONLY: broker traffic capture (T-009). Reinstall without --capture to disable.',
          'set "SN_MCP_CAPTURE=metadata+bodies-redacted"',
        ]
      : []),
    `${quote(nodePath)} ${quote(hostScript)} %*`,
    '',
  ].join('\r\n');
}

export function processCommandLine(pid: number): string {
  return run(systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`,
  ]);
}
