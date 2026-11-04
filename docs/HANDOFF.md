# Handoff

_Last updated: 2026-11-04 (after T-001)_

## Current project state

- **Phase 0 (Foundation):** T-001 DONE. A git repository (`main`) has been initialized with an npm-workspaces scaffold.
- **Packages:**
  - `packages/shared`: `@sn-mcp/shared`, built to `dist/`, exports `PROTOCOL_VERSION`.
  - `packages/server`: `@sn-mcp/server`, built to `dist/`, imports shared.
  - `packages/extension`: `@sn-mcp/extension`, type-check only for now (esbuild bundle comes in T-004).
- **Toolchain:** Node 24, TypeScript 7.0.2, vitest 5.1.0, Biome 2.6.5 (lint/format TS/JSON; `*.md` excluded).

## Tasks

- **Current task:** none (nothing IN_PROGRESS).
- **Last completed task:** T-001 — Repository scaffold (commit `T-001: repository scaffold`).
- **Next task:** **T-002 — Shared protocol schemas** (depends on T-001 ✔). Other eligible tasks: T-004 (extension skeleton).

## Files changed in last task

- Root: `package.json`, `package-lock.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.nvmrc`, `.editorconfig`.
- `packages/{shared,server,extension}/{package.json,tsconfig.json,src/index.ts,test/index.test.ts}`.
- Docs: TASKS (T-001 evidence), DECISIONS (ADR-007 addendum), HANDOFF. Markdown tables were re-aligned by a one-time Biome run, with no content change.

## Tests performed

`npm run build`, `npm test`, and `npm run lint` all exit 0, both in the working tree and in a clean clone. Details are in TASKS.md, T-001 evidence.

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
- **Not yet installed:** `zod` and `@modelcontextprotocol/server` (add `zod@4` to shared in T-002, and the MCP SDK to server in T-008). Re-check versions with `npm view`.
- **Workspace build order** is the `workspaces` array order (shared → server → extension). The server resolves `@sn-mcp/shared` via `dist/`, so build shared before running server type-checks.
- **Paths:**
  - `.claude/settings.local.json` is git-ignored (local Claude Code settings).
  - Claude Desktop config: `~/Library/Application Support/Claude/claude_desktop_config.json`.
  - Chrome native hosts directory: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
