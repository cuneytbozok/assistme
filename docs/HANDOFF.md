# Handoff

_Last updated: 2026-11-04 (after T-005)_

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
- **Last completed task:** T-005 — Live session hypothesis spike.
  - Commits: `T-005: session diagnostics spike` (`08aa721`, spike code kept for history) and `T-005: live session results, ADR-002 accepted (Path A)`.
- **Outcome:**
  - **ADR-002 Accepted: Path A.** The service worker sends `fetch(credentials:'include')` with `X-UserToken` = `g_ck`, read via MAIN-world `executeScript` from an open tab of the granted host. See `docs/POC_RESULTS.md`.
  - **New T-013 requirement:** suppress Chrome's native HTTP-auth dialog, which appeared on logged-out requests and blocked them until cancelled.
- **Next task:** **T-006 — Native host / authenticated broker** (depends on T-002 ✔). No live instance is needed.
- **T-007** needs T-005 ✔ and T-006.

## Files changed in last task

- New: `docs/POC_RESULTS.md`.
- Spike (added, then removed; see `08aa721`): `packages/extension/src/background/{session,diagnostics-handler}.ts`, `src/diagnostics/*`, `src/globals.d.ts`, `test/session-spike.test.ts`, `build:diag` script.
- Docs: DECISIONS (ADR-002 Accepted), ARCHITECTURE §7, TASKS (T-003 note, T-004 user confirmation, T-005 evidence, T-013 requirement), HANDOFF.

## Tests performed

- Live: three diagnostic sessions on `dev469966.service-now.com` (Chrome 156), run by the user.
- After removing the spike: root build, tests (shared 240, server 1, extension 50) and lint all exit 0.

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
- **Docs editing:** Biome formatted the markdown once, so headings are followed by a blank line (`### T-00N — …\n\n- **Status:** …`). Match that when scripting status edits.
- **Workspace build order** is the `workspaces` array order (shared → server → extension). The server resolves `@sn-mcp/shared` via `dist/`, so build shared before running server type-checks.
- **Paths:**
  - `.claude/settings.local.json` is git-ignored (local Claude Code settings).
  - Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`.
  - Chrome native hosts directory: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
