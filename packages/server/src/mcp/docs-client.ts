/**
 * Optional documentation research (T-050, ADR-019): keyword search through GitMCP's code search,
 * page reads directly from GitHub. Both destinations are fixed here: nothing a tool receives can
 * change the host or the repository, and nothing here touches the broker or ServiceNow.
 */

const GITMCP_URL = 'https://gitmcp.io/ServiceNow/ServiceNowDocs';
const RAW_BASE = 'https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs';
const CODE_SEARCH_TOOL = 'search_ServiceNowDocs_code';
/** The repository's default branch, which is its latest release. */
const LATEST_REF = 'HEAD';

const PAGE_PATH_RE =
  /^(?:markdown\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.md$/;
export const RELEASE_RE = /^[a-z][a-z0-9-]{0,30}$/;

const STOP_WORDS = new Set(
  'a an and are at be by can cannot do does doesn for from how i in is it its my not of on or the to was what when where why with without wont'.split(
    ' ',
  ),
);

export class DocsUnavailable extends Error {}

export interface DocsHit {
  path: string;
  /** GitHub URL pinned to the searched commit. */
  sourceUrl: string;
  /** The commit, so reading a hit gets exactly the version that matched. */
  ref: string;
}

export interface DocsSearchResult {
  total: number;
  hits: DocsHit[];
}

export interface PageMeta {
  title?: string;
  release?: string;
  lastUpdated?: string;
  canonicalUrl?: string;
}

/** `dir/page.md` or `markdown/dir/page.md`, always returned with the `markdown/` prefix. */
export function normalizePagePath(path: string): string | undefined {
  if (!PAGE_PATH_RE.test(path)) return undefined;
  return path.startsWith('markdown/') ? path : `markdown/${path}`;
}

/** The repository's Markdown escapes underscores outside code, so a term has two spellings. */
export function unescapeMarkdown(s: string): string {
  return s.replace(/\\_/g, '_');
}

export function querySpellings(query: string): string[] {
  const plain = unescapeMarkdown(query).trim();
  return plain.includes('_') ? [plain.replace(/_/g, '\\_'), plain] : [plain];
}

const isTechnical = (w: string) => /[_.]|[a-z][A-Z]|\d/.test(w);

/**
 * Every word has to match, so a long question often finds nothing. One simpler search: the
 * technical terms if there are any, otherwise the leading content words. Only one, because
 * GitMCP slows down and then fails when searches come in bursts (measured, T-050).
 */
export function simplerQuery(query: string): string | undefined {
  const words = unescapeMarkdown(query)
    .replace(/["?,;:!()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const content = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  const technical = content.filter(isTechnical);
  const simpler = (technical.length > 0 ? technical : content.slice(0, 3)).join(' ');
  return simpler && simpler !== words.join(' ') ? simpler : undefined;
}

/** The frontmatter fields used for citations. A plain reader: the format is one `key: value` a line. */
export function parseFrontmatter(page: string): PageMeta {
  const block = /^---\n([\s\S]*?)\n---/.exec(page)?.[1] ?? '';
  const get = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(block)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '');
  const title = get('title');
  const release = get('release');
  const lastUpdated = get('last_updated');
  const canonicalUrl = get('canonical_url');
  return {
    ...(title ? { title } : {}),
    ...(release ? { release } : {}),
    ...(lastUpdated ? { lastUpdated } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
  };
}

/** Up to `max` body lines mentioning the search terms, those with the most terms ahead. */
export function matchingLines(page: string, query: string, max = 2): string[] {
  const terms = query
    .toLowerCase()
    .replace(/["]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
  const body = page.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const scored: { line: string; score: number; at: number }[] = [];
  body.split('\n').forEach((raw, at) => {
    // Many reference tables are HTML on one line: keep the words.
    const line = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const lower = line.toLowerCase();
    const score = terms.filter((t) => lower.includes(t)).length;
    if (score > 0) scored.push({ line, score, at });
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.slice(0, max).map(({ line }) => {
    if (line.length <= 300) return line;
    // Keep the term in view when the line is long.
    const lower = line.toLowerCase();
    const hit = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
    const from = Math.max(0, hit - 80);
    return `${from > 0 ? '…' : ''}${line.slice(from, from + 300)}…`;
  });
}

function parseCodeSearch(text: string): DocsSearchResult {
  if (/No code matches found/i.test(text)) return { total: 0, hits: [] };
  const total = /Found (\d+) matches/.exec(text)?.[1];
  // Anything else is GitMCP or GitHub reporting a problem (a rate limit, say), not "no results".
  if (total === undefined) {
    throw new DocsUnavailable(
      /GitHub API request failed|rate limit/i.test(text)
        ? 'GitHub refused the search through GitMCP, probably a shared rate limit.'
        : 'GitMCP returned an unexpected search result.',
    );
  }
  const hits: DocsHit[] = [];
  for (const m of text.matchAll(
    /\*\*Path\*\*: (\S+)\s*\n- \*\*URL\*\*: (https:\/\/github\.com\/ServiceNow\/ServiceNowDocs\/blob\/([0-9a-f]{7,40})\/\S+)/g,
  )) {
    hits.push({ path: m[1] as string, sourceUrl: m[2] as string, ref: m[3] as string });
  }
  return { total: Number(total), hits };
}

function jsonRpcBody(text: string): {
  result?: Record<string, unknown>;
  error?: { message?: string };
} {
  // Streamable HTTP answers as one SSE event, or as plain JSON.
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  try {
    return JSON.parse(data ? data.slice(5) : text);
  } catch {
    throw new DocsUnavailable('GitMCP returned an unreadable response.');
  }
}

class SessionExpired extends Error {}

export class DocsClient {
  private session: Promise<string | undefined> | undefined;
  private id = 0;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private headers(session?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    };
  }

  private async post(
    message: Record<string, unknown>,
    session: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(GITMCP_URL, {
        method: 'POST',
        headers: this.headers(session),
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        signal,
      });
    } catch (e) {
      throw new DocsUnavailable(
        signal.aborted
          ? 'GitMCP did not answer in time.'
          : `GitMCP could not be reached: ${String(e)}`,
      );
    }
    if (session && (res.status === 404 || res.status === 400)) throw new SessionExpired();
    if (!res.ok) throw new DocsUnavailable(`GitMCP answered HTTP ${res.status}.`);
    return res;
  }

  private async open(signal: AbortSignal): Promise<string | undefined> {
    const res = await this.post(
      {
        id: ++this.id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'sn-mcp-docs', version: '1' },
        },
      },
      undefined,
      signal,
    );
    await res.text();
    const session = res.headers.get('mcp-session-id') ?? undefined;
    await (await this.post({ method: 'notifications/initialized' }, session, signal)).text();
    return session;
  }

  /**
   * One GitMCP code search page. An expired session is reopened once. Other failures aren't
   * retried: an immediate retry only adds to the load that slows GitMCP down.
   */
  async codeSearch(query: string, page: number, signal: AbortSignal): Promise<DocsSearchResult> {
    for (let attempt = 0; ; attempt++) {
      let session: string | undefined;
      try {
        this.session ??= this.open(signal);
        session = await this.session;
      } catch (e) {
        this.session = undefined;
        throw e;
      }
      try {
        const res = await this.post(
          {
            id: ++this.id,
            method: 'tools/call',
            params: { name: CODE_SEARCH_TOOL, arguments: { query, page } },
          },
          session,
          signal,
        );
        const body = jsonRpcBody(await res.text());
        if (body.error || body.result?.isError === true) {
          throw new DocsUnavailable(
            `GitMCP reported an error: ${body.error?.message ?? 'search failed'}`,
          );
        }
        const content = body.result?.content as { text?: string }[] | undefined;
        return parseCodeSearch((content ?? []).map((c) => c.text ?? '').join('\n'));
      } catch (e) {
        if (!(e instanceof SessionExpired)) throw e;
        this.session = undefined;
        if (attempt > 0) throw new DocsUnavailable('GitMCP keeps dropping the session.');
      }
    }
  }

  /** A page's text from a release or commit, or undefined if it doesn't exist there. */
  async readPage(
    path: string,
    ref: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    return this.raw(`${ref ?? LATEST_REF}/${path}`, signal);
  }

  /** The releases `llms.txt` lists, for explaining a release that wasn't found. */
  async listReleases(signal: AbortSignal): Promise<string[]> {
    const text = (await this.raw(`${LATEST_REF}/llms.txt`, signal)) ?? '';
    return [...text.matchAll(/^\s*- "([a-z0-9-]+)" : "[a-z0-9-]+"/gm)].map((m) => m[1] as string);
  }

  private async raw(suffix: string, signal: AbortSignal): Promise<string | undefined> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${RAW_BASE}/${suffix}`, { signal });
    } catch {
      throw new DocsUnavailable(
        signal.aborted ? 'GitHub did not answer in time.' : 'GitHub could not be reached.',
      );
    }
    if (res.status === 404) return undefined;
    if (!res.ok) throw new DocsUnavailable(`GitHub answered HTTP ${res.status}.`);
    return res.text();
  }
}
