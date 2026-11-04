# Handoff

_Last updated: 2026-11-04 (after T-002)_

## Current project state

- **Phase 0 (Foundation):** T-001 and T-002 DONE. The shared package now has the full bridge protocol (zod v4), error codes with hints, limits, and identifier validation.
- **Packages:**
  - `packages/shared`: `@sn-mcp/shared`, built to `dist/`. Exports the protocol schemas (`ClientToBrokerSchema`, `BrokerToClientSchema`, `BrokerToExtensionSchema`, `ExtensionToBrokerSchema`, `OperationSchema`, …), `ERROR_CODES`/`DEFAULT_HINTS`/`protocolError`, `limits`, and the identifier regexes and schemas.
  - `packages/server`: `@sn-mcp/server`, built to `dist/`, imports shared.
  - `packages/extension`: `@sn-mcp/extension`, type-check only for now (esbuild bundle comes in T-004).
- **Toolchain:** Node 24, TypeScript 7.0.2, vitest 5.1.0, Biome 2.6.5 (lint/format TS/JSON; `*.md` excluded).

## Tasks

- **Current task:** none (nothing IN_PROGRESS).
- **Last completed task:** T-002 — Shared protocol schemas (commit `T-002: shared protocol schemas`).
- **Next task:** **T-003 — Shared query module + attack corpus** (depends on T-002 ✔). Also eligible: T-004 (extension skeleton) and T-006 (native host/broker).

## Files changed in last task

- `packages/shared/src/{protocol,errors,limits,validation,index}.ts` (new or rewritten).
- `packages/shared/test/{fixtures,protocol.test}.ts` (new); `packages/shared/test/index.test.ts` (removed, superseded).
- `packages/shared/package.json` and `package-lock.json` (added `zod@4.6.7`).
- Docs: TASKS (T-002 evidence) and HANDOFF.
- A separate earlier commit, `T-001: correct task status in TASKS.md section`, fixed a T-001 section that still read IN_PROGRESS (Biome had added blank lines after headings, so the original replacement didn't match).

## Tests performed

- Root `npm run build`, `npm test` (shared 71, server 1, extension 1), `npm run lint`: all exit 0.
- Mutation check on strictness and the redaction audit (see T-002 evidence).

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
- **Docs editing:** Biome formatted the markdown once, so headings are followed by a blank line (`### T-00N — …\n\n- **Status:** …`). Match that when scripting status edits.
- **Workspace build order** is the `workspaces` array order (shared → server → extension). The server resolves `@sn-mcp/shared` via `dist/`, so build shared before running server type-checks.
- **Paths:**
  - `.claude/settings.local.json` is git-ignored (local Claude Code settings).
  - Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`.
  - Chrome native hosts directory: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
