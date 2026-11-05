# Acceptance matrix

Final build: version 0.1.2. Dates are 2026. "Live" means a real run against `dev469966`, a personal developer instance, with the user signed in as admin. Mocks don't count as connectivity proof (CLAUDE.md, rule 11), so results that rest on them are not called live.

**Result: 15 passed, 3 open, 1 out of scope.** None failed. M6's original exit criterion, all 19 evidenced, isn't met: the user accepted M6 with the 3 left open (5 Nov).

The final live run was on 5 Nov, 10:57–11:07 UTC: 16 of 16 scenarios passed, approved by the user in the popup ([results](evidence/T-040/final-live-run.json)). It holds counts, sizes, and table and field names, with no record content.

| AC | Criterion | Result | How it was shown | Evidence | Date |
| -- | --------- | ------ | ---------------- | -------- | ---- |
| AC-1 | Claude Desktop chat and Claude Code can use the connector | **Pass, with limits** | Live: real questions answered in Desktop chat through the installed bundle, and in a Claude Code session inside the Desktop app. **Not tested:** Claude Code in a terminal, and Cowork. The user uses neither | T-009, T-035, T-036 | 5 Nov |
| AC-2 | Detects authenticated sessions | **Pass** | Live: the popup and `list_instances` show `connected`; logging out is detected | T-013, T-015 | 5 Nov |
| AC-3 | Retrieves incident data through structured requests, with no UI navigation | **Pass** | Live: INC0000060 read and investigated. The code has no tab navigation, and no tab changed | T-009, T-034 | 5 Nov |
| AC-4 | Cookies and CSRF tokens stay in Chrome | **Pass, on an earlier build** | Live traffic capture with an exact-token check found none. Protocol tests rule out fields for them, and all builds run the credential guard. **The capture ran on the 4 Nov build:** messages added since (`scope.check`) carry no such field, but the capture wasn't repeated | T-009, T-002, T-007 | 4 Nov |
| AC-5 | Access needs the user's approval; Claude can't self-authorize or switch instances | **Pass** | Live: every run needed the popup approval, and revoking stopped the next call. Mock with the real `authz.ts`: another client's scope and another instance are refused. Switching between two real instances falls under AC-7 | T-011, T-012, T-015 | 5 Nov |
| AC-6 | Switching Chrome tabs doesn't change the instance | **Open** | Code and mock tests only: the target comes from the scope, never the tab. Needs a second instance live | T-015 | — |
| AC-7 | PROD can't be reached when only DEV is approved | **Open** | Mock with the real `authz.ts` only. Needs a second instance live | T-012, T-015 | — |
| AC-8 | Comparison needs an approved compare grant | **Open** | Mock only (`compare-records.test.ts`). `compare_records` has never run live. Needs a second instance. Comparing on one instance (T-042) can't close this: it needs no compare grant | T-032, T-015 | — |
| AC-9 | Writes are impossible | **Pass** | 30,000 fuzzed tool calls only ever produced GETs to the two allowed URL patterns. No tool takes a URL, method or header. Live traffic is read operations only | T-022, T-016 | 4 Nov |
| AC-10 | Unknown tables can be discovered | **Pass** | Live: 5 custom tables found and described | T-026, T-034 | 5 Nov |
| AC-11 | Schemas, references, scripts and logs can be investigated | **Pass** | Live: `incident` with 91 fields and inheritance; a 42,161-character script read in full; `search_code` across 611 tables; a CI's 916 relations; a 71-entry history | T-034 | 5 Nov |
| AC-12 | Compact, paginated, retrievable; partial results say what's missing | **Pass, with a limit** | Live: `syslog` read past offset 2,000 by cursor (2,510 rows, no duplicates, none skipped). The runner fails any partial result with no explanation. Largest result 65,182 characters (100,000 was asked for). **Limit:** see "Known limits" | T-023, T-034 | 5 Nov |
| AC-13 | Ambiguous matches are reported, never resolved arbitrarily | **Pass** | Live: 40 matches gave `AMBIGUOUS_MATCH`, with a working `list_all`. Per-side ambiguity in `compare_records`: live on one instance (T-042), mock only between two | T-025, T-034 | 5 Nov |
| AC-14 | Unsafe or broadening queries are rejected | **Pass** | Live: 4 refused with no request. 102 attack cases refused. Rows that contradict a filter are withheld (`FILTER_NOT_APPLIED`): 663 real rows raised no false alarm, though the check firing is shown only with mocks | T-003, T-018, T-034 | 5 Nov |
| AC-15 | Session expiry is handled safely | **Pass** | Live, in the user's own Chrome: logging out gave `SESSION_EXPIRED` with no sign-in dialog, and logging back in recovered with no new approval (reported by the user) | T-013, T-015 | 5 Nov |
| AC-16 | The broker rejects unauthenticated clients and detects squatted sockets | **Pass** | The real broker code with test clients: no key, wrong proof and a fake broker are all rejected; unsafe socket paths are refused | T-006, T-014 | 4 Nov |
| AC-17 | Official SDK skill guidance | **Out of scope** | The user dropped it. The user's Claude Code does have `fluent@servicenow`, by their choice, and the SDK can act outside the connector ([SKILLS.md](SKILLS.md)) | T-039 | 5 Nov |
| AC-18 | A new session can resume from the handoff docs | **Pass, with a caveat** | A read-only agent with no chat context identified the state correctly, but had to overrule HANDOFF, which was then rewritten. The rewrite hasn't had its own cold read | [T-041](evidence/T-041/README.md) | 5 Nov |
| AC-19 | Installable by following the docs | **Pass, with limits** | From the docs: uninstall, clean clone, install, setup and packaging worked, and Chrome started the clone's host. The real Chrome and Desktop install was done the same day, and answered real questions. **Skipped by the user:** repeating those steps from the clean clone, so no one has followed the docs end to end in one go | [T-041](evidence/T-041/README.md), T-036, T-037 | 5 Nov |

## Follow-ups

| Open item | Needs | Task |
| --------- | ----- | ---- |
| AC-6, AC-7, AC-8 | A second instance | T-015 (BLOCKED) |

## Known limits

- **Busy logs:** paging uses offsets, so on a table being written quickly, a long read can repeat or miss rows. The connector remembers the last 50 rows it returned and warns, but it can't make such a read exact. Claude is told to start with a short time window or a filter. **This instance is too quiet to show the problem at real volume**, so the behaviour on a busy instance isn't demonstrated.
- **One duplicate, cause unconfirmed:** one of the final runs (5 Nov, 10:31 UTC) returned a repeated `syslog` row. Rows moving between pages is the likely cause, but later runs measured no table growth and no moved rows, so it wasn't confirmed.
- **Filter check:** it only catches clear contradictions. It skips dates, dot-walks and references matched by name, and counts have no rows to check. So passing it doesn't prove a filter was applied.
- **Tested as admin only:** paging past rows hidden by ACLs is shown only with mocks.
- **One instance, one release:** nothing has run on production, or on an instance using SSO (T-005, H6).
- **Not readable on this instance:** 22 tables refused access even for admin, and 72 `var__m_*` tables can't be queried ([TOOLS.md](TOOLS.md#known-platform-behaviour)). All are reported, not hidden.
- **Skill content:** table names were checked live, except `discovery_schedule`, which this instance doesn't have. Field names and the accuracy of the third-party `servicenow-development-guide` weren't checked.
- **Flaky test:** one resilience test failed once under load, and passed every re-run. Cause not found (HANDOFF).
