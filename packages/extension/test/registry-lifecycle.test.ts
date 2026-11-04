/**
 * T-010: registry CRUD through the popup API, grant invalidation on registry changes, env
 * policy for unclassified instances, and tab suggestions. Chrome APIs are stubbed (mocks; not
 * evidence of ServiceNow connectivity).
 */
import { createHash, randomBytes } from 'node:crypto';
import { GRANT_TTL_MINUTES } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { handleForward } from '../src/background/authz.js';
import { type GrantStorage, Grants } from '../src/background/grants.js';
import { handlePopupMessage } from '../src/background/popup-api.js';
import {
  type InstanceEntry,
  Registry,
  type RegistryStorage,
  suggestionFromTabUrl,
  validateEdit,
} from '../src/background/registry.js';

const A = { keyId: 'a'.repeat(64), label: { name: 'claude-desktop', pid: 101 } };
const op = {
  kind: 'table.list',
  table: 'incident',
  limit: 1,
  offset: 0,
  displayValue: 'false',
  noCount: true,
};

function setup(granted = new Set<string>()) {
  let regData: unknown;
  const regStorage: RegistryStorage = {
    load: async () => structuredClone(regData),
    save: async (e) => {
      regData = structuredClone(e);
    },
  };
  let grantData: unknown;
  const grantStorage: GrantStorage = {
    load: async () => structuredClone(grantData),
    save: async (s) => {
      grantData = structuredClone(s);
    },
  };
  const clock = { t: Date.parse('2026-11-04T12:00:00Z') };
  const grants = new Grants(grantStorage, {
    now: () => clock.t,
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    sha256Hex: async (s) => createHash('sha256').update(s).digest('hex'),
  });
  const registry = new Registry(regStorage);
  const removedPermissions: string[] = [];
  const executed: string[] = [];
  const popup = {
    grants,
    registry: () => registry.list(),
    registryStore: registry,
    hasPermission: async (o: string) => granted.has(o),
    removePermission: async (o: string) => {
      removedPermissions.push(o);
      return granted.delete(o);
    },
    bridgeState: () => ({ state: 'connected' as const }),
    onChanged: () => undefined,
  };
  const authz = {
    grants,
    registry: () => registry.list(),
    hasPermission: async (o: string) => granted.has(o),
    execute: async (host: string) => {
      executed.push(host);
      return { ok: true as const, status: 200, body: [], bytes: 2 };
    },
  };
  const fwd = (request: Record<string, unknown>) => ({
    v: 1,
    kind: 'forward',
    client: A,
    request: { v: 1, ...request },
  });
  let n = 0;
  const id = () => `t${++n}`;

  async function add(alias: string, host: string, env: string, label = '') {
    granted.add(`https://${host}/*`);
    return handlePopupMessage(
      { type: 'popup.registry.add', entry: { alias, host, env, label } },
      popup,
    ) as Promise<{ ok: boolean; message?: string }>;
  }

  async function requestScope(alias: string) {
    const r = await handleForward(
      fwd({ kind: 'scope.request', id: id(), instances: [alias], mode: 'single', purpose: 'p' }),
      authz,
    );
    return (r as { result: { requestId: string } }).result.requestId;
  }

  async function scope(alias: string, typedHost?: string) {
    const requestId = await requestScope(alias);
    const ap = await grants.approve(requestId, await registry.list(), typedHost);
    if (!ap.ok) throw new Error(ap.message);
    const c = await handleForward(fwd({ kind: 'scope.claim', id: id(), requestId }), authz);
    return (c as { result: { scopeId: string; expiresAt: string } }).result;
  }

  const read = (scopeId: string, instance: string) =>
    handleForward(fwd({ kind: 'sn.op', id: id(), scopeId, instance, op }), authz);

  return {
    grants,
    registry,
    regStorage,
    popup,
    authz,
    clock,
    executed,
    removedPermissions,
    granted,
    add,
    scope,
    requestScope,
    read,
    claim: (requestId: string) =>
      handleForward(fwd({ kind: 'scope.claim', id: id(), requestId }), authz),
  };
}

describe('registry CRUD via the popup API (AC1)', () => {
  it('adds, edits and removes entries, and the result persists in storage', async () => {
    const s = setup();
    expect(await s.add('dev', 'dev1.service-now.com', 'dev', 'Dev')).toMatchObject({ ok: true });
    expect(await s.add('acme', 'servicenow.acme.example', 'unclassified')).toMatchObject({
      ok: true,
    });
    const edited = await handlePopupMessage(
      { type: 'popup.registry.edit', alias: 'dev', label: 'Dev box', env: 'test' },
      s.popup,
    );
    expect(edited).toMatchObject({ ok: true, entry: { label: 'Dev box', env: 'test' } });

    // A fresh Registry on the same storage sees the change (persistence).
    const reread = new Registry(s.regStorage);
    expect((await reread.list()).map((e) => [e.alias, e.host, e.label, e.env])).toEqual([
      ['dev', 'dev1.service-now.com', 'Dev box', 'test'],
      ['acme', 'servicenow.acme.example', '', 'unclassified'],
    ]);

    expect(
      await handlePopupMessage(
        { type: 'popup.registry.remove', alias: 'acme', removeHostPermission: false },
        s.popup,
      ),
    ).toMatchObject({ ok: true, permissionRemoved: false });
    expect((await reread.list()).map((e) => e.alias)).toEqual(['dev']);
    expect(s.removedPermissions).toEqual([]);
  });

  it('refuses entries without granted host permission, duplicates, and bad input', async () => {
    const s = setup();
    expect(
      await handlePopupMessage(
        {
          type: 'popup.registry.add',
          entry: { alias: 'dev', host: 'x.service-now.com', env: 'dev' },
        },
        s.popup,
      ),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/not granted/) });
    expect(await s.add('dev', 'dev1.service-now.com', 'dev')).toMatchObject({ ok: true });
    expect(await s.add('dev', 'dev2.service-now.com', 'dev')).toMatchObject({ ok: false });
    expect(await s.add('dev2', 'dev1.service-now.com', 'dev')).toMatchObject({ ok: false });
    expect(await s.add('Dev', 'dev3.service-now.com', 'dev')).toMatchObject({ ok: false });
    expect(
      await handlePopupMessage(
        { type: 'popup.registry.edit', alias: 'dev', env: 'staging' },
        s.popup,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await handlePopupMessage({ type: 'popup.registry.edit', alias: 'nope', label: 'x' }, s.popup),
    ).toMatchObject({ ok: false });
    expect(
      await handlePopupMessage(
        { type: 'popup.registry.remove', alias: 'nope', removeHostPermission: true },
        s.popup,
      ),
    ).toMatchObject({ ok: false });
  });

  it('edit never changes alias or host', async () => {
    const s = setup();
    await s.add('dev', 'dev1.service-now.com', 'dev');
    await handlePopupMessage(
      {
        type: 'popup.registry.edit',
        alias: 'dev',
        label: 'x',
        host: 'evil.example',
        newAlias: 'prod',
      },
      s.popup,
    );
    expect(await s.registry.list()).toMatchObject([{ alias: 'dev', host: 'dev1.service-now.com' }]);
  });

  it('serializes concurrent adds (no lost update)', async () => {
    const s = setup();
    const results = await Promise.all(
      ['a1', 'a2', 'a3', 'a4'].map((a) => s.add(a, `${a}.service-now.com`, 'dev')),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await s.registry.list()).map((e) => e.alias)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });
});

describe('grant invalidation on registry changes (AC2)', () => {
  it('removing an instance ends its grants immediately, even if re-added with another host', async () => {
    const s = setup();
    await s.add('dev', 'dev1.service-now.com', 'dev');
    await s.add('other', 'other.service-now.com', 'dev');
    const { scopeId } = await s.scope('dev');
    const otherScope = await s.scope('other');
    expect(await s.read(scopeId, 'dev')).toMatchObject({ ok: true });

    const removed = await handlePopupMessage(
      { type: 'popup.registry.remove', alias: 'dev', removeHostPermission: true },
      s.popup,
    );
    expect(removed).toMatchObject({ ok: true, invalidated: 1, permissionRemoved: true });
    expect(s.removedPermissions).toEqual(['https://dev1.service-now.com/*']);
    expect(await s.read(scopeId, 'dev')).toMatchObject({
      ok: false,
      error: { code: 'SCOPE_UNKNOWN' },
    });

    // Same alias, different host: the old scope must not follow the alias to the new host.
    await s.add('dev', 'dev2.service-now.com', 'dev');
    expect(await s.read(scopeId, 'dev')).toMatchObject({
      ok: false,
      error: { code: 'SCOPE_UNKNOWN' },
    });
    expect(s.executed).toEqual(['dev1.service-now.com']);

    // Grants for other instances are untouched.
    expect(await s.read(otherScope.scopeId, 'other')).toMatchObject({ ok: true });
  });

  it('removing an instance denies its open requests', async () => {
    const s = setup();
    await s.add('dev', 'dev1.service-now.com', 'dev');
    const pending = await s.requestScope('dev');
    const approved = await s.requestScope('dev');
    await s.grants.approve(approved, await s.registry.list());
    await handlePopupMessage(
      { type: 'popup.registry.remove', alias: 'dev', removeHostPermission: false },
      s.popup,
    );
    expect(await s.claim(pending)).toMatchObject({ result: { status: 'denied' } });
    expect(await s.claim(approved)).toMatchObject({ result: { status: 'denied' } });
    expect((await s.grants.snapshot()).pending).toEqual([]);
  });

  it('an env change ends grants; a label-only edit keeps them', async () => {
    const s = setup();
    await s.add('dev', 'dev1.service-now.com', 'dev');
    const { scopeId } = await s.scope('dev');
    expect(
      await handlePopupMessage(
        { type: 'popup.registry.edit', alias: 'dev', label: 'Renamed' },
        s.popup,
      ),
    ).toMatchObject({ ok: true, invalidated: 0 });
    expect(await s.read(scopeId, 'dev')).toMatchObject({ ok: true });

    expect(
      await handlePopupMessage({ type: 'popup.registry.edit', alias: 'dev', env: 'prod' }, s.popup),
    ).toMatchObject({ ok: true, invalidated: 1 });
    expect(await s.read(scopeId, 'dev')).toMatchObject({
      ok: false,
      error: { code: 'SCOPE_UNKNOWN' },
    });
  });

  it('authorization re-checks the binding even if reconcile never ran (storage written directly)', async () => {
    const s = setup();
    await s.add('dev', 'dev1.service-now.com', 'dev');
    const { scopeId } = await s.scope('dev');
    // Simulate a direct storage write that bypasses the popup API.
    const entries = await s.registry.list();
    await s.regStorage.save(entries.map((e) => ({ ...e, env: 'prod' as const })));
    expect(await s.read(scopeId, 'dev')).toMatchObject({
      ok: false,
      error: { code: 'SCOPE_UNKNOWN', message: expect.stringMatching(/changed after approval/) },
    });
    expect(s.executed).toEqual([]);
  });

  it('removing the host permission outside the popup blocks reads', async () => {
    const s = setup();
    await s.add('dev', 'dev1.service-now.com', 'dev');
    const { scopeId } = await s.scope('dev');
    s.granted.clear();
    expect(await s.read(scopeId, 'dev')).toMatchObject({
      ok: false,
      error: { code: 'INSTANCE_NOT_REGISTERED' },
    });
  });
});

describe('unclassified is treated as PROD in policy checks (AC3)', () => {
  it('requires typing the host and gets the PROD TTL', async () => {
    const s = setup();
    await s.add('unk', 'acme.service-now.com', 'unclassified');
    const requestId = await s.requestScope('unk');
    const regs = await s.registry.list();
    expect(await s.grants.approve(requestId, regs)).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await s.grants.approve(requestId, regs, 'wrong.service-now.com')).toMatchObject({
      ok: false,
    });
    expect(await s.grants.approve(requestId, regs, ' ACME.service-now.com ')).toMatchObject({
      ok: true,
    });
    const claim = (await s.claim(requestId)) as { result: { expiresAt: string } };
    expect(Date.parse(claim.result.expiresAt) - s.clock.t).toBe(
      GRANT_TTL_MINUTES.prod.default * 60_000,
    );
  });

  it('DEV gets the DEV TTL without typing the host', async () => {
    const s = setup();
    await s.add('dev', 'dev1.service-now.com', 'dev');
    const { expiresAt } = await s.scope('dev');
    expect(Date.parse(expiresAt) - s.clock.t).toBe(GRANT_TTL_MINUTES.dev.default * 60_000);
  });
});

describe('list_instances source reflects changes without a restart (AC4, extension side)', () => {
  it('registry.get reads the current registry on every call', async () => {
    const s = setup();
    const get = async () =>
      (
        (await handleForward(
          { v: 1, kind: 'forward', client: A, request: { v: 1, kind: 'registry.get', id: 'g' } },
          s.authz,
        )) as { result: { instances: { alias: string; env: string }[] } }
      ).result.instances.map((i) => `${i.alias}:${i.env}`);
    expect(await get()).toEqual([]);
    await s.add('dev', 'dev1.service-now.com', 'dev');
    expect(await get()).toEqual(['dev:dev']);
    await handlePopupMessage({ type: 'popup.registry.edit', alias: 'dev', env: 'test' }, s.popup);
    expect(await get()).toEqual(['dev:test']);
    await handlePopupMessage(
      { type: 'popup.registry.remove', alias: 'dev', removeHostPermission: false },
      s.popup,
    );
    expect(await get()).toEqual([]);
  });
});

describe('tab suggestions (AC5)', () => {
  const reg: InstanceEntry[] = [
    { alias: 'dev', host: 'dev1.service-now.com', label: '', env: 'dev', addedAt: 'x' },
  ];
  it.each([
    ['https://dev2.service-now.com/now/nav/ui/classic', 'dev2.service-now.com'],
    ['https://ACME.service-now.com/incident_list.do', 'acme.service-now.com'],
    ['https://gov.servicenowservices.com/', 'gov.servicenowservices.com'],
    ['https://itsm.acme.example/now/sow/home', 'itsm.acme.example'],
    ['https://itsm.acme.example/nav_to.do?uri=incident.do', 'itsm.acme.example'],
  ])('%s → %s', (url, host) => {
    expect(suggestionFromTabUrl(url, reg)).toBe(host);
  });

  it.each([
    [undefined],
    [''],
    ['chrome://extensions'],
    ['http://dev2.service-now.com/'],
    ['https://dev1.service-now.com/now/nav/ui'], // already registered
    ['https://www.google.com/search?q=servicenow'],
    ['https://dev2.service-now.com:8443/'],
    ['https://10.0.0.1/now/nav/ui'],
    ['https://user:pw@dev2.service-now.com/'],
    ['not a url'],
  ])('%s → no suggestion', (url) => {
    expect(suggestionFromTabUrl(url, reg)).toBeUndefined();
  });

  it('suggesting never registers anything', async () => {
    const s = setup();
    expect(suggestionFromTabUrl('https://dev2.service-now.com/', [])).toBe('dev2.service-now.com');
    expect(await s.registry.list()).toEqual([]);
  });
});

describe('validateEdit', () => {
  const reg: InstanceEntry[] = [
    { alias: 'dev', host: 'dev1.service-now.com', label: 'a', env: 'dev', addedAt: 'x' },
  ];
  it('validates labels like registration does', () => {
    expect(validateEdit(reg, 'dev', { label: 'x'.repeat(81) }).ok).toBe(false);
    expect(validateEdit(reg, 'dev', { label: 'bad\u0007' }).ok).toBe(false);
    expect(validateEdit(reg, 'dev', { label: '  ok  ' })).toMatchObject({
      ok: true,
      value: { after: { label: 'ok', env: 'dev' } },
    });
  });
  it('matches aliases exactly', () => {
    expect(validateEdit(reg, 'DEV', { label: 'x' }).ok).toBe(false);
    expect(validateEdit(reg, 'de', { label: 'x' }).ok).toBe(false);
  });
});
