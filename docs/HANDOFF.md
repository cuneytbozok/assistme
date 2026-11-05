# Handoff

_Current state only, rewritten on 2026-11-05. History is in `docs/TASKS.md` and git. If this file disagrees with `docs/TASKS.md`, trust TASKS; if either disagrees with the code or git, trust the code and git, and fix the doc._

## Where things stand

The connector is built, installed and working on the user's Mac, in Claude Desktop, against one developer instance.

- **Tasks:** 39 DONE, 1 BLOCKED (T-015), 1 DROPPED (T-039). Nothing is in progress.
- **Milestones:** M1, M3, M4 and M5 achieved. M2 not achieved (T-015). M6 not achieved: its exit criterion is all 19 acceptance criteria evidenced, and AC-6, AC-7 and AC-8 are open.
- **Acceptance:** `docs/ACCEPTANCE.md`: 15 passed, 3 open, 1 out of scope, none failed.
- **Next:** nothing is eligible. What remains needs the user: see `docs/NEXT_STEPS.md`.

## Open decision for the user

Should M6 count as achieved with AC-6, AC-7 and AC-8 recorded as open limits? Otherwise it waits for a second instance.

## Decisions made by the user (2026-11-05)

- Terminal Claude Code and Cowork aren't used: not tested, and recorded as such.
- The official SDK skill is dropped (T-039). `fluent@servicenow` stays installed in their Claude Code by their choice. Don't ask again.
- The Chrome and Desktop part of the clean install was skipped, because a real install was done the same day (T-041).
- The word "javascript" is allowed in filters; only the `javascript:` prefix is refused.
- Access stays open for follow-up questions, until expiry, revoke, or the user saying they're finished.
- Dictionary validation fails closed, with Claude telling the user what they can't read.
- A denied request is `status: "denied"` from `claim_scope` (T-015 AC6 changed).
- On logs and busy tables, Claude starts with a short time window or a filter. Broad reads still work, with a warning.
- The third-party `servicenow-development-guide` skill is included, pinned to a commit.

## The user's setup

- **Instance:** `dev469966.service-now.com`, alias `dev469966`, environment dev. A personal developer instance, signed in as admin.
- **Chrome:** unpacked extension from `packages/extension/dist`, ID `clipfeocpiljpcngmjpdbegciimchbol`.
- **Native host:** installed by `npm run setup` from this folder. Runtime files are in `~/Library/Application Support/sn-mcp/`, which is 0700: `broker.sock`, `broker.key`, `broker.pid`, `broker.log` (metadata only). Exit codes: 64 bad origin, 78 unsafe path, 75 conflict.
- **Claude Desktop:** the `.mcpb` bundle, version 0.1.2, named "ServiceNow (read-only)", plus both skills uploaded. `mcpServers` in `claude_desktop_config.json` is empty; the old entry's backup is `claude_desktop_config.json.before-sn-mcp-bundle`.
- **Claude Code:** Code sessions inside the Desktop app use the Desktop connector and skills. Nothing is registered separately: the `sn-mcp` registration and plugin were removed, because two connectors in one session don't share scopes.
- **Git:** no remote. The project exists only on this Mac.

## After changing code

1. `npm run build`, `npm test`, `npm run lint`.
2. If the extension or `packages/shared` changed: the user reloads the extension. It enforces shared rules, and it restarts the broker.
3. If the server changed: bump the version in `packages/server/mcpb/manifest.json` and `SERVER_VERSION`, run `npm run pack:mcpb`, and the user reinstalls the bundle. Then Cmd+Q and reopen.
4. If a skill changed: `npm run pack:skill`, and the user re-uploads that zip.

## Working notes

- **Live runs:** `npm run e2e:live -- --instance dev469966`, about 10 minutes, needs one approval from the user. `--only "a,b"` runs matching scenarios and saves to `results-partial.json`. `--dry-run` reads only the registry.
- **Read the numbers, not just the pass count.** A live run passed while a bug dropped 3,225 rows; only the metrics showed it.
- **Only the user approves scopes.** Don't click the approval, even if a browser tool could reach it (rule 4).
- **Claude in Chrome can't open `chrome://` or extension pages.** Reloading the extension is the user's step.
- **The installer refuses world-writable folders,** so a test clone can't be in `/tmp` or the scratchpad. Use the home folder.
- **Headless extension checks:** branded Chrome ignores `--load-extension`. Use `--headless=new --enable-unsafe-extension-debugging --remote-debugging-port=N` with a throwaway `--user-data-dir`, then CDP `Extensions.loadUnpacked`.
- **Build order:** the `workspaces` order, shared → server → extension. The server resolves `@sn-mcp/shared` through `dist/`, so build shared before type-checking the server.
- **Query module:** `compileFilter(input, {allowTextSearch})` for structured input; `parseEncodedQuery(q, {profile:'strict'})` for raw model input on the server, and `{profile:'enforce'}` in the extension.
- **`docs/TASKS.md`:** `test/task-docs.test.ts` checks its structure, so a misplaced status or evidence block fails `npm test`.
- **Flaky test:** `resilience.test.ts` › "broker id prefixes differ per process" failed once in a full run, then passed 9 of 9 re-runs. Cause not found. If it fails again, keep the message.

## Ideas not done

- `get_record_history` shows each journal entry twice: the audit row and the journal row.
- Remember tables that refused a `query_range` filter, to avoid repeat banners.
- Traffic capture wasn't repeated on the final build (AC-4).
- On one instance, T-015 AC5 and AC6, and possibly AC4 by temporarily setting the environment to PROD, could still run live without a second instance.
