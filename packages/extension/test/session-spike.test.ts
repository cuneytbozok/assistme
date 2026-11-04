import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  choosePath,
  countPath,
  type FetchOutcome,
  fingerprint,
  isAllowedSpikePath,
  QUERY_SEMANTICS_CASES,
  SPIKE_PATHS,
  summarizeBody,
  userPaths,
} from '../src/background/session.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const outcome = (o: Partial<FetchOutcome>): FetchOutcome => ({
  ok: false,
  status: 0,
  responseType: 'basic',
  contentType: '',
  totalCount: null,
  isJson: false,
  rows: null,
  ...o,
});
const json200 = outcome({ ok: true, status: 200, isJson: true, rows: 1 });
const html200 = outcome({ ok: true, status: 200, contentType: 'text/html' });
const s401 = outcome({ status: 401, isJson: true });

describe('spike paths', () => {
  it('all fixed and generated paths are Table/Stats API GET paths', () => {
    for (const p of Object.values(SPIKE_PATHS)) expect(isAllowedSpikePath(p), p).toBe(true);
    for (const c of QUERY_SEMANTICS_CASES)
      expect(isAllowedSpikePath(countPath(c.query)), c.id).toBe(true);
    const u = userPaths('admin');
    expect(isAllowedSpikePath(u.user)).toBe(true);
    expect(isAllowedSpikePath(u.sessions)).toBe(true);
  });

  it.each([
    '/api/now/table/incident/123?x=1',
    '/api/now/import/x?x=1',
    '/api/sn_sc/servicecatalog/items',
    '/nav_to.do?uri=incident.do',
    '//evil.example/api/now/table/x?y=1',
    '/api/now/table/incident?sysparm_query=a b',
    '/api/now/table/../x?y=1',
  ])('rejects %s', (p) => {
    expect(isAllowedSpikePath(p)).toBe(false);
  });

  it('encodes queries and validates user names', () => {
    expect(countPath('a=1^b=2')).toBe(
      '/api/now/table/sys_db_object?sysparm_limit=1&sysparm_fields=sys_id&sysparm_query=a%3D1%5Eb%3D2',
    );
    expect(() => userPaths('admin^ORname=x')).toThrow();
    expect(() => userPaths('')).toThrow();
  });
});

describe('summarizeBody', () => {
  it('keeps row counts and allowlisted samples only', () => {
    expect(
      summarizeBody({
        result: [{ sys_id: 'x', number: 'INC0010001', short_description: 'secret' }],
      }),
    ).toEqual({
      rows: 1,
      sample: 'number=INC0010001',
    });
    expect(summarizeBody({ result: { stats: { count: '42' } } })).toEqual({
      rows: 1,
      sample: 'count=42',
    });
    expect(
      summarizeBody({ error: { message: 'User Not Authenticated' }, status: 'failure' }),
    ).toEqual({
      rows: null,
      errorMessage: 'User Not Authenticated',
    });
    expect(summarizeBody('nope')).toEqual({ rows: null });
  });
});

describe('fingerprint', () => {
  it('is 8 hex chars and does not contain the value', async () => {
    const fp = await fingerprint('abcdef0123456789');
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).not.toContain('abcdef01');
    expect(await fingerprint('abcdef0123456789')).toBe(fp);
  });
});

describe('choosePath (ADR-002 decision rule)', () => {
  it('prefers path A when the service worker gets JSON', () => {
    expect(choosePath({ swWithCookies: json200 })).toBe('A');
    expect(choosePath({ swWithCookies: s401, swWithToken: json200 })).toBe('A');
  });
  it('falls back to path B when only the tab fetch works', () => {
    expect(choosePath({ swWithCookies: s401, swWithToken: s401, tabWithToken: json200 })).toBe('B');
  });
  it('treats HTML login pages as failure', () => {
    expect(choosePath({ swWithCookies: html200, tabWithToken: html200 })).toBe('none');
  });
});

describe('build flag', () => {
  const dirs: string[] = [];
  const buildTo = (diag: boolean) => {
    const out = mkdtempSync(join(tmpdir(), 'sn-mcp-build-'));
    dirs.push(out);
    execFileSync(process.execPath, ['build.mjs'], {
      cwd: root,
      env: { ...process.env, OUT_DIR: out, DEV_DIAGNOSTICS: diag ? '1' : '' },
      stdio: 'pipe',
    });
    return out;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('release build contains no diagnostics page or spike code', () => {
    const out = buildTo(false);
    expect(existsSync(join(out, 'diagnostics.html'))).toBe(false);
    expect(existsSync(join(out, 'diagnostics.js'))).toBe(false);
    for (const f of ['background.js', 'popup.js']) {
      const js = readFileSync(join(out, f), 'utf8');
      expect(js, f).not.toContain('diagnostics.run');
      expect(js, f).not.toContain('X-UserToken');
      expect(js, f).not.toContain('g_ck');
    }
  });

  it('diagnostics build includes the page and handler', () => {
    const out = buildTo(true);
    expect(existsSync(join(out, 'diagnostics.html'))).toBe(true);
    expect(readFileSync(join(out, 'background.js'), 'utf8')).toContain('diagnostics.run');
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).permissions).not.toContain(
      'cookies',
    );
  });
});
