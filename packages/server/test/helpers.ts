/**
 * Test helpers. Everything here is a MOCK (fake extension / raw socket clients). Mocks are never
 * evidence of real ServiceNow connectivity (CLAUDE.md rule 11).
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { encodeFrame, FrameDecoder } from '../src/native-host/framing.js';

export function makeTempDir(): { dir: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'snm-')));
  const dir = join(base, 'rt');
  return {
    dir,
    cleanup: () => {
      try {
        chmodSync(base, 0o700);
      } catch {}
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Collects decoded frames from a stream and lets tests await the next matching one. */
export class FrameReader {
  private readonly decoder = new FrameDecoder(64 * 1024 * 1024);
  readonly received: Record<string, unknown>[] = [];
  private waiters: {
    match: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];

  feed(chunk: Buffer): void {
    for (const m of this.decoder.push(chunk) as Record<string, unknown>[]) {
      const w = this.waiters.find((x) => x.match(m));
      if (w) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(m);
      } else this.received.push(m);
    }
  }

  next(
    match: (m: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown>> {
    const idx = this.received.findIndex(match);
    if (idx >= 0)
      return Promise.resolve(this.received.splice(idx, 1)[0] as Record<string, unknown>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

/** MOCK extension: the broker's stdin/stdout replaced with in-memory streams. */
export class MockExtension {
  readonly extIn = new PassThrough(); // extension → broker
  readonly extOut = new PassThrough(); // broker → extension
  readonly reader = new FrameReader();

  constructor() {
    this.extOut.on('data', (c: Buffer) => this.reader.feed(c));
  }

  send(message: unknown): void {
    this.extIn.write(encodeFrame(message));
  }

  next(kind?: string, timeoutMs?: number) {
    return this.reader.next((m) => kind === undefined || m.kind === kind, timeoutMs);
  }
}

/** Raw socket client (no handshake logic) for negative tests. */
export async function rawClient(path: string) {
  const socket: Socket = connect(path);
  const reader = new FrameReader();
  let closedAt: number | undefined;
  const closed = new Promise<number>((resolve) => {
    socket.on('close', () => {
      closedAt = Date.now();
      resolve(closedAt);
    });
  });
  socket.on('data', (c: Buffer) => {
    try {
      reader.feed(c);
    } catch {}
  });
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    reader,
    closed,
    isClosed: () => closedAt !== undefined,
    send: (m: unknown) => socket.write(encodeFrame(m)),
    sendRaw: (b: Buffer) => socket.write(b),
  };
}

export const LABEL = { name: 'vitest', pid: process.pid };
