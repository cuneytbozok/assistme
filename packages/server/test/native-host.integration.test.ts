/**
 * Integration: spawns the built native host (dist/bin/native-host.js) with a MOCK extension on
 * stdio, as Chrome would. Not evidence of ServiceNow connectivity.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ORIGIN } from '@sn-mcp/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToBroker } from '../src/bridge/handshake.js';
import { encodeFrame } from '../src/native-host/framing.js';
import { FrameReader, LABEL, makeTempDir } from './helpers.js';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'native-host.js');
const procs: ChildProcessWithoutNullStreams[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill('SIGKILL');
  for (const c of cleanups.splice(0)) c();
});

function spawnHost(dir: string, origin: string | null = EXTENSION_ORIGIN) {
  const p = spawn(process.execPath, origin === null ? [HOST] : [HOST, origin], {
    env: { ...process.env, SN_MCP_RUNTIME_DIR: dir },
  });
  procs.push(p);
  const reader = new FrameReader();
  p.stdout.on('data', (c: Buffer) => reader.feed(c));
  const exited = new Promise<number | null>((resolve) => p.once('exit', (code) => resolve(code)));
  return { p, reader, exited, send: (m: unknown) => p.stdin.write(encodeFrame(m)) };
}

function tempDir() {
  const t = makeTempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('native host process', () => {
  it('AC7: exits non-zero for a wrong or missing origin', async () => {
    const dir = tempDir();
    expect(
      await spawnHost(dir, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/').exited,
    ).toBe(64);
    expect(await spawnHost(dir, 'https://evil.example/').exited).toBe(64);
    expect(await spawnHost(dir, null).exited).toBe(64);
    expect(existsSync(dir)).toBe(false); // nothing created before the origin check
  });

  it('relays a request end to end, and AC8: stdin close removes socket, key and lock', async () => {
    const dir = tempDir();
    const host = spawnHost(dir);
    expect(await host.reader.next((m) => m.kind === 'broker.status')).toMatchObject({
      state: 'ready',
    });

    const conn = await connectToBroker(dir, { clientKey: randomBytes(16), label: LABEL });
    const got = new Promise<unknown>((resolve) => conn.onMessage(resolve));
    conn.send({
      v: 1,
      kind: 'scope.request',
      id: 'r1',
      instances: ['dev'],
      mode: 'single',
      purpose: 'MARKER-INT-41b2',
    });
    const fwd = await host.reader.next((m) => m.kind === 'forward');
    const brokerId = (fwd.request as { id: string }).id;
    host.send({
      v: 1,
      kind: 'response',
      id: brokerId,
      ok: true,
      result: {
        type: 'scope.request',
        requestId: `req_${'A'.repeat(22)}`,
        approvalCode: 'K7QF2M',
        expiresInSeconds: 300,
      },
    });
    expect(await got).toMatchObject({ id: 'r1', ok: true, result: { approvalCode: 'K7QF2M' } });
    conn.close();

    host.p.stdin.end();
    expect(await host.exited).toBe(0);
    for (const f of ['broker.sock', 'broker.key', 'broker.pid'])
      expect(existsSync(join(dir, f)), f).toBe(false);
    const log = join(dir, 'broker.log');
    expect(lstatSync(log).mode & 0o777).toBe(0o600);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('request.forwarded');
    expect(text).not.toContain('MARKER-INT-41b2');
  });

  it('AC5: a second host reports BROKER_CONFLICT; after a crash the stale socket is recovered', async () => {
    const dir = tempDir();
    const a = spawnHost(dir);
    await a.reader.next((m) => m.kind === 'broker.status');
    const b = spawnHost(dir);
    expect(await b.reader.next((m) => m.kind === 'broker.status')).toMatchObject({
      state: 'conflict',
    });
    expect(await b.exited).toBe(75);

    a.p.kill('SIGKILL'); // crash: socket, key and lock stay behind
    await a.exited;
    expect(existsSync(join(dir, 'broker.sock'))).toBe(true);
    const c = spawnHost(dir);
    expect(await c.reader.next((m) => m.kind === 'broker.status')).toMatchObject({
      state: 'ready',
    });
    await expect(
      connectToBroker(dir, { clientKey: randomBytes(16), label: LABEL }),
    ).resolves.toBeTruthy();
    c.p.stdin.end();
    expect(await c.exited).toBe(0);
  });

  it('AC4: refuses to start in an unsafe runtime directory', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const host = spawnHost(dir);
    expect(await host.exited).toBe(78);
    expect(existsSync(join(dir, 'broker.sock'))).toBe(false);
  });
});
