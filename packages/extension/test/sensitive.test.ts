/**
 * T-020 (extension side, the enforcement point): denied tables, credential field names in
 * requests, and name-based stripping of responses. Mocks only.
 */
import { DEFAULT_DENIED_TABLES } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { Executor, type TokenProvider } from '../src/background/executor.js';
import {
  buildRequest,
  RequestBuildError,
  revalidate,
  stripSensitiveKeys,
} from '../src/background/request-builder.js';
import { validateState } from '../src/background/settings.js';

const HOST = 'dev.service-now.com';
const list = (extra: Record<string, unknown> = {}) => ({
  kind: 'table.list',
  table: 'incident',
  limit: 5,
  offset: 0,
  displayValue: 'false',
  noCount: true,
  ...extra,
});
const tokens: TokenProvider = { get: async () => 'tok', clear: () => {} };

describe('denied tables → TABLE_DENIED (AC1)', () => {
  it.each([
    'discovery_credentials',
    'discovery_credentials_ssh',
    'sys_auth_profile_basic',
    'oauth_entity',
    'sys_certificate',
    'sys_user_token',
    'sys_credentials',
  ])('%s', (table) => {
    for (const op of [
      list({ table }),
      { kind: 'table.get', table, sysId: 'a'.repeat(32), displayValue: 'all' },
      { kind: 'stats.aggregate', table, displayValue: 'false' },
    ]) {
      expect(revalidate(op)).toMatchObject({ ok: false, code: 'TABLE_DENIED' });
      expect(() => buildRequest(HOST, op, 't')).toThrow(RequestBuildError);
    }
  });

  it('extra patterns add to the defaults; the defaults cannot be removed', () => {
    expect(revalidate(list({ table: 'u_vault' }), ['u_vault'])).toMatchObject({
      code: 'TABLE_DENIED',
    });
    expect(revalidate(list({ table: 'u_vault' })).ok).toBe(true);
    // Passing an empty extra list never re-enables a default.
    expect(revalidate(list({ table: 'sys_user_token' }), [])).toMatchObject({
      code: 'TABLE_DENIED',
    });
    expect(DEFAULT_DENIED_TABLES.length).toBeGreaterThan(10);
  });

  it('settings validate extra patterns', () => {
    expect(
      validateState({
        global: {},
        perInstance: {},
        extraDeniedTables: ['u_vault', 'x_acme_*', 'u_vault'],
      }),
    ).toMatchObject({
      ok: true,
      value: { extraDeniedTables: ['u_vault', 'x_acme_*'] },
    });
    for (const bad of [['a b'], ['x_*_y'], ['../x'], 'u_vault', [1]]) {
      expect(
        validateState({ global: {}, perInstance: {}, extraDeniedTables: bad }).ok,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('the executor applies the user extras', async () => {
    let calls = 0;
    const ex = new Executor({
      tokens,
      extraDeniedTables: async () => ['u_vault*'],
      fetch: (async () => {
        calls++;
        return new Response('{"result":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    expect(await ex.run(HOST, list({ table: 'u_vault_items' }))).toMatchObject({
      ok: false,
      code: 'TABLE_DENIED',
    });
    expect(calls).toBe(0);
  });
});

describe('credential field names (AC2)', () => {
  it.each([
    ['fields', list({ fields: ['number', 'user_password'] })],
    ['dot-walked field', list({ fields: ['caller_id.user_password'] })],
    ['condition', list({ query: 'user_passwordISNOTEMPTY' })],
    ['order', list({ query: 'ORDERBYu_api_key' })],
    [
      'group by',
      { kind: 'stats.aggregate', table: 'sys_user', groupBy: ['password2'], displayValue: 'false' },
    ],
    [
      'aggregate',
      {
        kind: 'stats.aggregate',
        table: 'sys_user',
        aggregates: [{ fn: 'max', field: 'u_client_secret' }],
        displayValue: 'false',
      },
    ],
    [
      'get fields',
      {
        kind: 'table.get',
        table: 'sys_user',
        sysId: 'a'.repeat(32),
        fields: ['user_password'],
        displayValue: 'all',
      },
    ],
  ])('refused in %s', (_n, op) => {
    expect(revalidate(op)).toMatchObject({ ok: false, code: 'FORBIDDEN_OPERATION' });
  });

  it('responses are stripped of credential-like keys, also with all fields (no sysparm_fields)', async () => {
    const ex = new Executor({
      tokens,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            result: [
              {
                sys_id: '1',
                user_name: 'admin',
                user_password: 'hunter2',
                'manager.user_password': 'x',
                u_api_key: 'k',
              },
              { sys_id: '2', user_name: 'bob', password2: { value: 'v', display_value: '***' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    const r = await ex.run(HOST, list({ table: 'sys_user' }));
    expect(r.ok && r.body).toEqual([
      { sys_id: '1', user_name: 'admin' },
      { sys_id: '2', user_name: 'bob' },
    ]);
    expect(stripSensitiveKeys({ sys_id: 'x', secret: 's' })).toEqual({ sys_id: 'x' });
  });
});
