import { createHash, randomBytes } from 'node:crypto';
import { APPROVAL_CODE_RE, REQUEST_ID_RE, SCOPE_ID_RE } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { type GrantStorage, Grants, makeApprovalCode } from '../src/background/grants.js';
import type { InstanceEntry } from '../src/background/registry.js';

const entry = (
  alias: string,
  env: InstanceEntry['env'],
  host = `${alias}.service-now.com`,
): InstanceEntry => ({
  alias,
  host,
  label: '',
  env,
  addedAt: '2026-11-04T00:00:00Z',
});
const REGISTRY = [entry('dev', 'dev'), entry('prod', 'prod'), entry('unk', 'unclassified')];
const A = { keyId: 'a'.repeat(64), label: { name: 'claude-desktop', pid: 101 } };
const B = { keyId: 'b'.repeat(64), label: { name: 'claude-code', pid: 202 } };

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
  return { grants, clock, raw: () => data as { grants: { scopeHash: string }[] } };
}

async function approvedScope(g: Grants, client = A, alias = 'dev', typedHost?: string) {
  const req = await g.createRequest(
    client,
    { instances: [alias], mode: 'single', purpose: 'test' },
    REGISTRY,
  );
  if (!req.ok) throw new Error(req.message);
  const ap = await g.approve(req.value.requestId, REGISTRY, typedHost);
  if (!ap.ok) throw new Error(ap.message);
  const claim = await g.claim(client.keyId, req.value.requestId);
  if (!claim.ok || claim.value.status !== 'approved') throw new Error('claim failed');
  return { requestId: req.value.requestId, scopeId: claim.value.scopeId, claim: claim.value };
}

describe('approval codes', () => {
  it('are 6 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(makeApprovalCode((n) => new Uint8Array(randomBytes(n)))).toMatch(APPROVAL_CODE_RE);
    }
  });
});

describe('grants (minimal model)', () => {
  it('request → pending until the user approves → single claim returns a scope', async () => {
    const { grants } = setup();
    const req = await grants.createRequest(
      A,
      { instances: ['dev'], mode: 'single', purpose: 'look at INC1' },
      REGISTRY,
    );
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    expect(req.value.requestId).toMatch(REQUEST_ID_RE);
    expect(req.value.approvalCode).toMatch(APPROVAL_CODE_RE);
    expect(req.value.expiresInSeconds).toBe(300);
    expect(await grants.claim(A.keyId, req.value.requestId)).toEqual({
      ok: true,
      value: { status: 'pending' },
    });
    expect((await grants.snapshot()).pending).toHaveLength(1);
    expect((await grants.approve(req.value.requestId, REGISTRY)).ok).toBe(true);
    const claim = await grants.claim(A.keyId, req.value.requestId);
    expect(claim).toMatchObject({
      ok: true,
      value: { status: 'approved', instances: ['dev'], mode: 'single' },
    });
    if (claim.ok && claim.value.status === 'approved')
      expect(claim.value.scopeId).toMatch(SCOPE_ID_RE);
    // Second claim never returns a scope again.
    expect(await grants.claim(A.keyId, req.value.requestId)).toEqual({
      ok: true,
      value: { status: 'claimed' },
    });
  });

  it('stores only the hash of the scope id', async () => {
    const { grants, raw } = setup();
    const { scopeId } = await approvedScope(grants);
    expect(JSON.stringify(raw())).not.toContain(scopeId);
    expect(raw().grants[0]?.scopeHash).toBe(createHash('sha256').update(scopeId).digest('hex'));
  });

  it('another client cannot claim the request or use the scope', async () => {
    const { grants } = setup();
    const req = await grants.createRequest(
      A,
      { instances: ['dev'], mode: 'single', purpose: 'x' },
      REGISTRY,
    );
    if (!req.ok) throw new Error();
    await grants.approve(req.value.requestId, REGISTRY);
    expect(await grants.claim(B.keyId, req.value.requestId)).toEqual({
      ok: true,
      value: { status: 'expired' },
    });
    const claim = await grants.claim(A.keyId, req.value.requestId);
    if (!claim.ok || claim.value.status !== 'approved') throw new Error();
    expect(await grants.authorize(B.keyId, claim.value.scopeId, 'dev')).toMatchObject({
      ok: false,
      code: 'SCOPE_UNKNOWN',
    });
    expect((await grants.authorize(A.keyId, claim.value.scopeId, 'dev')).ok).toBe(true);
  });

  it('AC2: an operation without a valid grant is refused', async () => {
    const { grants, clock } = setup();
    expect(await grants.authorize(A.keyId, `scp_${'x'.repeat(22)}`, 'dev')).toMatchObject({
      ok: false,
      code: 'SCOPE_UNKNOWN',
    });
    expect(await grants.authorize(A.keyId, 'not-a-scope', 'dev')).toMatchObject({
      ok: false,
      code: 'SCOPE_UNKNOWN',
    });
    const { scopeId } = await approvedScope(grants);
    expect(await grants.authorize(A.keyId, scopeId, 'prod')).toMatchObject({
      ok: false,
      code: 'INSTANCE_NOT_IN_SCOPE',
    });
    clock.t += 4 * 60 * 60_000 + 1; // DEV default TTL 4 h
    expect(await grants.authorize(A.keyId, scopeId, 'dev')).toMatchObject({
      ok: false,
      code: 'SCOPE_EXPIRED',
    });
  });

  it('denied and expired requests never yield a scope', async () => {
    const { grants, clock } = setup();
    const r1 = await grants.createRequest(
      A,
      { instances: ['dev'], mode: 'single', purpose: 'x' },
      REGISTRY,
    );
    if (!r1.ok) throw new Error();
    await grants.deny(r1.value.requestId);
    expect(await grants.claim(A.keyId, r1.value.requestId)).toEqual({
      ok: true,
      value: { status: 'denied' },
    });
    expect((await grants.approve(r1.value.requestId, REGISTRY)).ok).toBe(false);

    const r2 = await grants.createRequest(
      A,
      { instances: ['dev'], mode: 'single', purpose: 'x' },
      REGISTRY,
    );
    if (!r2.ok) throw new Error();
    clock.t += 301_000;
    expect((await grants.approve(r2.value.requestId, REGISTRY)).ok).toBe(false);
    expect(await grants.claim(A.keyId, r2.value.requestId)).toEqual({
      ok: true,
      value: { status: 'expired' },
    });
  });

  it('PROD and unclassified approval needs the host typed exactly; TTL is 15 min', async () => {
    const { grants, clock } = setup();
    for (const alias of ['prod', 'unk']) {
      const req = await grants.createRequest(
        A,
        { instances: [alias], mode: 'single', purpose: 'x' },
        REGISTRY,
      );
      if (!req.ok) throw new Error();
      expect(await grants.approve(req.value.requestId, REGISTRY)).toMatchObject({
        ok: false,
        code: 'INVALID_INPUT',
      });
      expect(
        (await grants.approve(req.value.requestId, REGISTRY, 'wrong.service-now.com')).ok,
      ).toBe(false);
      expect(
        (
          await grants.approve(
            req.value.requestId,
            REGISTRY,
            ` ${alias.toUpperCase()}.service-now.com `,
          )
        ).ok,
      ).toBe(true);
    }
    const { scopeId, claim } = await approvedScope(grants, A, 'prod', 'prod.service-now.com');
    expect(Date.parse(claim.expiresAt) - clock.t).toBe(15 * 60_000);
    clock.t += 15 * 60_000 + 1;
    expect(await grants.authorize(A.keyId, scopeId, 'prod')).toMatchObject({
      ok: false,
      code: 'SCOPE_EXPIRED',
    });
  });

  it('rejects unregistered instances and (for now) compare mode', async () => {
    const { grants } = setup();
    expect(
      await grants.createRequest(
        A,
        { instances: ['nope'], mode: 'single', purpose: 'x' },
        REGISTRY,
      ),
    ).toMatchObject({
      ok: false,
      code: 'INSTANCE_NOT_REGISTERED',
    });
    expect(
      await grants.createRequest(
        A,
        { instances: ['dev', 'prod'], mode: 'compare', purpose: 'x' },
        REGISTRY,
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('release (client) and revoke (user) end access immediately', async () => {
    const { grants } = setup();
    const s1 = await approvedScope(grants);
    expect(await grants.release(B.keyId, s1.scopeId)).toBe(false);
    expect(await grants.release(A.keyId, s1.scopeId)).toBe(true);
    expect(await grants.authorize(A.keyId, s1.scopeId, 'dev')).toMatchObject({
      ok: false,
      code: 'SCOPE_UNKNOWN',
    });
    const s2 = await approvedScope(grants);
    const snap = await grants.snapshot();
    expect(snap.grants).toHaveLength(1);
    expect(snap.grants[0]?.scopeHash).toBe(''); // the UI never sees hashes
    expect(await grants.revoke(snap.grants[0]?.grantId as string)).toBe(true);
    expect(await grants.authorize(A.keyId, s2.scopeId, 'dev')).toMatchObject({
      ok: false,
      code: 'SCOPE_UNKNOWN',
    });
  });

  it('reports per-client status without exposing scope ids', async () => {
    const { grants } = setup();
    await approvedScope(grants);
    expect(await grants.clientStatus(A.keyId, 'dev')).toEqual({
      pendingRequest: false,
      activeGrant: true,
    });
    expect(await grants.clientStatus(B.keyId, 'dev')).toEqual({
      pendingRequest: false,
      activeGrant: false,
    });
  });

  it('serializes concurrent mutations (no lost updates)', async () => {
    const { grants } = setup();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        grants.createRequest(A, { instances: ['dev'], mode: 'single', purpose: 'x' }, REGISTRY),
      ),
    );
    expect((await grants.snapshot()).pending).toHaveLength(20);
  });
});
