# Handoff

_Current state only, rewritten on 2026-11-05. History is in `docs/TASKS.md` and git. If this file disagrees with `docs/TASKS.md`, trust TASKS; if either disagrees with the code or git, trust the code and git, and fix the doc._

## Where things stand

The connector is built, installed and working on the user's Mac, in Claude Desktop, against one developer instance.

- **Tasks:** 40 DONE, 1 BLOCKED (T-015), 1 DROPPED (T-039).
- **Milestones:** M1, M3, M4, M5 and M6 achieved. M6 by the user's decision, with AC-6, AC-7 and AC-8 left open: not all 19 criteria are evidenced. M2 not achieved (T-015).
- **Acceptance:** `docs/ACCEPTANCE.md`: 15 passed, 3 open, 1 out of scope, none failed.
- **Next:** no task is eligible. Anything else that remains needs the user: see `docs/NEXT_STEPS.md`.

## T-042: what it did and didn't show

Done by the user's decision. Live on `dev469966` (`docs/evidence/T-042/`): two records compare, and two versions of a `sys_script` compare by element, with the diff applied back exactly. Not live: reaching another instance (no second instance exists; mock and the unchanged extension only), an over-long line being cut, and `compare_records` between two instances. Payload forms beyond the 9 pairs checked may come back as raw text.

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
- `cuneytbozok/assistme` is public, with commit emails replaced by the GitHub no-reply address.
- `sys_update_version` is readable with no extra guard, though its XML payloads aren't covered by field-level credential protection.
- `compare_records` stays untested between two real instances for now: AC-6, AC-7 and AC-8 stay open.
- The skills weren't changed for T-042, so they needn't be uploaded again.
- T-042's AC2 is accepted without a live attempt to reach another instance.

## The user's setup

- **Instance:** `dev469966.service-now.com`, alias `dev469966`, environment dev. A personal developer instance, signed in as admin.
- **Chrome:** unpacked extension from `packages/extension/dist`, ID `clipfeocpiljpcngmjpdbegciimchbol`.
- **Native host:** installed by `npm run setup` from this folder. Runtime files are in `~/Library/Application Support/sn-mcp/`, which is 0700: `broker.sock`, `broker.key`, `broker.pid`, `broker.log` (metadata only). Exit codes: 64 bad origin, 78 unsafe path, 75 conflict.
- **Claude Desktop:** the `.mcpb` bundle, version 0.1.2, named "ServiceNow (read-only)", plus both skills uploaded. Version 0.1.4 (T-042) is built at `packages/server/sn-mcp.mcpb`. It isn't known to be installed: until the user installs 0.1.3 or later, Desktop still refuses `compare_records` on a single-instance scope. The live test doesn't depend on that, because it starts the built server itself. `mcpServers` in `claude_desktop_config.json` is empty; the old entry's backup is `claude_desktop_config.json.before-sn-mcp-bundle`.
- **Claude Code:** Code sessions inside the Desktop app use the Desktop connector and skills. Nothing is registered separately: the `sn-mcp` registration and plugin were removed, because two connectors in one session don't share scopes.
- **Git:** `origin` is https://github.com/cuneytbozok/assistme (public). Commits use the no-reply address set in this repo's git config.

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
- **`tools/list`:** 11,938 of 12,000 bytes. A new input or longer description needs a cut elsewhere.
- **Flaky test:** `resilience.test.ts` › "broker id prefixes differ per process" failed once in a full run, then passed 9 of 9 re-runs. Cause not found. If it fails again, keep the message.

## Ideas not done

- `get_record_history` shows each journal entry twice: the audit row and the journal row.
- Remember tables that refused a `query_range` filter, to avoid repeat banners.
- Traffic capture wasn't repeated on the final build (AC-4).
- On one instance, T-015 AC5 and AC6, and possibly AC4 by temporarily setting the environment to PROD, could still run live without a second instance.
