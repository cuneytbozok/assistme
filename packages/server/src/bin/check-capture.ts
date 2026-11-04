#!/usr/bin/env node
/**
 * Checks a broker traffic capture (T-009, AC3):
 *   - no frame contained a credential marker (Cookie, JSESSIONID, glide_, g_ck, X-UserToken),
 *     checked on the raw frame at capture time and again on the stored frame;
 *   - optionally, the active session token never appeared: put the token in SN_MCP_TOKEN
 *     (e.g. copy(g_ck) in the ServiceNow tab's DevTools, then SN_MCP_TOKEN="$(pbpaste)").
 *     Only its hash prefix is compared; the value is never printed.
 *
 *   npm run check-capture -w @sn-mcp/server [-- /path/to/broker.capture.jsonl]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURE_FILE, hashPrefix, scanForCredentials } from '../native-host/capture.js';
import { defaultRuntimeDir } from '../native-host/socket-guard.js';

const path = process.argv[2] ?? join(defaultRuntimeDir(), CAPTURE_FILE);
const token = process.env.SN_MCP_TOKEN?.trim();
const tokenHash = token ? hashPrefix(token) : undefined;

interface Line {
  at: string;
  dir: string;
  kind: string;
  detail?: string;
  bytes: number;
  findings: string[];
  hashes: string[];
  frame: unknown;
}

const lines = readFileSync(path, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Line);

const problems: string[] = [];
const byDir = new Map<string, number>();
const clients = new Set<string>();
let snOk = 0;
for (const [i, l] of lines.entries()) {
  byDir.set(l.dir, (byDir.get(l.dir) ?? 0) + 1);
  if (l.findings.length > 0)
    problems.push(`line ${i + 1} (${l.dir} ${l.kind}): raw frame matched ${l.findings.join(', ')}`);
  const stored = scanForCredentials(JSON.stringify(l.frame));
  if (stored.length > 0) problems.push(`line ${i + 1}: stored frame matched ${stored.join(', ')}`);
  if (tokenHash && l.hashes.includes(tokenHash))
    problems.push(`line ${i + 1} (${l.dir} ${l.kind}): contains the session token`);
  const f = l.frame as {
    client?: { label?: { name?: string } };
    ok?: boolean;
    result?: { type?: string; status?: number };
  };
  if (f.client?.label?.name) clients.add(f.client.label.name);
  if (
    l.dir === 'ext>broker' &&
    f.ok === true &&
    f.result?.type === 'sn.op' &&
    f.result.status === 200
  )
    snOk++;
}

console.log(`Capture: ${path}`);
console.log(`Frames: ${lines.length} (${[...byDir].map(([d, n]) => `${d}: ${n}`).join(', ')})`);
console.log(`Clients seen: ${[...clients].join(', ') || 'none'}`);
console.log(`Successful sn.op responses (HTTP 200): ${snOk}`);
console.log(`Credential markers checked: Cookie, JSESSIONID, glide_, g_ck, X-UserToken`);
console.log(
  `Session token value check: ${tokenHash ? 'performed (hash prefix only)' : 'skipped (set SN_MCP_TOKEN to enable)'}`,
);
if (problems.length > 0) {
  console.log(`\nFAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nPASS — no credential material in the capture.');
