/**
 * T-033: the tool contract as a whole: size, descriptions, the strictness of the compact
 * published schemas, docs/TOOLS.md, and consistent results (mock only).
 */
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ERROR_CODES } from '@sn-mcp/shared';
import { describe, expect, it } from 'vitest';
import type { BridgeClient } from '../src/bridge/client.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer, INSTRUCTIONS } from '../src/mcp/server.js';
import { dictionaryFixture } from './fake-sn.js';
import { claim, claimCompare, harness, withIncidents } from './mcp-harness.js';

const TOOLS_MD = readFileSync(new URL('../../../docs/TOOLS.md', import.meta.url), 'utf8');
const MAX_TOOLS_LIST_BYTES = 12_000;

async function listTools() {
  const server = createMcpServer({ cachedRegistry: undefined } as unknown as BridgeClient, {
    config: loadConfig({}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  const { tools } = await c.listTools();
  await c.close();
  return tools;
}

const DATA_TOOLS = [
  'query_records',
  'get_record',
  'discover_tables',
  'describe_table',
  'get_field_content',
  'aggregate_records',
  'get_related_records',
  'get_record_history',
  'search_code',
  'compare_records',
];

describe('tools/list', () => {
  it(`stays within ${MAX_TOOLS_LIST_BYTES} bytes`, async () => {
    const size = Buffer.byteLength(JSON.stringify({ tools: await listTools() }));
    expect(size).toBeLessThanOrEqual(MAX_TOOLS_LIST_BYTES);
    if (process.env.SIZE_REPORT) console.error(`tools/list: ${size} bytes`);
  });

  it('every tool has an output schema and a description; annotations are read-only', async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(14);
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(50);
      expect(t.description?.length ?? 0, t.name).toBeLessThan(500);
      expect(t.annotations, t.name).toEqual({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('every data tool says how to continue; the main tools steer toward efficient reads', async () => {
    const tools = await listTools();
    for (const name of DATA_TOOLS) {
      const d = tools.find((t) => t.name === name)?.description ?? '';
      expect(d, name).toMatch(/cursor|`next`|omitted|one record/i);
    }
    const q = tools.find((t) => t.name === 'query_records')?.description ?? '';
    expect(q).toMatch(/Prefer filters/);
    expect(q).toMatch(/fields/);
    expect(q).toMatch(/aggregate_records/);
    expect(q).toMatch(/complete/);
    expect(tools.find((t) => t.name === 'aggregate_records')?.description).toMatch(/prefer/i);
    // The shared contract is in the server instructions every client receives.
    for (const word of ['complete', 'omitted', 'next_cursor', 'aggregate_records', 'untrusted']) {
      expect(INSTRUCTIONS, word).toContain(word);
    }
  });
});

describe('reading busy tables', () => {
  it('tells Claude to start small, and warns on an open-ended read', async () => {
    expect(INSTRUCTIONS).toMatch(/short recent time window/);
    const sn = dictionaryFixture();
    sn.insert('sys_db_object', { name: 'syslog', label: 'Log', super_class: '' });
    sn.insert('sys_dictionary', {
      name: 'syslog',
      element: 'sys_created_on',
      column_label: 'c',
      internal_type: 'glide_date_time',
      reference: '',
      max_length: '40',
      mandatory: 'false',
      display: 'false',
    });
    const h = await harness({ sn });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: scope, table: 'syslog' });
    expect(r.hints.join(' ')).toMatch(/short time window.*may repeat or miss rows/);
    // A broad read is still allowed: it warns, it doesn't refuse.
    expect(r.ok).toBe(true);
    await h.close();
  });
});

describe('keeping access for follow-up questions', () => {
  it('tells Claude to keep the scope, and to release only when the user is finished', async () => {
    expect(INSTRUCTIONS).toMatch(/follow-up questions/);
    expect(INSTRUCTIONS).toMatch(/release_scope only when the user says they're finished/);
    expect(INSTRUCTIONS).not.toMatch(/release_scope when you are done/);
    const release = (await listTools()).find((t) => t.name === 'release_scope');
    expect(release?.description).toMatch(/only when the user says/);
  });
});

describe('compact published schemas validate as strictly as before', () => {
  const REJECTED: [string, Record<string, unknown>][] = [
    ['query_records', { table: 'BAD TABLE' }],
    ['query_records', { table: '../etc' }],
    ['query_records', { table: 'incident', where: [{ field: 'a', op: 'DROP', value: 1 }] }],
    ['query_records', { table: 'incident', where: [{ field: 'a b', op: '=', value: 1 }] }],
    ['query_records', { table: 'incident', where: [{ field: 'a', op: '=', value: 1, url: 'x' }] }],
    ['query_records', { table: 'incident', where: [] }],
    ['query_records', { table: 'incident', any_of: [[{ field: 'a', op: '=', value: 1 }]] }],
    ['query_records', { table: 'incident', order_by: [{ field: 'a', direction: 'up' }] }],
    ['query_records', { table: 'incident', fields: ['a b'] }],
    ['query_records', { table: 'incident', fields: Array(50).fill('number') }],
    ['query_records', { table: 'incident', limit: 0 }],
    ['query_records', { table: 'incident', limit: 1.5 }],
    ['query_records', { table: 'incident', url: 'https://evil.example' }],
    ['query_records', { table: 'incident', instance: 'BAD ALIAS' }],
    ['get_record', { table: 'incident', sys_id: 'not-a-sys-id' }],
    ['get_record', { table: 'incident', match: { 'bad field': 'x' } }],
    ['get_field_content', { table: 'incident', sys_id: 'a'.repeat(32), field: 'a b' }],
    [
      'get_field_content',
      { table: 'incident', sys_id: 'a'.repeat(32), field: 'a', start_char: -1 },
    ],
    ['aggregate_records', { table: 'incident', group_by: ['a', 'b', 'c'] }],
    ['aggregate_records', { table: 'incident', aggregates: [{ fn: 'drop', field: 'a' }] }],
    ['get_related_records', { table: 'incident', sys_id: 'a'.repeat(32), samples: 51 }],
    ['get_record_history', { table: 'incident', sys_id: 'a'.repeat(32), since: "'; DROP" }],
    ['search_code', { pattern: '' }],
    ['search_code', { pattern: 'x', tables: ['BAD TABLE'] }],
    ['compare_records', { table: 'incident', match_a: { 'bad field': 'x' } }],
    ['compare_records', { table: 'incident', match_a: { number: 'x' }, fields: ['a.b'] }],
    ['request_scope', { instance: 'BAD ALIAS', purpose: 'x' }],
    ['request_scope', { instance: 'dev', purpose: 'a\nb' }],
    ['claim_scope', { request_id: 'nope' }],
  ];

  it.each(REJECTED)('%s refuses %j', async (tool, args) => {
    const h = await harness();
    const scope = await claim(h, 'dev');
    const scoped =
      tool === 'request_scope' || tool === 'claim_scope' ? args : { scope_id: scope, ...args };
    // The MCP layer refuses with a plain-text message.
    await expect(h.call(tool, scoped)).rejects.toThrow(/Input vali/);
    expect(h.dataRequests).toEqual([]);
    await h.close();
  });

  it('published schemas stay closed objects with no forbidden inputs', async () => {
    for (const t of await listTools()) {
      const schema = t.inputSchema as { additionalProperties?: boolean; properties?: object };
      expect(schema.additionalProperties, t.name).toBe(false);
      for (const k of Object.keys(schema.properties ?? {})) {
        expect(k, t.name).not.toMatch(/^(url|uri|method|headers?|body|script|path)$/);
      }
    }
  });
});

describe('docs/TOOLS.md', () => {
  it('covers every tool and every error code', async () => {
    for (const t of await listTools()) expect(TOOLS_MD, t.name).toContain(`### \`${t.name}\``);
    for (const code of ERROR_CODES) expect(TOOLS_MD, code).toContain(`| \`${code}\` |`);
  });

  it('names every input of every tool', async () => {
    for (const t of await listTools()) {
      const start = TOOLS_MD.indexOf(`### \`${t.name}\``);
      const end = TOOLS_MD.indexOf('\n### ', start + 5);
      const section = TOOLS_MD.slice(start, end === -1 ? undefined : end);
      for (const k of Object.keys((t.inputSchema as { properties?: object }).properties ?? {})) {
        if (k === 'scope_id') continue;
        expect(section, `${t.name}.${k}`).toContain(`\`${k}\``);
      }
    }
  });

  it('every tool has an example, and each one runs through the real tool', async () => {
    const blocks = [
      ...TOOLS_MD.matchAll(/### `(\w+)`[\s\S]*?```json (example|compare-example)\n([\s\S]*?)```/g),
    ];
    expect(blocks.map((b) => b[1]).sort()).toEqual((await listTools()).map((t) => t.name).sort());

    const fill = (json: string, vars: Record<string, string>) =>
      JSON.parse(json.replace(/\$[A-Z_]+/g, (m) => vars[m.slice(1)] ?? m));
    for (const [, tool, kind, json] of blocks) {
      const sn = withIncidents(3);
      const sysId = sn.tables.get('incident')?.[0]?.sys_id as string;
      const h = await harness({ sn, snByInstance: { dev: sn, prod: sn } });
      const scope = await claim(h, 'dev');
      const req = await h.call('request_scope', { instance: 'dev', purpose: 'x' });
      const vars = {
        SCOPE: scope,
        COMPARE_SCOPE: kind === 'compare-example' ? await claimCompare(h) : '',
        SYS_ID: sysId,
        REQUEST_ID: req.data.request_id,
      };
      // A validation failure surfaces as text and makes h.call throw. Anything else is fine: the
      // example was accepted and reached the tool (a fixture may hold no matching record).
      const r = await h.call(tool as string, fill(json as string, vars));
      expect(typeof r.ok, tool).toBe('boolean');
      await h.close();
    }
  });
});

describe('results are consistent across tools', () => {
  it('each data tool reports provenance, untrusted_content, complete and requests_used', async () => {
    const sn = withIncidents(2);
    const id = sn.tables.get('incident')?.[0]?.sys_id as string;
    for (const f of ['sys_audit', 'sys_journal_field']) {
      sn.insert('sys_db_object', { name: f, label: f, super_class: '' });
    }
    for (const [t, e] of [
      ['sys_audit', 'documentkey'],
      ['sys_audit', 'user'],
      ['sys_audit', 'fieldname'],
      ['sys_audit', 'oldvalue'],
      ['sys_audit', 'newvalue'],
      ['sys_audit', 'sys_created_on'],
      ['sys_journal_field', 'element_id'],
      ['sys_journal_field', 'sys_created_by'],
      ['sys_journal_field', 'element'],
      ['sys_journal_field', 'value'],
      ['sys_journal_field', 'sys_created_on'],
    ] as const) {
      sn.insert('sys_dictionary', {
        name: t,
        element: e,
        column_label: e,
        internal_type: 'string',
        reference: '',
        max_length: '40',
        mandatory: 'false',
        display: 'false',
      });
    }
    const h = await harness({ sn, snByInstance: { dev: sn, prod: sn } });
    const scope = await claim(h, 'dev');
    const compare = await claimCompare(h);
    const calls: [string, Record<string, unknown>][] = [
      ['query_records', { scope_id: scope, table: 'incident' }],
      ['get_record', { scope_id: scope, table: 'incident', sys_id: id }],
      ['discover_tables', { scope_id: scope, search: 'incident' }],
      ['describe_table', { scope_id: scope, table: 'incident' }],
      ['get_field_content', { scope_id: scope, table: 'incident', sys_id: id, field: 'number' }],
      ['aggregate_records', { scope_id: scope, table: 'incident' }],
      ['get_related_records', { scope_id: scope, table: 'incident', sys_id: id }],
      ['get_record_history', { scope_id: scope, table: 'incident', sys_id: id }],
      ['search_code', { scope_id: scope, pattern: 'x' }],
      ['compare_records', { scope_id: compare, table: 'incident', match_a: { sys_id: id } }],
    ];
    expect(calls.map((c) => c[0]).sort()).toEqual([...DATA_TOOLS].sort());
    for (const [tool, args] of calls) {
      const r = await h.call(tool, args);
      expect(r.ok, `${tool}: ${JSON.stringify(r).slice(0, 200)}`).toBe(true);
      expect(r.provenance?.retrieved_at, tool).toBeTruthy();
      expect(r.untrusted_content, tool).toBeTruthy();
      expect(typeof r.complete, tool).toBe('boolean');
      expect(typeof r.requests_used, tool).toBe('number');
      if (!r.complete) expect(r.omitted?.length ?? 0, tool).toBeGreaterThan(0);
    }
    await h.close();
  });
});

describe('fixes found in review', () => {
  it('ACL-hidden rows are never repeated after a budget stop inside a window', async () => {
    const sn = dictionaryFixture();
    const rows = Array.from({ length: 300 }, (_, i) =>
      sn.insert('incident', {
        number: `INC${String(i).padStart(4, '0')}`,
        short_description: `row ${i} ${'x'.repeat(200)}`,
      }),
    );
    const hidden = (r: Record<string, unknown>) => {
      const n = Number(String(r.number ?? '').slice(3));
      return String(r.number ?? '').startsWith('INC') && n % 7 === 3;
    };
    const visible = rows.filter((r) => !hidden(r)).map((r) => r.sys_id);
    const h = await harness({ sn, hidden });
    const scope = await claim(h, 'dev');
    const seen: string[] = [];
    let r = await h.call('query_records', {
      scope_id: scope,
      table: 'incident',
      limit: 300,
      max_chars: 4000,
    });
    for (;;) {
      seen.push(...r.data.records.map((x: { sys_id: string }) => x.sys_id));
      if (!r.page.next_cursor) break;
      r = await h.call('query_records', {
        scope_id: scope,
        cursor: r.page.next_cursor,
        max_chars: 4000,
      });
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...visible].sort());
    await h.close();
  });

  it('an oversized record on a table with over 50 fields is read within the wire limit', async () => {
    const sn = dictionaryFixture();
    sn.insert('sys_db_object', { name: 'u_wide', label: 'Wide', super_class: '' });
    const row: Record<string, unknown> = {};
    for (let i = 0; i < 70; i++) {
      const element = `u_f${String(i).padStart(2, '0')}`;
      sn.insert('sys_dictionary', {
        name: 'u_wide',
        element,
        column_label: element,
        internal_type: 'string',
        reference: '',
        max_length: '40',
        mandatory: 'false',
        display: 'false',
      });
      row[element] = 'v';
    }
    const inserted = sn.insert('u_wide', row);
    // Anything but an explicit short field list counts as too large.
    const h = await harness({ sn, tooLarge: (op) => (op.fields?.length ?? 99) > 50 || !op.fields });
    const scope = await claim(h, 'dev');
    const r = await h.call('query_records', { scope_id: scope, table: 'u_wide', fields: ['*'] });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    expect(r.data.records[0].sys_id).toBe(inserted.sys_id);
    expect(Object.keys(r.data.records[0]).length).toBe(50);
    const dropped = r.omitted.filter((o: { reason?: string }) => o.reason === 'too_large');
    expect(dropped).toHaveLength(21);
    for (const o of dropped) expect(o.next.tool).toBe('get_field_content');
    expect(r.complete).toBe(false);
    await h.close();
  });
});
