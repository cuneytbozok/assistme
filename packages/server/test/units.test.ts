import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthFailureLimiter,
  brokerProof,
  clientKeyId,
  clientProof,
  KEY_FILE,
  newNonce,
  proofsEqual,
  readBrokerKey,
  removeBrokerKey,
  writeBrokerKey,
} from '../src/native-host/auth.js';
import { encodeFrame, FrameDecoder, FrameError } from '../src/native-host/framing.js';
import { formatLogLine } from '../src/native-host/logger.js';
import {
  acquireLock,
  BrokerStartError,
  checkSocketFile,
  ensureRuntimeDir,
  LOCK_FILE,
  prepareSocketPath,
  SOCKET_FILE,
} from '../src/native-host/socket-guard.js';
import { makeTempDir } from './helpers.js';

const uid = process.getuid?.() as number;
const temps: (() => void)[] = [];
const temp = () => {
  const t = makeTempDir();
  temps.push(t.cleanup);
  return t.dir;
};
afterEach(() => {
  for (const c of temps.splice(0)) c();
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof BrokerStartError ? e.code : 'OTHER';
  }
  return undefined;
};

describe('framing', () => {
  it('round-trips frames split across arbitrary chunk boundaries', () => {
    const a = encodeFrame({ kind: 'a', n: 1 });
    const b = encodeFrame({ kind: 'b', s: 'ü€😀' });
    const all = Buffer.concat([a, b]);
    const d = new FrameDecoder(1024);
    const out: unknown[] = [];
    for (let i = 0; i < all.length; i += 3) out.push(...d.push(all.subarray(i, i + 3)));
    expect(out).toEqual([
      { kind: 'a', n: 1 },
      { kind: 'b', s: 'ü€😀' },
    ]);
    expect(d.pendingBytes).toBe(0);
  });

  it('uses a 4-byte little-endian length header', () => {
    const f = encodeFrame({});
    expect(f.readUInt32LE(0)).toBe(2);
    expect(f.subarray(4).toString()).toBe('{}');
  });

  it('rejects oversized frames from the header alone, and invalid JSON', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(2048, 0);
    expect(() => new FrameDecoder(1024).push(header)).toThrow(FrameError);
    const bad = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('{x}')]);
    expect(() => new FrameDecoder(1024).push(bad)).toThrow(/JSON/);
    expect(() => encodeFrame({ s: 'x'.repeat(100) }, 50)).toThrow(FrameError);
  });
});

describe('auth', () => {
  it('broker and client proofs are role-bound and nonce-bound', () => {
    const key = Buffer.alloc(32, 7);
    const cn = newNonce();
    const bn = newNonce();
    expect(cn).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(brokerProof(key, cn)).not.toBe(clientProof(key, bn, cn));
    expect(proofsEqual(brokerProof(key, cn), brokerProof(key, cn))).toBe(true);
    expect(proofsEqual(brokerProof(key, cn), brokerProof(Buffer.alloc(32, 8), cn))).toBe(false);
    expect(proofsEqual(clientProof(key, bn, cn), clientProof(key, newNonce(), cn))).toBe(false);
    expect(proofsEqual('abc', 'abc')).toBe(false); // wrong length never matches
    expect(clientKeyId(Buffer.alloc(16, 1))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the key atomically with mode 0600, rotates it, and removes only its own key', () => {
    const dir = temp();
    ensureRuntimeDir(dir, uid);
    const k1 = writeBrokerKey(dir);
    expect(lstatSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(readBrokerKey(dir, uid).equals(k1)).toBe(true);
    const k2 = writeBrokerKey(dir);
    expect(k2.equals(k1)).toBe(false);
    removeBrokerKey(dir, k1); // not ours any more → kept
    expect(existsSync(join(dir, KEY_FILE))).toBe(true);
    removeBrokerKey(dir, k2);
    expect(existsSync(join(dir, KEY_FILE))).toBe(false);
  });

  it('refuses to read a key with a wider mode, a symlinked key, or a foreign owner', () => {
    const dir = temp();
    ensureRuntimeDir(dir, uid);
    writeBrokerKey(dir);
    chmodSync(join(dir, KEY_FILE), 0o644);
    expect(() => readBrokerKey(dir, uid)).toThrow(/mode 644/);
    chmodSync(join(dir, KEY_FILE), 0o600);
    expect(() => readBrokerKey(dir, uid + 1)).toThrow(/owned by/);
    const other = join(dir, 'elsewhere');
    writeFileSync(other, 'a'.repeat(64), { mode: 0o600 });
    const linkDir = temp();
    ensureRuntimeDir(linkDir, uid);
    symlinkSync(other, join(linkDir, KEY_FILE));
    expect(() => readBrokerKey(linkDir, uid)).toThrow(/symlink/);
  });

  it('limits repeated authentication failures in a sliding window', () => {
    let now = 0;
    const l = new AuthFailureLimiter(3, 1000, () => now);
    l.recordFailure();
    l.recordFailure();
    expect(l.isLimited()).toBe(false);
    l.recordFailure();
    expect(l.isLimited()).toBe(true);
    now = 1500;
    expect(l.isLimited()).toBe(false);
  });
});

describe('socket guard (AC4)', () => {
  it('creates the runtime directory with mode 0700', () => {
    const dir = temp();
    ensureRuntimeDir(dir, uid);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlinked, wrong-mode, foreign-owned or non-directory runtime dir', () => {
    const real = temp();
    ensureRuntimeDir(real, uid);
    const linkParent = temp();
    mkdirSync(linkParent, { recursive: true });
    const link = join(linkParent, 'link');
    symlinkSync(real, link);
    expect(code(() => ensureRuntimeDir(link, uid))).toBe('UNSAFE_PATH');

    const wide = temp();
    mkdirSync(wide, { recursive: true, mode: 0o755 });
    chmodSync(wide, 0o755);
    expect(code(() => ensureRuntimeDir(wide, uid))).toBe('UNSAFE_PATH');

    expect(code(() => ensureRuntimeDir(real, uid + 1))).toBe('UNSAFE_PATH');

    const fileParent = temp();
    mkdirSync(fileParent, { recursive: true });
    const file = join(fileParent, 'f');
    writeFileSync(file, '');
    expect(code(() => ensureRuntimeDir(file, uid))).toBe('UNSAFE_PATH');
  });

  it('refuses a socket path that is a symlink, a regular file, wrong mode or foreign-owned', async () => {
    const dir = temp();
    ensureRuntimeDir(dir, uid);
    const sock = join(dir, SOCKET_FILE);
    writeFileSync(sock, '', { mode: 0o600 });
    expect(code(() => checkSocketFile(sock, uid))).toBe('UNSAFE_PATH');
    await expect(prepareSocketPath(dir, uid)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    const dir2 = temp();
    ensureRuntimeDir(dir2, uid);
    symlinkSync(join(dir, 'x'), join(dir2, SOCKET_FILE));
    await expect(prepareSocketPath(dir2, uid)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    // A real socket left by a SIGKILLed process, with a widened mode.
    const dir3 = temp();
    ensureRuntimeDir(dir3, uid);
    await leaveStaleSocket(join(dir3, SOCKET_FILE));
    chmodSync(join(dir3, SOCKET_FILE), 0o666);
    await expect(prepareSocketPath(dir3, uid)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    chmodSync(join(dir3, SOCKET_FILE), 0o600);
    expect(code(() => checkSocketFile(join(dir3, SOCKET_FILE), uid + 1))).toBe('UNSAFE_PATH');
  });

  it('removes a stale socket (AC5)', async () => {
    const dir = temp();
    ensureRuntimeDir(dir, uid);
    const sock = join(dir, SOCKET_FILE);
    await leaveStaleSocket(sock);
    chmodSync(sock, 0o600);
    expect(existsSync(sock)).toBe(true);
    await expect(prepareSocketPath(dir, uid)).resolves.toBe(sock);
    expect(existsSync(sock)).toBe(false);
  });

  it('pid lock: live holder → BROKER_CONFLICT; dead holder → stale lock replaced', async () => {
    const dir = temp();
    ensureRuntimeDir(dir, uid);
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)']);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(dir, LOCK_FILE), String(child.pid), { mode: 0o600 });
    expect(code(() => acquireLock(dir, uid))).toBe('BROKER_CONFLICT');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const release = acquireLock(dir, uid);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });
});

describe('logger', () => {
  it('drops unknown fields and control characters', () => {
    const line = formatLogLine('x', {
      kind: 'sn.op',
      body: 'SECRET',
      clientName: 'a\nb',
    } as unknown as Parameters<typeof formatLogLine>[1]);
    expect(line).not.toContain('SECRET');
    expect(JSON.parse(line)).toMatchObject({ event: 'x', kind: 'sn.op', clientName: 'ab' });
  });
});

/** Leaves a socket file behind by SIGKILLing a process that is listening on it. */
async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, [
    '-e',
    `require('net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('up'))`,
  ]);
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
}
