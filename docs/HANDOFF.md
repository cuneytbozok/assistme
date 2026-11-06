# Handoff

_Current state only, rewritten on 2026-11-05, updated 2026-11-06 for T-047. History is in `docs/TASKS.md` and git. If this file disagrees with `docs/TASKS.md`, trust TASKS; if either disagrees with the code or git, trust the code and git, and fix the doc._

## Where things stand

The connector is built, installed and working on the user's Mac, in Claude Desktop, against one developer instance.

- **Tasks:** 46 DONE, 2 BLOCKED (T-015, T-044), 1 DROPPED (T-039).
- **Milestones:** M1, M3, M4, M5 and M6 achieved. M6 by the user's decision, with AC-6, AC-7 and AC-8 left open: not all 19 criteria are evidenced. M2 not achieved (T-015).
- **Acceptance:** `docs/ACCEPTANCE.md`: 15 passed, 3 open, 1 out of scope, none failed.
- **Next:** no task is eligible. T-044 waits for someone with a Windows PC. Anything else that remains needs the user: see `docs/NEXT_STEPS.md`.

## T-047, T-048 and T-049 (done)

Merged into `main`, server 0.1.13. The user has reloaded the extension on this build.

- **T-049 (DONE):** relative dates now use ServiceNow's units, and **a query can run script (ADR-018, the user's decision):** `javascript:` values and `DYNAMIC` are sent, with a warning hint. Don't describe the connector as unable to run scripts. Full live run: 19 of 19. `NOTON`, `DATEPART`, `MORETHAN`, `LESSTHAN` and `DYNAMIC` (Me) were checked live against row dates; `RELATIVEEE` is refused, because it matched no rows live.

- **T-047 (DONE):** native encoded forms verified live. On `dev469966`, `IN` lists work up to 226 sys_ids (7,465 characters), and longer ones get HTTP 414 with an explanation. `table.list` now always sends `sysparm_suppress_pagination_header=true`, found live. The full live run with it passes, 19 of 19, with multi-page reads.
- **T-048 (DONE):** no `tools/list` budget any more (ADR-017). Works live with bundle 0.1.11 in a Code session in Desktop; a normal Desktop chat wasn't tried. In that session `where` reached the model without its types, so the units are also in the tool descriptions and the error.


## T-043, T-044 and T-046

**Mistral Vibe (T-046):** done, live through real `vibe-acp` 3.1.0, with a throwaway `VIBE_HOME` and a local scripted model: discovery, broker connectivity, per-client authorization, access across turns. The user then ran it in the `vibe` window with Mistral Medium 3.5, once: the instances and a count of `sys_user`, through the popup. **The model kept the approval code in its reasoning and never showed it, so the user approved without matching it.** Server 0.1.7 and the popup address this: in the user's one retest, the model showed the code, waited for them, and kept its access (T-046). In the first run it had also released its access right after answering. Its model reaches tools through `search_tool_functions` and `run_typescript`, not directly, and it ignores the server's `instructions`, so the printed block carries them in `prompt` (ADR-016).

**ChatGPT Desktop (T-043):** done, live through the engine inside `ChatGPT.app`, with a throwaway `CODEX_HOME`: discovery, broker connectivity and per-client authorization. Each conversation gets its own access. The user registered it in the app's settings: **it works in a Codex chat and not in a normal chat** (their test, 2026-11-05).

**Windows (T-044):** the user has no Windows PC. `windows.yml` passes 20 of 20 on real Windows, but not with real Chrome, a real AI client or a real instance, so don't describe it as working there. The job runs on every push.

**Skills in Codex (T-045):** `npm run codex-skills` copies both to `~/.agents/skills`; done on the user's Mac, and the engine finds both. No model has used one yet.

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
- **Claude Desktop:** the `.mcpb` bundle, named "ServiceNow (read-only)", plus both skills uploaded. The installed bundle is 0.1.13. `mcpServers` in `claude_desktop_config.json` is empty; the old entry's backup is `claude_desktop_config.json.before-sn-mcp-bundle`.
- **Claude Code:** Code sessions inside the Desktop app use the Desktop connector and skills. Nothing is registered separately: the `sn-mcp` registration and plugin were removed, because two connectors in one session don't share scopes.
- **ChatGPT Desktop:** installed, version 26.1029.61003, engine codex-cli 0.166.0-alpha.6. sn-mcp is registered in `~/.codex/config.toml` by the user, through the app's settings, without the longer timeouts.
- **Mistral Vibe:** 3.1.0, a uv tool at `~/.local/bin/vibe`, which isn't on the non-login shell's PATH. sn-mcp is registered in `~/.vibe/config.toml`, with the printed block; the earlier file is `config.toml.before-sn-mcp`. Reads work there with Mistral Medium 3.5. Its `prompt` was updated to the 0.1.7 text. Skills are already visible to it, through `~/.agents/skills`.
- **Git:** `origin` is https://github.com/cuneytbozok/assistme (public). Commits use the no-reply address set in this repo's git config.

## After changing code

1. `npm run build`, `npm test`, `npm run lint`.
2. If the extension or `packages/shared` changed: the user reloads the extension. It enforces shared rules, and it restarts the broker.
3. If the server changed: bump the version in `packages/server/mcpb/manifest.json` and `SERVER_VERSION`, run `npm run pack:mcpb`, and the user reinstalls the bundle. Then Cmd+Q and reopen.
4. If a skill changed: `npm run pack:skill`, and the user re-uploads that zip.

## Working notes

- **Vibe live run:** `npm run e2e:vibe -- --instance dev469966`, about three minutes including the wait, one approval. `--discovery-only` needs none. Re-run it after upgrading Vibe.
- **ChatGPT live run:** `npm run e2e:chatgpt -- --instance dev469966`, about a minute, one approval. `--discovery-only` needs none.
- **Live runs:** `npm run e2e:live -- --instance dev469966`, about 10 minutes, needs one approval from the user. `--only "a,b"` runs matching scenarios and saves to `results-partial.json`. `--dry-run` reads only the registry.
- **Read the numbers, not just the pass count.** A live run passed while a bug dropped 3,225 rows; only the metrics showed it.
- **Only the user approves scopes.** Don't click the approval, even if a browser tool could reach it (rule 4). Keep prompts few: each `e2e:live` asks once and releases at the end, and a Desktop restart loses the connector's scope, so batch them.
- **Claude in Chrome can't open `chrome://` or extension pages.** Reloading the extension is the user's step.
- **The installer refuses world-writable folders,** so a test clone can't be in `/tmp` or the scratchpad. Use the home folder.
- **Headless extension checks:** branded Chrome ignores `--load-extension`. Use `--headless=new --enable-unsafe-extension-debugging --remote-debugging-port=N` with a throwaway `--user-data-dir`, then CDP `Extensions.loadUnpacked`.
- **Build order:** the `workspaces` order, shared → server → extension. The server resolves `@sn-mcp/shared` through `dist/`, so build shared before type-checking the server.
- **Query module:** `compileFilter(input, {allowTextSearch})` for structured input; `parseEncodedQuery(q, {allowTextSearch})` for raw input, the same rules in server and extension (no profiles since T-047). Send `serializeQuery(parsed)`, the canonical form. `parsed.normalizations` and `parsed.warnings` become hints; a `QueryError` carries `position`, `reason` and `suggestion`, and `formatQueryError` makes the message. Explanations live in `query/diagnostics.ts`.
- **Installer tests in Linux cloud containers:** 9 tests in `installer`, `setup-scripts` and `capture` fail there because `/tmp` is mode 777, which the installer correctly refuses. They pass on the Mac.
- **`docs/TASKS.md`:** `test/task-docs.test.ts` checks its structure, so a misplaced status or evidence block fails `npm test`.
- **`tools/list`:** no budget (ADR-017), about 34 KB. What to watch: each tool's input schema ≤ 4,500 bytes (Codex strips larger ones; `query_records` is at 4,300) and each description ≤ 4,096 characters (Claude Code). `tool-contract.test.ts` checks both. Put long explanations in the tool description, not inside nested schemas.
- **Client checks without the Mac apps:** Linux builds of the same versions work in a cloud container: `npm i @openai/codex@0.166.0-alpha.6` (pass `--engine` with the native binary under `@openai/codex-linux-x64/vendor/.../bin/codex`) and `uv tool install mistral-vibe==3.1.0` (`--vibe-acp ~/.local/bin/vibe-acp`). Broker checks fail there: no Chrome.
- **Flaky test:** `resilience.test.ts` › "broker id prefixes differ per process" failed once in a full run, then passed 9 of 9 re-runs. Cause not found. If it fails again, keep the message.

## Ideas not done

- `get_record_history` shows each journal entry twice: the audit row and the journal row.
- Remember tables that refused a `query_range` filter, to avoid repeat banners.
- Traffic capture wasn't repeated on the final build (AC-4).
- On one instance, T-015 AC5 and AC6, and possibly AC4 by temporarily setting the environment to PROD, could still run live without a second instance.
