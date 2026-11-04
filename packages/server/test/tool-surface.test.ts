/**
 * T-022 AC1 + AC2: the tool surface is exactly the approved read-only set with no URL, method or
 * header inputs, and fuzzed tool inputs (≥10k) can only ever produce GETs to the two templates.
 * The extension's real request builder judges every operation the server emits. Mocked bridge.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PARAMS,
  buildRequest,
  PATH_TEMPLATES,
  type RequestBuildError,
} from '../../extension/src/background/request-builder.js';
import type { BridgeClient } from '../src/bridge/client.js';
import { createMcpServer } from '../src/mcp/server.js';
import { answerMetadata } from './fake-sn.js';

const APPROVED = [
  'claim_scope',
  'list_instances',
  'query_records',
  'release_scope',
  'request_scope',
];
const FORBIDDEN_INPUTS =
  /^(url|uri|href|endpoint|path|method|verb|header|headers|body|payload|script|http|request)$/i;
const SCOPE = `scp_${'Z'.repeat(22)}`;
const HOST = 'dev.service-now.com';

/** A bridge stand-in: grants one scope, answers metadata, records every data operation. */
function fakeBridge(ops: unknown[]): BridgeClient {
  let n = 0;
  const reply = (result: unknown) => ({ v: 1, kind: 'response', id: `r${++n}`, ok: true, result });
  return {
    cachedRegistry: undefined,
    noteRegistry: () => {},
    close: () => {},
    request: async (req: { kind: string; [k: string]: unknown }) => {
      switch (req.kind) {
        case 'registry.get':
          return reply({
            type: 'registry.get',
            instances: [
              {
                alias: 'dev',
                label: '',
                host: HOST,
                env: 'dev',
                connection: 'connected',
                thisClient: { pendingRequest: false, activeGrant: true },
              },
            ],
          });
        case 'scope.request':
          return reply({
            type: 'scope.request',
            requestId: `req_${'R'.repeat(22)}`,
            approvalCode: 'K7QF2M',
            expiresInSeconds: 300,
          });
        case 'scope.claim':
          return reply({
            type: 'scope.claim',
            status: 'approved',
            scopeId: SCOPE,
            instances: ['dev'],
            mode: 'single',
            expiresAt: '2099-01-01T00:00:00.000Z',
          });
        case 'scope.release':
          return reply({ type: 'scope.release', released: true });
        case 'sn.op': {
          const m = answerMetadata(req.op);
          if (!m) ops.push(req.op);
          return reply({
            type: 'sn.op',
            instance: 'dev',
            host: HOST,
            env: 'dev',
            status: 200,
            body: m?.body ?? [],
            bytes: 2,
          });
        }
        default:
          throw new Error(`unexpected ${req.kind}`);
      }
    },
  } as unknown as BridgeClient;
}

async function connect(ops: unknown[]) {
  const server = createMcpServer(fakeBridge(ops));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'fuzz', version: '0' });
  await client.connect(ct);
  return client;
}

describe('AC1: tool surface snapshot', () => {
  it('exactly the approved tools, all read-only, no URL/method/header inputs', async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(APPROVED);
    const snapshot = tools
      .map((t) => ({
        name: t.name,
        inputs: Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).sort(),
        readOnly: t.annotations?.readOnlyHint,
        destructive: t.annotations?.destructiveHint,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(snapshot).toEqual([
      { name: 'claim_scope', inputs: ['request_id'], readOnly: true, destructive: false },
      { name: 'list_instances', inputs: [], readOnly: true, destructive: false },
      {
        name: 'query_records',
        inputs: [
          'cursor',
          'fields',
          'include_total',
          'instance',
          'limit',
          'max_chars',
          'scope_id',
          'table',
        ],
        readOnly: true,
        destructive: false,
      },
      { name: 'release_scope', inputs: ['scope_id'], readOnly: true, destructive: false },
      {
        name: 'request_scope',
        inputs: ['instance', 'instances', 'purpose'],
        readOnly: true,
        destructive: false,
      },
    ]);
    for (const t of snapshot)
      for (const i of t.inputs) expect(i, `${t.name}.${i}`).not.toMatch(FORBIDDEN_INPUTS);
    for (const t of tools) {
      // Strict schemas: unknown keys (e.g. "url") are rejected, not ignored.
      expect(
        (t.inputSchema as { additionalProperties?: boolean }).additionalProperties,
        t.name,
      ).toBe(false);
    }
    await client.close();
  });
});

describe('AC2: fuzzed tool inputs only ever yield GETs to the templates', () => {
  it('30,000 random calls (≥10k required)', async () => {
    const ops: unknown[] = [];
    const client = await connect(ops);
    await client.callTool({
      name: 'claim_scope',
      arguments: { request_id: `req_${'R'.repeat(22)}` },
    });

    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const junk = [
      '',
      '../',
      '%2e%2e',
      '?',
      '#',
      '&',
      '=',
      '/',
      '\\\\',
      '@',
      ':',
      'javascript:',
      'gs.',
      'DELETE',
      'https://evil.example',
      'sys_user_token',
      'user_password',
      'incident',
      'number',
      'sys_id',
      'caller_id.name',
      'a'.repeat(300),
    ];
    const word = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(junk)).join('');
    const value = (): unknown =>
      pick([
        word(),
        1,
        -1,
        0,
        6,
        1.5,
        true,
        null,
        [],
        {},
        [word()],
        { url: word() },
        ['number', 'short_description'],
        ['caller_id.department.name'],
      ]);
    const tools = [...APPROVED, 'http_request', 'run_script', 'update_record'];
    const keys = [
      'scope_id',
      'instance',
      'instances',
      'table',
      'fields',
      'limit',
      'include_total',
      'purpose',
      'request_id',
      'url',
      'method',
      'headers',
      'body',
      'encoded_query',
      'path',
    ];

    const N = 30_000; // AC2 requires ≥10k
    let errors = 0;
    for (let i = 0; i < N; i++) {
      let name: string;
      const args: Record<string, unknown> = {};
      if (rnd() < 0.5) {
        // Near-valid: the right keys with hostile or edge-case values, to reach the builder.
        name = 'query_records';
        args.scope_id = SCOPE;
        args.table =
          rnd() < 0.7
            ? pick(['incident', 'task', 'sys_user', 'cmn_department', 'problem', 'incident_task'])
            : word();
        if (rnd() < 0.6) {
          args.fields = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
            rnd() < 0.6
              ? pick([
                  'number',
                  'sys_id',
                  'short_description',
                  'caller_id.name',
                  'assigned_to.manager.name',
                  'user_name',
                  'state',
                ])
              : word(),
          );
        }
        if (rnd() < 0.5) args.limit = pick([1, 2, 3, 5]);
        if (rnd() < 0.3) args.include_total = rnd() < 0.5;
        if (rnd() < 0.2) args.instance = pick(['dev', 'prod', word()]);
      } else {
        name = pick(tools);
        if (rnd() < 0.8) args.scope_id = rnd() < 0.85 ? SCOPE : value();
        if (rnd() < 0.85)
          args.table =
            rnd() < 0.6
              ? pick(['incident', 'task', 'sys_user', 'cmn_department', 'problem'])
              : value();
        if (rnd() < 0.5)
          args.fields =
            rnd() < 0.6
              ? pick([['number'], ['number', 'caller_id.name'], ['sys_id', 'short_description']])
              : value();
        if (rnd() < 0.4) args.limit = pick([1, 2, 5, 0, 6, 1000, -1]);
        const extra = Math.floor(rnd() * 3);
        for (let k = 0; k < extra; k++) args[pick(keys)] = value();
      }
      try {
        const r = await client.callTool({ name, arguments: args });
        if (r.isError) errors++;
      } catch (e) {
        errors++;
        void e; // unknown tools throw a protocol error
      }
    }
    await client.close();

    // Every operation the server emitted must pass the extension's real builder, and the result
    // must be a GET to a template with allowlisted parameters on the granted host.
    expect(ops.length).toBeGreaterThan(500);
    for (const op of ops) {
      let b: ReturnType<typeof buildRequest>;
      try {
        b = buildRequest(HOST, op, 'tok');
      } catch (e) {
        // A server-emitted op the extension refuses would still be safe, but it shouldn't happen.
        throw new Error(
          `server emitted an op the builder refused: ${JSON.stringify(op)} (${(e as RequestBuildError).message})`,
        );
      }
      const u = new URL(b.url);
      expect(b.init.method).toBe('GET');
      expect(u.hostname).toBe(HOST);
      expect(PATH_TEMPLATES[b.template].test(u.pathname)).toBe(true);
      for (const k of u.searchParams.keys()) expect(ALLOWED_PARAMS[b.template]).toContain(k);
    }
    expect(errors).toBeGreaterThan(N / 4); // many fuzz inputs are (correctly) refused
    if (process.env.FUZZ_REPORT)
      console.error(
        `fuzz: ${N} calls, ${errors} refused, ${ops.length} data ops, all GET to templates`,
      );
  }, 120_000);
});
