/**
 * T-050: optional documentation research, with GitMCP and GitHub mocked. Mocks prove the logic
 * only: live evidence is test/e2e/docs-client.ts and a real client run.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { BridgeClient } from '../src/bridge/client.js';
import { loadConfig } from '../src/config.js';
import {
  matchingLines,
  normalizePagePath,
  parseFrontmatter,
  querySpellings,
  simplerQuery,
} from '../src/mcp/docs-client.js';
import { createMcpServer, INSTRUCTIONS } from '../src/mcp/server.js';

const SHA = 'a'.repeat(40);
const PAGE = `---
title: Table API
canonical_url: https://www.servicenow.com/docs/r/x/c_TableAPI.html
release: brazil
last_updated: "2026-09-10"
---

# Table API

Other text.
Use sysparm\\_suppress\\_pagination\\_header to skip the Link header.
`;

const hitText = (path: string, total = 1) =>
  `Found ${total} matches in ServiceNow/ServiceNowDocs.\n\n#### p\n- **Path**: ${path}\n- **URL**: https://github.com/ServiceNow/ServiceNowDocs/blob/${SHA}/${path}\n- **Score**: 1\n`;
const NONE = '### Code Search Results\n\nNo code matches found in ServiceNow/ServiceNowDocs.';

interface Fake {
  urls: string[];
  queries: string[];
  fetch: typeof fetch;
}

function fakeNet(search: (query: string, page: number) => string | Error | 'hang'): Fake {
  const urls: string[] = [];
  const queries: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://gitmcp.io/ServiceNow/ServiceNowDocs') {
      const m = JSON.parse(String(init?.body));
      if (m.method === 'initialize') {
        return new Response(
          `event: message\ndata: ${JSON.stringify({ id: m.id, result: {} })}\n\n`,
          {
            headers: { 'mcp-session-id': 's1' },
          },
        );
      }
      if (m.method === 'notifications/initialized') return new Response('', { status: 202 });
      queries.push(m.params.arguments.query);
      const out = search(m.params.arguments.query, m.params.arguments.page);
      if (out === 'hang') {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (out instanceof Error) throw out;
      return new Response(
        `event: message\ndata: ${JSON.stringify({ id: m.id, result: { content: [{ type: 'text', text: out }] } })}\n\n`,
      );
    }
    if (url.endsWith('/llms.txt')) {
      return new Response(
        '    - "brazil" : "brazil" -- Brazil family\n    - "zurich" : "zurich" -- Zurich family\n',
      );
    }
    if (url.includes('/missing.md')) return new Response('404', { status: 404 });
    return new Response(PAGE);
  }) as typeof fetch;
  return { urls, queries, fetch: f };
}

async function connect(fake: Fake | undefined, env: Record<string, string> = { SN_MCP_DOCS: '1' }) {
  const server = createMcpServer({ cachedRegistry: undefined } as unknown as BridgeClient, {
    config: loadConfig(env),
    ...(fake ? { docs: { fetch: fake.fetch, searchDeadlineMs: 300 } } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  // biome-ignore lint/suspicious/noExplicitAny: result bodies are checked field by field
  return { isError: r.isError === true, body: r.structuredContent as Record<string, any> };
}

describe('setting', () => {
  it('is off by default: no tools, unchanged instructions', async () => {
    const c = await connect(undefined, {});
    const { tools } = await c.listTools();
    expect(tools.some((t) => t.name.startsWith('docs_'))).toBe(false);
    expect(c.getInstructions()).toBe(INSTRUCTIONS);
    await c.close();
  });

  it.each([['1'], ['true'], ['TRUE']])('%s turns it on', async (v) => {
    const c = await connect(undefined, { SN_MCP_DOCS: v });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('docs_search');
    expect(names).toContain('docs_read');
    await c.close();
  });

  // An unfilled mcpb placeholder counts as off.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the test
  it.each([['false'], ['0'], [''], ['${user_config.docs_research}']])('%s leaves it off', (v) => {
    expect(loadConfig({ SN_MCP_DOCS: v }).docsEnabled).toBe(false);
  });
});

describe('time limit', () => {
  it('defaults to 55 seconds, can be changed, and ignores invalid values', () => {
    expect(loadConfig({}).docsTimeoutMs).toBe(55_000);
    expect(loadConfig({ SN_MCP_DOCS_TIMEOUT_S: '120' }).docsTimeoutMs).toBe(120_000);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an unfilled placeholder is the test
    for (const bad of ['1', '601', 'soon', '', '${user_config.docs_timeout_s}']) {
      expect(loadConfig({ SN_MCP_DOCS_TIMEOUT_S: bad }).docsTimeoutMs).toBe(55_000);
    }
  });

  it('the setting decides when a slow search ends, and the result names it', async () => {
    const server = createMcpServer({ cachedRegistry: undefined } as unknown as BridgeClient, {
      config: { ...loadConfig({ SN_MCP_DOCS: '1' }), docsTimeoutMs: 200 },
      docs: { fetch: fakeNet(() => 'hang').fetch },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(ct);
    const started = Date.now();
    const r = await call(c, 'docs_search', { query: 'x' });
    expect(r.body.error.code).toBe('DOCS_UNAVAILABLE');
    expect(r.body.error.hint).toMatch(/SN_MCP_DOCS_TIMEOUT_S/);
    expect(Date.now() - started).toBeLessThan(3000);
    await c.close();
  });
});

describe('research stays free', () => {
  // Wording that would rank documentation above other sources, or impose an order.
  const STEERING =
    /\b(first|before|prefer|instead of|only source|authoritative|definitive|must|always|required|mandatory|start here)\b/i;

  it('tool text, instructions and hints have no ordering or exclusivity wording', async () => {
    const fake = fakeNet(() => NONE);
    const c = await connect(fake);
    const docs = (await c.listTools()).tools.filter((t) => t.name.startsWith('docs_'));
    expect(docs).toHaveLength(2);
    const texts = docs.map((t) => t.description ?? '');
    texts.push((c.getInstructions() ?? '').slice(INSTRUCTIONS.length));
    const empty = await call(c, 'docs_search', { query: 'nothing' });
    texts.push(...(empty.body.hints as string[]));
    for (const t of texts) expect(t).not.toMatch(STEERING);
    expect(texts.at(-1)).toMatch(/other sources/);
    await c.close();
  });

  it('no docs input can carry a URL, method or header', async () => {
    const c = await connect(fakeNet(() => NONE));
    for (const t of (await c.listTools()).tools.filter((x) => x.name.startsWith('docs_'))) {
      for (const k of Object.keys(t.inputSchema.properties ?? {})) {
        expect(k).not.toMatch(/^(url|uri|href|endpoint|path|method|verb|header|headers|body)$/i);
      }
    }
    await c.close();
  });

  it('no docs call is needed for another tool, and docs need no scope', async () => {
    const fake = fakeNet(() => hitText('markdown/a/b.md'));
    const c = await connect(fake);
    expect((await call(c, 'docs_search', { query: 'x' })).isError).toBe(false);
    expect((await call(c, 'query_records', { table: 'incident' })).body.error.code).toBe(
      'SCOPE_REQUIRED',
    );
    await c.close();
  });
});

describe('docs_search', () => {
  it('searches both Markdown spellings and cites its results', async () => {
    const fake = fakeNet((q) => (q.includes('\\_') ? hitText('markdown/a/page.md') : NONE));
    const c = await connect(fake);
    const { body } = await call(c, 'docs_search', { query: 'sysparm_suppress_pagination_header' });
    expect(fake.queries.sort()).toEqual([
      'sysparm\\_suppress\\_pagination\\_header',
      'sysparm_suppress_pagination_header',
    ]);
    expect(body.complete).toBe(true);
    expect(body.data.release).toBe('brazil');
    expect(body.data.results[0]).toEqual({
      path: 'markdown/a/page.md',
      title: 'Table API',
      release: 'brazil',
      last_updated: '2026-09-10',
      canonical_url: 'https://www.servicenow.com/docs/r/x/c_TableAPI.html',
      source_url: `https://github.com/ServiceNow/ServiceNowDocs/blob/${SHA}/markdown/a/page.md`,
      matches: ['Use sysparm_suppress_pagination_header to skip the Link header.'],
    });
    await c.close();
  });

  it('merges the spellings without repeating a page', async () => {
    const fake = fakeNet((q) => hitText(q.includes('\\_') ? 'markdown/a/x.md' : 'markdown/a/x.md'));
    const c = await connect(fake);
    const { body } = await call(c, 'docs_search', { query: 'a_b' });
    expect(body.data.results).toHaveLength(1);
    await c.close();
  });

  it('retries with simpler terms and says what it searched', async () => {
    const fake = fakeNet((q) => (q === 'setWorkflow' ? hitText('markdown/a/br.md', 18) : NONE));
    const c = await connect(fake);
    const { body } = await call(c, 'docs_search', {
      query: 'why is my business rule not firing setWorkflow',
    });
    // One retry only: GitMCP slows down and fails under bursts.
    expect(fake.queries).toEqual(['why is my business rule not firing setWorkflow', 'setWorkflow']);
    expect(body.data.searched_as).toBe('setWorkflow');
    expect(body.data.results).toHaveLength(1);
    await c.close();
  });

  it('an empty search is a normal result that points outward', async () => {
    const fake = fakeNet(() => NONE);
    const c = await connect(fake);
    const r = await call(c, 'docs_search', { query: 'zz' });
    expect(r.isError).toBe(false);
    expect(r.body.data.results).toEqual([]);
    expect(r.body.hints[0]).toMatch(/other sources may cover it/);
    await c.close();
  });

  it('a failure of GitHub behind GitMCP is not retried, and keeps the session', async () => {
    const fake = fakeNet(
      () => 'Failed to search code in ServiceNow/ServiceNowDocs. GitHub API request failed.',
    );
    const c = await connect(fake);
    const r = await call(c, 'docs_search', { query: 'word' });
    expect(r.body.error.message).toMatch(/rate limit/);
    expect(fake.queries).toEqual(['word']);
    await call(c, 'docs_search', { query: 'word2' });
    const opens = fake.urls.filter((u) => u.includes('gitmcp')).length;
    expect(opens).toBe(4); // initialize, initialized, two searches
    await c.close();
  });

  it('larger result sets say how to continue', async () => {
    const fake = fakeNet(() => hitText('markdown/a/x.md', 67));
    const c = await connect(fake);
    const { body } = await call(c, 'docs_search', { query: 'acl' });
    expect(body.complete).toBe(false);
    expect(body.omitted[0].next).toEqual({ tool: 'docs_search', args: { query: 'acl', page: 2 } });
    await c.close();
  });

  it.each([
    ['network failure', new Error('down')],
    ['a rate-limit message', 'GitHub API rate limit exceeded'],
  ] as const)('%s gives DOCS_UNAVAILABLE, and docs_read still works', async (_n, out) => {
    const fake = fakeNet(() => out);
    const c = await connect(fake);
    const r = await call(c, 'docs_search', { query: 'x' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('DOCS_UNAVAILABLE');
    expect(r.body.error.hint).toMatch(/other tool or source/);
    expect((await call(c, 'docs_read', { page_path: 'a/page.md' })).isError).toBe(false);
    await c.close();
  });

  it('a slow service ends at the deadline', async () => {
    const fake = fakeNet(() => 'hang');
    const c = await connect(fake);
    const started = Date.now();
    const r = await call(c, 'docs_search', { query: 'x' });
    expect(r.body.error.code).toBe('DOCS_UNAVAILABLE');
    expect(r.body.error.message).toMatch(/time limit/);
    expect(Date.now() - started).toBeLessThan(3000);
    await c.close();
  });

  it('one spelling failing still returns the other, and says so', async () => {
    const fake = fakeNet((q) =>
      q.includes('\\_') ? hitText('markdown/a/x.md') : new Error('down'),
    );
    const c = await connect(fake);
    const { body } = await call(c, 'docs_search', { query: 'a_b' });
    expect(body.data.results).toHaveLength(1);
    expect(body.complete).toBe(false);
    expect(body.omitted[0].kind).toBe('spelling');
    await c.close();
  });

  it('reuses one GitMCP session, and sends requests only to the fixed destinations', async () => {
    const fake = fakeNet(() => hitText('markdown/a/x.md'));
    const c = await connect(fake);
    await call(c, 'docs_search', { query: 'one' });
    await call(c, 'docs_search', { query: 'two' });
    await call(c, 'docs_read', { page_path: 'a/x.md', release: 'zurich' });
    for (const u of fake.urls) {
      expect(
        u === 'https://gitmcp.io/ServiceNow/ServiceNowDocs' ||
          u.startsWith('https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/'),
        u,
      ).toBe(true);
    }
    const inits = fake.urls.filter((u) => u.includes('gitmcp')).length;
    expect(inits).toBe(4); // initialize, initialized, two searches
    await c.close();
  });
});

describe('docs_read', () => {
  it('reads the latest release by default, with what is needed to cite it', async () => {
    const fake = fakeNet(() => NONE);
    const c = await connect(fake);
    const { body } = await call(c, 'docs_read', { page_path: 'markdown/a/page.md' });
    expect(fake.urls).toEqual([
      'https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/HEAD/markdown/a/page.md',
    ]);
    expect(body.data).toMatchObject({
      path: 'markdown/a/page.md',
      release: 'brazil',
      title: 'Table API',
      last_updated: '2026-09-10',
      source_url: 'https://github.com/ServiceNow/ServiceNowDocs/blob/brazil/markdown/a/page.md',
    });
    expect(body.complete).toBe(true);
    expect(JSON.stringify(body.data.lines)).toContain('sysparm_suppress_pagination_header');
    await c.close();
  });

  it('reads a named release from that release', async () => {
    const fake = fakeNet(() => NONE);
    const c = await connect(fake);
    await call(c, 'docs_read', { page_path: 'a/page.md', release: 'zurich' });
    expect(fake.urls[0]).toContain('/ServiceNowDocs/zurich/markdown/a/page.md');
    await c.close();
  });

  it('a missing page is reported, never replaced, and lists the releases', async () => {
    const fake = fakeNet(() => NONE);
    const c = await connect(fake);
    const r = await call(c, 'docs_read', { page_path: 'a/missing.md', release: 'zurich' });
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect(r.body.error.hint).toContain('brazil, zurich');
    expect(fake.urls.filter((u) => u.endsWith('.md'))).toHaveLength(1);
    await c.close();
  });

  it('continues a long page with next until complete', async () => {
    const long = `---\ntitle: L\n---\n${Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')}`;
    const fake = fakeNet(() => NONE);
    const base = fake.fetch;
    fake.fetch = (async (u: RequestInfo | URL, i?: RequestInit) =>
      String(u).includes('long.md') ? new Response(long) : base(u, i)) as typeof fetch;
    const c = await connect(fake);
    let args: Record<string, unknown> = { page_path: 'a/long.md', max_lines: 100 };
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { body } = await call(c, 'docs_read', args);
      for (const l of body.data.lines) lines.push(l.text);
      if (body.complete) break;
      args = body.omitted[0].next.args;
    }
    expect(lines.join('\n')).toBe(long);
    await c.close();
  });

  it.each([
    ['../../secrets.md'],
    ['a/../b.md'],
    ['/etc/passwd.md'],
    ['https://evil.example/a.md'],
    ['a/page.txt'],
    ['a/.hidden.md'],
  ])('refuses %s without any request', async (p) => {
    const fake = fakeNet(() => NONE);
    const c = await connect(fake);
    const r = await call(c, 'docs_read', { page_path: p });
    expect(r.body.error.code).toBe('INVALID_INPUT');
    expect(fake.urls).toEqual([]);
    await c.close();
  });

  it('refuses a release that could change the path', async () => {
    const fake = fakeNet(() => NONE);
    const c = await connect(fake);
    const r = await c.callTool({
      name: 'docs_read',
      arguments: { page_path: 'a/b.md', release: '../other' },
    });
    expect(r.isError).toBe(true);
    expect(fake.urls).toEqual([]);
    await c.close();
  });
});

describe('helpers', () => {
  it('querySpellings', () => {
    expect(querySpellings('GlideRecord')).toEqual(['GlideRecord']);
    expect(querySpellings('a_b')).toEqual(['a\\_b', 'a_b']);
    expect(querySpellings('a\\_b')).toEqual(['a\\_b', 'a_b']);
  });

  it('simplerQuery', () => {
    expect(simplerQuery('oneword')).toBeUndefined();
    expect(simplerQuery('MID Server')).toBeUndefined();
    expect(simplerQuery('how does ACL evaluation order work')).toBe('ACL evaluation order');
    expect(simplerQuery('glide.ui.session_timeout not working')).toBe('glide.ui.session_timeout');
    expect(simplerQuery('why is my business rule not firing setWorkflow')).toBe('setWorkflow');
  });

  it('normalizePagePath', () => {
    expect(normalizePagePath('a/b.md')).toBe('markdown/a/b.md');
    expect(normalizePagePath('markdown/a/b.md')).toBe('markdown/a/b.md');
    expect(normalizePagePath('a/../b.md')).toBeUndefined();
  });

  it('parseFrontmatter and matchingLines ignore frontmatter as matches', () => {
    expect(parseFrontmatter(PAGE).release).toBe('brazil');
    expect(parseFrontmatter('no frontmatter')).toEqual({});
    expect(matchingLines('---\ntitle: acl\n---\nno\nacl order\n', 'acl order')).toEqual([
      'acl order',
    ]);
    expect(matchingLines('<td>acl</td><td>rule</td>', 'acl')).toEqual(['acl rule']);
    const far = matchingLines(`${'x '.repeat(400)}target ${'y '.repeat(400)}`, 'target')[0];
    expect(far).toContain('target');
    expect(far?.startsWith('…')).toBe(true);
  });
});
