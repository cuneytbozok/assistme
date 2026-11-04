# Handoff

_Last updated: 2026-11-04 (after T-003)_

## Current project state

- **Phase 0 (Foundation): complete** (T-001, T-002, T-003 DONE). The shared package has the bridge protocol (zod v4), error codes with hints, limits, identifier validation, and the query module (structured filter compiler + encoded-query validator with `enforce`/`strict` profiles).
- **Packages:**
  - `packages/shared`: `@sn-mcp/shared`, built to `dist/`. Exports the protocol schemas (`ClientToBrokerSchema`, `BrokerToClientSchema`, `BrokerToExtensionSchema`, `ExtensionToBrokerSchema`, `OperationSchema`, …), `ERROR_CODES`/`DEFAULT_HINTS`/`protocolError`, `limits`, and the identifier regexes and schemas.
  - `packages/server`: `@sn-mcp/server`, built to `dist/`, imports shared.
  - `packages/extension`: `@sn-mcp/extension`, type-check only for now (esbuild bundle comes in T-004).
- **Toolchain:** Node 24, TypeScript 7.0.2, vitest 5.1.0, Biome 2.6.5 (lint/format TS/JSON; `*.md` excluded).

## Tasks

- **Current task:** none (nothing IN_PROGRESS).
- **Last completed task:** T-003 — Shared query module + attack corpus (commit `T-003: shared query module and attack corpus`).
- **Next task:** **T-004 — MV3 extension skeleton + minimal registry** (depends on T-001 ✔). Also eligible: T-006 (native host/broker). T-005 (live session spike) follows T-004 and needs a ServiceNow DEV instance. T-004 includes a manual step: loading the unpacked extension in Chrome.

## Files changed in last task

- New: `packages/shared/src/query/{operators,normalize,encoded-query,filter-compiler,index}.ts`, `packages/shared/test/query.test.ts`, `packages/shared/test/fixtures/{attack-corpus,valid-corpus}.json`.
- Modified: `packages/shared/src/index.ts` (exports query), `packages/shared/package.json` (`coverage` script), root `package.json` and lock file (`@vitest/coverage-v8`).
- Docs: TASKS (T-003 evidence), DECISIONS (ADR-005 addendum), ARCHITECTURE (§6.1 relative ops, §6.4a profiles), HANDOFF.

## Tests performed

- Root `npm run build`, `npm test` (shared 238, server 1, extension 1), `npm run lint`: all exit 0.
- `npm run coverage -w @sn-mcp/shared`: query module at 97.4% statements / 95.8% branches (90% thresholds enforced).

## Open blockers

- **Live ServiceNow DEV instance:** T-005, T-009, T-015, T-022 (manual part), T-034, and T-036 need a reachable DEV instance (a PDI is fine) with an active Chrome login. Not yet confirmed as available.

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
- **Docs editing:** Biome formatted the markdown once, so headings are followed by a blank line (`### T-00N — …\n\n- **Status:** …`). Match that when scripting status edits.
- **Workspace build order** is the `workspaces` array order (shared → server → extension). The server resolves `@sn-mcp/shared` via `dist/`, so build shared before running server type-checks.
- **Paths:**
  - `.claude/settings.local.json` is git-ignored (local Claude Code settings).
  - Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`.
  - Chrome native hosts directory: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
