/**
 * T-020 (server side): denied tables (also via dot-walk), password-type fields refused and
 * stripped from output, even when all fields are returned. Mocked dictionary.
 */
import { DEFAULT_DENIED_TABLES, isDeniedTable, isSensitiveFieldName } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGH_VOLUME_TABLES, loadConfig } from '../src/config.js';
import { stripSensitive } from '../src/mcp/compact.js';
import { type MetaContext, MetadataService } from '../src/mcp/metadata.js';
import { planQuery, type QueryRequest } from '../src/mcp/query-guard.js';
import { dictionaryFixture } from './fake-sn.js';

function setup(extra: string[] = []) {
  const sn = dictionaryFixture();
  const ctx: MetaContext = {
    instanceKey: 'dev',
    fetch: async (req) => ({ ok: true, rows: sn.list(req).rows }),
  };
  const meta = new MetadataService();
  return {
    sn,
    ctx,
    meta,
    plan: (req: QueryRequest) =>
      planQuery(meta, ctx, req, {
        highVolumeTables: DEFAULT_HIGH_VOLUME_TABLES,
        extraDeniedTables: extra,
      }),
  };
}

describe('AC1: denied tables are refused, including via dot-walk', () => {
  it.each([
    'discovery_credentials',
    'sys_auth_profile_basic',
    'oauth_entity',
    'oauth_entity_profile',
    'sys_certificate',
    'sys_user_token',
    'sys_credentials_alias',
  ])('%s → TABLE_DENIED before any metadata read', async (table) => {
    const s = setup();
    await expect(s.plan({ table })).rejects.toMatchObject({ code: 'TABLE_DENIED' });
    expect(s.sn.calls).toEqual([]);
  });

  it('extra patterns from config add to the defaults', async () => {
    const s = setup(['u_api_*']);
    await expect(s.plan({ table: 'u_api_config' })).rejects.toMatchObject({ code: 'TABLE_DENIED' });
    expect(
      loadConfig({ SN_MCP_DENIED_TABLES: 'u_vault, x_acme_* ,bad;pattern, x_*_mid' })
        .extraDeniedTables,
    ).toEqual(['u_vault', 'x_acme_*']);
    expect(loadConfig({}).extraDeniedTables).toEqual([]);
  });

  it('a dot-walk into a denied table is refused (fields, conditions, order)', async () => {
    const s = setup();
    for (const req of [
      { table: 'incident', fields: ['u_cred_ref.name'] },
      { table: 'incident', where: [{ field: 'u_cred_ref.name', op: '=' as const, value: 'x' }] },
      { table: 'incident', order_by: [{ field: 'u_cred_ref.name', direction: 'asc' as const }] },
    ]) {
      await expect(s.plan(req)).rejects.toMatchObject({
        code: 'TABLE_DENIED',
        message: expect.stringContaining('discovery_credentials'),
      });
    }
    // The reference field itself (a sys_id) is fine.
    await expect(s.plan({ table: 'incident', fields: ['u_cred_ref'] })).resolves.toBeDefined();
  });

  it('the default list covers the task examples and is shared with the extension', () => {
    for (const p of [
      'discovery_credentials*',
      'sys_auth_profile*',
      'oauth_entity*',
      'sys_certificate*',
      'sys_user_token',
      'sys_credentials*',
    ]) {
      expect(DEFAULT_DENIED_TABLES).toContain(p);
    }
    expect(isDeniedTable('incident')).toBe(false);
    expect(isDeniedTable('sys_user')).toBe(false);
  });
});

describe('AC2: password-type fields never appear in output', () => {
  it('requesting or filtering on a password field is refused (dictionary type and name)', async () => {
    const s = setup();
    for (const req of [
      { table: 'sys_user', fields: ['user_password'] },
      { table: 'incident', fields: ['caller_id.user_password'] },
      { table: 'sys_user', where: [{ field: 'user_password', op: 'is_not_empty' as const }] },
      { table: 'u_api_config', fields: ['u_auth'] }, // type password2, innocuous name
    ]) {
      await expect(s.plan(req)).rejects.toMatchObject({ code: 'FORBIDDEN_OPERATION' });
    }
  });

  it('stripSensitive removes password types and credential names, reporting names only', async () => {
    const s = setup();
    const fields = await s.meta.fields(s.ctx, 'u_api_config');
    const { records, stripped } = stripSensitive(
      [
        {
          sys_id: '1',
          u_label: 'Payments',
          u_endpoint: 'https://x',
          u_auth: 'hunter2',
          u_password: 'p',
          'caller_id.user_password': 'q',
        },
        { sys_id: '2', u_label: 'CRM', u_auth: { value: 's3cret', display_value: '********' } },
      ],
      fields,
    );
    expect(stripped).toEqual(['caller_id.user_password', 'u_auth', 'u_password']);
    expect(JSON.stringify(records)).not.toMatch(/hunter2|s3cret|\*{8}|"p"|"q"/);
    expect(records).toEqual([
      { sys_id: '1', u_label: 'Payments', u_endpoint: 'https://x' },
      { sys_id: '2', u_label: 'CRM' },
    ]);
  });

  it('name fallback helper', () => {
    for (const f of [
      'user_password',
      'password2',
      'u_api_key',
      'client_secret',
      'a.b.private_key',
      'credentials',
    ]) {
      expect(isSensitiveFieldName(f), f).toBe(true);
    }
    for (const f of [
      'number',
      'description',
      'u_secretary',
      'password_needs_reset',
      'token_count',
    ]) {
      expect(isSensitiveFieldName(f), f).toBe(false);
    }
  });
});
