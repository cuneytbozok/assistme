/**
 * Broker key and mutual HMAC challenge-response (ARCHITECTURE §4.3).
 *
 *   brokerProof = HMAC-SHA256(key, clientNonce ‖ "broker" ‖ "sn-mcp/v1")
 *   clientProof = HMAC-SHA256(key, brokerNonce ‖ clientNonce ‖ "client" ‖ "sn-mcp/v1")
 *
 * Fields are joined with "\n" (nonces are base64url, so they never contain it). The key rotates
 * on every broker start and is never sent over the socket.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { checkRegularFile } from './socket-guard.js';

export const KEY_FILE = 'broker.key';
const CONTEXT = 'sn-mcp/v1';

export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function brokerProof(key: Buffer, clientNonce: string): string {
  return createHmac('sha256', key)
    .update([clientNonce, 'broker', CONTEXT].join('\n'))
    .digest('hex');
}

export function clientProof(key: Buffer, brokerNonce: string, clientNonce: string): string {
  return createHmac('sha256', key)
    .update([brokerNonce, clientNonce, 'client', CONTEXT].join('\n'))
    .digest('hex');
}

/** Constant-time comparison of two hex strings. */
export function proofsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** SHA-256 of a per-process client key: the identity grants are bound to. */
export function clientKeyId(clientKey: Buffer): string {
  return createHash('sha256').update(clientKey).digest('hex');
}

/**
 * Writes a fresh 256-bit key atomically with mode 0600 (exclusive temp file + rename, so the
 * key is never readable with a wider mode and an existing symlink is replaced, not followed).
 */
export function writeBrokerKey(dir: string): Buffer {
  const key = randomBytes(32);
  const tmp = join(dir, `.${KEY_FILE}.${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, key.toString('hex'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, KEY_FILE));
  return key;
}

/** Reads the broker key after checking it is a regular 0600 file owned by `uid`. */
export function readBrokerKey(dir: string, uid = currentUid()): Buffer {
  const path = join(dir, KEY_FILE);
  checkRegularFile(path, 0o600, uid);
  const hex = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('broker key is malformed');
  return Buffer.from(hex, 'hex');
}

/** Removes the key only if it is still the one this broker wrote. */
export function removeBrokerKey(dir: string, key: Buffer): void {
  const path = join(dir, KEY_FILE);
  try {
    const hex = readFileSync(path, 'utf8').trim();
    if (hex === key.toString('hex')) unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Windows has no uid, and its checks don't use one (ADR-015). */
export function currentUid(): number {
  if (process.platform === 'win32') return -1;
  if (typeof process.getuid !== 'function') throw new Error('POSIX uid required');
  return process.getuid();
}

/** Counts failed authentications in a sliding window; refuses connections while exceeded. */
export class AuthFailureLimiter {
  private failures: number[] = [];

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  recordFailure(): void {
    this.failures.push(this.now());
  }

  isLimited(): boolean {
    const cutoff = this.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= this.maxFailures;
  }
}
