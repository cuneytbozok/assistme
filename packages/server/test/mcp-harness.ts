/**
 * Test harness: an MCP server over a fake bridge backed by the in-memory ServiceNow fake
 * (mock; not evidence of real connectivity). Every operation the server emits is also built by
 * the extension's real request builder, so anything it would refuse fails the test.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildRequest } from '../../extension/src/background/request-builder.js';
import type { BridgeClient } from '../src/bridge/client.js';
import { loadConfig } from '../src/config.js';
import type { CursorCodec } from '../src/mcp/cursor.js';
import { createMcpServer } from '../src/mcp/server.js';
import { dictionaryFixture, type FakeServiceNow } from './fake-sn.js';

export const HOSTS: Record<string, string> = {
  dev: 'dev.service-now.com',
  prod: 'prod.service-now.com',
};
const scopeFor = (inst: string, n = 1) =>
  `scp_${inst.toUpperCase().padEnd(4, 'X')}${String(n).padStart(18, '0')}`;

export interface Harness {
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
  sn: FakeServiceNow;
  /** The user revokes a scope in the popup. */
  revoke: (scope: string) => void;
  dataRequests: {
    kind: string;
    table: string;
    offset: number;
    limit: number;
    fields?: string[];
    displayValue?: string;
  }[];
  close: () => Promise<void>;
}

/**
 * MCP server over a fake bridge. `tooLarge(op)` lets a test simulate the extension's
 * RESPONSE_TOO_LARGE for some requests.
 */
export async function harness(
  opts: {
    sn?: FakeServiceNow;
    env?: Record<string, string>;
    tooLarge?: (op: { limit: number; fields?: string[]; offset: number }) => boolean;
    cursors?: CursorCodec;
    /** Rows the user's ACLs hide: removed from a page AFTER windowing, like ServiceNow does. */
    hidden?: (row: Record<string, unknown>) => boolean;
    /** Tables the signed-in user's ACLs refuse (HTTP 403 → ACL_DENIED). */
    denyTables?: string[];
  } = {},
): Promise<Harness> {
  const sn = opts.sn ?? dictionaryFixture();
  const dataRequests: Harness['dataRequests'] = [];
  let n = 0;
  let claims = 0;
  const reply = (result: unknown) => ({ v: 1, kind: 'response', id: `r${++n}`, ok: true, result });
  const fail = (code: string, message: string) => ({
    v: 1,
    kind: 'response',
    id: `r${++n}`,
    ok: false,
    error: { code, message },
  });
  const pendingInstance = new Map<string, string>();
  const revoked = new Set<string>();
  const bridge = {
    cachedRegistry: {
      instances: Object.entries(HOSTS).map(([alias, host]) => ({
        alias,
        host,
        label: '',
        env: alias === 'prod' ? 'prod' : 'dev',
        connection: 'connected',
      })),
      receivedAt: 0,
    },
    noteRegistry: () => {},
    close: () => {},
    request: async (req: any) => {
      switch (req.kind) {
        case 'scope.request': {
          const id = `req_${String(++claims).padStart(22, '0')}`;
          pendingInstance.set(id, req.instances[0]);
          return reply({
            type: 'scope.request',
            requestId: id,
            approvalCode: 'K7QF2M',
            expiresInSeconds: 300,
          });
        }
        case 'scope.claim': {
          const inst = pendingInstance.get(req.requestId) as string;
          return reply({
            type: 'scope.claim',
            status: 'approved',
            scopeId: scopeFor(inst, Number(req.requestId.slice(4))),
            instances: [inst],
            mode: 'single',
            expiresAt: '2099-01-01T00:00:00.000Z',
          });
        }
        case 'scope.check':
          if (revoked.has(req.scopeId)) return fail('SCOPE_UNKNOWN', 'Unknown scope.');
          return reply({ type: 'scope.check', valid: true });
        case 'sn.op': {
          if (revoked.has(req.scopeId)) return fail('SCOPE_UNKNOWN', 'Unknown scope.');
          const op = req.op;
          buildRequest(HOSTS[req.instance] as string, op, 'tok'); // the extension would accept it
          const isMeta = ['sys_db_object', 'sys_dictionary', 'sys_choice'].includes(op.table);
          if (!isMeta) {
            dataRequests.push({
              kind: op.kind,
              table: op.table,
              displayValue: op.displayValue,
              offset: op.offset,
              limit: op.limit,
              ...(op.fields ? { fields: op.fields } : {}),
            });
            if (opts.tooLarge?.(op))
              return fail('RESPONSE_TOO_LARGE', 'The response exceeded 10485760 bytes.');
          }
          if (op.kind === 'table.get' || op.kind === 'stats.aggregate') {
            if (opts.denyTables?.includes(op.table))
              return fail('ACL_DENIED', 'Insufficient rights to read this table.');
            const body =
              op.kind === 'table.get'
                ? sn.get({
                    table: op.table,
                    sysId: op.sysId,
                    ...(op.fields ? { fields: op.fields } : {}),
                  })
                : sn.stats({
                    table: op.table,
                    ...(op.query ? { query: op.query } : {}),
                    ...(op.groupBy ? { groupBy: op.groupBy } : {}),
                    ...(op.aggregates ? { aggregates: op.aggregates } : {}),
                  });
            if (body === undefined) return fail('NOT_FOUND', 'No Record found');
            return reply({
              type: 'sn.op',
              instance: req.instance,
              host: HOSTS[req.instance],
              env: 'dev',
              status: 200,
              body,
              bytes: 10,
            });
          }
          if (opts.denyTables?.includes(op.table))
            return fail('ACL_DENIED', 'Insufficient rights to read this table.');
          const { rows, total } = sn.list({
            table: op.table,
            ...(op.query ? { query: op.query } : {}),
            ...(op.fields ? { fields: op.fields } : {}),
            limit: op.limit,
            offset: op.offset,
          });
          const visible = !isMeta && opts.hidden ? rows.filter((r) => !opts.hidden?.(r)) : rows;
          return reply({
            type: 'sn.op',
            instance: req.instance,
            host: HOSTS[req.instance],
            env: 'dev',
            status: 200,
            body: visible,
            ...(op.noCount ? {} : { totalCount: total }),
            bytes: 10,
          });
        }
        default:
          throw new Error(`unexpected ${req.kind}`);
      }
    },
  } as unknown as BridgeClient;
  const server = createMcpServer(bridge, {
    config: loadConfig(opts.env ?? {}),
    ...(opts.cursors ? { cursors: opts.cursors } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
  };
  return {
    call,
    sn,
    dataRequests,
    revoke: (scope) => revoked.add(scope),
    close: () => client.close(),
  };
}

export async function claim(h: Harness, instance: string): Promise<string> {
  const req = await h.call('request_scope', { instance, purpose: 'test' });
  return (await h.call('claim_scope', { request_id: req.data.request_id })).data.scope_id;
}

export function withIncidents(count: number, longEvery = 0): FakeServiceNow {
  const sn = dictionaryFixture();
  for (let i = 0; i < count; i++) {
    sn.insert('incident', {
      number: `INC${String(i).padStart(7, '0')}`,
      short_description:
        longEvery && i % longEvery === 0 ? `Long ${i} ${'x'.repeat(3000)}` : `Incident ${i}`,
      priority: String((i % 4) + 1),
      sys_updated_on: `2026-01-01 00:00:${String(i % 60).padStart(2, '0')}`,
    });
  }
  return sn;
}

/** Follows next_cursor until done; returns every response. */
export async function walk(
  h: Harness,
  scope: string,
  first: Record<string, unknown>,
  maxCalls = 10_000,
) {
  const responses: any[] = [];
  let r = await h.call('query_records', { scope_id: scope, ...first });
  responses.push(r);
  while (r.page?.next_cursor && responses.length < maxCalls) {
    r = await h.call('query_records', { scope_id: scope, cursor: r.page.next_cursor });
    responses.push(r);
  }
  return responses;
}
