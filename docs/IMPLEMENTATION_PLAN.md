# Implementation Plan

Rev. 2 (approved 2026-11-04). Detailed task definitions are in `TASKS.md`. Architecture is in `ARCHITECTURE.md`.

## Principles

- Build the final architecture from the start, and deliver capabilities in small, independently verifiable tasks.
- Resolve critical technical unknowns first: session access, then the bridge, then a real end-to-end PoC.
- Do one task at a time, following the protocol in `CLAUDE.md`. Never auto-start the next task.
- Mocks are allowed in automated tests but never count as connectivity evidence.

## Phases & milestones

| Phase                         | Tasks         | Milestone      | Exit criterion                                                                                                                         |
| ----------------------------- | ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Foundation                  | T-001 – T-003 | —              | Workspace builds and tests; protocol and query validator with attack corpus                                                            |
| 1 Live PoC                    | T-004 – T-009 | **M1 (T-009)** | Claude (Code + Desktop) retrieves a real incident from DEV through extension + broker after user approval; no credentials leave Chrome |
| 2 Authorization & lifecycle   | T-010 – T-015 | **M2 (T-015)** | Full registry and grant model; scope enforcement; session lifecycle; resilient bridge; live scope acceptance                           |
| 3 Read-only & query hardening | T-016 – T-022 | **M3 (T-022)** | Request builder, dictionary-aware validation, per-request safeguards and settings, sensitive-data handling, threat model, read-only verification                   |
| 4 General-purpose tools       | T-023 – T-034 | **M4 (T-034)** | All tools implemented, documented, and live-verified on DEV                                                                            |
| 5 Packaging                   | T-035 – T-037 | **M5 (T-037)** | Claude Code registration, `.mcpb` for Desktop, setup/uninstall, INSTALL.md                                                             |
| 6 Skills                      | T-038 – T-039 | —              | Custom skill shipped; official skill dropped by the user (T-039)                                                                         |
| 7 Acceptance                  | T-040 – T-041 | **M6 (T-041)** | All 19 acceptance criteria evidenced; recovery drill; install from scratch                                                             |
| Optional documentation research | T-050       | —              | ADR-019: GitMCP search, GitHub reads. Off by default; a source the AI combines freely with others, with no required order |

## Dependency graph

```
T-001 ─┬─ T-002 ─┬─ T-003 ───────────────┬──────────────── T-008 ─┐
       │         └─ T-006 ───────────────┼─ T-007 ──────────────┐ │
       └─ T-004 ── T-005 ────────────────┘   │                  T-009 (M1)
                                             ├─ T-010 ─ T-011 ─┬─ T-012 ─ T-014 ─┐
                                             │                 └─ T-013 ─────────┴─ T-015 (M2)
                                             └─ T-016 (+T-003) ─┬─ T-017 (+T-012) ─┬─ T-018 ─┐
                                                                │                  └─ T-020  │
                                                                └─ T-019 ────────────────────┴─ T-021 ─ T-022 (M3)
T-018 ─ T-023 ─┬─ T-024 ─┬─ T-025 ─┬─ T-027
               │         │         ├─ T-030
               │         │         └─ T-032 (+T-011)
               │         └─ T-028 ─┐
               └─ T-026 (+T-017) ──┼─ T-029
                         └─ T-031  │
T-024…T-032 ─ T-033 ─ T-034 (M4) ─┬─ T-035
                                   ├─ T-036 ─ T-037 (M5)
                                   └─ T-038 ─ T-039
T-037 ─ T-040 ─ T-041 (M6)
```

Tasks that can proceed while T-005 is blocked (no DEV instance): T-006, T-008 (mock broker), T-016, and the query/validation parts of T-003.

## Testing strategy

| Level                          | Scope                                                                                                                                                | Tooling                     | Counts as connectivity evidence? |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------- |
| Unit                           | shared validators + attack corpus, filter compiler, request builder, grant model, cursor signing, compaction/response shaping/completeness, framing, broker auth, redaction | vitest                      | No                               |
| Integration (mocked, labelled) | MCP SDK client ↔ MCP server ↔ real broker ↔ fake extension (stdio); rogue client; squatted socket; reconnect/fault injection                         | vitest + child processes    | No                               |
| Extension logic                | Pure modules (registry, grants, authz, request builder, safeguards) with chrome API stubs                                                               | vitest                      | No                               |
| Live (opt-in)                  | Real chain against a real DEV instance through an MCP stdio client: `npm run e2e:live -- --instance <alias>`                                             | Node script                 | **Yes**                          |
| Manual client checks           | Claude Desktop chat, Claude Code, Cowork (best effort), with captured transcripts or screenshots                                                     | checklist in TASKS evidence | **Yes**                          |

Rules:

- Every task records the exact commands run and their results in its TASKS.md evidence section.
- Live tests never run in default `npm test`. They need `--instance` and an explicit user-approved scope, which means they still go through the approval flow.
- The redaction test (no `Cookie`, `JSESSIONID`, `glide_user`, `g_ck`, `X-UserToken`, or token-like 32+ hex values that match the active token in upstream messages) runs in both unit tests and live capture.

## Environment assumptions & expected blockers

- macOS, Node ≥22 (local: 24.21), npm 11, Chrome (stable), Claude Desktop installed, Homebrew available. Docker isn't required.
- **Blocker risk:** T-005, T-009, T-015, T-022 (manual part), T-034, and T-036 need a reachable ServiceNow DEV instance (a PDI is fine) with an active Chrome login. If that's unavailable, mark them `BLOCKED` and continue with independent tasks.
- Cowork support is uncertain. Document the actual behavior (T-036).
- Possible SDK v2 ↔ Desktop incompatibility: fall back to v1 (ADR-008).

## Definition of Done (all tasks)

1. Deliverables exist and are committed in a task-specific commit.
2. `npm run build`, `npm test`, and `npm run lint` pass (once T-001 is done).
3. Every acceptance criterion is evaluated with evidence.
4. TASKS.md status and evidence, plus HANDOFF.md, are updated. DECISIONS.md too if a decision was made.
5. Nothing is unverified without being explicitly listed as such.
