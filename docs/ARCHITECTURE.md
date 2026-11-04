# Architecture — ServiceNow Read-Only MCP Connector

Rev. 2 (approved 2026-11-04). Decisions are referenced as ADR-xxx (see `DECISIONS.md`).

## 1. Components

```
Claude Desktop / Claude Code
   │ stdio (MCP, JSON-RPC)
   ▼
MCP Server (Node/TS)  ─ one process per client (Desktop: one process shared by all conversations;
   │                    Claude Code: one per session). Several may run at once.
   │ authenticated Unix domain socket  ~/Library/Application Support/sn-mcp/bridge.sock
   ▼
Native Host = Broker (Node/TS)  ─ launched by Chrome via Native Messaging; dumb relay + client auth
   │ Chrome Native Messaging (stdio, 4-byte length-prefixed JSON)
   ▼
Chrome Extension (MV3 service worker + popup)
   │  AUTHORITATIVE for: instance registry, user approvals/grants, operation validation,
   │  URL construction, budgets, session access. Trusts neither broker nor MCP server.
   ▼ HTTPS GET with the user's session (credentials never leave Chrome)
ServiceNow Table API / Stats API  →  JSON
```

| Component  | Responsibility                                                                                                                                                                                               | Not responsible for                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| MCP server | MCP protocol and tool definitions; input validation (friendly errors); compiling structured filters; the metadata cache; compaction, response budgets, signed cursors; composite tools (fan-out); provenance | Authorization decisions, URLs, sessions |
| Broker     | Client authentication, routing, request-ID rewriting, size/rate limits, lifecycle                                                                                                                            | Any ServiceNow logic or policy          |
| Extension  | Registry, grants and approval UI, per-request authorization, re-validation, URL building, session/token handling, budgets, size caps                                                                         | Tool semantics, compaction              |
| Skills     | Optional guidance                                                                                                                                                                                            | Data access, workflows                  |

## 2. Data flow (one query)

1. Claude calls `query_records({scope_id, table, where, fields, limit})`.
2. The MCP server validates input with zod. It validates fields against the cached dictionary (fetching metadata through the same path if the cache is cold), compiles the filter into an encoded query, and builds an `Operation` descriptor `{kind:"table.list", table, query, fields, limit, offset, displayValue}`.
3. The MCP server sends `{v:1, id, kind:"sn.op", scopeId, op}` over the authenticated socket.
4. The broker rewrites the `id` to a per-client namespace and forwards the message to the extension over native messaging.
5. The extension:
   - Checks the grant: the scope exists, isn't expired, is bound to this `client_key_id`, and is for the instance.
   - Re-validates the operation with the shared validator.
   - Checks budgets.
   - Builds the URL from a fixed template and performs a `GET` using the session mechanism chosen in ADR-002.
   - Enforces the 30 s timeout and the 5 MB streaming cap.
   - Maps HTTP results to error codes.
6. The extension returns `{id, ok, status, data, headers:{xTotalCount?}, truncated?, error?}`. Cookie and token values are never present (no such fields exist in the schema).
7. The broker restores the original `id` and sends the response to the right client.
8. The MCP server compacts the result: projection, `{v,d}` references, field truncation, the response budget, and a signed `next_cursor`. It adds provenance and returns `content` (compact JSON text) plus `structuredContent`.

## 3. Trust boundaries

| Boundary                 | Threat                                             | Control                                                                                                                                                               |
| ------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude ↔ MCP server      | Prompt-injected or erroneous tool inputs           | Closed tool set, zod validation, query validator, scope required, untrusted-content instructions                                                                      |
| MCP server ↔ broker      | Rogue local client, fake broker on the socket path | HMAC mutual auth, socket directory/mode/owner checks, key rotation                                                                                                    |
| Broker ↔ extension       | Unauthorized host launch, tampered relay           | `allowed_origins` + argv origin check; the extension re-validates everything, so the broker is untrusted                                                              |
| Extension ↔ web pages    | Malicious pages, other extensions                  | No `externally_connectable`; popup-only grant mutation (`sender` checks); MAIN-world script only on granted hosts and only to read the token (if ADR-002 requires it) |
| Extension ↔ ServiceNow   | Side-effecting endpoints, credential leakage       | GET-only fixed templates, param allowlist, redirect manual, denylist tables, password-field stripping                                                                 |
| ServiceNow data ↔ Claude | Prompt injection inside records                    | Treated as data; it never affects policy, which is enforced in code                                                                                                   |

Out of scope: malware running as the same macOS user (it can read Chrome's profile anyway). Documented in `SECURITY.md` (T-021).

## 4. Bridge & broker (ADR-001)

### 4.1 Native host launch

- The manifest (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json`) lists exactly one `allowed_origins` entry: the extension's stable ID, which comes from a fixed `key` in `manifest.json`.
- The host checks that `argv[1]` equals `chrome-extension://<ID>/` and exits otherwise.
- The wrapper script uses an absolute Node path. The installer refuses group- or world-writable directories in the path. Modes: wrapper 0755, manifest 0644, user-owned.

### 4.2 Socket guard

- Directory `~/Library/Application Support/sn-mcp/` is created with mode 0700. The socket is created with umask 077.
- On every start: `lstat` the directory and socket. They must not be symlinks, the owner must be the current uid, and the mode must be exact. Otherwise startup is refused.
- A pid lock file is held. Existing socket: connect test. Refused → stale, so unlink and bind. Alive → another profile's broker, so report `BROKER_CONFLICT` to the extension and exit.

### 4.3 Client authentication (mutual)

1. On start, the broker writes a fresh 256-bit key to `broker.key` (0600, atomic rename).
2. Client → `hello {clientNonce, client_key_id, label{name,pid,cwd}, protocol:1}`.
3. Broker → `challenge {brokerNonce, brokerProof = HMAC(key, clientNonce‖"broker"‖"sn-mcp/v1")}`. The client verifies `brokerProof`, which detects a fake broker.
4. Client → `auth {clientProof = HMAC(key, brokerNonce‖clientNonce‖"client"‖"sn-mcp/v1")}`.
5. The connection must authenticate within 2 s or it's closed. Failed attempts are rate-limited.

`client_key_id = SHA-256(client_key)`. The 128-bit `client_key` is random per MCP process. Grants are bound to `client_key_id`. The label is display-only.

### 4.4 Message hygiene

- Upstream request max 256 KB. Downstream responses are bounded by the extension's caps. The 1 MB host→extension native-messaging limit applies only to requests.
- zod validation at each hop; unknown kinds are dropped.
- The broker rewrites request IDs and enforces per-client rate limits and an in-flight maximum.

### 4.5 Lifecycle

- **Extension:** connects with `connectNative` on SW start, `onStartup`, and `onInstalled`. Exponential backoff. 20 s heartbeat. The open port keeps the SW alive.
- **Broker:** lives while stdin is open. On close it disconnects all clients and unlinks the socket and key.
- **MCP server:** connects lazily and re-authenticates on every reconnect, because the key rotates. In-flight requests fail with `BRIDGE_UNAVAILABLE` on disconnect and are **never replayed**.
- **Grants:** survive broker or extension reconnects while the MCP process lives. Cleared when Chrome restarts.
- **Limitation:** one Chrome profile at a time.

### 4.6 Logging

Metadata only: kind, instance alias, table, status, duration, byte sizes. Log files are 0600 and rotated. Never bodies, headers, cookies, or tokens.

## 5. Instance authorization & scopes (ADR-003)

### 5.1 Registry (extension)

`{alias, host, label, env: dev|test|prod|unclassified}`. Unclassified is treated as PROD. Adding an instance calls `chrome.permissions.request` for that origin, which needs a user gesture. Detected ServiceNow tabs are shown as suggestions only.

### 5.2 Request → approve → claim

```
Claude ──request_scope({instances:["dev"], mode:"single", purpose})──▶ MCP ──▶ extension
        ◀── {request_id, approval_code:"K7QF-2M", status:"pending", expires_in:300}
Claude tells the user: "Please approve request K7QF-2M in the ServiceNow MCP extension."
User opens popup: sees client label, instance(s)+env, purpose (plain text, truncated), code → Approve (TTL) / Deny
Claude ──claim_scope({request_id})──▶ {scope_id, instances, env, expires_at}   (once; same client_key_id only)
```

- Approval codes: 6 characters from an unambiguous alphabet, shown in both the tool result and the popup. Requests expire after 5 min.
- Approval binds to the conversation the code was shown in. Desktop provides no conversation ID, so the code is the binding.
- The grant is stored in the extension: `{scopeHash, clientKeyId, instances[], mode, env, createdAt, expiresAt}`.

### 5.3 Enforcement

- Every `sn.op` carries `scopeId`. The extension checks the hash, expiry, client binding, and that the target instance is in the grant, on **every** request.
- There is no default scope and no fallback. Unknown or expired scopes return an error that tells Claude to request a new scope.
- Scope IDs are never listed by any tool. `list_instances` reports only whether _this client_ has a pending request or active grant per instance.
- `release_scope` revokes immediately.
- Tabs never select the target. They are used only for token access to the already-granted host, if ADR-002 requires it.

### 5.4 Environment policies

|                    | DEV / TEST    | PROD / unclassified      |
| ------------------ | ------------- | ------------------------ |
| Approval           | One click     | Type the host to confirm |
| TTL default / max  | 4 h / 12 h    | 15 min / 60 min          |
| Renewal            | New request   | New request (no renewal) |
| Max limit          | 100           | 50                       |
| Rate / concurrency | 60 req/min, 4 | 20 req/min, 2            |
| Badge              | Normal        | Red while active         |

### 5.5 Residual risk

Within one Desktop process, a `scope_id` is a bearer capability that only the claiming conversation knows. This is the strongest binding available without conversation IDs.

## 6. Query security (ADR-005)

### 6.1 Structured filters

```
where:  [ cond | {or: [cond, ...]} , ... ]          // AND of terms; or-groups compile to ^OR
any_of: [ where, where, where ]  (optional, ≤3)      // compiles to ^NQ
cond:   {field, op, value}
op ∈ = != > >= < <= contains not_contains starts_with ends_with in not_in
     is_empty is_not_empty between within_last older_than
within_last / older_than: {amount, unit: minute|hour|day|week|month|year}
     → RELATIVEGE@unit@ago@n / RELATIVELT@unit@ago@n   (accepted by ServiceNow: verify in T-005)
```
Values containing `^`, control characters, or newlines are rejected, as are `,` inside `in` items.

### 6.2 Raw encoded query (`encoded_query`)

- Tokenize on `^NQ`, `^OR`, `^`, then `ORDERBY`/`ORDERBYDESC`. Each term must parse as `<field><allowlisted op><value>`, with ops matched longest-first. Anything else is rejected.
- Rejected: `DYNAMIC`, `RLQUERY`, `SUBQUERY`, `JOIN`, `123TEXTQUERY321`, `GOTO`, `EQ` tricks, unknown operators.
- Values are normalized (NFKC, zero-width characters stripped, URL-decoded ≤2 passes, lowercased for matching). After that, these patterns are rejected: `javascript`, `gs.`, `${`, `new `, `eval(`.
- Limits: ≤20 terms, ≤3 `^NQ` groups, ≤2 KB.

### 6.3 Anti-broadening

- Every referenced field is checked against the dictionary hierarchy before execution: filters, `encoded_query` terms, `fields`, `order_by`, and each dot-walk hop (≤3).
- This matters because ServiceNow may ignore invalid fields and return all rows.
- Tool-internal conditions are compiled from structured filters only. Raw queries are never concatenated with internal conditions.

### 6.4 Cost guards

- No conditions → limit ≤20.
- **High-volume tables** (configurable: `syslog*`, `sys_audit`, `sys_journal_field`, `ecc_queue`, `sys_email`, `sys_history_line`, `discovery_device_history`, `sys_poll`, `*_log`) require a `sys_created_on` window (≤7 days by default) **or** an equality/IN on an indexed key (`sys_id`, `number`, `documentkey`, `element_id`, `source`, `agent_correlator`, …). `contains` on these tables also needs the time window.
- Counts are opt-in (`include_total`). The default sends `sysparm_no_count=true`.

### 6.4a Profiles (T-003)
`enforce` (authoritative; server + extension) vs `strict` (raw `encoded_query` from the model; additionally rejects `gs.`, `${`, `eval(`, `new X`). See the ADR-005 addendum.

### 6.5 Placement

The shared module (`packages/shared/query`) runs in the MCP server for friendly errors and in the extension for enforcement. The dictionary-aware checks run in the MCP server, and the extension re-runs the syntactic and safety checks.

## 7. Session access (ADR-002 — Proposed; finalized by T-005)

Hypotheses H1–H8 (see `DECISIONS.md` ADR-002) are tested live.

- **Path A** (preferred if H1 holds and the token is obtainable): the service worker's `fetch(credentials:'include')` plus `X-UserToken` if required. The token is read on demand via MAIN-world `executeScript` from a tab of the granted host and cached in memory only.
- **Path B** (fallback): a MAIN-world `fetch` executed inside a tab of the granted host, with limits enforced in the injected function.
- **Invariants:** no `cookies` permission; no credential values in any outbound message; no UI navigation.

Session expiry (401, redirect, or HTML response) → `SESSION_EXPIRED`. The token is cleared and the popup status updated. Nothing is retried elsewhere.

## 8. MCP tools, efficiency & ambiguity (ADR-006)

| Tool                  | Inputs (abridged)                                                                                    | Notes                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `list_instances`      | —                                                                                                    | alias, env, label, connection state, this client's pending/active state; no scope IDs |
| `request_scope`       | instances[1–2], mode, purpose                                                                        | returns request_id + approval_code                                                    |
| `claim_scope`         | request_id                                                                                           | once; returns scope_id                                                                |
| `release_scope`       | scope_id                                                                                             | narrows only                                                                          |
| `discover_tables`     | scope_id, search, limit                                                                              | `sys_db_object`                                                                       |
| `describe_table`      | scope_id, table, include_inherited, include_choices                                                  | dictionary hierarchy; NOT_FOUND + suggestions                                         |
| `query_records`       | scope_id, table, where/any_of or encoded_query, fields, text, order_by, limit, cursor, include_total | main query                                                                            |
| `get_record`          | scope_id, table, sys_id or match{field:value}, fields, expand_references                             | `AMBIGUOUS_MATCH` (≤5 candidates + count)                                             |
| `get_field_content`   | scope_id, table, sys_id, field, start_line, max_lines ≤400                                           | numbered lines, chunked                                                               |
| `aggregate_records`   | scope_id, table, where, group_by, limit                                                              | Stats API                                                                             |
| `get_related_records` | scope_id, table, sys_id, max_relations ≤10                                                           | reverse refs via dictionary + counts + ≤3 samples                                     |
| `get_record_history`  | scope_id, table, sys_id, limit                                                                       | `sys_audit` + `sys_journal_field`                                                     |
| `search_code`         | scope_id, pattern, tables?, limit                                                                    | script fields discovered from dictionary; ±3-line snippets                            |
| `compare_records`     | scope_id (compare grant), table, match_a, match_b?, fields                                           | per-side ambiguity check; field diff + unified diff                                   |

All ServiceNow tools are annotated `readOnlyHint: true`. There is no generic HTTP tool.

**Default projection:** `sys_id`, the dictionary display field, `number`/`name`/`short_description` if present, `sys_updated_on`, `sys_class_name`. `fields:["*"]` caps the limit at 10.

**Limits:**

- Default 20, max 100 (PROD 50). Offset ≤2,000.
- Long fields are truncated at 1,000 chars and point to `get_field_content`.
- References are compacted to `{v, d}`.

**Response budget:** about 24k chars, configurable. Overflow rows are dropped (`truncated.rows=true`), and the cursor resumes at the first dropped row.

**Cursors:** HMAC-signed with a per-process key. They bind the query hash, scope, and offset, so a tampered or mismatched cursor returns `INVALID_INPUT`. A stable order with a `sys_id` tiebreak is enforced.

**Budgets:**

- Per-scope rate and concurrency limits (§5.4) are enforced in the extension.
- Composite-tool fan-out caps are enforced in the MCP server, and responses report `requests_used`.
- Identical requests are deduplicated for 30 s.
- 5 MB raw cap.

**Cache:** metadata only (`sys_db_object`, `sys_dictionary`, `sys_choice`), 15 min TTL per instance. Record data is never cached beyond the dedup window.

**Response contract:**

```json
{"ok":true,
 "provenance":{"instance":"dev","env":"dev","host":"acmedev.service-now.com","scope":"…3f9a","retrieved_at":"…"},
 "data":{…},
 "page":{"returned":20,"next_cursor":"…","total":null},
 "truncated":{"rows":false,"fields":["script"]},
 "links":["https://acmedev.service-now.com/nav_to.do?uri=incident.do?sys_id=…"]}
```
Errors: `isError: true`, `{"ok":false,"error":{"code","message","hint","candidates?"}}`.

**Error codes:** `SCOPE_REQUIRED, SCOPE_UNKNOWN, SCOPE_EXPIRED, SCOPE_NOT_APPROVED, REQUEST_DENIED, INSTANCE_NOT_REGISTERED, INSTANCE_NOT_IN_SCOPE, BRIDGE_UNAVAILABLE, BROKER_CONFLICT, NO_INSTANCE_TAB, SESSION_EXPIRED, ACL_DENIED, NOT_FOUND, AMBIGUOUS_MATCH, INVALID_INPUT, INVALID_FIELD, UNSAFE_QUERY, QUERY_TOO_BROAD, FORBIDDEN_OPERATION, TABLE_DENIED, BUDGET_EXCEEDED, RESPONSE_TOO_LARGE, TIMEOUT, SN_API_ERROR`.

## 9. Read-only enforcement (defense in depth)

1. **MCP:** closed tool set, no URL/method/header inputs, validation.
2. **Shared validator:** identifiers (`^[a-z0-9_]{1,80}$` tables, `^[a-z0-9_]+(\.[a-z0-9_]+){0,3}$` fields, `^[0-9a-f]{32}$` sys_ids) and query rules.
3. **Extension request builder:**
   - Templates: `/api/now/table/{table}[/{sys_id}]` and `/api/now/stats/{table}` on the granted host. GET only.
   - Param allowlist: `sysparm_query, sysparm_fields, sysparm_limit, sysparm_offset, sysparm_display_value, sysparm_exclude_reference_link, sysparm_no_count, sysparm_count, sysparm_group_by, sysparm_order_by`.
   - Fixed headers, `redirect:'manual'`.
4. **Excluded endpoints:** `*.do`, export processors, scripted REST, UI APIs, attachment download.
5. **Sensitive data:** table denylist and password-type field stripping.
6. **ServiceNow:** the user's ACLs always apply. Optional `admin + snc_read_only` dedicated user (T-022).

## 10. Repository layout (ADR-007)

```
package.json (npm workspaces)  tsconfig.base.json  biome.json  .gitignore  .nvmrc  CLAUDE.md
docs/  PRODUCT_SPEC  ARCHITECTURE  IMPLEMENTATION_PLAN  TASKS  HANDOFF  DECISIONS
       SECURITY (T-021)  TOOLS (T-033)  INSTALL (T-037)  POC_RESULTS (T-005)
packages/
  shared/     src/protocol.ts  src/errors.ts  src/validation.ts  src/limits.ts
              src/query/ (filter-compiler.ts, encoded-query.ts, operators.ts, normalize.ts)
  server/     src/mcp/ (server.ts, tools/*.ts, scope-store.ts, metadata.ts, compact.ts, budget.ts, cursor.ts, errors.ts)
              src/bridge/client.ts
              src/native-host/ (main.ts, framing.ts, broker.ts, socket-guard.ts, auth.ts)
              src/bin/ (mcp-server.ts, native-host.ts)
              scripts/install-native-host.ts   mcpb/manifest.json
  extension/  manifest.json  build.mjs
              src/background/ (index.ts, port.ts, registry.ts, grants.ts, authz.ts, request-builder.ts,
                               executor.ts, session.ts, budgets.ts)
              src/popup/ (popup.html, popup.ts, popup.css)
skills/servicenow-troubleshooting/ (SKILL.md, references/*.md)
.claude-plugin/marketplace.json
test/e2e/ (live, opt-in)
```

Dependencies stay minimal: `@modelcontextprotocol/server`, `zod@4`, `typescript`, `esbuild`, `vitest`, `@biomejs/biome`, `@types/chrome`, `@anthropic-ai/mcpb` (dev). No database, Docker, or embedding dependencies.

## 11. Client registration

- **Claude Code:** `claude mcp add servicenow -- node <repo>/packages/server/dist/mcp-server.js`, or a project `.mcp.json`.
- **Claude Desktop (dev):** add an `mcpServers` entry to `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Claude Desktop (distribution):** a `.mcpb` bundle (single-file esbuild output + `manifest.json`, `server.type: node`) installed via Settings → Extensions → Advanced → Install Extension.
- **Native host:** always installed separately (`npm run setup`) because Chrome launches it with system Node. Future distribution: a Node SEA binary.
