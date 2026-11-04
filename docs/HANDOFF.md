# Handoff

_Last updated: 2026-11-04 (after T-008)_

## Current project state

- **Phase 0 (Foundation):** complete (T-001, T-002, T-003).
- **Phase 1:** T-004 is DONE. The MV3 extension builds to `packages/extension/dist/` with stable ID `clipfeocpiljpcngmjpdbegciimchbol` (`packages/extension/EXTENSION_ID`). It has a minimal popup registry: paste the URL, pick alias and env, and it requests the exact host permission and saves to `chrome.storage.local`.
- **Packages:**
  - `packages/shared`: protocol schemas, errors, limits, identifier validation, query module.
  - `packages/server`: placeholder.
  - `packages/extension`: service worker (`src/background/index.ts`, logging only), `src/background/registry.ts` (pure logic plus a `chrome.storage.local` adapter), popup (`src/popup/*`), and `src/csp.ts` (zod `jitless`; must be the first import of every entry point).
- **Toolchain:** Node 24, TypeScript 7.0.2, vitest 5.1.0, Biome 2.6.5, esbuild 0.28.2 (its postinstall is denied in `allowScripts`; it works without it).

## Design revision — ADR-011 (2026-11-04, user-directed)

**"Optimize how Claude retrieves information, not how much it may investigate."**

- **Removed:**
  - Row caps (100, or 50 on PROD), the offset ceiling of 2,000, and the no-condition limit of 20.
  - The `fields:["*"]` limit of 10, the high-volume time-window requirement and `QUERY_TOO_BROAD`.
  - Per-minute quotas and `BUDGET_EXCEEDED`, fan-out caps, the 30 s dedup, and the 400-line chunk cap.
- **Kept, as user-configurable per-request safeguards in the extension:** timeout 30 s, response size 10 MB (the server halves the page size automatically), concurrency 4 per instance (queued). Same for DEV and PROD; PROD is stricter only for authorization.
- **New contract:**
  - Automatic upstream pagination with signed cursors bound to the instance (not the scope).
  - `complete` + `omitted[]` with a `next` call for every missing part.
  - Complete field reads through line/char chunks, with an in-process field cache.
  - Per-call `max_chars` up to a configurable ceiling.
- **Updated:**
  - Docs: ARCHITECTURE §5.4, §6.4, §8; PRODUCT_SPEC FR-3.6, FR-5.5, FR-6, AC-12; CLAUDE.md rule 8; IMPLEMENTATION_PLAN.
  - DECISIONS: ADR-011 added; ADR-005 and ADR-006 marked partly superseded.
  - TASKS: T-018, T-019, T-023, T-024, T-025, T-027–T-034 rewritten; T-016 note.
- **Shared code aligned:**
  - `limits.ts`: `MAX_PAGE_SIZE`, `SERVER_DEFAULTS`, `SAFEGUARD_DEFAULTS`/`RANGES`, `BROKER_MAX_IN_FLIGHT_PER_CLIENT`.
  - `protocol.ts`: page size ≤1,000 per request, no offset ceiling.
  - `errors.ts`: `RATE_LIMITED`, revised hints.
  - Tests updated: 240 shared tests pass.

## Tasks

- **Current task:** none (nothing IN_PROGRESS).
- **Last completed task:** T-008 — Minimal MCP server (commit `T-008: minimal MCP server`). Tools: `list_instances`, `request_scope`, `claim_scope`, `query_records` (PoC). Entry point: `packages/server/dist/bin/mcp-server.js`.
- **Next task:** **T-009 — PoC end-to-end in Claude Code + Desktop (Milestone M1).** It depends on T-007 ✔ and T-008 ✔. It needs:
  - registering the server with Claude Code (`claude mcp add`) and with Claude Desktop (`claude_desktop_config.json`);
  - the user's Chrome with the extension, and a logged-in `dev469966` tab;
  - a broker traffic capture showing no cookie or token;
  - confirming the SDK v2 protocol works with Desktop.
- **Installed on the user's Mac:** the native host (see T-007).

## Files changed in last task

- Server:
  - New: `src/bridge/client.ts`, `src/mcp/{server,results,scope-store}.ts`, `src/bin/mcp-server.ts`, `test/mcp.test.ts`.
  - Modified: `src/bridge/handshake.ts` (`isOpen`), `src/native-host/broker.ts` (register-before-send fix), `test/broker.test.ts` (regression), `package.json` (deps, `bin`, `start`), `README.md`.
- Docs: TASKS (T-008 evidence), DECISIONS (ADR-008 addendum), HANDOFF.

## Tests performed

- Root build, tests (shared 240, server 48, extension 74) and lint all exit 0.
- Live stdio smoke: 4 tools; `list_instances` → `dev`; `SCOPE_REQUIRED` without a scope.

## Open blockers

- **Live ServiceNow DEV instance:** available: `dev469966.service-now.com` (alias `dev`, PDI, local login `admin`), registered in the user's Chrome extension. Live steps need the user to run them in their own Chrome, because Claude in Chrome can't open `chrome://` or extension pages.

## Important context to continue

- **Scope:** Native Claude + Local MCP server + Chrome session bridge + optional skills. **No knowledge or memory subsystem** (ADR-010).
- **Key decisions:**
  - ADR-001: Native Messaging + HMAC-authenticated socket broker.
  - ADR-003: user-approved scope grants with approval codes.
  - ADR-004: operation descriptors only.
  - ADR-005: structured filters + validated encoded queries.
  - ADR-006: budgets, signed cursors, `AMBIGUOUS_MATCH`.
- **ADR-002 (session access path) is still Proposed**, pending live T-005 results.
- **Dependencies:** `zod@4.6.7` is in shared. `@modelcontextprotocol/server` isn't installed yet (comes in T-008; re-check the version with `npm view`).
- **Query module usage:** use `compileFilter(input, {allowTextSearch})` for structured input. Use `parseEncodedQuery(q, {profile:'strict'})` for raw model input in the server, and `{profile:'enforce'}` in the extension. `referencedFields` feeds dictionary validation (T-018). To verify live in T-005: `RELATIVEGE@unit@ago@n` and plain-date `BETWEEN`.
- **Loading the extension headlessly for checks:** branded Chrome ignores `--load-extension`. Use `--headless=new --enable-unsafe-extension-debugging --remote-debugging-port=N` with a throwaway `--user-data-dir`, then the CDP `Extensions.loadUnpacked`. `chrome.developerPrivate.getExtensionInfo(id)` on `chrome://extensions` gives the errors and warnings.
- **Native host runtime files:** `~/Library/Application Support/sn-mcp/` (0700) holds `broker.sock` (0600), `broker.key` (0600, rotates per start), `broker.pid` and `broker.log` (0600, metadata only). Host exit codes: 64 bad origin, 78 unsafe path, 75 conflict.
- **Docs editing:** Biome formatted the markdown once, so headings are followed by a blank line (`### T-00N — …\n\n- **Status:** …`). Match that when scripting status edits.
- **Workspace build order** is the `workspaces` array order (shared → server → extension). The server resolves `@sn-mcp/shared` via `dist/`, so build shared before running server type-checks.
- **Paths:**
  - `.claude/settings.local.json` is git-ignored (local Claude Code settings).
  - Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`.
  - Chrome native hosts directory: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
