/**
 * T-050 live run: an MCP client → the built server over STDIO → real GitMCP and real GitHub.
 * Needs no instance, scope, key or Chrome. Checks every page it cites against GitHub, so a result
 * is judged by the page and not by the tool's own words.
 *
 *   node test/e2e/docs-client.ts [--out docs/evidence/T-050/live.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: { out: { type: 'string', default: 'docs/evidence/T-050/live.json' } },
});

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(ROOT, 'packages/server/dist/bin/mcp-server.js')],
    env: { ...(process.env as Record<string, string>), ...env },
  });
  const c = new Client({ name: 'docs-e2e', version: '0' });
  await c.connect(transport);
  return c;
}

const checks: { name: string; pass: boolean; detail: unknown }[] = [];
function check(name: string, pass: boolean, detail: unknown): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail).slice(0, 200)}`);
}

const clean = (s: string) => s.replace(/\\_/g, '_');

/** GitMCP slows down under bursts, and a person's client searches far less often than this script. */
const pace = (ms = 7000) => new Promise((r) => setTimeout(r, ms));

async function run(c: Client, name: string, args: Record<string, unknown>) {
  const t = Date.now();
  const r = await c.callTool({ name, arguments: args }, { timeout: 120_000 });
  return {
    ms: Date.now() - t,
    isError: r.isError === true,
    // biome-ignore lint/suspicious/noExplicitAny: result bodies are checked field by field below
    body: r.structuredContent as any,
  };
}

const off = await connect({ SN_MCP_DOCS: '' });
const offNames = (await off.listTools()).tools.map((t) => t.name);
check(
  'off by default: 14 tools, none for docs',
  offNames.length === 14 && !offNames.some((n) => n.startsWith('docs_')),
  {
    tools: offNames.length,
  },
);
await off.close();

const c = await connect({ SN_MCP_DOCS: '1' });
const names = (await c.listTools()).tools.map((t) => t.name);
check(
  'on: 16 tools',
  names.length === 16 && names.includes('docs_search') && names.includes('docs_read'),
  {
    tools: names.length,
  },
);

// Terms found in page bodies, with one page known to hold each.
const TERMS: [string, string][] = [
  ['sysparm_suppress_pagination_header', 'markdown/api-reference/rest-apis/c_TableAPI.md'],
  [
    'glide.invalid_query.returns_no_rows',
    'markdown/api-reference/server-api-reference/c_GlideRecordAPI.md',
  ],
  ['glide.ui.session_timeout', 'markdown/platform-administration/r_AvailableSystemProperties.md'],
  ['sysparm_display_value', 'markdown/api-reference/rest-apis/c_TableAPI.md'],
];
for (const [term, page] of TERMS) {
  await pace();
  let paths: string[] = [];
  let r = await run(c, 'docs_search', { query: term });
  const first = r;
  for (
    let p = 2;
    !r.isError && r.body.omitted?.some((o: { kind: string }) => o.kind === 'results') && p < 5;
    p++
  ) {
    paths = paths.concat(r.body.data.results.map((x: { path: string }) => x.path));
    r = await run(c, 'docs_search', { query: term, page: p });
  }
  if (!r.isError) paths = paths.concat(r.body.data.results.map((x: { path: string }) => x.path));
  const top = first.body?.data?.results?.[0];
  const raw = top
    ? clean(
        await (
          await fetch(
            top.source_url
              .replace('github.com', 'raw.githubusercontent.com')
              .replace('/blob/', '/'),
          )
        ).text(),
      )
    : '';
  check(
    `body term: ${term}`,
    !first.isError &&
      paths.includes(page) &&
      raw.includes(term) &&
      top?.release === 'brazil' &&
      Boolean(top?.matches?.length),
    {
      ms: first.ms,
      total: first.body?.data?.total_matches,
      top: top?.path,
      release: top?.release,
      known_page_found: paths.includes(page),
      cited_page_has_term: raw.includes(term),
      match: top?.matches?.[0],
    },
  );
}

// Troubleshooting phrases, as a model or user might write them. Recorded, for reading.
const PHRASES = [
  'ACL evaluation order',
  'why is my business rule not firing setWorkflow',
  'MID Server down not connecting',
  'flow stuck waiting error handling',
  'duplicate CI identification rule',
  'scheduled job sys_trigger not running',
  'zzqqxx_no_such_term_anywhere',
];
const phrases = [];
for (const q of PHRASES) {
  await pace();
  const r = await run(c, 'docs_search', { query: q });
  phrases.push({
    query: q,
    ms: r.ms,
    is_error: r.isError,
    searched_as: r.body?.data?.searched_as,
    total: r.body?.data?.total_matches,
    top: r.body?.data?.results?.slice(0, 3).map((x: { path: string }) => x.path),
    hints: r.body?.hints,
  });
  console.log(JSON.stringify(phrases.at(-1)).slice(0, 260));
}
const sw = phrases[1];
check(
  'a question with no full match retries with simpler terms',
  (sw?.total ?? 0) > 0 && Boolean(sw?.searched_as),
  sw,
);
const none = phrases.at(-1);
check(
  'nothing found is a normal result that points to other sources',
  none?.is_error === false && /other sources/.test(String(none?.hints)),
  none?.hints,
);

// Reading.
const latest = await run(c, 'docs_read', {
  page_path: 'markdown/api-reference/rest-apis/c_TableAPI.md',
});
check(
  'reads the latest release, with citations',
  latest.body?.data?.release === 'brazil' &&
    /servicenow\.com\/docs/.test(latest.body?.data?.canonical_url),
  {
    ms: latest.ms,
    release: latest.body?.data?.release,
    title: latest.body?.data?.title,
    last_updated: latest.body?.data?.last_updated,
    canonical_url: latest.body?.data?.canonical_url,
    source_url: latest.body?.data?.source_url,
    complete: latest.body?.complete,
  },
);
const zurich = await run(c, 'docs_read', {
  page_path: 'markdown/api-reference/rest-apis/c_TableAPI.md',
  release: 'zurich',
});
check('reads a named release', zurich.body?.data?.release === 'zurich', {
  ms: zurich.ms,
  release: zurich.body?.data?.release,
});

// A whole long page, following next, equals the page on GitHub.
const LONG = 'markdown/api-reference/server-api-reference/c_GlideRecordAPI.md';
const rawLong = clean(
  await (
    await fetch(`https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/HEAD/${LONG}`)
  ).text(),
);
let args: Record<string, unknown> = { page_path: LONG };
const out: string[] = [];
let calls = 0;
for (; calls < 100; calls++) {
  const r = await run(c, 'docs_read', args);
  if (r.isError) break;
  for (const l of r.body.data.lines) {
    if (l.from_char) out[out.length - 1] += l.text;
    else out.push(l.text);
  }
  if (r.body.complete) break;
  args = r.body.omitted[0].next.args;
}
check('a long page read in chunks is exact', out.join('\n') === rawLong, {
  calls: calls + 1,
  chars: rawLong.length,
});

const missing = await run(c, 'docs_read', {
  page_path: 'markdown/no/such-page.md',
  release: 'zurich',
});
check(
  'a missing page is reported, with the releases',
  missing.body?.error?.code === 'NOT_FOUND' && /brazil/.test(missing.body?.error?.hint),
  missing.body?.error,
);
const bad = await run(c, 'docs_read', { page_path: '../../etc/passwd.md' });
check(
  'an invalid path is refused',
  bad.body?.error?.code === 'INVALID_INPUT',
  bad.body?.error?.code,
);

// The citation works.
const cite = await fetch(latest.body.data.source_url, { method: 'HEAD' });
check('source_url opens on GitHub', cite.ok, cite.status);

// No Chrome is required for docs, and instance tools answer for themselves.
const scope = await run(c, 'query_records', { table: 'incident' });
check(
  'instance tools still ask for their own scope, with no docs call',
  scope.body?.error?.code === 'SCOPE_REQUIRED',
  scope.body?.error?.code,
);
await c.close();

const passed = checks.filter((x) => x.pass).length;
console.log(`\n${passed}/${checks.length} passed`);
mkdirSync(dirname(resolve(ROOT, values.out as string)), { recursive: true });
writeFileSync(
  resolve(ROOT, values.out as string),
  `${JSON.stringify({ date: new Date().toISOString(), node: process.version, checks, phrases }, null, 2)}\n`,
);
process.exit(passed === checks.length ? 0 : 1);
