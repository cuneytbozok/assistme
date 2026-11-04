/**
 * Broker tests with a MOCK extension (in-memory stdio). Not evidence of ServiceNow connectivity.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToBroker } from '../src/bridge/handshake.js';
import {
  AuthFailureLimiter,
  clientKeyId,
  KEY_FILE,
  newNonce,
  writeBrokerKey,
} from '../src/native-host/auth.js';
import { Broker } from '../src/native-host/broker.js';
import { encodeFrame, FrameDecoder } from '../src/native-host/framing.js';
import { MemoryLogger } from '../src/native-host/logger.js';
import { ensureRuntimeDir, LOCK_FILE, SOCKET_FILE } from '../src/native-host/socket-guard.js';
import { LABEL, MockExtension, makeTempDir, rawClient } from './helpers.js';

const uid = process.getuid?.() as number;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startBroker(opts: Partial<ConstructorParameters<typeof Broker>[0]> = {}) {
  const t = makeTempDir();
  const ext = new MockExtension();
  const logger = new MemoryLogger();
  const broker = new Broker({
    dir: t.dir,
    uid,
    extIn: ext.extIn,
    extOut: ext.extOut,
    logger,
    ...opts,
  });
  await broker.start();
  cleanups.push(t.cleanup);
  cleanups.push(() => broker.stop('test end'));
  expect(await ext.next('broker.status')).toMatchObject({ state: 'ready' });
  return { dir: t.dir, ext, logger, broker, sock: join(t.dir, SOCKET_FILE) };
}

const identity = () => ({ clientKey: randomBytes(16), label: LABEL });

async function client(dir: string) {
  const conn = await connectToBroker(dir, identity());
  const inbox: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  conn.onMessage((m) => {
    const w = waiters.shift();
    if (w) w(m as Record<string, unknown>);
    else inbox.push(m as Record<string, unknown>);
  });
  cleanups.push(() => conn.close());
  return {
    conn,
    next: () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const m = inbox.shift();
        if (m) return resolve(m);
        const timer = setTimeout(() => reject(new Error('no message')), 3000);
        waiters.push((x) => {
          clearTimeout(timer);
          resolve(x);
        });
      }),
  };
}

const registryGet = (id: string) => ({ v: 1, kind: 'registry.get', id });
const registryResult = (id: string, alias: string) => ({
  v: 1,
  kind: 'response',
  id,
  ok: true,
  result: {
    type: 'registry.get',
    instances: [
      {
        alias,
        label: '',
        host: `${alias}.service-now.com`,
        env: 'dev',
        connection: 'connected',
        thisClient: { pendingRequest: false, activeGrant: false },
      },
    ],
  },
});

describe('broker start', () => {
  it('creates a 0600 socket, a 0600 rotating key and a lock in a 0700 dir', async () => {
    const { dir, sock } = await startBroker();
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });

  it('a second broker on the same dir fails with BROKER_CONFLICT (AC5)', async () => {
    const { dir } = await startBroker();
    const ext = new MockExtension();
    const b2 = new Broker({
      dir,
      uid,
      extIn: ext.extIn,
      extOut: ext.extOut,
      logger: new MemoryLogger(),
    });
    await expect(b2.start()).rejects.toMatchObject({ code: 'BROKER_CONFLICT' });
    expect(existsSync(join(dir, SOCKET_FILE))).toBe(true); // the first broker is untouched
  });
});

describe('client authentication', () => {
  it('a real client authenticates', async () => {
    const { dir } = await startBroker();
    const c = await client(dir);
    expect(c.conn.keyId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC1: a client without the key is disconnected within 2 s', async () => {
    const { sock } = await startBroker();
    const silent = await rawClient(sock);
    const start = Date.now();
    const closedAt = await silent.closed;
    expect(closedAt - start).toBeLessThanOrEqual(2300);

    // Sends hello, receives a challenge, but cannot produce the proof.
    const guesser = await rawClient(sock);
    guesser.send({
      v: 1,
      kind: 'hello',
      clientNonce: newNonce(),
      clientKeyId: clientKeyId(randomBytes(16)),
      label: LABEL,
    });
    const ch = await guesser.reader.next((m) => m.kind === 'challenge');
    expect(ch).toHaveProperty('brokerProof');
    const t0 = Date.now();
    await guesser.closed;
    expect(Date.now() - t0).toBeLessThanOrEqual(2300);
  });

  it('AC2: a wrong proof is rejected, and repeated failures are rate-limited', async () => {
    const { dir, sock, logger } = await startBroker({ limiter: new AuthFailureLimiter(3, 60_000) });
    for (let i = 0; i < 3; i++) {
      const c = await rawClient(sock);
      c.send({
        v: 1,
        kind: 'hello',
        clientNonce: newNonce(),
        clientKeyId: 'a'.repeat(64),
        label: LABEL,
      });
      await c.reader.next((m) => m.kind === 'challenge');
      c.send({ v: 1, kind: 'auth', clientProof: 'b'.repeat(64) });
      await c.closed;
      expect(c.reader.received.some((m) => m.kind === 'auth_ok')).toBe(false);
    }
    // Now even a correct client is refused immediately while the limit holds.
    await expect(connectToBroker(dir, identity())).rejects.toBeTruthy();
    expect(logger.lines.some((l) => l.includes('auth_rate_limited'))).toBe(true);
  });

  it('AC3: the client detects a fake broker (process without the current key)', async () => {
    const { dir } = await startBroker();
    // The client now holds a different key than the process listening on the socket.
    writeFileSync(join(dir, KEY_FILE), randomBytes(32).toString('hex'), { mode: 0o600 });
    await expect(connectToBroker(dir, identity())).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
  });

  it('AC3: an impostor that accepts anything is rejected before the client reveals its proof', async () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    ensureRuntimeDir(t.dir, uid);
    writeBrokerKey(t.dir); // the client reads this key; the impostor does not know it
    const sock = join(t.dir, SOCKET_FILE);
    const seen: string[] = [];
    const server = createServer((s) => {
      const d = new FrameDecoder(1024 * 1024);
      s.on('data', (c: Buffer) => {
        for (const m of d.push(c) as { kind: string }[]) {
          seen.push(m.kind);
          if (m.kind === 'hello') {
            s.write(
              encodeFrame({
                v: 1,
                kind: 'challenge',
                brokerNonce: newNonce(),
                brokerProof: 'c'.repeat(64),
              }),
            );
          }
          s.write(encodeFrame({ v: 1, kind: 'auth_ok' }));
        }
      });
    });
    const previous = process.umask(0o077);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    process.umask(previous);
    chmodSync(sock, 0o600);
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    await expect(connectToBroker(t.dir, identity())).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
      message: expect.stringMatching(/broker proof mismatch/),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['hello']); // no 'auth' frame was ever sent to the impostor
  });

  it('requests before authentication, malformed frames and oversized frames close the connection', async () => {
    const { sock, ext } = await startBroker();
    const early = await rawClient(sock);
    early.send(registryGet('x1'));
    await early.closed;

    const junk = await rawClient(sock);
    junk.sendRaw(Buffer.concat([Buffer.from([5, 0, 0, 0]), Buffer.from('{oops')]));
    await junk.closed;

    const big = await rawClient(sock);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(300 * 1024, 0);
    big.sendRaw(header);
    await big.closed;
    expect(ext.reader.received.filter((m) => m.kind === 'forward')).toHaveLength(0);
  });
});

describe('routing', () => {
  it('AC6: two clients using the same request id never receive each other’s responses', async () => {
    const { dir, ext } = await startBroker();
    const a = await client(dir);
    const b = await client(dir);
    a.conn.send(registryGet('1'));
    b.conn.send(registryGet('1'));
    const f1 = await ext.next('forward');
    const f2 = await ext.next('forward');
    const id1 = (f1.request as { id: string }).id;
    const id2 = (f2.request as { id: string }).id;
    expect(id1).not.toBe(id2);
    expect([id1, id2]).not.toContain('1');
    expect((f1.client as { keyId: string }).keyId).not.toBe((f2.client as { keyId: string }).keyId);
    const aliasFor = (keyId: string) => (keyId === a.conn.keyId ? 'alpha' : 'beta');
    // Answer in reverse order.
    ext.send(registryResult(id2, aliasFor((f2.client as { keyId: string }).keyId)));
    ext.send(registryResult(id1, aliasFor((f1.client as { keyId: string }).keyId)));
    const ra = await a.next();
    const rb = await b.next();
    expect(ra).toMatchObject({ id: '1', ok: true });
    expect(rb).toMatchObject({ id: '1', ok: true });
    expect(JSON.stringify(ra)).toContain('alpha');
    expect(JSON.stringify(rb)).toContain('beta');
  });

  it('accepts an answer that arrives before the forward write returns (synchronous extension)', async () => {
    const { dir, ext } = await startBroker();
    // Reply from inside the broker's own write to the extension.
    ext.extOut.on('data', () => {
      const idx = ext.reader.received.findIndex((m) => m.kind === 'forward');
      if (idx < 0) return;
      const f = ext.reader.received.splice(idx, 1)[0] as { request: { id: string } };
      ext.send(registryResult(f.request.id, 'sync'));
    });
    const a = await client(dir);
    a.conn.send(registryGet('1'));
    expect(JSON.stringify(await a.next())).toContain('sync');
  });

  it('enforces the in-flight cap and rejects duplicate in-flight ids', async () => {
    const { dir } = await startBroker({ maxInFlightPerClient: 2 });
    const a = await client(dir);
    a.conn.send(registryGet('1'));
    a.conn.send(registryGet('1'));
    expect(await a.next()).toMatchObject({ id: '1', ok: false, error: { code: 'INVALID_INPUT' } });
    a.conn.send(registryGet('2'));
    a.conn.send(registryGet('3'));
    expect(await a.next()).toMatchObject({ id: '3', ok: false, error: { code: 'RATE_LIMITED' } });
  });

  it('answers pings locally, broadcasts registry updates, and answers extension pings', async () => {
    const { dir, ext } = await startBroker();
    const a = await client(dir);
    a.conn.send({ v: 1, kind: 'ping', id: 'p1' });
    expect(await a.next()).toEqual({ v: 1, kind: 'pong', id: 'p1' });
    ext.send({ v: 1, kind: 'registry.update', instances: [] });
    expect(await a.next()).toMatchObject({ kind: 'registry.update' });
    ext.send({ v: 1, kind: 'ping', id: 'e1' });
    expect(await ext.next('pong')).toEqual({ v: 1, kind: 'pong', id: 'e1' });
  });

  it('drops responses for a client that disconnected (never replayed) and ignores unknown ids', async () => {
    const { dir, ext, logger } = await startBroker();
    const a = await client(dir);
    a.conn.send(registryGet('1'));
    const f = await ext.next('forward');
    a.conn.close();
    await new Promise((r) => setTimeout(r, 50));
    ext.send(registryResult((f.request as { id: string }).id, 'alpha'));
    ext.send(registryResult('b999', 'alpha'));
    await new Promise((r) => setTimeout(r, 50));
    expect(logger.lines.filter((l) => l.includes('ext.unknown_response'))).toHaveLength(2);
    const b = await client(dir);
    b.conn.send({ v: 1, kind: 'ping', id: 'p' });
    expect(await b.next()).toMatchObject({ kind: 'pong' }); // nothing replayed to the new client
  });

  it('times out requests the extension never answers', async () => {
    const { dir, ext } = await startBroker({ pendingTimeoutMs: 100 });
    const a = await client(dir);
    a.conn.send(registryGet('1'));
    await ext.next('forward');
    expect(await a.next()).toMatchObject({ id: '1', ok: false, error: { code: 'TIMEOUT' } });
  });

  it('a protocol violation after auth closes the client', async () => {
    const { dir } = await startBroker();
    const a = await client(dir);
    const closed = new Promise<void>((r) => a.conn.onClose(() => r()));
    a.conn.send({
      v: 1,
      kind: 'hello',
      clientNonce: newNonce(),
      clientKeyId: 'a'.repeat(64),
      label: LABEL,
    });
    await closed;
  });
});

describe('shutdown', () => {
  it('AC8 (in-process): stdin end fails pending requests and removes socket, key and lock', async () => {
    const { dir, ext } = await startBroker();
    const a = await client(dir);
    a.conn.send(registryGet('1'));
    await ext.next('forward');
    ext.extIn.end();
    expect(await a.next()).toMatchObject({
      id: '1',
      ok: false,
      error: { code: 'BRIDGE_UNAVAILABLE' },
    });
    await new Promise((r) => setTimeout(r, 100));
    for (const f of [SOCKET_FILE, KEY_FILE, LOCK_FILE])
      expect(existsSync(join(dir, f)), f).toBe(false);
  });
});

describe('logging (DoD)', () => {
  it('never logs message bodies', async () => {
    const { dir, ext, logger } = await startBroker();
    const a = await client(dir);
    a.conn.send({
      v: 1,
      kind: 'scope.request',
      id: '1',
      instances: ['dev'],
      mode: 'single',
      purpose: 'MARKER-PURPOSE-7f3a',
    });
    const f = await ext.next('forward');
    ext.send({
      v: 1,
      kind: 'response',
      id: (f.request as { id: string }).id,
      ok: true,
      result: {
        type: 'sn.op',
        instance: 'dev',
        host: 'dev.service-now.com',
        env: 'dev',
        status: 200,
        body: { result: [{ short_description: 'MARKER-BODY-9c1d' }] },
        bytes: 10,
      },
    });
    await a.next();
    const all = logger.lines.join('');
    expect(logger.lines.length).toBeGreaterThan(3);
    expect(all).not.toContain('MARKER-PURPOSE-7f3a');
    expect(all).not.toContain('MARKER-BODY-9c1d');
    expect(all).not.toContain(a.conn.keyId); // only an 8-char prefix
  });
});
