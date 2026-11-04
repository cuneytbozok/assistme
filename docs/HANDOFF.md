# Handoff

_Last updated: 2026-11-04 (after T-012)_

## Current project state

- **Phase 0 (Foundation):** complete (T-001, T-002, T-003).
- **Phase 2:** T-012 (MCP scope enforcement) is DONE: `release_scope`, no default scope, compare requests through `request_scope`, `connector_access` in `list_instances`, and an e2e test against the real extension authz. T-011 (full grant model) is DONE: compare grants, TTL choice, revoke-all, red PROD badge, request notifications, purpose and approval time on active access. T-010 (full instance registry) is DONE: add, edit and remove in the popup; grants bound to `{alias, host, env}` and invalidated on removal or env change; `activeTab` suggestions; server-side `registry.update` cache.
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

## Milestones

- **M1 — PoC end to end: ACHIEVED (2026-11-04, T-009).**
  - Claude Desktop chat and a Claude Code session each read INC0000060 from `dev469966` through MCP → broker → extension → Table API, after user approval.
  - The capture check, including the exact-token check, passed.

## Tasks

- **Current task:** none (nothing IN_PROGRESS).
- **Last completed task:** T-012 — MCP scope enforcement (commit `T-012: MCP scope enforcement`).
- **Next tasks:** T-013 (session lifecycle; depends on T-011 ✔), T-014 (bridge resilience; depends on T-012 ✔), T-016 (request builder hardening).
- **Claude Desktop runs the old server build** until it's restarted (`npm run build` done). Restart it before live checks (T-015).
- **"Other" environment (after T-010, user request):** the popup shows `unclassified` as **Other** with an optional name (UAT, SIT, …). It always gets PROD rules and the name is display only. `list_instances` returns `env_name` and `policy`.
- **Popup redesign (after T-010, user request, 2026-11-04):** card layout, status pill, icon edit/remove, segmented env picker, collapsible add form, alias proposal from a tab suggestion, toasts. Same logic and permission calls. Screenshots (seeded data, stubbed `popup.state`): `docs/evidence/T-010/popup-*.png`.
- **Also eligible:** T-016 (request builder hardening; depends on T-007 ✔ and T-003 ✔).
- **Needs a manual check by the user (from T-010):** reload the extension, open the popup on an unregistered ServiceNow tab and check that **Use it** appears and only fills the form. Then edit or remove an instance and confirm `list_instances` in Claude Desktop follows. Removing `dev` ends any active scope.
- **Finding to carry forward:**
  - In the Claude Desktop app, all conversations share one `sn-mcp` server process and therefore one `client_key_id` (ADR-003 addendum; notes added to T-011, T-012, T-015).
  - A standalone Claude Code CLI is untested: the bundled CLI isn't logged in on its own.
  - The MCP server connects to the broker lazily, so it only receives `registry.update` pushes after its first tool call. The cache is a hint only; `list_instances` always reads live.

## Current setup on the user's Mac

- **Native host:** installed without capture. Capture file deleted.
- **Claude Desktop:** `claude_desktop_config.json` has `mcpServers.sn-mcp` (node `/opt/homebrew/Cellar/node@24/24.21.0/bin/node`, `dist/bin/mcp-server.js`, `SN_MCP_CLIENT_NAME=Claude Desktop`). Run `npm run build` after server changes and restart Claude Desktop to pick them up.
- **No `.mcp.json` in the repo.** Code sessions in the Desktop app use the Desktop server.

## Files changed in last task

- Extension:
  - `src/background/{grants,popup-api,index}.ts`
  - `src/popup/{popup.ts,popup.html,popup.css}`
  - `manifest.json` (icons), `build.mjs`, `icons/*.png`
  - `test/grant-model.test.ts` (new), `test/grants.test.ts`
- Docs: TASKS, HANDOFF, DECISIONS (ADR-003 T-011 addendum), ARCHITECTURE §5.4, `docs/evidence/T-011/`.

## Tests performed

- Root build, tests (shared 240, server 58, extension 121) and lint all exit 0.
- Mutation checks: 6 of 6 caught.
- Headless Chrome: loads clean, notification created, red PROD badge, popup screenshots in light and dark mode with no overflow.

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
- **ADR-002 (session access path): Accepted, Path A** (T-005). _Discrepancy fixed in T-010: this line still said "Proposed"._
- **Dependencies:** `zod@4.6.7` is in shared. `@modelcontextprotocol/server@2.4.0` is in the server (T-008, ADR-008).
- **Query module usage:** use `compileFilter(input, {allowTextSearch})` for structured input. Use `parseEncodedQuery(q, {profile:'strict'})` for raw model input in the server, and `{profile:'enforce'}` in the extension. `referencedFields` feeds dictionary validation (T-018). To verify live in T-005: `RELATIVEGE@unit@ago@n` and plain-date `BETWEEN`.
- **Loading the extension headlessly for checks:** branded Chrome ignores `--load-extension`. Use `--headless=new --enable-unsafe-extension-debugging --remote-debugging-port=N` with a throwaway `--user-data-dir`, then the CDP `Extensions.loadUnpacked`. `chrome.developerPrivate.getExtensionInfo(id)` on `chrome://extensions` gives the errors and warnings.
- **Native host runtime files:** `~/Library/Application Support/sn-mcp/` (0700) holds `broker.sock` (0600), `broker.key` (0600, rotates per start), `broker.pid` and `broker.log` (0600, metadata only). Host exit codes: 64 bad origin, 78 unsafe path, 75 conflict.
- **Docs editing:** Biome formatted the markdown once, so headings are followed by a blank line (`### T-00N — …\n\n- **Status:** …`). Match that when scripting status edits.
- **Workspace build order** is the `workspaces` array order (shared → server → extension). The server resolves `@sn-mcp/shared` via `dist/`, so build shared before running server type-checks.
- **Paths:**
  - `.claude/settings.local.json` is git-ignored (local Claude Code settings).
  - Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`.
  - Chrome native hosts directory: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
