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
   │  URL construction, per-request safeguards, session access. Trusts neither broker nor MCP server.
   ▼ HTTPS GET with the user's session (credentials never leave Chrome)
ServiceNow Table API / Stats API  →  JSON
```

| Component  | Responsibility                                                                                                                                                                                               | Not responsible for                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| MCP server | MCP protocol and tool definitions; input validation (friendly errors); compiling structured filters; the metadata cache; compaction, response shaping, automatic pagination, completeness reporting, signed cursors; composite tools; provenance | Authorization decisions, URLs, sessions |
| Broker     | Client authentication, routing, request-ID rewriting, message-size and in-flight limits, lifecycle                                                                                                                            | Any ServiceNow logic or policy          |
| Extension  | Registry, grants and approval UI, per-request authorization, re-validation, URL building, session/token handling, per-request safeguards (timeout, size, concurrency)                                       | Tool semantics, compaction              |
| Skills     | Optional guidance                                                                                                                                                                                            | Data access, workflows                  |

## 2. Data flow (one query)

1. Claude calls `query_records({scope_id, table, where, fields, limit})`.
2. The MCP server validates input with zod. It validates fields against the cached dictionary (fetching metadata through the same path if the cache is cold), compiles the filter into an encoded query, and builds an `Operation` descriptor `{kind:"table.list", table, query, fields, limit, offset, displayValue}`.
3. The MCP server sends `{v:1, id, kind:"sn.op", scopeId, op}` over the authenticated socket.
4. The broker rewrites the `id` to a per-client namespace and forwards the message to the extension over native messaging.
5. The extension:
   - Checks the grant: the scope exists, isn't expired, is bound to this `client_key_id`, and is for the instance.
   - Re-validates the operation with the shared validator.
   - Queues the request behind the instance's concurrency limit.
   - Builds the URL from a fixed template and performs a `GET` using the session mechanism chosen in ADR-002.
   - Enforces the configured timeout (default 30 s) and response-size cap (default 10 MB, streaming).
   - Maps HTTP results to error codes.
6. The extension returns `{id, ok, status, data, headers:{xTotalCount?}, truncated?, error?}`. Cookie and token values are never present (no such fields exist in the schema).
7. The broker restores the original `id` and sends the response to the right client.
8. The MCP server compacts the result: projection, `{v,d}` references, long-field previews, the response budget, automatic upstream pagination, a signed `next_cursor`, and the completeness report (`complete`, `omitted[]`). It adds provenance and returns `content` (compact JSON text) plus `structuredContent`.

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
- The host name is `com.snmcp.bridge`. The wrapper is `~/Library/Application Support/sn-mcp/host/native-host`, and the manifest is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.snmcp.bridge.json`.
- The wrapper script runs an absolute (resolved) Node path. Re-run the installer after upgrading Node.
- The installer refuses any directory in the Node, host-script, wrapper or manifest paths that is:
  - a symlink,
  - owned by another user (other than root),
  - world-writable,
  - or group-writable by a group other than `admin`/`wheel`. Members of those groups can already become root; Homebrew's `/opt/homebrew/Cellar` is 775 group `admin`.
- Modes: wrapper 0755, manifest 0644, user-owned.
- Host exit codes: 64 wrong origin, 78 unsafe runtime path, 75 `BROKER_CONFLICT` (after sending `broker.status: conflict`), 0 normal shutdown.
- `SN_MCP_RUNTIME_DIR` overrides the runtime directory (used by tests). The same checks apply.

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
- The broker rewrites request IDs and enforces a per-client in-flight maximum (default 64) against misbehaving clients. The MCP server stays well below it because the extension queues requests per instance. There is no per-client request quota.

### 4.5 Lifecycle

- **Extension:** connects with `connectNative` on SW start, `onStartup`, and `onInstalled`. Exponential backoff. 20 s heartbeat. The open port keeps the SW alive.
- **Broker:** lives while stdin is open. On close it disconnects all clients and unlinks the socket and key.
- **MCP server:** connects lazily and re-authenticates on every reconnect, because the key rotates. In-flight requests fail with `BRIDGE_UNAVAILABLE` on disconnect and are **never replayed**.
- **Grants:** survive broker or extension reconnects while the MCP process lives. Cleared when Chrome restarts.
- **Limitation:** one Chrome profile at a time.

**Failure scenarios (T-014).** Each one has a test. "Executed" counts ServiceNow requests made by the extension.

| Scenario | Expected outcome | Test |
| --- | --- | --- |
| Broker killed or restarted (Chrome starts a new host; key rotates) | In-flight call → `BRIDGE_UNAVAILABLE`, never replayed (executed once). The next call re-authenticates to the new broker, and the **same scope works** (grants live in the extension). | `server/test/resilience.test.ts`, `mcp.test.ts` |
| Late answer from an operation forwarded by a previous broker | Dropped: the extension sends a response only on the port the request came in on (generation check), and broker ids carry a random per-process prefix, so a stale id can't match a new request. | `extension/test/resilience.test.ts`, `server/test/resilience.test.ts` |
| Extension reload (new service worker) | Port reconnects with backoff; grants in `storage.session` survive, and the scope keeps working. | `extension/test/resilience.test.ts`, `bridge.test.ts` |
| Chrome restart | `storage.session` cleared → `SCOPE_UNKNOWN`; a new approval is needed. | `extension/test/resilience.test.ts` |
| MCP server restart | New client key → the old scope is `SCOPE_UNKNOWN` for the new process. | `server/test/resilience.test.ts`, `scope-e2e.test.ts` |
| Client disconnects mid-request | Broker drops the answer (`ext.unknown_response`), nothing replayed to a later client. | `broker.test.ts` |
| Host alive but silent (hung) | No inbound message for 60 s (3 × 20 s heartbeat) → the extension drops the port and reconnects; messages arriving later on the dropped port are ignored. | `extension/test/resilience.test.ts` |
| Extension never answers a forward | Broker answers `TIMEOUT` after its pending timeout. | `broker.test.ts` |
| Error response containing a session token | Credential guard withholds it and sends a generic error instead; broker logs carry metadata only (code, kind, duration). | `extension/test/resilience.test.ts`, `server/test/resilience.test.ts` |

### 4.6 Logging

Metadata only: kind, instance alias, table, status, duration, byte sizes. Log files are 0600 and rotated. Never bodies, headers, cookies, or tokens.

## 5. Instance authorization & scopes (ADR-003)

### 5.1 Registry (extension)

`{alias, host, label, env: dev|test|prod|unclassified}`. Unclassified is treated as PROD. Adding an instance calls `chrome.permissions.request` for that origin, which needs a user gesture. Detected ServiceNow tabs are shown as suggestions only.

- Detection uses `activeTab`: only the tab the popup was opened on (ADR-007 addendum, T-010).
- Add, edit and remove run in the service worker (`popup.registry.*` messages from the popup only). Alias and host are immutable; label and env are editable.
- Removal or env change invalidates that instance's grants and open requests. Grants are also bound to the approved `{alias, host, env}` and re-checked on every `sn.op` (ADR-003 addendum).
- Every registry change is pushed as `registry.update` to the broker and all clients. The MCP server keeps the latest snapshot in memory as a hint (error messages); `list_instances` always reads live via `registry.get`.

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
- `release_scope` revokes immediately. Claude keeps a scope for follow-up questions and releases it only when the user says they're finished, so the duration chosen at approval means something (user decision, 2026-11-05).
- Server side (T-012): `scope-store.ts` remembers only the scopes this process claimed. It resolves the target for single scopes, requires `instance` for compare scopes, and fails fast on local expiry or on an instance not covered. It only narrows; unknown scope ids are still forwarded when an instance is given, and the extension decides. Scope errors from the extension drop the local entry (`errors.ts`).
- Tabs never select the target. They are used only for token access to the already-granted host, if ADR-002 requires it.

### 5.4 Environment policies

|                    | DEV / TEST                         | PROD / unclassified ("Other")              |
| ------------------ | ---------------------------------- | ------------------------------------------ |
| Approval           | One click                          | Type the host to confirm (each PROD host)  |
| TTL default / max  | 4 h / 12 h                         | 15 min / 60 min                            |
| TTL choices        | 1 h, 4 h, 8 h, 12 h                | 15 min, 30 min, 60 min                     |
| Renewal            | New request                        | New request (no renewal)                   |
| Badge              | Blue pending count                 | Red ("PROD", or the pending count) while active |

- **Compare grants** cover one fixed pair of distinct aliases. The strictest instance decides the policy (`policyEnv`: prod > test > dev). Every PROD host in the pair must be typed.
- The user picks the TTL at approval. It is fixed afterwards: there is no extend or renew API (`Grants` has none).
- Grant record (`chrome.storage.session`): `{grantId, scopeHash, clientKeyId, clientLabel, instances, mode, env (policy), targets[{alias,host,env}], purpose, approvedAt, createdAt, expiresAt}`.
- Revoke (one) and revoke-all are popup-only. Revoked grants are deleted, so they return `SCOPE_UNKNOWN`; expired ones are kept as tombstones for a day and return `SCOPE_EXPIRED`.
- A new request raises a Chrome notification with the client label, the aliases and the approval code. It never includes the purpose (untrusted text). Clicking it opens the popup.
- Active access shows the purpose and approval time, because every Claude Desktop conversation shares one client label (§5.5).

PROD differs only in **authorization**. Operational safeguards (timeout, size, concurrency) have the same defaults for every environment. The user can override them per instance in the popup, for example lowering concurrency for a fragile instance (ADR-011, §8.2).

### 5.5 Residual risk

Within one Desktop process, a `scope_id` is a bearer capability that only the claiming conversation knows. This is the strongest binding available without conversation IDs.

Observed in T-009: the Claude Desktop app runs one `sn-mcp` process for **all** its conversations, chat and Code tab alike. So they share a `client_key_id`, and the popup shows the same client label for each. The approval code (shown only in the requesting conversation) and the `scope_id` are what keep conversations apart.

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
- Values are normalized (NFKC, zero-width characters stripped, URL-decoded ≤2 passes, lowercased for matching). After that, these patterns are rejected: `javascript:` (the word followed by a colon, with any separators; the word alone is allowed), `gs.`, `${`, `new `, `eval(`.
- Limits: ≤20 terms, ≤3 `^NQ` groups, ≤2 KB.

### 6.3 Anti-broadening

- Every referenced field is checked against the dictionary hierarchy before execution: filters, `encoded_query` terms, `fields`, `order_by`, and each dot-walk hop (≤3).
- This matters because ServiceNow may ignore invalid fields and return all rows.
- Tool-internal conditions are compiled from structured filters only. Raw queries are never concatenated with internal conditions.

### 6.4 Cost-aware defaults (ADR-011, replaces the former cost guards)

- No query is rejected for being broad, old or unconditioned. Validation rejects only *unsafe* or *invalid* queries (§6.2–6.3).
- **High-volume tables** (configurable: `syslog*`, `sys_audit`, `sys_journal_field`, `ecc_queue`, `sys_email`, `sys_history_line`, `discovery_device_history`, `sys_poll`, `*_log`):
  - With no `order_by`, the default order is `ORDERBYDESCsys_created_on` (indexed, newest first).
  - Responses carry a hint suggesting time ranges, key conditions or `aggregate_records` when the query has no selective condition.
- Counts are opt-in (`include_total`). The default sends `sysparm_no_count=true`, and `has_more` is detected by fetching one extra row.
- Instance protection comes from per-request safeguards (§8.2), not from rejecting queries.
- **Implementation (T-018, `server/src/mcp/query-guard.ts`, `server/src/config.ts`):**
  - High-volume list: `SN_MCP_HIGH_VOLUME_TABLES` (comma-separated) **replaces** the default list above. Patterns are `name`, `prefix*`, `*suffix` or `*infix*` (lowercase `[a-z0-9_]`); invalid entries are dropped.
  - Default order: only when the query has no ordering of its own (structured `order_by` or `ORDERBY…` in `encoded_query`) and the table has `sys_created_on`. A user order is never changed.
  - "Selective" means at least one condition that is a time range on `sys_created_on`/`sys_updated_on` (`>`, `>=`, `<`, `<=`, `BETWEEN`, `RELATIVE…`) or an exact/prefix match (`=`, `IN`, `STARTSWITH`). Without one, a high-volume query gets the "No selective condition" hint.
  - `contains`, `not_contains`, `ends_with` or `text` on a high-volume table → a hint suggesting `starts_with` or an exact match on an indexed field.
  - Hints are returned in the tool result's `hints` array; nothing is rejected for breadth, age or missing conditions.
  - Field validation covers filters, raw query terms, `fields`, `order_by` and every dot-walk hop (≤3 hops). Unknown fields are reported together with close-match suggestions, before any data request. Tool-internal conditions are structured only and ANDed into every `any_of` group; a raw `encoded_query` is refused where a tool has internal conditions.
  - **Fails closed:** metadata is read with the user's own session. If their roles can't read `sys_db_object`/`sys_dictionary`, the data query is not sent (the metadata error, e.g. `ACL_DENIED`, is returned).

### 6.4a Profiles (T-003)
`enforce` (authoritative; server + extension) vs `strict` (raw `encoded_query` from the model; additionally rejects `gs.`, `${`, `eval(`, `new X`). See the ADR-005 addendum.

### 6.5 Placement

The shared module (`packages/shared/query`) runs in the MCP server for friendly errors and in the extension for enforcement. The dictionary-aware checks run in the MCP server, and the extension re-runs the syntactic and safety checks.

## 7. Session access (ADR-002 — Accepted: Path A, T-005)

Hypotheses H1–H8 were tested live (`docs/POC_RESULTS.md`). **Path A was chosen.**

- **Path A (chosen):** the service worker's `fetch(credentials:'include')` plus `X-UserToken` if required. The token is read on demand via MAIN-world `executeScript` from a tab of the granted host and cached in memory only.
- **Path B** (works, not used; it runs inside the user's page): a MAIN-world `fetch` executed inside a tab of the granted host, with limits enforced in the injected function.
- **Invariants:** no `cookies` permission; no credential values in any outbound message; no UI navigation.

- **Errors:**
  - A missing token or an expired session both return `401` JSON "User is not authenticated" (observed; no redirect or HTML).
  - On `401`, the token is re-read from the tab and the request retried once. If it's still `401` → `SESSION_EXPIRED`: the token is cleared and the popup status updated. Nothing is retried elsewhere.
  - No open tab of the granted host → `NO_INSTANCE_TAB`.
- **Must not prompt (T-013):** on an expired session, Chrome can show its native HTTP-auth dialog for credentialed requests. The extension must suppress this, so requests never hang and the user is never asked for a password.

## 8. MCP tools, efficiency & ambiguity (ADR-006, ADR-011)

| Tool                  | Inputs (abridged)                                                                                    | Notes                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `list_instances`      | —                                                                                                    | alias, env, env_name, policy, label, connection state, `connector_access` (per MCP process, shared by Desktop conversations); no scope IDs |
| `request_scope`       | instance, or instances[1–2] (two → compare), purpose                                                 | returns request_id + approval_code                                                    |
| `claim_scope`         | request_id                                                                                           | once; returns scope_id                                                                |
| `release_scope`       | scope_id                                                                                             | narrows only                                                                          |
| `discover_tables`     | scope_id, search, limit                                                                              | `sys_db_object`                                                                       |
| `describe_table`      | scope_id, table, include_inherited, include_choices                                                  | dictionary hierarchy; NOT_FOUND + suggestions                                         |
| `query_records`       | scope_id, table, where/any_of or encoded_query, fields, text, order_by, limit, cursor, include_total | main query                                                                            |
| `get_record`          | scope_id, table, sys_id or match{field:value}, fields, expand_references                             | `AMBIGUOUS_MATCH` (5 candidates + count + query to list all)                          |
| `get_field_content`   | scope_id, table, sys_id, field, start_line, start_char, max_lines, max_chars, refresh                | numbered lines; any length; complete content reachable chunk by chunk                 |
| `aggregate_records`   | scope_id, table, where, group_by, aggregates, cursor                                                 | Stats API; all groups, paginated                                                      |
| `get_related_records` | scope_id, table, sys_id, samples, cursor                                                             | all reverse refs via dictionary + counts + samples; paginated                         |
| `get_record_history`  | scope_id, table, sys_id, limit, cursor, since?, until?                                               | `sys_audit` + `sys_journal_field`; full history, any age                              |
| `search_code`         | scope_id, pattern, tables?, limit, cursor                                                            | all script fields from dictionary; ±3-line snippets; continues across tables          |
| `compare_records`     | scope_id (compare grant, or single: match_b required), table, match_a, match_b?, fields              | per-side ambiguity check; field diff + unified diff; version payloads by element      |

All ServiceNow tools are annotated `readOnlyHint: true`. There is no generic HTTP tool. Every data tool also accepts `max_chars` (§8.3).

### 8.1 Principle (ADR-011)

Optimize *how* Claude retrieves information, not *how much* it may investigate. Nothing caps the total rows, the pagination depth, the age of records, or the length of content Claude can read. Every limit is either a per-request reliability safeguard (§8.2) or response shaping with an explicit continuation (§8.3).

### 8.2 Per-request safeguards (extension-enforced, user-configurable)

| Setting                     | Default | Allowed range | Behavior when hit                                                             |
| --------------------------- | ------- | ------------- | ----------------------------------------------------------------------------- |
| Request timeout             | 30 s    | 5–300 s       | `TIMEOUT` (hint: narrow the range or order by an indexed field)               |
| Max raw response per request | 10 MB   | 1–50 MB       | Streaming abort → `RESPONSE_TOO_LARGE`; the server retries automatically (§8.3) |
| Max concurrent per instance | 4       | 1–16          | Extra requests queue (FIFO). A queue wait longer than the timeout → `TIMEOUT` |
| Upstream page size (wire)   | —       | 1–1,000 rows  | Validation bound on one HTTP request                                          |

- Settings live in the popup, globally and optionally per instance, in `chrome.storage.local`. Only the user changes them. The MCP server and broker can't.
- ServiceNow `429` or transaction-quota errors → `RATE_LIMITED`, with the `Retry-After` value in the hint.
- There is no per-minute quota, no dedup and no fan-out cap. Add one only if live use shows a need.

### 8.3 Response shaping, pagination and completeness (MCP server)

| Server setting (env var / `.mcpb` user_config)  | Default | Purpose                                                  |
| ----------------------------------------------- | ------- | -------------------------------------------------------- |
| `SN_MCP_RESPONSE_CHARS`                         | 24,000  | Default size of one tool result                          |
| `SN_MCP_MAX_RESPONSE_CHARS`                     | 100,000 | Ceiling for the per-call `max_chars` argument            |
| `SN_MCP_PAGE_SIZE`                              | 100     | Rows per upstream request during automatic pagination    |
| `SN_MCP_FIELD_PREVIEW_CHARS`                    | 1,000   | Preview length of long fields in record lists            |
| `SN_MCP_FIELD_CACHE_MB` / `SN_MCP_FIELD_CACHE_TTL_S` | 64 / 600 | In-process cache for chunked field reads             |

- **Default projection:** `sys_id`, the dictionary display field, `number`/`name`/`short_description` if present, `sys_updated_on`, `sys_class_name`. `fields:["*"]` is allowed with any `limit`; the response budget decides how many rows fit per result.
- **`limit`** is the number of rows wanted. It has no maximum and defaults to 20.
- **Automatic pagination:**
  - The server fetches upstream pages of `SN_MCP_PAGE_SIZE` (+1 row to detect more) until `limit` is reached or the response budget is full.
  - It returns `next_cursor` whenever more rows exist. Claude continues with `{cursor}` alone and never handles offsets.
  - No offset ceiling. Ordering always ends with a `sys_id` tiebreak.
- **Adaptive size:** on `RESPONSE_TOO_LARGE`, the server halves the upstream page size and retries, down to 1 row. A single record still over the cap is returned without its largest fields, each listed in `omitted` with the exact `get_field_content` call.
- **Long fields:**
  - Lists show a preview with an `omitted` entry (`shown_chars`, `total_chars`, next call).
  - `get_field_content` returns numbered line windows. Lines longer than the budget are split by `start_char`.
  - Every chunk reports `total_lines`, `total_chars`, `next` and `complete`, so Claude can always read the whole value.
- **Cursors:**
  - HMAC-signed with a per-process key. They bind table, query, fields, order and instance (not scope ID), so pagination survives re-approval of an expired grant.
  - Every request still needs a valid scope for that instance.
  - A tampered or mismatched cursor → `INVALID_INPUT`.
- **Composite tools:**
  - `get_related_records`: all relations.
  - `get_record_history`: all entries, any age.
  - `search_code`: all script tables.
  - `compare_records`: the full diff.
  - All of them page through results with cursors and report `requests_used`. Their requests go through the same concurrency queue.
- **Caches** (in-process only, never persisted; ADR-010):
  - Metadata (`sys_db_object`, `sys_dictionary`, `sys_choice`): 15 min TTL per instance.
  - Field content for chunked reads: TTL and LRU size as configured; bypassed with `refresh: true`. Keyed by scope; the server sends `scope.check` before using a hit, so the extension still decides every read (ADR-003 addendum).
- **Hints, not refusals:** on high-volume tables or unselective queries, the result suggests filters, time ranges or `aggregate_records` (§6.4).

**Response contract** (completeness is mandatory: a result is either `complete: true` or says exactly what is missing and how to get it):

```json
{"ok":true,
 "provenance":{"instance":"dev","env":"dev","host":"acmedev.service-now.com","scope":"…3f9a","retrieved_at":"…"},
 "data":{…},
 "complete":false,
 "page":{"returned":60,"has_more":true,"next_cursor":"…","total":null},
 "omitted":[
   {"kind":"rows","reason":"response_budget","next":{"tool":"query_records","args":{"scope_id":"…","cursor":"…"}}},
   {"kind":"field","sys_id":"…","field":"script","shown_chars":1000,"total_chars":48211,
    "next":{"tool":"get_field_content","args":{"scope_id":"…","table":"sys_script_include","sys_id":"…","field":"script"}}}
 ],
 "hints":["syslog has no selective condition; consider a sys_created_on range or aggregate_records."],
 "links":["https://acmedev.service-now.com/nav_to.do?uri=incident.do?sys_id=…"]}
```
`omitted[].kind` is one of `rows`, `field`, `relation`, `table`, `source` (for example, ACL denied on one history source) or `groups`.

**Implementation (T-023, `server/src/mcp/{cursor,paginate,compact,response}.ts`):**

- `page`: `returned` (this result), `returned_total` (all calls with this cursor chain), `has_more`, `next_cursor` (null when done), `total` (only with `include_total`). Every list result also carries `requests_used` and `untrusted_content`.
- `complete` is true only when `has_more` is false **and** `omitted` is empty. A `rows` entry carries `reason` (`limit`, `response_budget`, `error`), a note and `next: {tool, args:{scope_id, cursor}}`. Each `field` entry carries `reason` (`preview`, `response_budget`, `too_large`), `sys_id`, `field`, `shown_chars`, `total_chars` (null if unknown) and the `get_field_content` call (the tool arrives in T-027). Stripped credential fields appear as `{kind:"fields", reason:"sensitive", fields}`.
- Values: `{value, display_value}` becomes the plain value when they're equal, else `{v, d}`. Explicit projections always include `sys_id` (links and next calls need it). `links` holds classic-UI record links for the user; they are never fetched.
- Budget: rows are added while `max_chars` − 2,500 characters (envelope reserve) allows. The first record is shrunk (largest fields first, each listed in `omitted`) rather than dropped. `max_chars` is clamped to 4,000…`SN_MCP_MAX_RESPONSE_CHARS`, with a hint when clamped.
- **ACL-hidden rows:** ServiceNow removes rows the user can't read **after** windowing, so a page can be short, or even empty, while more matching rows follow. Neither proves the end. After one, the next request asks for the total count (which includes hidden rows); when matching rows exist past the current offset, a fully hidden window is skipped. A small read costs one data request plus at most one count check. When `include_total` shows more rows than were readable, a hint explains the difference.
- Cursors: HMAC-SHA256 over the state with a random per-process key (restarting the server invalidates cursors → `INVALID_INPUT`). The state is instance, table, final query, fields, display mode, offset, limit and rows seen. A cursor can't be combined with `table`, `fields` or `include_total`; `limit` and `max_chars` may change per call.

Errors: `isError: true`, `{"ok":false,"error":{"code","message","hint","candidates?"}}`.

**Error codes:** `SCOPE_REQUIRED, SCOPE_UNKNOWN, SCOPE_EXPIRED, SCOPE_NOT_APPROVED, REQUEST_DENIED, INSTANCE_NOT_REGISTERED, INSTANCE_NOT_IN_SCOPE, BRIDGE_UNAVAILABLE, BROKER_CONFLICT, NO_INSTANCE_TAB, SESSION_EXPIRED, ACL_DENIED, NOT_FOUND, AMBIGUOUS_MATCH, INVALID_INPUT, INVALID_FIELD, UNSAFE_QUERY, FORBIDDEN_OPERATION, TABLE_DENIED, RATE_LIMITED, RESPONSE_TOO_LARGE, FILTER_NOT_APPLIED, TIMEOUT, SN_API_ERROR`.

## 9. Read-only enforcement (defense in depth)

1. **MCP:** closed tool set, no URL/method/header inputs, validation.
2. **Shared validator:** identifiers (`^[a-z0-9_]{1,80}$` tables, `^[a-z0-9_]+(\.[a-z0-9_]+){0,3}$` fields, `^[0-9a-f]{32}$` sys_ids) and query rules.
3. **Extension request builder:**
   - Templates: `/api/now/table/{table}[/{sys_id}]` and `/api/now/stats/{table}` on the granted host. GET only.
   - Param allowlist: `sysparm_query, sysparm_fields, sysparm_limit, sysparm_offset, sysparm_display_value, sysparm_exclude_reference_link, sysparm_no_count, sysparm_count, sysparm_group_by, sysparm_order_by`.
   - Fixed headers, `redirect:'manual'`.
4. **Excluded endpoints:** `*.do`, export processors, scripted REST, UI APIs, attachment download.
5. **Sensitive data:** table denylist and password-type field stripping (T-020). The defaults live in `shared/src/sensitive.ts`. Extras are additive only: `SN_MCP_DENIED_TABLES` on the server and Settings in the extension. The extension refuses denied tables and credential-named fields and strips such keys from every response. The server also refuses denied tables reached by a dot-walk and dictionary password types, and reports stripped field names in `omitted`.
6. **ServiceNow:** the signed-in user's roles and ACLs always apply. The connector is role-agnostic (ADR-012): it doesn't require, check or manage roles, and read-only enforcement (items 1–5) is the same for an admin session as for any other. Access-denied responses become `ACL_DENIED` with an explanation Claude can relay.

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
plugin/skills/servicenow-readonly-troubleshooting/ (SKILL.md, references/*.md)
.claude-plugin/marketplace.json
test/e2e/ (live, opt-in)
```

Dependencies stay minimal: `@modelcontextprotocol/server`, `zod@4`, `typescript`, `esbuild`, `vitest`, `@biomejs/biome`, `@types/chrome`, `@anthropic-ai/mcpb` (dev). No database, Docker, or embedding dependencies.

## 11. Client registration

- **Claude Code:** `claude mcp add servicenow -- node <repo>/packages/server/dist/mcp-server.js`, or a project `.mcp.json`.
- **Claude Desktop (dev):** add an `mcpServers` entry to `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Claude Desktop (distribution):** a `.mcpb` bundle (single-file esbuild output + `manifest.json`, `server.type: node`) installed via Settings → Extensions → Advanced → Install Extension.
- **Native host:** always installed separately (`npm run setup`) because Chrome launches it with system Node. Future distribution: a Node SEA binary.
