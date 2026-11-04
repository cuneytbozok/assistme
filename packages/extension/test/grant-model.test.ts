/**
 * T-011 acceptance: full grant model (ARCHITECTURE §5.4). Mocks only; not evidence of
 * ServiceNow connectivity.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_CODE_ALPHABET,
  GRANT_TTL_MINUTES,
  SCOPE_REQUEST_TTL_SECONDS,
} from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import {
  type ApproveOptions,
  badgeFor,
  type GrantStorage,
  Grants,
  policyEnv,
  TTL_CHOICES,
} from '../src/background/grants.js';
import { handlePopupMessage } from '../src/background/popup-api.js';
import type { InstanceEntry } from '../src/background/registry.js';

const entry = (alias: string, env: InstanceEntry['env']): InstanceEntry => ({
  alias,
  host: `${alias}.service-now.com`,
  label: '',
  env,
  addedAt: 'x',
});
const REG = [
  entry('dev', 'dev'),
  entry('qa', 'test'),
  entry('prod', 'prod'),
  entry('uat', 'unclassified'),
];
const A = { keyId: 'a'.repeat(64), label: { name: 'Claude Desktop', pid: 1 } };
const B = { keyId: 'b'.repeat(64), label: { name: 'claude-code', pid: 2 } };
const MIN = 60_000;

function setup() {
  let data: unknown;
  const storage: GrantStorage = {
    load: async () => structuredClone(data),
    save: async (s) => {
      data = structuredClone(s);
    },
  };
  const clock = { t: Date.parse('2026-11-04T12:00:00Z') };
  const grants = new Grants(storage, {
    now: () => clock.t,
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    sha256Hex: async (s) => createHash('sha256').update(s).digest('hex'),
  });
  async function request(instances: string[], client = A) {
    const r = await grants.createRequest(
      client,
      { instances, mode: instances.length === 2 ? 'compare' : 'single', purpose: 'p' },
      REG,
    );
    if (!r.ok) throw new Error(r.message);
    return r.value;
  }
  async function scope(instances: string[], opts?: ApproveOptions, client = A) {
    const { requestId } = await request(instances, client);
    const ap = await grants.approve(requestId, REG, opts);
    if (!ap.ok) throw new Error(ap.message);
    const c = await grants.claim(client.keyId, requestId);
    if (!c.ok || c.value.status !== 'approved') throw new Error('claim');
    return { requestId, ...c.value };
  }
  return { grants, clock, request, scope };
}

describe('AC1: grant policy', () => {
  it('claim twice → fail; claim from another client → fail', async () => {
    const s = setup();
    const { requestId } = await s.request(['dev']);
    await s.grants.approve(requestId, REG);
    expect(await s.grants.claim(B.keyId, requestId)).toMatchObject({
      value: { status: 'expired' },
    });
    expect(await s.grants.claim(A.keyId, requestId)).toMatchObject({
      value: { status: 'approved' },
    });
    expect(await s.grants.claim(A.keyId, requestId)).toMatchObject({
      value: { status: 'claimed' },
    });
  });

  it('expired → SCOPE_EXPIRED; revoked → SCOPE_UNKNOWN; revoke-all ends everything', async () => {
    const s = setup();
    const a = await s.scope(['dev'], { ttlMinutes: 60 });
    s.clock.t += 60 * MIN + 1;
    expect(await s.grants.authorize(A.keyId, a.scopeId, 'dev')).toMatchObject({
      code: 'SCOPE_EXPIRED',
    });

    const b = await s.scope(['dev']);
    const [g] = (await s.grants.snapshot()).grants;
    await s.grants.revoke(g?.grantId as string);
    expect(await s.grants.authorize(A.keyId, b.scopeId, 'dev')).toMatchObject({
      code: 'SCOPE_UNKNOWN',
    });

    const c = await s.scope(['dev']);
    const d = await s.scope(['qa'], undefined, B);
    const pending = await s.request(['qa']);
    expect(await s.grants.revokeAll()).toBe(3);
    for (const [k, id, inst] of [
      [A.keyId, c.scopeId, 'dev'],
      [B.keyId, d.scopeId, 'qa'],
    ] as const) {
      expect(await s.grants.authorize(k, id, inst)).toMatchObject({ code: 'SCOPE_UNKNOWN' });
    }
    expect(await s.grants.claim(A.keyId, pending.requestId)).toMatchObject({
      value: { status: 'denied' },
    });
  });

  it('PROD approval without the typed host is impossible (also for unclassified and compare)', async () => {
    const s = setup();
    for (const instances of [['prod'], ['uat'], ['dev', 'prod'], ['prod', 'uat']]) {
      const { requestId } = await s.request(instances);
      expect(await s.grants.approve(requestId, REG)).toMatchObject({ code: 'INVALID_INPUT' });
      expect(
        await s.grants.approve(requestId, REG, { typedHosts: ['dev.service-now.com'] }),
      ).toMatchObject({
        ok: false,
      });
    }
    // Both PROD hosts of a PROD pair must be typed.
    const pair = await s.request(['prod', 'uat']);
    expect(
      await s.grants.approve(pair.requestId, REG, { typedHosts: ['prod.service-now.com'] }),
    ).toMatchObject({ ok: false });
    expect(
      await s.grants.approve(pair.requestId, REG, {
        typedHosts: [' PROD.service-now.com', 'uat.service-now.com '],
      }),
    ).toMatchObject({ ok: true });
  });

  it('PROD TTL default 15 min, capped at 60; DEV/TEST default 4 h, capped at 12 h', async () => {
    const s = setup();
    const typed = { typedHosts: ['prod.service-now.com'] };
    const p15 = await s.scope(['prod'], typed);
    expect(Date.parse(p15.expiresAt) - s.clock.t).toBe(15 * MIN);
    const p60 = await s.scope(['prod'], { ...typed, ttlMinutes: 60 });
    expect(Date.parse(p60.expiresAt) - s.clock.t).toBe(60 * MIN);
    const over = await s.request(['prod']);
    expect(await s.grants.approve(over.requestId, REG, { ...typed, ttlMinutes: 61 })).toMatchObject(
      {
        ok: false,
      },
    );

    const d = await s.scope(['dev']);
    expect(Date.parse(d.expiresAt) - s.clock.t).toBe(240 * MIN);
    const d12 = await s.scope(['qa'], { ttlMinutes: 720 });
    expect(Date.parse(d12.expiresAt) - s.clock.t).toBe(720 * MIN);
    for (const bad of [721, 0, -5, 1.5, Number.NaN]) {
      const r = await s.request(['dev']);
      expect(await s.grants.approve(r.requestId, REG, { ttlMinutes: bad })).toMatchObject({
        ok: false,
      });
    }
    // A DEV+PROD compare pair takes the PROD range.
    const mixed = await s.request(['dev', 'prod']);
    expect(
      await s.grants.approve(mixed.requestId, REG, { ...typed, ttlMinutes: 240 }),
    ).toMatchObject({ ok: false });
  });

  it('a compare grant covers exactly its pair; a single grant covers only its instance', async () => {
    const s = setup();
    const pair = await s.scope(['dev', 'qa']);
    expect(pair).toMatchObject({ mode: 'compare', instances: ['dev', 'qa'] });
    expect(await s.grants.authorize(A.keyId, pair.scopeId, 'dev')).toMatchObject({ ok: true });
    expect(await s.grants.authorize(A.keyId, pair.scopeId, 'qa')).toMatchObject({ ok: true });
    expect(await s.grants.authorize(A.keyId, pair.scopeId, 'prod')).toMatchObject({
      code: 'INSTANCE_NOT_IN_SCOPE',
    });
    const single = await s.scope(['dev']);
    expect(await s.grants.authorize(A.keyId, single.scopeId, 'qa')).toMatchObject({
      code: 'INSTANCE_NOT_IN_SCOPE',
    });
  });

  it('there is no renewal: a claimed request cannot be re-approved or re-claimed', async () => {
    const s = setup();
    const g = await s.scope(['prod'], { typedHosts: ['prod.service-now.com'] });
    expect(
      await s.grants.approve(g.requestId, REG, {
        typedHosts: ['prod.service-now.com'],
        ttlMinutes: 60,
      }),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(await s.grants.claim(A.keyId, g.requestId)).toMatchObject({
      value: { status: 'claimed' },
    });
    expect(
      Object.keys(Grants.prototype).concat(Object.getOwnPropertyNames(Grants.prototype)),
    ).not.toContain('renew');
  });

  it('stores {scopeHash, clientKeyId, instances, mode, env, expiresAt} plus purpose and approval time', async () => {
    const s = setup();
    await s.scope(['dev', 'uat'], { typedHosts: ['uat.service-now.com'], ttlMinutes: 30 });
    const [g] = (await s.grants.snapshot()).grants;
    expect(g).toMatchObject({
      clientKeyId: A.keyId,
      instances: ['dev', 'uat'],
      mode: 'compare',
      env: 'prod',
      purpose: 'p',
      approvedAt: s.clock.t,
      expiresAt: s.clock.t + 30 * MIN,
    });
  });
});

describe('AC2: approval codes and request expiry', () => {
  it('codes use the unambiguous alphabet and requests expire after 5 min', async () => {
    const s = setup();
    expect(APPROVAL_CODE_ALPHABET).not.toMatch(/[01ILO]/);
    const r = await s.request(['dev']);
    expect([...r.approvalCode].every((c) => APPROVAL_CODE_ALPHABET.includes(c))).toBe(true);
    expect(r.expiresInSeconds).toBe(SCOPE_REQUEST_TTL_SECONDS);
    expect(SCOPE_REQUEST_TTL_SECONDS).toBe(300);
    s.clock.t += 300_000 + 1;
    expect(await s.grants.approve(r.requestId, REG)).toMatchObject({ code: 'NOT_FOUND' });
    expect((await s.grants.snapshot()).pending).toEqual([]);
  });
});

describe('AC3: purpose is rendered as text, never HTML', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  it('the popup never uses HTML-parsing sinks', () => {
    const src = readFileSync(join(root, 'src/popup/popup.ts'), 'utf8');
    for (const sink of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'DOMParser',
      'createContextualFragment',
    ]) {
      expect(src, sink).not.toContain(sink);
    }
  });
  it('notifications never include the purpose', () => {
    const src = readFileSync(join(root, 'src/background/index.ts'), 'utf8');
    const block = src.slice(
      src.indexOf('async function notifyRequest'),
      src.indexOf('async function sendRegistryUpdate'),
    );
    expect(block).toContain('chrome.notifications.create');
    expect(block).not.toMatch(/purpose/);
  });
});

describe('policy helpers, badge and popup messages', () => {
  it('policyEnv picks the strictest; TTL choices stay within the caps', () => {
    expect(policyEnv([entry('a', 'dev')])).toBe('dev');
    expect(policyEnv([entry('a', 'dev'), entry('b', 'test')])).toBe('test');
    expect(policyEnv([entry('a', 'dev'), entry('b', 'unclassified')])).toBe('prod');
    for (const env of ['dev', 'test', 'prod'] as const) {
      expect(TTL_CHOICES[env]).toContain(GRANT_TTL_MINUTES[env].default);
      expect(Math.max(...TTL_CHOICES[env])).toBe(GRANT_TTL_MINUTES[env].max);
    }
  });

  it('badge is red while a PROD grant is active, and counts pending requests', () => {
    const now = 1000;
    expect(badgeFor(0, [], now)).toEqual({ text: '', color: '#2563eb' });
    expect(badgeFor(2, [{ env: 'dev', expiresAt: 2000 }], now)).toEqual({
      text: '2',
      color: '#2563eb',
    });
    expect(badgeFor(0, [{ env: 'prod', expiresAt: 2000 }], now)).toEqual({
      text: 'PROD',
      color: '#dc2626',
    });
    expect(badgeFor(1, [{ env: 'prod', expiresAt: 2000 }], now)).toEqual({
      text: '1',
      color: '#dc2626',
    });
    expect(badgeFor(0, [{ env: 'prod', expiresAt: 500 }], now)).toEqual({
      text: '',
      color: '#2563eb',
    });
  });

  it('popup.approve passes typed hosts and TTL; popup.revokeAll revokes', async () => {
    const s = setup();
    const deps = {
      grants: s.grants,
      registry: async () => REG,
      bridgeState: () => ({ state: 'connected' as const }),
      onChanged: () => undefined,
    };
    const { requestId } = await s.request(['prod']);
    expect(
      await handlePopupMessage({ type: 'popup.approve', requestId, ttlMinutes: 30 }, deps),
    ).toMatchObject({ ok: false });
    expect(
      await handlePopupMessage(
        { type: 'popup.approve', requestId, typedHosts: ['prod.service-now.com'], ttlMinutes: 30 },
        deps,
      ),
    ).toEqual({ ok: true });
    const c = await s.grants.claim(A.keyId, requestId);
    expect(c.ok && c.value.status === 'approved' && Date.parse(c.value.expiresAt) - s.clock.t).toBe(
      30 * MIN,
    );
    expect(await handlePopupMessage({ type: 'popup.revokeAll' }, deps)).toEqual({
      ok: true,
      revoked: 1,
    });
    expect((await s.grants.snapshot()).grants).toEqual([]);
  });
});
