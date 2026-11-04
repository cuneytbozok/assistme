import { describe, expect, it } from 'vitest';
import {
  effectiveEnv,
  type InstanceEntry,
  looksLikeServiceNow,
  MAX_INSTANCES,
  originPattern,
  parseInstanceHost,
  Registry,
  type RegistryStorage,
  sanitizeStored,
  validateNewEntry,
} from '../src/background/registry.js';

function memoryStorage(initial: unknown = undefined): RegistryStorage & { data: unknown } {
  const s = {
    data: initial,
    async load() {
      return s.data;
    },
    async save(entries: InstanceEntry[]) {
      s.data = structuredClone(entries);
    },
  };
  return s;
}

const NOW = new Date('2026-11-04T12:00:00Z');
const entry = (alias: string, host: string, env: InstanceEntry['env'] = 'dev'): InstanceEntry => ({
  alias,
  host,
  label: '',
  env,
  addedAt: NOW.toISOString(),
});

describe('parseInstanceHost', () => {
  it.each([
    ['dev123.service-now.com', 'dev123.service-now.com'],
    ['https://dev123.service-now.com', 'dev123.service-now.com'],
    [
      'https://DEV123.Service-Now.com/now/nav/ui/classic/params/target/incident.do',
      'dev123.service-now.com',
    ],
    ['  https://acme.service-now.com/nav_to.do?uri=x  ', 'acme.service-now.com'],
    ['https://servicenow.acme.example/', 'servicenow.acme.example'],
  ])('accepts %s', (input, host) => {
    expect(parseInstanceHost(input)).toEqual({ ok: true, value: host });
  });

  it.each([
    '',
    'http://dev123.service-now.com',
    'ftp://dev123.service-now.com',
    'javascript:alert(1)',
    'https://user:pw@dev123.service-now.com',
    'https://dev123.service-now.com:8443',
    'https://localhost',
    'https://10.0.0.1',
    '10.0.0.1',
    'https://192.168.1.20/now',
    'https://*.service-now.com',
    'https://exa mple.com',
    'chrome-extension://abc/',
  ])('rejects %s', (input) => {
    expect(parseInstanceHost(input).ok).toBe(false);
  });
});

describe('originPattern', () => {
  it('requests exactly one https origin', () => {
    expect(originPattern('dev123.service-now.com')).toBe('https://dev123.service-now.com/*');
  });

  it.each([
    '*.service-now.com',
    'a',
    '',
    'dev.service-now.com/x',
    'dev.service-now.com:443',
    '10.0.0.1',
  ])('refuses %s', (host) => {
    expect(() => originPattern(host)).toThrow();
  });
});

describe('validateNewEntry', () => {
  const existing = [entry('dev', 'dev1.service-now.com')];

  it('accepts a valid entry and trims alias/label', () => {
    const r = validateNewEntry(
      existing,
      { alias: ' prod ', host: 'acme.service-now.com', label: ' Main ', env: 'prod' },
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      value: {
        alias: 'prod',
        host: 'acme.service-now.com',
        label: 'Main',
        env: 'prod',
        addedAt: NOW.toISOString(),
      },
    });
  });

  it.each([
    [{ alias: 'Dev2', host: 'x.service-now.com', env: 'dev' }, /Alias/],
    [{ alias: '2dev', host: 'x.service-now.com', env: 'dev' }, /Alias/],
    [{ alias: 'dev', host: 'x.service-now.com', env: 'dev' }, /already used/],
    [{ alias: 'dev2', host: 'dev1.service-now.com', env: 'dev' }, /already registered/],
    [{ alias: 'dev2', host: 'x.service-now.com', env: 'staging' }, /environment/],
    [{ alias: 'dev2', host: 'not a host', env: 'dev' }, /Invalid host/],
    [{ alias: 'dev2', host: 'x.service-now.com', env: 'dev', label: 'a\u0007b' }, /control/],
    [{ alias: 'dev2', host: 'x.service-now.com', env: 'dev', label: 'x'.repeat(81) }, /Label/],
  ])('rejects %o', (input, message) => {
    const r = validateNewEntry(existing, input, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('caps the number of instances', () => {
    const many = Array.from({ length: MAX_INSTANCES }, (_, i) =>
      entry(`i${i}`, `i${i}.service-now.com`),
    );
    const r = validateNewEntry(many, { alias: 'extra', host: 'x.service-now.com', env: 'dev' });
    expect(r.ok).toBe(false);
  });
});

describe('sanitizeStored', () => {
  it('drops malformed and duplicate entries', () => {
    const good = entry('dev', 'dev1.service-now.com');
    expect(
      sanitizeStored([
        good,
        { ...good }, // duplicate alias
        { ...good, alias: 'other' }, // duplicate host
        { ...good, alias: 'BAD', host: 'x.service-now.com' },
        { ...good, alias: 'x', host: 'x.service-now.com', env: 'staging' },
        { ...good, alias: 'y', host: 'y.service-now.com', label: 42 },
        null,
        'dev',
      ]),
    ).toEqual([good]);
    expect(sanitizeStored(undefined)).toEqual([]);
    expect(sanitizeStored({ dev: good })).toEqual([]);
  });

  it('strips unknown properties from stored entries', () => {
    const stored = [{ ...entry('dev', 'dev1.service-now.com'), scopeId: 'leak' }];
    expect(sanitizeStored(stored)[0]).not.toHaveProperty('scopeId');
  });
});

describe('Registry', () => {
  it('adds, lists and removes entries via storage', async () => {
    const storage = memoryStorage();
    const reg = new Registry(storage);
    expect(await reg.list()).toEqual([]);
    expect((await reg.add(entry('dev', 'dev1.service-now.com'))).ok).toBe(true);
    expect((await reg.add(entry('dev', 'dev2.service-now.com'))).ok).toBe(false);
    expect((await reg.add(entry('prod', 'acme.service-now.com', 'prod'))).ok).toBe(true);
    expect((await reg.list()).map((e) => e.alias)).toEqual(['dev', 'prod']);
    expect((await reg.remove('dev'))?.host).toBe('dev1.service-now.com');
    expect(await reg.remove('missing')).toBeUndefined();
    expect((await reg.list()).map((e) => e.alias)).toEqual(['prod']);
  });

  it('does not trust tampered storage', async () => {
    const reg = new Registry(memoryStorage([{ alias: 'x', host: 'https://evil/*' }]));
    expect(await reg.list()).toEqual([]);
  });
});

describe('helpers', () => {
  it('treats unclassified as prod', () => {
    expect(effectiveEnv('unclassified')).toBe('prod');
    expect(effectiveEnv('dev')).toBe('dev');
    expect(effectiveEnv('test')).toBe('test');
    expect(effectiveEnv('prod')).toBe('prod');
  });

  it('recognises ServiceNow-hosted names only as a hint', () => {
    expect(looksLikeServiceNow('dev1.service-now.com')).toBe(true);
    expect(looksLikeServiceNow('service-now.com.evil.example')).toBe(false);
    expect(looksLikeServiceNow('servicenow.acme.example')).toBe(false);
  });
});
