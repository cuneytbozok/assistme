/**
 * Native host entry (launched by Chrome via native messaging).
 *
 * - argv origin check: Chrome passes the caller origin as the first argument; anything other
 *   than this extension's origin exits non-zero (ARCHITECTURE §4.1).
 * - stdout carries native-messaging frames only. Diagnostics go to the 0600 log file.
 * - Lives while stdin is open; on close it removes the socket, key and lock and exits 0.
 */
import { join } from 'node:path';
import { EXTENSION_ORIGIN, PROTOCOL_VERSION } from '@sn-mcp/shared';
import { currentUid } from './auth.js';
import { Broker } from './broker.js';
import { encodeFrame } from './framing.js';
import { FileLogger } from './logger.js';
import { BrokerStartError, defaultRuntimeDir, ensureRuntimeDir, LOG_FILE } from './socket-guard.js';

export const EXIT = { ok: 0, usage: 64, unsafePath: 78, conflict: 75, failure: 1 } as const;

function writeStdout(buf: Buffer): Promise<void> {
  return new Promise((resolve) => process.stdout.write(buf, () => resolve()));
}

export async function main(argv: readonly string[]): Promise<number | 'running'> {
  // Never let stray console output corrupt the native-messaging stream.
  console.log = () => {};
  console.info = () => {};

  if (argv[2] !== EXTENSION_ORIGIN) {
    process.stderr.write('sn-mcp native host: refusing launch from an unexpected origin\n');
    return EXIT.usage;
  }
  const dir = defaultRuntimeDir();
  let uid: number;
  try {
    uid = currentUid();
    ensureRuntimeDir(dir, uid);
  } catch (e) {
    process.stderr.write(`sn-mcp native host: ${String((e as Error).message)}\n`);
    return EXIT.unsafePath;
  }
  const logger = new FileLogger(join(dir, LOG_FILE));
  const broker = new Broker({ dir, uid, extIn: process.stdin, extOut: process.stdout, logger });
  try {
    await broker.start();
  } catch (e) {
    if (e instanceof BrokerStartError && e.code === 'BROKER_CONFLICT') {
      logger.log('broker.conflict');
      await writeStdout(
        encodeFrame({ v: PROTOCOL_VERSION, kind: 'broker.status', state: 'conflict' }),
      );
      return EXIT.conflict;
    }
    logger.log('broker.start_failed', { code: e instanceof BrokerStartError ? e.code : 'UNKNOWN' });
    process.stderr.write(`sn-mcp native host: ${String((e as Error).message)}\n`);
    return e instanceof BrokerStartError ? EXIT.unsafePath : EXIT.failure;
  }
  const shutdown = (reason: string) => void broker.stop(reason).then(() => process.exit(EXIT.ok));
  process.stdin.once('end', () => shutdown('stdin closed'));
  process.stdin.once('close', () => shutdown('stdin closed'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return 'running';
}
