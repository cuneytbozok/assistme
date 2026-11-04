import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ALL_WIRE_SCHEMAS,
  BrokerToClientSchema,
  BrokerToExtensionSchema,
  ClientToBrokerSchema,
  DEFAULT_HINTS,
  ERROR_CODES,
  ExtensionToBrokerSchema,
  OperationSchema,
  protocolError,
  RegistryUpdateSchema,
  ScopeRequestSchema,
} from '../src/index.js';
import { FIXTURES, REQUEST_ID, SCOPE_ID, SYS_ID } from './fixtures.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * Every path to a plain object inside a value. The `body` subtree of sn.op results is
 * ServiceNow record data (z.unknown by design) and is skipped.
 */
function objectPaths(value: Json, path: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== 'object') return [];
  const out: (string | number)[][] = [];
  if (!Array.isArray(value)) out.push(path);
  const entries: [string | number, Json][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value);
  for (const [k, v] of entries) {
    if (k === 'body') continue;
    out.push(...objectPaths(v, [...path, k]));
  }
  return out;
}

function withKeyAt(value: Json, path: (string | number)[], key: string, keyValue: Json): Json {
  const copy = clone(value);
  let node: Json = copy;
  for (const p of path) node = (node as Record<string | number, Json>)[p] as Json;
  (node as Record<string, Json>)[key] = keyValue;
  return copy;
}

/** Collect every property name declared anywhere in a zod schema tree (zod v4 internals). */
function declaredKeys(schema: z.ZodType, seen = new Set<unknown>(), out = new Set<string>()) {
  if (seen.has(schema)) return out;
  seen.add(schema);
  // biome-ignore lint/suspicious/noExplicitAny: walking zod internals in a test only
  const def = (schema as any)._zod.def;
  switch (def.type) {
    case 'object':
      for (const [k, child] of Object.entries(def.shape)) {
        out.add(k);
        declaredKeys(child as z.ZodType, seen, out);
      }
      break;
    case 'union':
      for (const o of def.options) declaredKeys(o, seen, out);
      break;
    case 'array':
      declaredKeys(def.element, seen, out);
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
      declaredKeys(def.innerType, seen, out);
      break;
    case 'pipe':
      declaredKeys(def.in, seen, out);
      declaredKeys(def.out, seen, out);
      break;
    default:
      break;
  }
  return out;
}

const FORBIDDEN_KEY_RE = /cookie|header|url|uri|method|token|jsession|g_ck|csrf|password|secret/i;
const INJECTED_KEYS = [
  'cookie',
  'Cookie',
  'headers',
  'url',
  'method',
  'token',
  'X-UserToken',
  'g_ck',
  'JSESSIONID',
  'extra',
];

describe('protocol fixtures', () => {
  it('cover every message kind of every direction', () => {
    const kinds = new Set(FIXTURES.map((f) => (f.value as { kind: string }).kind));
    for (const k of [
      'hello',
      'auth',
      'ping',
      'pong',
      'sn.op',
      'scope.request',
      'scope.claim',
      'scope.release',
      'registry.get',
      'challenge',
      'auth_ok',
      'broker.status',
      'registry.update',
      'response',
      'forward',
    ]) {
      expect(kinds, k).toContain(k);
    }
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s parses and round-trips', (_n, f) => {
    const parsed = f.schema.parse(f.value);
    expect(parsed).toEqual(f.value);
    expect(f.schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(f.value);
  });
});

describe('strictness', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    '%s rejects unknown/forbidden keys at every object level',
    (_n, f) => {
      const paths = objectPaths(f.value as Json);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        for (const key of INJECTED_KEYS) {
          const tampered = withKeyAt(f.value as Json, path, key, 'x');
          expect(f.schema.safeParse(tampered).success, `${key} at /${path.join('/')}`).toBe(false);
        }
      }
    },
  );

  it('rejects unknown message kinds on every direction', () => {
    for (const schema of Object.values(ALL_WIRE_SCHEMAS)) {
      expect(
        schema.safeParse({ v: 1, kind: 'http.request', id: 'x', url: 'https://x' }).success,
      ).toBe(false);
      expect(schema.safeParse({ v: 1, kind: 'sn.write', id: 'x' }).success).toBe(false);
    }
  });

  it('rejects other protocol versions', () => {
    expect(ClientToBrokerSchema.safeParse({ v: 2, kind: 'ping', id: 'p' }).success).toBe(false);
  });

  it('accepts messages only on their own direction', () => {
    const hello = FIXTURES.find((f) => f.name === 'hello')?.value;
    const forward = FIXTURES.find((f) => f.name === 'forward')?.value;
    expect(BrokerToClientSchema.safeParse(hello).success).toBe(false);
    expect(ExtensionToBrokerSchema.safeParse(forward).success).toBe(false);
    expect(BrokerToExtensionSchema.safeParse(hello).success).toBe(false);
    // extension cannot send requests upstream, clients cannot send responses
    const snOp = FIXTURES.find((f) => f.name === 'sn.op probe')?.value;
    expect(ExtensionToBrokerSchema.safeParse(snOp).success).toBe(false);
    const resp = FIXTURES.find((f) => f.name === 'response error')?.value;
    expect(ClientToBrokerSchema.safeParse(resp).success).toBe(false);
  });
});

describe('redaction by construction', () => {
  it('no wire schema declares a field able to carry URLs, methods, headers, cookies or tokens', () => {
    for (const [dir, schema] of Object.entries(ALL_WIRE_SCHEMAS)) {
      const keys = [...declaredKeys(schema as z.ZodType)];
      expect(keys.length, dir).toBeGreaterThan(10);
      const bad = keys.filter((k) => FORBIDDEN_KEY_RE.test(k));
      expect(bad, dir).toEqual([]);
    }
  });

  it('broadcast registry updates cannot carry per-client state', () => {
    const msg = {
      v: 1,
      kind: 'registry.update',
      instances: [
        {
          alias: 'dev',
          label: 'DEV',
          host: 'acmedev.service-now.com',
          env: 'dev',
          connection: 'connected',
          thisClient: { pendingRequest: false, activeGrant: true },
        },
      ],
    };
    expect(RegistryUpdateSchema.safeParse(msg).success).toBe(false);
  });
});

describe('operation limits', () => {
  const base = {
    kind: 'table.list',
    table: 'incident',
    limit: 20,
    offset: 0,
    displayValue: 'false',
    noCount: true,
  };
  const ok = (o: object) => OperationSchema.safeParse({ ...base, ...o }).success;

  it('bounds one request (page size, field count) but never pagination depth (ADR-011)', () => {
    expect(ok({ limit: 1000 })).toBe(true);
    expect(ok({ limit: 1001 })).toBe(false);
    expect(ok({ limit: 0 })).toBe(false);
    expect(ok({ limit: 1.5 })).toBe(false);
    expect(ok({ offset: 2001 })).toBe(true);
    expect(ok({ offset: 5_000_000 })).toBe(true);
    expect(ok({ offset: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(ok({ offset: -1 })).toBe(false);
    expect(ok({ offset: 1.5 })).toBe(false);
    expect(ok({ fields: Array.from({ length: 50 }, (_, i) => `f${i}`) })).toBe(true);
    expect(ok({ fields: Array.from({ length: 51 }, (_, i) => `f${i}`) })).toBe(false);
    expect(ok({ fields: [] })).toBe(false);
  });

  it('validates identifiers', () => {
    for (const table of [
      '../incident',
      'Incident',
      'incident;drop',
      'incident.do',
      '',
      'a'.repeat(81),
    ]) {
      expect(ok({ table }), table).toBe(false);
    }
    expect(ok({ table: 'x_acme_app_widget' })).toBe(true);
    expect(ok({ fields: ['caller_id.manager.department.name'] })).toBe(true);
    expect(ok({ fields: ['a.b.c.d.e'] })).toBe(false); // > 3 dot-walk hops
    expect(ok({ fields: ['Number'] })).toBe(false);
    const get = { kind: 'table.get', table: 'incident', displayValue: 'false' };
    expect(OperationSchema.safeParse({ ...get, sysId: SYS_ID }).success).toBe(true);
    expect(OperationSchema.safeParse({ ...get, sysId: SYS_ID.toUpperCase() }).success).toBe(false);
    expect(OperationSchema.safeParse({ ...get, sysId: `${SYS_ID}0` }).success).toBe(false);
  });

  it('bounds query strings (full validation is the query module, T-003)', () => {
    expect(ok({ query: 'active=true' })).toBe(true);
    expect(ok({ query: 'active=true\n^NQsys_idISNOTEMPTY' })).toBe(false);
    expect(ok({ query: 'a'.repeat(2049) })).toBe(false);
  });

  it('has no write/execute operation kinds', () => {
    for (const kind of ['table.insert', 'table.update', 'table.delete', 'script.run', 'http']) {
      expect(OperationSchema.safeParse({ ...base, kind }).success, kind).toBe(false);
    }
  });
});

describe('scope messages', () => {
  const req = {
    v: 1,
    kind: 'scope.request',
    id: 'm',
    instances: ['dev'],
    mode: 'single',
    purpose: 'x',
  };
  const ok = (o: object) => ScopeRequestSchema.safeParse({ ...req, ...o }).success;

  it('limits instances, aliases and purpose text', () => {
    expect(ok({})).toBe(true);
    expect(ok({ instances: [] })).toBe(false);
    expect(ok({ instances: ['dev', 'test', 'prod'] })).toBe(false);
    expect(ok({ instances: ['DEV'] })).toBe(false);
    expect(ok({ instances: ['dev*'] })).toBe(false);
    expect(ok({ purpose: '' })).toBe(false);
    expect(ok({ purpose: 'a'.repeat(201) })).toBe(false);
    expect(ok({ purpose: 'line1\nline2' })).toBe(false);
    expect(ok({ purpose: 'bell\u0007' })).toBe(false);
  });

  it('validates approval codes, scope ids and request ids', () => {
    const resp = (approvalCode: string) =>
      BrokerToClientSchema.safeParse({
        v: 1,
        kind: 'response',
        id: 'm',
        ok: true,
        result: {
          type: 'scope.request',
          requestId: REQUEST_ID,
          approvalCode,
          expiresInSeconds: 300,
        },
      }).success;
    expect(resp('K7QF2M')).toBe(true);
    for (const bad of ['K7QF2', 'K7QF2MM', 'O7QF2M', 'K0QF2M', 'I7QF2M', 'k7qf2m', 'K7QF-2']) {
      expect(resp(bad), bad).toBe(false);
    }
    const release = (scopeId: string) =>
      ClientToBrokerSchema.safeParse({ v: 1, kind: 'scope.release', id: 'm', scopeId }).success;
    expect(release(SCOPE_ID)).toBe(true);
    expect(release('scp_short')).toBe(false);
    expect(release(REQUEST_ID)).toBe(false);
  });
});

describe('errors', () => {
  it('every error code has a non-empty default hint', () => {
    for (const code of ERROR_CODES) expect(DEFAULT_HINTS[code].length).toBeGreaterThan(10);
  });

  it('protocolError applies the default hint', () => {
    expect(protocolError('SESSION_EXPIRED', 'expired').hint).toBe(DEFAULT_HINTS.SESSION_EXPIRED);
    expect(protocolError('NOT_FOUND', 'x', 'custom').hint).toBe('custom');
  });

  it('rejects unknown error codes', () => {
    expect(
      BrokerToClientSchema.safeParse({
        v: 1,
        kind: 'response',
        id: 'm',
        ok: false,
        error: { code: 'WHATEVER', message: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('ADR-011: no volume-limit codes or DEV/PROD operational limits', () => {
  it('has no codes that reject queries for breadth or request quotas', () => {
    const codes: readonly string[] = ERROR_CODES;
    expect(codes).not.toContain('QUERY_TOO_BROAD');
    expect(codes).not.toContain('BUDGET_EXCEEDED');
    expect(codes).toContain('RATE_LIMITED');
  });

  it('safeguard defaults sit inside their user-configurable ranges', async () => {
    const { SAFEGUARD_DEFAULTS, SAFEGUARD_RANGES, SERVER_DEFAULTS, MAX_PAGE_SIZE } = await import(
      '../src/limits.js'
    );
    for (const key of Object.keys(SAFEGUARD_DEFAULTS) as (keyof typeof SAFEGUARD_DEFAULTS)[]) {
      expect(SAFEGUARD_DEFAULTS[key]).toBeGreaterThanOrEqual(SAFEGUARD_RANGES[key].min);
      expect(SAFEGUARD_DEFAULTS[key]).toBeLessThanOrEqual(SAFEGUARD_RANGES[key].max);
    }
    expect(SERVER_DEFAULTS.pageSize).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(SERVER_DEFAULTS.responseChars).toBeLessThanOrEqual(SERVER_DEFAULTS.maxResponseChars);
  });
});
