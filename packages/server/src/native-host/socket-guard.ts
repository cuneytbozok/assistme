/**
 * Runtime directory, socket and pid-lock checks (ARCHITECTURE §4.2).
 *
 * Every check uses lstat, so symlinks are rejected rather than followed. Ownership must be the
 * current uid and modes must be exact; otherwise startup is refused (BrokerStartError).
 * Windows has no uid or mode: symlinks are still rejected, and the folder's ACL is set (ADR-015).
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isWindows, pipeName, restrictToCurrentUser, windowsRuntimeDir } from './windows.js';

export const SOCKET_FILE = 'broker.sock';
export const LOCK_FILE = 'broker.pid';
export const LOG_FILE = 'broker.log';

export type StartErrorCode = 'UNSAFE_PATH' | 'BROKER_CONFLICT';

export class BrokerStartError extends Error {
  constructor(
    readonly code: StartErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Default runtime directory; `SN_MCP_RUNTIME_DIR` overrides it (tests). Checks still apply. */
export function defaultRuntimeDir(): string {
  if (process.env.SN_MCP_RUNTIME_DIR) return process.env.SN_MCP_RUNTIME_DIR;
  return isWindows()
    ? windowsRuntimeDir(homedir())
    : join(homedir(), 'Library', 'Application Support', 'sn-mcp');
}

/** Where the broker listens: a socket file, or on Windows a named pipe. */
export function brokerEndpoint(dir: string): string {
  return isWindows() ? pipeName(dir) : join(dir, SOCKET_FILE);
}

function modeOf(m: number): number {
  return m & 0o777;
}

function unsafe(message: string): never {
  throw new BrokerStartError('UNSAFE_PATH', message);
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Creates the directory with 0700 if missing; then verifies type, owner and exact mode. */
export function ensureRuntimeDir(dir: string, uid: number): void {
  if (!lstatOrUndefined(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) unsafe(`${dir} is a symlink`);
  if (!st.isDirectory()) unsafe(`${dir} is not a directory`);
  if (isWindows()) {
    try {
      restrictToCurrentUser(dir);
    } catch {
      unsafe(`could not restrict ${dir} to the current user`);
    }
    return;
  }
  if (st.uid !== uid) unsafe(`${dir} is owned by uid ${st.uid}, expected ${uid}`);
  if (modeOf(st.mode) !== 0o700) {
    unsafe(`${dir} has mode ${modeOf(st.mode).toString(8)}, expected 700`);
  }
}

export function checkRegularFile(path: string, mode: number, uid: number): void {
  const st = lstatOrUndefined(path);
  if (!st) throw new Error(`${path} does not exist`);
  if (st.isSymbolicLink()) unsafe(`${path} is a symlink`);
  if (!st.isFile()) unsafe(`${path} is not a regular file`);
  if (isWindows()) return; // protected by the runtime folder's ACL
  if (st.uid !== uid) unsafe(`${path} is owned by uid ${st.uid}, expected ${uid}`);
  if (modeOf(st.mode) !== mode) {
    unsafe(`${path} has mode ${modeOf(st.mode).toString(8)}, expected ${mode.toString(8)}`);
  }
}

/** Verifies an existing socket file: a socket (not a symlink), our uid, mode 0600. */
export function checkSocketFile(path: string, uid: number): void {
  if (isWindows()) return; // a pipe has no file: the mutual proof detects an impostor
  const st = lstatSync(path);
  if (st.isSymbolicLink()) unsafe(`${path} is a symlink`);
  if (!st.isSocket()) unsafe(`${path} is not a socket`);
  if (st.uid !== uid) unsafe(`${path} is owned by uid ${st.uid}, expected ${uid}`);
  if (modeOf(st.mode) !== 0o600) {
    unsafe(`${path} has mode ${modeOf(st.mode).toString(8)}, expected 600`);
  }
}

/** Resolves true if something accepts connections on the socket path. */
export function isSocketAlive(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the pid lock (O_EXCL). A lock of a dead process is stale and replaced once. */
export function acquireLock(dir: string, uid: number): () => void {
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      checkRegularFile(path, 0o600, uid);
      const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
        throw new BrokerStartError('BROKER_CONFLICT', `another broker (pid ${pid}) is running`);
      }
      unlinkSync(path); // stale
    }
  }
  throw new BrokerStartError('BROKER_CONFLICT', 'could not take the broker lock');
}

/**
 * Prepares the socket path: an existing socket must pass the checks; if it is alive another
 * broker owns it (conflict), otherwise it is stale and removed.
 */
export async function prepareSocketPath(dir: string, uid: number): Promise<string> {
  const path = brokerEndpoint(dir);
  if (isWindows()) {
    if (await isSocketAlive(path)) {
      throw new BrokerStartError('BROKER_CONFLICT', 'another broker is listening on the pipe');
    }
    return path;
  }
  if (lstatOrUndefined(path)) {
    checkSocketFile(path, uid);
    if (await isSocketAlive(path)) {
      throw new BrokerStartError('BROKER_CONFLICT', 'another broker is listening on the socket');
    }
    unlinkSync(path);
  }
  return path;
}
