import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../src/bridge/client.js';
import { planInstall } from '../src/install/installer.js';
import { Broker } from '../src/native-host/broker.js';
import {
  CAPTURE_FILE,
  CaptureWriter,
  hashPrefix,
  longStringHashes,
  redactFrame,
  scanForCredentials,
} from '../src/native-host/capture.js';
import { MemoryLogger } from '../src/native-host/logger.js';
import { LABEL, MockExtension, makeTempDir } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uid = process.getuid?.() as number;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TOKEN = 'f'.repeat(64) + 'abcd1234';
const snResult = (body: unknown) => ({
  v: 1,
  kind: 'response',
  id: 'b1',
  ok: true,
  result: {
    type: 'sn.op',
    instance: 'dev',
    host: 'dev.service-now.com',
    env: 'dev',
    status: 200,
    body,
    bytes: 10,
  },
});

describe('capture helpers', () => {
  it('flags credential markers', () => {
    expect(scanForCredentials('{"headers":{"Cookie":"JSESSIONID=1"}}')).toEqual([
      'Cookie',
      'JSESSIONID',
    ]);
    expect(scanForCredentials('{"x":"glide_user_route","y":"g_ck","z":"X-UserToken"}')).toEqual([
      'glide_',
      'g_ck',
      'X-UserToken',
    ]);
    expect(scanForCredentials('{"number":"INC0000060"}')).toEqual([]);
  });

  it('redacts record values and handshake material, keeping structure', () => {
    const r = redactFrame(
      snResult([{ number: 'INC0000060', short_description: 'secret text' }]),
    ) as {
      result: { body: Record<string, string>[]; host: string };
    };
    expect(r.result.host).toBe('dev.service-now.com');
    expect(r.result.body[0]).toEqual({
      number: '<redacted:10 chars>',
      short_description: '<redacted:11 chars>',
    });
    expect(JSON.stringify(redactFrame({ kind: 'auth', clientProof: 'abc' }))).not.toContain('abc');
    expect(JSON.stringify(redactFrame({ request: { purpose: 'private' } }))).not.toContain(
      'private',
    );
  });

  it('never stores scope or request ids (access handles)', () => {
    const handles = JSON.stringify(
      redactFrame({
        request: { scopeId: `scp_${'S'.repeat(22)}` },
        result: { requestId: `req_${'R'.repeat(22)}` },
      }),
    );
    expect(handles).not.toMatch(/scp_S|req_R/);
  });

  it('records hashes of long strings so a token can be checked without storing it', () => {
    const hashes = longStringHashes(snResult([{ t: TOKEN }]));
    expect(hashes).toContain(hashPrefix(TOKEN));
    expect(JSON.stringify(hashes)).not.toContain(TOKEN);
  });
});

describe('broker capture', () => {
  it('records all four directions with redacted bodies, in a 0600 file', async () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const capture = new CaptureWriter(join(t.dir, CAPTURE_FILE));
    const ext = new MockExtension();
    const broker = new Broker({
      dir: t.dir,
      uid,
      extIn: ext.extIn,
      extOut: ext.extOut,
      logger: new MemoryLogger(),
      capture,
    });
    await broker.start();
    cleanups.push(() => broker.stop('end'));
    const bridge = new BridgeClient({ dir: t.dir, label: LABEL });
    cleanups.push(() => bridge.close());
    const p = bridge.request({
      kind: 'sn.op',
      scopeId: `scp_${'S'.repeat(22)}`,
      instance: 'dev',
      op: { kind: 'probe' },
    } as never);
    const f = await ext.next('forward');
    ext.send({ ...snResult([{ number: 'INC0000060' }]), id: (f.request as { id: string }).id });
    await p;
    const lines = readFileSync(join(t.dir, CAPTURE_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(new Set(lines.map((l) => l.dir))).toEqual(
      new Set(['broker>ext', 'client>broker', 'ext>broker', 'broker>client']),
    );
    expect(lstatSync(join(t.dir, CAPTURE_FILE)).mode & 0o777).toBe(0o600);
    const text = readFileSync(join(t.dir, CAPTURE_FILE), 'utf8');
    expect(text).not.toContain('INC0000060');
    expect(lines.every((l) => l.findings.length === 0)).toBe(true);
  });
});

describe('check-capture CLI', () => {
  const script = join(root, 'dist', 'bin', 'check-capture.js');
  function run(file: string, env: Record<string, string> = {}) {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [script, file], {
          env: { ...process.env, ...env },
          encoding: 'utf8',
        }),
      };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  }
  function captureOf(messages: unknown[]) {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const file = join(t.dir, CAPTURE_FILE);
    const w = new CaptureWriter(file);
    for (const m of messages) w.record('ext>broker', m);
    return file;
  }

  it('passes a clean capture and reports what it saw', () => {
    const r = run(captureOf([snResult([{ number: 'INC0000060' }])]), { SN_MCP_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Successful sn.op responses (HTTP 200): 1');
    expect(r.out).toContain('performed');
    expect(r.out).toContain('PASS');
    expect(r.out).not.toContain(TOKEN);
  });

  it('fails on credential markers and on the token value, without printing it', () => {
    expect(run(captureOf([snResult([{ note: 'Cookie: JSESSIONID=abc' }])])).code).toBe(1);
    const leak = run(captureOf([snResult([{ x: TOKEN }])]), { SN_MCP_TOKEN: TOKEN });
    expect(leak.code).toBe(1);
    expect(leak.out).toContain('contains the session token');
    expect(leak.out).not.toContain(TOKEN);
  });

  it('a tampered capture file (marker in the stored frame) also fails', () => {
    const file = captureOf([snResult([])]);
    const line = JSON.parse(readFileSync(file, 'utf8'));
    line.frame.extra = 'x-usertoken';
    writeFileSync(file, `${JSON.stringify(line)}\n`);
    expect(run(file).code).toBe(1);
  });
});

describe('installer --capture', () => {
  it('adds the capture env only when asked', () => {
    const t = makeTempDir();
    cleanups.push(t.cleanup);
    mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const script = join(t.dir, 'host.js');
    writeFileSync(script, '');
    const paths = {
      nodePath: process.execPath,
      hostScript: script,
      installDir: join(t.dir, 'i'),
      manifestDir: join(t.dir, 'm'),
    };
    expect(planInstall(paths, uid).wrapperContent).not.toContain('SN_MCP_CAPTURE');
    expect(planInstall(paths, uid, { capture: true }).wrapperContent).toContain(
      "export SN_MCP_CAPTURE='metadata+bodies-redacted'",
    );
  });
});
