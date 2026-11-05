# T-041 evidence (2026-11-05)

## (a) Recovery drill

A subagent with no chat context ran `show progress` and `review current task`, read-only, against commit `456af3f`. It wasn't a session the user opened, and it couldn't run the verification steps.

**Result:** it identified the state correctly: T-041 current, 38 DONE, T-015 blocked and why, T-039 dropped, milestones, no git remote. It spot-checked figures against `final-live-run.json`.

**But it had to overrule `docs/HANDOFF.md`,** which said nothing was in progress, listed T-034 as both blocked and done, and described old setup. A reader trusting HANDOFF alone would have got the current task wrong.

**Fixed as a result:**

- HANDOFF rewritten to current state only, and NEXT_STEPS rewritten.
- CLAUDE.md: which doc wins when docs disagree; `DROPPED`; the missing docs.
- Two connectors in one Code session: the separate `sn-mcp` registration and plugin were removed, and INSTALL explains it.
- Node requirement: `npm run setup` runs TypeScript directly, so it's 22.18 or newer, not 22 (22.18 from memory of Node's release notes, not tested here on 22.x).
- README's "no admin rights" claim: all live runs were as admin, so it now says so.
- AC-8 had no live owner: added to T-015.
- Stale `skills/` paths, `--instance dev`, and the plan's SDK and T-039 references.

**Not repeated after the fixes,** so the rewritten HANDOFF hasn't had its own cold read.

## (b) Install from scratch

**Done, on this Mac, following `docs/INSTALL.md`:**

| Step | Result |
| ---- | ------ |
| `npm run uninstall` | Stopped the host. Manifest and `sn-mcp` folder gone, checked by listing |
| `git clone` to `~/sn-mcp-clean-test` | Worked, from the local path (no remote exists) |
| `npm install` | Worked. One harmless warning about `fsevents` install scripts |
| `npm run setup` | Worked. Printed the right paths, and the native host pointed at the clone |
| Extension build | `dist` built, with the expected ID file |
| Host started by Chrome | Chrome's extension started the clone's host by itself |
| `npm run pack:mcpb`, `npm run pack:skill` | Worked. Same server code as the main copy |
| Restore | Uninstall and setup from the main copy; the extension reconnected in 1 s; dry run listed `dev469966 (connected)`; clone deleted |

**Skipped by the user's decision:** removing and re-adding the extension from the clone, re-registering the instance, and a scoped query through a clean install. The user judged them unnecessary, because they'd done the real Chrome and Desktop install the same day, and that install answered real questions (T-036).

**Doc gaps found:** `git clone <this repository>` has nothing to point at without a remote, and "Already loaded? Press its reload icon" doesn't switch a loaded extension to another folder. Both are noted in INSTALL.
