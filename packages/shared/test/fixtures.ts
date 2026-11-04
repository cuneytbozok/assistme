import type { z } from 'zod';
import {
  BrokerToClientSchema,
  BrokerToExtensionSchema,
  ClientToBrokerSchema,
  ExtensionToBrokerSchema,
} from '../src/index.js';

/** Valid sample values (not secrets — fixed test strings). */
export const NONCE = 'A'.repeat(43);
export const HEX = 'a'.repeat(64);
export const SCOPE_ID = `scp_${'b'.repeat(22)}`;
export const REQUEST_ID = `req_${'c'.repeat(22)}`;
export const SYS_ID = '0123456789abcdef0123456789abcdef';

const label = { name: 'claude-code', pid: 4242, cwd: '/Users/dev/project' };
const instance = {
  alias: 'dev',
  label: 'ACME DEV',
  host: 'acmedev.service-now.com',
  env: 'dev',
  connection: 'connected',
} as const;

const snOp = {
  v: 1,
  kind: 'sn.op',
  id: 'm1',
  scopeId: SCOPE_ID,
  instance: 'dev',
  op: {
    kind: 'table.list',
    table: 'incident',
    query: 'active=true^priority=1^ORDERBYDESCsys_updated_on',
    fields: ['sys_id', 'number', 'caller_id.name'],
    limit: 20,
    offset: 0,
    displayValue: 'false',
    noCount: true,
  },
};

export interface Fixture {
  name: string;
  schema: z.ZodType;
  value: unknown;
}

export const FIXTURES: Fixture[] = [
  // MCP server → broker
  {
    name: 'hello',
    schema: ClientToBrokerSchema,
    value: { v: 1, kind: 'hello', clientNonce: NONCE, clientKeyId: HEX, label },
  },
  { name: 'auth', schema: ClientToBrokerSchema, value: { v: 1, kind: 'auth', clientProof: HEX } },
  { name: 'ping(client)', schema: ClientToBrokerSchema, value: { v: 1, kind: 'ping', id: 'p1' } },
  { name: 'sn.op table.list', schema: ClientToBrokerSchema, value: snOp },
  {
    name: 'sn.op table.get',
    schema: ClientToBrokerSchema,
    value: {
      ...snOp,
      op: { kind: 'table.get', table: 'sys_script', sysId: SYS_ID, displayValue: 'all' },
    },
  },
  {
    name: 'sn.op stats.aggregate',
    schema: ClientToBrokerSchema,
    value: {
      ...snOp,
      op: {
        kind: 'stats.aggregate',
        table: 'syslog',
        query: 'level=2',
        groupBy: ['source'],
        aggregates: [{ fn: 'max', field: 'sys_created_on' }],
        displayValue: 'false',
      },
    },
  },
  { name: 'sn.op probe', schema: ClientToBrokerSchema, value: { ...snOp, op: { kind: 'probe' } } },
  {
    name: 'scope.request',
    schema: ClientToBrokerSchema,
    value: {
      v: 1,
      kind: 'scope.request',
      id: 'm2',
      instances: ['dev', 'prod'],
      mode: 'compare',
      purpose: 'Compare business rule between DEV and PROD',
    },
  },
  {
    name: 'scope.claim',
    schema: ClientToBrokerSchema,
    value: { v: 1, kind: 'scope.claim', id: 'm3', requestId: REQUEST_ID },
  },
  {
    name: 'scope.release',
    schema: ClientToBrokerSchema,
    value: { v: 1, kind: 'scope.release', id: 'm4', scopeId: SCOPE_ID },
  },
  {
    name: 'registry.get',
    schema: ClientToBrokerSchema,
    value: { v: 1, kind: 'registry.get', id: 'm5' },
  },

  // broker → MCP server
  {
    name: 'challenge',
    schema: BrokerToClientSchema,
    value: { v: 1, kind: 'challenge', brokerNonce: NONCE, brokerProof: HEX },
  },
  { name: 'auth_ok', schema: BrokerToClientSchema, value: { v: 1, kind: 'auth_ok' } },
  { name: 'pong(client)', schema: BrokerToClientSchema, value: { v: 1, kind: 'pong', id: 'p1' } },
  {
    name: 'broker.status',
    schema: BrokerToClientSchema,
    value: { v: 1, kind: 'broker.status', state: 'ready' },
  },
  {
    name: 'registry.update(client)',
    schema: BrokerToClientSchema,
    value: { v: 1, kind: 'registry.update', instances: [instance] },
  },
  {
    name: 'response sn.op',
    schema: BrokerToClientSchema,
    value: {
      v: 1,
      kind: 'response',
      id: 'm1',
      ok: true,
      result: {
        type: 'sn.op',
        instance: 'dev',
        host: 'acmedev.service-now.com',
        env: 'dev',
        status: 200,
        body: { result: [{ sys_id: SYS_ID, number: 'INC0012345' }] },
        totalCount: 1,
        bytes: 87,
      },
    },
  },
  {
    name: 'response scope.request',
    schema: BrokerToClientSchema,
    value: {
      v: 1,
      kind: 'response',
      id: 'm2',
      ok: true,
      result: {
        type: 'scope.request',
        requestId: REQUEST_ID,
        approvalCode: 'K7QF2M',
        expiresInSeconds: 300,
      },
    },
  },
  {
    name: 'response scope.claim',
    schema: BrokerToClientSchema,
    value: {
      v: 1,
      kind: 'response',
      id: 'm3',
      ok: true,
      result: {
        type: 'scope.claim',
        status: 'approved',
        scopeId: SCOPE_ID,
        instances: ['dev'],
        mode: 'single',
        expiresAt: '2026-11-04T20:00:00Z',
      },
    },
  },
  {
    name: 'response scope.release',
    schema: BrokerToClientSchema,
    value: {
      v: 1,
      kind: 'response',
      id: 'm4',
      ok: true,
      result: { type: 'scope.release', released: true },
    },
  },
  {
    name: 'response registry.get',
    schema: BrokerToClientSchema,
    value: {
      v: 1,
      kind: 'response',
      id: 'm5',
      ok: true,
      result: {
        type: 'registry.get',
        instances: [{ ...instance, thisClient: { pendingRequest: false, activeGrant: true } }],
      },
    },
  },
  {
    name: 'response error',
    schema: BrokerToClientSchema,
    value: {
      v: 1,
      kind: 'response',
      id: 'm1',
      ok: false,
      error: { code: 'SESSION_EXPIRED', message: 'Session expired', hint: 'Log in again' },
    },
  },

  // broker → extension
  {
    name: 'forward',
    schema: BrokerToExtensionSchema,
    value: { v: 1, kind: 'forward', client: { keyId: HEX, label }, request: snOp },
  },
  { name: 'ping(ext)', schema: BrokerToExtensionSchema, value: { v: 1, kind: 'ping', id: 'h1' } },
  {
    name: 'broker.status(ext)',
    schema: BrokerToExtensionSchema,
    value: { v: 1, kind: 'broker.status', state: 'conflict' },
  },

  // extension → broker
  {
    name: 'registry.update(ext)',
    schema: ExtensionToBrokerSchema,
    value: { v: 1, kind: 'registry.update', instances: [instance] },
  },
  { name: 'pong(ext)', schema: ExtensionToBrokerSchema, value: { v: 1, kind: 'pong', id: 'h1' } },
  {
    name: 'response(ext)',
    schema: ExtensionToBrokerSchema,
    value: {
      v: 1,
      kind: 'response',
      id: 'b-17',
      ok: false,
      error: { code: 'TABLE_DENIED', message: 'Table is blocked' },
    },
  },
];
