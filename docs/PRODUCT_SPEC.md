# Product Specification — ServiceNow Read-Only MCP Connector

Status: **Authoritative** (rev. 2, approved 2026-11-04)

## 1. Vision

Give native Claude secure, **read-only** access to the ServiceNow instances the user is already logged into in Chrome. Users ask in natural language, for example:

- Investigate incident INC0012345.
- Find out why a Business Rule is not triggering.
- Examine Discovery logs and identify possible root causes.
- Compare a script between DEV and PROD.
- Find which configuration is updating a particular field.
- Investigate CI relationships and reconciliation behavior.
- Research an unfamiliar feature and check whether it exists in the instance.
- Continue troubleshooting using findings from earlier in the conversation.

Claude decides on its own which records, tables, scripts, logs, and configuration to examine. The user never has to copy data out of ServiceNow by hand.

**Scope:** Native Claude + Local ServiceNow MCP Server + Chrome Session Bridge + Optional ServiceNow Skills.

**Out of scope:**

- A custom chat UI, LLM backend, or model-provider integration
- Thinking-mode management, conversation orchestration, or agents/supervisors
- A persistent knowledge or memory subsystem (any database, SQLite/JSON memory, or embeddings)
- A corporate AI gateway
- Mandatory Docker
- Browser automation (Playwright, Selenium, DOM scraping, UI clicking)

## 2. Target clients

| Client                  | Support                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Claude Desktop — chat   | **Primary.** Local MCP server via `.mcpb` Desktop Extension (distribution) or `claude_desktop_config.json` (development). |
| Claude Code             | Supported (`claude mcp add` / `.mcp.json`).                                                                               |
| Claude Desktop — Cowork | Best effort. Verified and documented in T-036.                                                                            |
| claude.ai web / mobile  | Not supported (a local connector by design).                                                                              |

## 3. Functional requirements

### FR-1 Session-based access

- FR-1.1 The user logs into ServiceNow in Chrome. The connector uses that session for authenticated HTTP `GET` requests to supported REST APIs (Table API, Stats API).
- FR-1.2 No UI navigation, DOM scraping, or browser automation is used to retrieve data.
- FR-1.3 Session cookies and CSRF tokens (`g_ck` / `X-UserToken`) stay inside the Chrome extension. They are never sent to the native host, the MCP server, Claude, logs, or files.
- FR-1.4 The exact session mechanism (cookie inclusion, token requirement, token source) is decided by the live PoC (T-005) and recorded in `docs/POC_RESULTS.md` and ADR-002.
- FR-1.5 Session expiry is detected (401, login redirect, or non-JSON response) and reported as `SESSION_EXPIRED` for that instance only. Nothing is retried against another instance.

### FR-2 Instance registry

- FR-2.1 The user registers instances in the extension popup: alias, host, label, and environment (`dev | test | prod | unclassified`).
- FR-2.2 Registering requests host permission for that exact origin. Custom domains are supported.
- FR-2.3 Unclassified instances are treated as PROD.
- FR-2.4 The popup shows connection status per instance: connected, no tab, session expired, or permission missing.
- FR-2.5 Aliases match exactly. There is no fuzzy matching.

### FR-3 User-approved scopes

- FR-3.1 Claude calls `request_scope`, which returns an approval code. The user approves or denies the request in the popup after checking the code matches. Claude then calls `claim_scope` to receive an opaque `scope_id`.
- FR-3.2 A scope is immutable: one instance, or one fixed pair in compare mode.
- FR-3.3 Every data tool requires `scope_id`. There is no default scope and no fallback.
- FR-3.4 The extension re-validates the grant (existence, expiry, client binding, instance) on every request.
- FR-3.5 A claim succeeds once and only from the requesting MCP client. No tool ever lists scope IDs.
- FR-3.6 PROD approval requires typing the host. PROD grants have a TTL of 15 min by default (max 60), can't be renewed, and show a red badge while active. PROD is stricter for authorization only; operational safeguards are the same for every environment (ADR-011).
- FR-3.7 DEV/TEST grants have a TTL of 4 h by default (max 12 h).
- FR-3.8 Grants live in `chrome.storage.session` (cleared when Chrome restarts). The popup offers revoke and revoke-all.
- FR-3.9 The active Chrome tab never selects or changes the target instance.
- FR-3.10 Cross-instance comparison requires a compare-mode grant covering both instances, approved by the user.
- FR-3.11 Every result includes provenance: instance, env, host, scope suffix, and retrieval time.

### FR-4 General-purpose read-only tools

These tools work on any table the user can access. Nothing is hard-coded to Incident, CMDB, Discovery, or ITSM.

- `list_instances`
- `request_scope`, `claim_scope`, `release_scope`
- `discover_tables`, `describe_table`
- `query_records`, `get_record`, `get_field_content`
- `aggregate_records`, `get_related_records`, `get_record_history`
- `search_code`, `compare_records`

Contracts: `docs/ARCHITECTURE.md` §8, finalized in `docs/TOOLS.md` (T-033).

### FR-5 Query safety

- FR-5.1 Structured filters (`where`, `any_of`) are the primary query input.
- FR-5.2 Raw `encoded_query` is accepted only after tokenization and validation. Allowlisted operators only. Rejected: `DYNAMIC`, `RLQUERY`, `SUBQUERY`, `JOIN`, `123TEXTQUERY321`, `GOTO`, and script-like values (`javascript`, `gs.`, `${`, `eval(`, `new `) after normalization. Limits: ≤20 terms, ≤3 `^NQ` groups, ≤2 KB.
- FR-5.3 Every field referenced (filters, projections, ordering, dot-walks ≤3) is validated against `sys_dictionary` before execution. Unknown fields fail with `INVALID_FIELD`.
- FR-5.4 Tool-internal conditions can't be combined with raw queries.
- FR-5.5 Queries are never rejected for being broad, unconditioned or about old records. On configured high-volume tables, the connector defaults to newest-first ordering on an indexed field and adds hints (time ranges, key conditions, aggregates). It never refuses (ADR-011).
- FR-5.6 Total counts are opt-in.

### FR-6 Efficiency

Principle: optimize *how* Claude retrieves information, not *how much* it may investigate (ADR-011).

- FR-6.1 No limit on total rows, pagination depth, record age, or content length. `limit` (default 20) has no maximum.
- FR-6.2 Automatic pagination: the server pages upstream and returns a signed cursor whenever more data exists. Claude continues with the cursor alone, and no user step is needed.
- FR-6.3 Complete content: any script, log or long field can be read in full through `get_field_content` chunks (line windows, with character windows for very long lines).
- FR-6.4 No silent truncation: every result has `complete`. When it's false, `omitted[]` lists each missing part (rows, fields, relations, tables, sources) with the exact call that retrieves it.
- FR-6.5 Intelligent retrieval: default field projection, long-field previews, structured filters, aggregates, opt-in counts, metadata caching (15 min), and an in-process field-content cache for chunked reads.
- FR-6.6 Per-request safeguards, configurable by the user per instance in the extension: timeout (30 s), response size (10 MB, with automatic page-size reduction), and concurrency (4, queued). Plus a per-result size budget (24k chars by default, configurable, with per-call `max_chars` up to a ceiling). Every one of these has a continuation; none caps total retrieval.

### FR-7 Ambiguity

- Lookups by non-unique criteria that match more than one record return `AMBIGUOUS_MATCH` with up to 5 candidates and the total count. The connector never picks one.
- Unknown tables return close-match suggestions and are never auto-selected.

### FR-8 Skills (optional)

- FR-8.1 The custom `servicenow-troubleshooting` skill is guidance only, with on-demand references. It ships as a Claude Code plugin and as a Claude Desktop zip.
- FR-8.2 The official `now-sdk` skill is optional and Claude Code only, limited to `explain`. No SDK auth. Mutating SDK commands are denied.

### FR-9 Local installation

- macOS, Node ≥22 (developed on 24).
- `npm run setup` builds the project and installs the native-host manifest. The user loads the unpacked extension and installs the `.mcpb` or registers in Claude Code.
- No corporate credentials and no separate LLM API key are needed.

## 4. Security rules

- S-1 Only `GET` to `https://{grantedHost}/api/now/table/{table}[/{sys_id}]` and `https://{grantedHost}/api/now/stats/{table}`.
- S-2 Allow-listed `sysparm_*` params only; fixed headers; `redirect: 'manual'`; 30 s timeout.
- S-3 Excluded: `*.do` processors, `JSONv2`/`CSV`/`XML` exports, scripted REST APIs, UI APIs, attachment download.
- S-4 No generic HTTP tool, no script execution, no URL input from the LLM.
- S-5 Credential-table denylist. Password-type fields are stripped.
- S-6 Retrieved content is untrusted data and never changes behavior.
- S-7 Broker:
  - The launch origin is verified.
  - Socket directory 0700, socket 0600, `lstat` ownership/mode checks.
  - HMAC mutual challenge-response with a key that rotates per broker start.
  - Per-client request-ID rewriting, message-size and in-flight limits, no replay after disconnect.
- S-8 The extension accepts grant-mutating messages only from its own popup. No `externally_connectable`.
- S-9 Logs hold metadata only (no bodies, headers, or tokens) and are written 0600.
- S-10 Optional hardening: a dedicated `admin + snc_read_only` ServiceNow user (evaluated in T-022). It is never the only safeguard.

## 5. Acceptance criteria (product level)

| #     | Criterion                                                                                                       | Verified in                    |
| ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| AC-1  | Claude Desktop chat and Claude Code can use the local MCP connector.                                            | T-009, T-035, T-036            |
| AC-2  | The connector detects authenticated ServiceNow sessions.                                                        | T-013                          |
| AC-3  | Claude retrieves incident data through structured HTTP requests without UI navigation.                          | T-009                          |
| AC-4  | Browser cookies and CSRF tokens stay inside Chrome.                                                             | T-009, T-014 (redaction tests) |
| AC-5  | Instance access needs explicit user approval in the extension; Claude can't self-authorize or switch instances. | T-011, T-012, T-015            |
| AC-6  | Switching Chrome tabs doesn't change the selected instance.                                                     | T-015                          |
| AC-7  | PROD can't be accessed when only DEV is approved.                                                               | T-015                          |
| AC-8  | Cross-instance comparison needs an approved compare grant covering both instances.                              | T-032                          |
| AC-9  | ServiceNow write operations are impossible through the connector.                                               | T-022                          |
| AC-10 | Unknown accessible tables can be discovered dynamically.                                                        | T-026                          |
| AC-11 | Table schemas, references, scripts, and logs can be investigated where permitted.                               | T-034                          |
| AC-12 | Responses are compact and paginated. Large datasets and complete scripts/logs are retrievable without user intervention, and partial results always say what was omitted and how to get it. | T-023, T-034                   |
| AC-13 | Ambiguous matches are reported explicitly and never resolved arbitrarily.                                       | T-025, T-032                   |
| AC-14 | Unsafe or broadening queries are rejected.                                                                      | T-003, T-018                   |
| AC-15 | Session expiration is handled safely.                                                                           | T-013, T-015                   |
| AC-16 | The broker rejects unauthenticated clients and detects squatted sockets.                                        | T-006, T-014                   |
| AC-17 | Official ServiceNow skill guidance complements the tools without adding write capability.                       | T-039                          |
| AC-18 | A new development session can resume work using the repository handoff docs.                                    | T-041                          |
| AC-19 | The complete project can be installed locally by following the docs.                                            | T-037, T-041                   |

Final acceptance run: T-040 (matrix with evidence for every criterion).
