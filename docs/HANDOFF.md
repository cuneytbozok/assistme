# Handoff

_Last updated: 2026-11-05 (after T-039 preparation)_

## Where things stand (read this first)

**All code that can be built and mock-tested is done. Everything left needs the user.**

- **DONE:** T-001 to T-014, T-016 to T-034, T-038. All 14 MCP tools exist; 13 ran live on `dev469966` (T-034). `compare_records` is mock-only until a second instance exists.
- **DROPPED by the user:** T-039 (official SDK skill).
- **BLOCKED on the user, prepared as far as possible:** T-015, T-035, T-036, T-037. Each task's entry in TASKS lists what remains unverified.
- **TODO, waiting on those:** T-040 (acceptance matrix), T-041 (recovery drill, install from scratch).
- **Milestones:** M1, M3, M4 achieved. M2, M5, M6 not achieved.

**The user's checklist, in order:**

1. Done 2026-11-05: extension reloaded, T-034 live runs passed.
2. Fully quit and reopen Claude Desktop: its `sn-mcp` server is still the old build.
3. Claude Code: registered and skills installed for the user on 2026-11-05. In a fresh signed-in session: check `/mcp`, try a query, and ask something that should load a skill (T-035, T-038).
4. Done 2026-11-05: Claude Desktop. The bundle and skills are installed, and a real chat worked (user report). Only Cowork remains for T-036. Backup of the old config: `claude_desktop_config.json.before-sn-mcp-bundle`.
6. Done 2026-11-05: the setup round trip on the real machine (T-037). It waits only on T-036.
7. Dropped: the official SDK skill (T-039). The user's Claude Code has `fluent@servicenow`, and the user chose to keep it (2026-11-05). Don't ask again.
8. A second instance for T-015, if one is available. That also allows a live `compare_records` run, which T-034 can't cover.

**Decisions made 2026-11-05 by the user:** the word "javascript" is allowed and only the `javascript:` prefix is refused (ADR-005 addendum); dictionary validation stays fail-closed, with Claude telling the user what they can't read; a denied request stays `status: "denied"` (T-015 AC6 changed).

**Trial investigation passed after the Claude Desktop restart (2026-11-05):** the tools and skill worked in a Code session on INC0000060. Ideas not done: `get_record_history` shows each journal entry twice (the audit row and the journal row); keep a list of tables that refused a `query_range` filter, to avoid repeat banners.

**The user's remaining steps are in `docs/NEXT_STEPS.md`.** Added 2026-11-05: the filter check on returned rows (`mcp/filter-check.ts`, `FILTER_NOT_APPLIED`, live re-run 16 of 16), a first-time `README.md`, and an original teal magnifying-glass icon (`packages/extension/scripts/gen-icons.mjs`). The extension must be reloaded to show the icon.

**Flaky test:** `resilience.test.ts` › "broker id prefixes differ per process" failed once during a full `npm test` on 2026-11-05, then passed 9 of 9 re-runs. Cause not found; the error wasn't captured. If it fails again, keep the message. Timing under load is a guess.

**Known deviations:**

- Output schemas are the `{ok}` envelope only (the 12 KB limit); the full contract is in `docs/TOOLS.md`.
- The `.mcpb` `user_config` has four numeric shaping settings rather than a log level (the server has no log level).
- `scope.check` was added to the protocol (ADR-003 addendum).
- `sysparm_offset` counting pre-ACL rows can't be shown live with an admin user.
- `npm audit`: 0 for production dependencies; 6 in dev packages, nested in `@anthropic-ai/mcpb`.

## Current project state

- **Phase 0 (Foundation):** complete (T-001, T-002, T-003).
- **Phase 3:** T-021 (untrusted-content marker, error catalog test, `docs/SECURITY.md`) is DONE. T-020 (sensitive data: credential-table denylist, password-field refusal and stripping) is DONE. T-019 (per-request safeguards and popup Settings) is DONE. T-018 (dictionary-aware validation, cost-aware defaults) is DONE; `query_records` already validates fields. T-017 (metadata service) is DONE, along with `test/fake-sn.ts` for server tests. T-016 (request builder hardening) is DONE: a single URL constructor with templates, allowlists and a self-check; stats requests are buildable.
- **Phase 2:** T-014 (bridge resilience) is DONE: fixed a stale-answer misdelivery bug after broker restarts, added a heartbeat timeout, and documented the scenario table in ARCHITECTURE §4.5. T-013 (session lifecycle and status) is DONE: per-instance connection states in the popup and `list_instances`; no credential prompts thanks to the `X-UserToken` invariant (ADR-002 addendum). T-012 (MCP scope enforcement) is DONE: `release_scope`, no default scope, compare requests through `request_scope`, `connector_access` in `list_instances`, and an e2e test against the real extension authz. T-011 (full grant model) is DONE: compare grants, TTL choice, revoke-all, red PROD badge, request notifications, purpose and approval time on active access. T-010 (full instance registry) is DONE: add, edit and remove in the popup; grants bound to `{alias, host, env}` and invalidated on removal or env change; `activeTab` suggestions; server-side `registry.update` cache.
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

- **M3 — Read-only and query hardening: ACHIEVED (2026-11-04, T-022).**
- **M2 — Live scope acceptance: BLOCKED** (T-015: needs a second instance).
- **M1 — PoC end to end: ACHIEVED (2026-11-04, T-009).**
  - Claude Desktop chat and a Claude Code session each read INC0000060 from `dev469966` through MCP → broker → extension → Table API, after user approval.
  - The capture check, including the exact-token check, passed.

## Tasks

- **Current task:** none (nothing IN_PROGRESS).
- **Blocked:** T-015 (live scope acceptance, M2) has no second instance for PROD checks (see TASKS T-015).
- **T-024 DONE:** `query_records` is complete (filters, raw query, text, order, display mode, cursors). Tools now live in `server/src/mcp/tools/` with a shared `ToolContext`; tests use `test/mcp-harness.ts`.
- **T-025 DONE:** `get_record` with `tools/support.ts` (`SnClient`, budget), `tools/record-lookup.ts`, `dataResponse`, signed composite cursor state.
- **T-026 DONE:** `discover_tables`, `describe_table`; `beginTool` is the shared opening for data tools.
- **T-027 DONE:** `get_field_content`, `field-cache.ts`, and the new `scope.check` message. **The extension must be reloaded** for it (old extensions fail closed).
- **T-028 DONE:** `aggregate_records` (Stats API, all groups through cursors).
- **T-029 DONE:** `get_related_records` (all reverse references via the dictionary, counts + samples, batches of 60 relations per call).
- **T-030 DONE:** `get_record_history`, `tools/window-reader.ts`. Known issue for T-033: `paginate.ts` can repeat rows after a budget stop inside a window with ACL-hidden rows (no loss).
- **T-031 DONE:** `search_code` (script fields from the dictionary, batches of 25 tables per call, ±3-line snippets).
- **T-031 DONE:** `search_code` (script fields from the dictionary, batches of 25 tables per call, ±3-line snippets).
- **T-032 DONE:** `compare_records` (`line-diff.ts`, snapshot pages, per-side ambiguity).
- **T-033 DONE:** `docs/TOOLS.md`, `lean()` compact schemas (`tools/list` under 12,000 bytes), server instructions hold the shared contract. Fixed: `paginate.ts` repeats with hidden rows; 49-field limit on `query_records`. Output schemas are the `{ok}` envelope only (full contract in TOOLS.md).
- **T-034 BLOCKED:** the runner is written (`npm run e2e:live -- --instance dev469966`); the run needs the user to reload the extension and approve a scope. Dry run: real bridge connected, `tools/list` 11,798 bytes.
- **T-036 DONE:** Prepared, BLOCKED on the user: `.mcp.json.example` (T-035), `.mcpb` bundle and `npm run pack:mcpb` (T-036). `docs/INSTALL.md` written.
- **T-037 DONE:** Prepared, BLOCKED on the user: `npm run setup`, `npm run uninstall`, `docs/INSTALL.md`. Tested under a throwaway HOME only; the real machine run stops the live broker, so it is left to the user.
- **T-038, T-039 prepared, BLOCKED on the user.**
- **T-037 real-machine run passed:** the extension reconnects by itself after uninstall and setup.
- **The repo has no git remote:** nothing is backed up off this machine.
- **Third-party skill added (user decision):** `plugin/skills/servicenow-development-guide`, pinned; see its `PROVENANCE.md`.
- **T-034 DONE (live):** 14 of 14 scenarios on `dev469966`; M4 achieved.
- **Next task:** the checklist at the top of this file.
- **Verify live in T-034:** `sysparm_offset` counts pre-ACL rows (ADR-011 addendum).
- **Role-agnostic (ADR-012, 2026-11-04):** no ServiceNow role handling of any kind. Don't add role checks, dedicated accounts or impersonation features.
- **T-015 must include:** logout in the user's own profile → `SESSION_EXPIRED` with no sign-in dialog (T-013 AC4). Fallback if a dialog appears: the DNR rule in the ADR-002 addendum.
- **Claude Desktop runs the old server build** until it's restarted (`npm run build` done). Restart it before live checks (T-015).
- **"Other" environment (after T-010, user request):** the popup shows `unclassified` as **Other** with an optional name (UAT, SIT, …). It always gets PROD rules and the name is display only. `list_instances` returns `env_name` and `policy`.
- **Popup redesign (after T-010, user request, 2026-11-04):** card layout, status pill, icon edit/remove, segmented env picker, collapsible add form, alias proposal from a tab suggestion, toasts. Same logic and permission calls. Screenshots (seeded data, stubbed `popup.state`): `docs/evidence/T-010/popup-*.png`.
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

- **Live ServiceNow DEV instance:** available: `dev469966.service-now.com` (alias `dev469966`, per `list_instances` on 2026-11-05; earlier docs said `dev`. PDI, local login `admin`), registered in the user's Chrome extension. Live steps need the user to run them in their own Chrome, because Claude in Chrome can't open `chrome://` or extension pages.

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
