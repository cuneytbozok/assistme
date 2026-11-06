# Architecture Decision Records

Format: Status · Context · Decision · Alternatives considered · Consequences. Statuses: Proposed, Accepted, Superseded.

---

## ADR-001 — Native Messaging + authenticated Unix-socket broker

- **Status:** Accepted (2026-11-04)
- **Context:**
  - The MCP server is launched by Claude (Desktop or Code) and the extension lives in Chrome, so they need an IPC channel.
  - Several MCP processes may run at once (Desktop + Code).
  - Web pages must not be able to reach the channel.
  - Chrome's `allowed_origins` only controls who can _launch_ the native host. It is not end-to-end security.
- **Decision:**
  - Chrome launches a Node native host via Native Messaging. That host acts as a broker on a Unix domain socket in `~/Library/Application Support/sn-mcp/`.
  - The host verifies the launch origin from argv.
  - The socket directory is 0700 and the socket 0600, with `lstat` owner/mode/symlink checks.
  - Clients and broker authenticate each other with HMAC challenge-response, using a key that rotates on every broker start (`broker.key`, 0600).
  - The broker rewrites request IDs per client and enforces size and rate limits.
  - Request descriptors are never replayed after a disconnect.
  - The extension treats the broker as untrusted and re-validates every operation and grant.
- **Alternatives considered:**
  - **Localhost WebSocket/HTTP:** reachable by any web page (needs Origin checks plus pairing), and there are port conflicts between MCP processes. Rejected.
  - **MCP server as socket server, host as client:** a single host would need to discover N servers. Rejected.
  - **Peer-credential checks (`getpeereid`):** needs a native addon, and adds little over HMAC + 0700 for the same-user threat model. Deferred.
- **Consequences:**
  - A one-time install step for the host manifest.
  - System Node is required for the host (Desktop's bundled Node isn't visible to Chrome). Future: a Node SEA binary.
  - One Chrome profile at a time (`BROKER_CONFLICT`).
- *Addendum (T-006, 2026-11-04):*
  - **Framing:** client↔broker uses the same 4-byte LE length-prefixed JSON framing as native messaging.
  - **HMAC inputs** are joined with `\n`.
  - **Broker limits:** per-client in-flight cap of 64, with no request quota (ADR-011). Duplicate in-flight IDs are rejected. Requests unanswered after 330 s get `TIMEOUT`.
  - **Auth failures:** after 5 failed authentications in 60 s (including 2 s timeouts), new connections are refused until the window clears.
  - **Installer group rule:** group-writable directories are accepted only for root-equivalent groups (`admin` 80, `wheel` 0), so Homebrew Node installs work. World-writable directories and other groups are refused.
  - **File locations:** the installer lives in `src/install/installer.ts` + `src/bin/install-native-host.ts` (compiled), not `scripts/`, so it runs without a TS runtime. Client handshake: `src/bridge/handshake.ts` (reused by T-008).


- *Addendum (T-014, 2026-11-04): stale-answer bug fixed.* Chrome starts a new host process on every reconnect, and each broker numbered forwards `b1, b2, …` from scratch. An operation still running in the extension when its broker died would send its late answer on the **new** port, where it could match another client's pending request with the same id. Fix: (1) broker ids are `b<random 8 chars>_<n>` per process; (2) the extension tags each forward with its connection generation and sends the response only on that connection (`BridgePort.respond`). Also added: an extension-side heartbeat timeout (60 s without inbound → reconnect).
## ADR-002 — Session access path

- **Status:** **Accepted (2026-11-04, T-005): Path A.** Live results are in `docs/POC_RESULTS.md` (H1–H5, H7, H8 confirmed; H6 untested; no SSO instance).
- **Decision:**
  - **Requests:** the service worker sends every ServiceNow request as `fetch(credentials:'include', redirect:'manual')` with `X-UserToken: <g_ck>`.
  - **Token:** `g_ck` is read on demand via MAIN-world `executeScript` from an open tab of the granted host, and cached in service-worker memory only.
  - **Error handling:**
    - No tab of the host → `NO_INSTANCE_TAB`.
    - `401` → re-read the token and retry once; if it's still `401` → `SESSION_EXPIRED`.
  - **Path B** (in-tab fetch) works but is not used, because it runs inside the user's page.
- **Open item (T-013):** while logged out, credentialed requests made Chrome show its native HTTP-auth sign-in dialog, and the request waited for the user. The connector must suppress this (e.g. a request header ServiceNow honors, or `webRequest.onAuthRequired` cancellation, which needs a manifest change and user approval). Verify live and record the result here.
- **Context:** Only community sources describe how ServiceNow REST behaves under browser-session auth and how MV3 service-worker fetch handles cookies. None of it is authoritative, so it must be tested on a live instance.
- **Hypotheses:**

| ID  | Hypothesis                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------- |
| H1  | SW `fetch(credentials:'include')` to a host in `host_permissions` sends ServiceNow session cookies                                |
| H2  | Table API GET with cookies but without `X-UserToken` returns 401                                                                  |
| H3  | `g_ck` is readable via MAIN-world `executeScript` in UI16 (`/nav_to.do`), Next Experience (`/now/nav/ui`), and `gsft_main` frames |
| H4  | `g_ck` stays valid for the session, changes after re-login, and an invalid token gives 401                                        |
| H5  | Fallback: MAIN-world `fetch` inside a tab of the granted host works                                                               |
| H6  | SSO/MFA sessions behave like local login (untested if no SSO instance is available)                                               |
| H7  | Session timeout shows up as 401 or as a redirect/HTML login page                                                                  |
| H8  | Read requests cause no visible side effects (`last_login_time`, `sys_user_session`)                                               |

- **Decision rule:**
  - H1 ∧ (H2 → H3) → **Path A**: the service worker owns fetch. The token is read on demand from a granted-host tab and cached in memory only.
  - ¬H1 ∧ H5 → **Path B**: MAIN-world fetch in a granted-host tab, with limits inside the injected function.
  - Both fail → stop and escalate under change management.
- **Invariants:** no `cookies` permission; no credential values outside the extension; no UI navigation.
- **Alternatives considered:**
  - Basic auth or OAuth credentials stored locally: contradicts "use the browser session" and would add secret storage. Rejected unless the PoC fails and the user approves.
  - Browser automation: forbidden.


- *Addendum (T-013, 2026-11-04): no credential prompts.*
  - Measured: ServiceNow's 401 carries `WWW-Authenticate: Basic` (which triggers Chrome's sign-in dialog) unless the request has an `X-UserToken` header; then it sends `WWW-Authenticate: none`. `X-Requested-With: XMLHttpRequest` does **not** remove the Basic challenge.
  - Decision: every ServiceNow request carries `X-UserToken` (already true for Path A), and no request is sent without one (`NO_INSTANCE_TAB`). A test enforces this. No `webRequest`, `webRequestAuthProvider` or `declarativeNetRequest` permission is added.
  - In throwaway headed profiles, service-worker fetches to the logged-out PDI never showed a dialog in any combination (guest session, stale token). The T-005 dialog most likely came from a page-context request (H5). Fallback if T-015 shows a dialog in the user's profile: a `declarativeNetRequestWithHostAccess` session rule removing `WWW-Authenticate` for extension-initiated requests to registered hosts (tested: removes the header). It needs approval as a manifest change.
  - Session status: local signals (host permission, open tab) every 30 s and on tab/permission events. Session expiry is learned from requests; expired hosts are re-probed (one read-only GET) at most every 30 s while a tab is open; unknown hosts are probed only when the user opens the popup. Evidence: `docs/evidence/T-013/`.
## ADR-003 — User-approved scope grants with approval codes, enforced in the extension

- **Status:** Accepted (2026-11-04)
- **Context:**
  - Claude must not be able to authorize or switch instances.
  - Claude Desktop shares one MCP process across conversations and provides no conversation ID.
  - MCP elicitation support in Desktop is undocumented.
- **Decision:**
  - Device-flow style. `request_scope` returns a request ID and a 6-character approval code. The user approves in the extension popup after checking the code matches the one in the conversation. `claim_scope` returns an opaque 128-bit `scope_id`, once, and only to the requesting `client_key_id`.
  - Grants are immutable (one instance, or one compare pair) and stored in `chrome.storage.session`. They're checked on every request.
  - Scope IDs are never listed.
  - PROD (and unclassified): typed host confirmation, TTL 15/60 min, no renewal, stricter budgets, red badge.
  - DEV/TEST: TTL 4/12 h.
  - Revoke and revoke-all in the popup.
- **Alternatives considered:**
  - `select_instance` chosen by Claude plus a global "enabled" toggle: Claude would choose the instance. Rejected.
  - Required `instance` parameter only: no user binding. Rejected.
  - Blocking tool call waiting for approval: client timeouts are unknown. Rejected in favor of request/claim.
  - Auto-approve for DEV: deferred, since it weakens "user authorizes".
- **Consequences:**
  - One approval step per conversation per instance.
  - Residual risk: within a Desktop process, the `scope_id` is a bearer secret known only to the claiming conversation.

- *Addendum (T-009, 2026-11-04):*
  - In the Claude Desktop app, chat **and** Code conversations use the single `sn-mcp` server that Desktop starts from its config. All of them share one `client_key_id`, and grants show the same client label.
  - Binding is therefore per process, and the `scope_id` bearer handle (plus the approval code shown only in the requesting conversation) is the only per-conversation separation. This matches the residual risk in ARCHITECTURE §5.5, which now explicitly includes Code sessions in the Desktop app.
  - A standalone Claude Code CLI starts its own server process and gets its own identity.

- *Addendum (T-010, 2026-11-04):*
  - **Grants are bound to the registry entry, not just the alias.** On approval, the request records `targets: [{alias, host, env}]` and the grant copies them. Every `sn.op` checks that the current registry entry still matches exactly; otherwise `SCOPE_UNKNOWN` ("registration changed after approval"). This stops a grant following an alias that was removed and registered again with another host, or reclassified (for example DEV → PROD, which would otherwise skip PROD's typed confirmation and short TTL).
  - **Registry mutations invalidate grants.** Removing an instance or changing its env drops its grants and denies its open requests (`Grants.reconcile`). A label-only edit keeps them. `reconcile` also runs on every `chrome.storage.local` registry change as a backstop. Grants stored before T-010 have no `targets` and are dropped (session storage only).
  - Alias and host are immutable once registered; to change them, remove and register again.
  - *Follow-up (2026-11-04, user request):* **"Other" environments with a custom name.** The protocol enum stays `dev|test|prod|unclassified`. The popup shows `unclassified` as **Other** with an optional `envName` (`ENV_NAME_RE`: 1–16 letters, digits, spaces, `-`, `_`; `dev`/`test`/`prod`/`production`/`development` refused). `envName` is display only. It always gets PROD rules and isn't part of the grant target, so a rename keeps grants. `InstanceInfo.envName` is optional; `list_instances` returns `env_name` and `policy`. The add form has no default environment; the user must choose (previously the default was unclassified).

- *Addendum (2026-11-05, user decision): keep a scope for follow-ups.* Claude was told to release a scope when done, so access ended after one question and the duration chosen at approval had no effect. Now it keeps the scope for the conversation, and releases it only when the user says they're finished. Access still ends at expiry, on revoke, or when Chrome restarts, and scopes aren't shared between conversations. These are instructions to Claude, which it follows but the connector can't force: the extension's expiry and revoke are the enforced limits.
- *Addendum (T-027, 2026-11-05): `scope.check`.* The server's in-process field cache answers chunked reads without a ServiceNow request, so a hit would never reach the extension, and a scope the user revoked would stay readable until the cache TTL. New protocol message `scope.check {scopeId, instance}`: the extension runs the same checks as `sn.op` (grant, client binding, expiry, instance, registration, host permission) and makes no HTTP request. The server sends it before using any hit and drops that scope's entries on refusal. Entries are also keyed by scope. An extension without this message doesn't answer, so cached reads fail closed.
- *Addendum (T-011, 2026-11-04):*
  - Compare mode is enabled in the extension (exactly two distinct instances). The policy is the strictest of the pair, and every PROD host must be typed. The MCP `request_scope` tool still requests single scopes only. Exposing compare requests to Claude belongs to T-012/T-032.
  - TTL choices are fixed lists within the ADR caps (DEV/TEST 1/4/8/12 h, PROD 15/30/60 min). There is no renewal.
  - Notifications use a fixed template (client label, aliases, approval code), never the purpose. The extension now ships icons (`packages/extension/icons/`, generated once from a canvas; no external assets).
  - Badge: red while any PROD grant is active, refreshed every 30 s and on every change.

## ADR-004 — Operation descriptors, never URLs

- **Status:** Accepted (2026-11-04)
- **Decision:**
  - The MCP server sends a closed union of operations (`table.list`, `table.get`, `stats.aggregate`, `probe`).
  - Only the extension's request builder creates URLs, from fixed templates, with GET only and allowlisted params.
- **Alternatives considered:** a URL/path allowlist on forwarded URLs. More brittle and easier to bypass. Rejected.
- **Consequences:** a new ServiceNow capability needs a reviewed new operation kind.


- *Addendum (T-016, 2026-11-04):* `request-builder.ts` is the single URL constructor.
  - Templates: `/api/now/table/{table}[/{sys_id}]` and `/api/now/stats/{table}`. Each has a parameter allowlist and fixed headers (`Accept`, `X-UserToken`), with `redirect: 'manual'`, `credentials: 'include'` and `cache: 'no-store'`.
  - Every built URL is parsed back and checked before use.
  - `stats.aggregate` is now buildable in the extension (it was refused until now); the MCP tool comes in T-028.
  - A source-scan test keeps `/api/now/` out of every other file and `fetch` out of everything but the executor.
## ADR-005 — Structured filters + validated encoded queries + dictionary validation

> Partly superseded by ADR-011 (2026-11-04): the cost guards (no-condition limit ≤20, mandatory time window / indexed key on high-volume tables, `QUERY_TOO_BROAD`) are removed. Query validation and anti-broadening are unchanged.

- **Status:** Accepted (2026-11-04)
- **Context:**
  - Encoded queries can contain server-side script (`javascript:`), dynamic filters, and related-list subqueries.
  - ServiceNow can ignore invalid fields, which broadens results.
  - Blocking `javascript:` alone isn't enough.
- **Decision:**
  - Structured `where`/`any_of` filters are the primary input, compiled by the server.
  - Raw `encoded_query` is tokenized and fully parsed against an operator allowlist.
  - Dangerous operators (`DYNAMIC`, `RLQUERY`, `SUBQUERY`, `JOIN`, `123TEXTQUERY321`, `GOTO`) are rejected, as are script-like values after normalization.
  - Size and term limits apply.
  - All fields and dot-walks are validated against `sys_dictionary` before execution.
  - Internal conditions are never combined with raw queries.
  - High-volume tables need a time window or an indexed-key condition. Counts are opt-in.
  - The same validation runs in the server and the extension.
- **Alternatives considered:**
  - Blocklist only: insufficient.
  - Structured filters only: too limiting for experts. Raw queries are kept but validated.
- **Consequences:** some valid but exotic queries are refused, with an `UNSAFE_QUERY`/`QUERY_TOO_BROAD` hint.
- *Addendum (T-003, 2026-11-04) — implementation refinements:*
  - **Validation profiles.**
    - `enforce` is authoritative and runs in the server and the extension. It covers the operator allowlist, full term parsing, and structure/size limits. It rejects `javascript:` in any disguise after normalization, plus control characters and `^` in values.
    - ~~`strict` is used for raw `encoded_query` typed by the model. It is `enforce` plus a rejection of script-like patterns (`gs.`, `${`, `eval(`, `new X`).~~ Removed by T-047 (below).
    - **Why split:** those patterns are legitimate literal searches (e.g. `search_code` looking for `gs.addErrorMessage` or `new GlideRecord`). ServiceNow evaluates only `javascript:`-prefixed values, which `enforce` always blocks. The extension only sees compiled queries, so it can't tell which path produced them and therefore applies `enforce`.
  - ~~**Known false positive:** any value containing the word "javascript" is refused.~~ Replaced on 2026-11-05 (below).
  - *Addendum (2026-11-05, user-directed): returned rows are checked against the query.* ServiceNow warns that it "ignored" parts of queries under `query_range` ACLs. The API refused those queries on the tables tested, but other instances may differ, and an ignored filter would make unfiltered rows look like an answer. `query_records`, `get_record` matches, `search_code` and `get_record_history` now withhold rows that certainly contradict their conditions (`FILTER_NOT_APPLIED`). It's conservative, to avoid false alarms, so it can miss cases. Aggregates have no rows to check.
  - *Addendum (T-034, 2026-11-05, user-directed): only the `javascript:` prefix is refused.* The live run showed the old rule made a real table unreadable (`automation_pipeline_transformer_javascript`), and it blocked searching for a common word. Only `javascript` followed by a colon is dangerous, because ServiceNow evaluates that prefix on the server. The rule now rejects that, anywhere in a value, in any disguise: separators between the letters or before the colon, URL encoding, HTML entities, escapes, fullwidth forms, invisible characters. The word alone passes in every profile. It's still enforced in both the server and the extension. To find `javascript:` in scripts, search for `javascript` without the colon. Not tested: how ServiceNow treats the word without a colon, beyond the live queries in T-034, because testing the executable form would mean running script.
  - **Excluded operators:** `ON`, `NOTON`, `DATEPART`, `MORETHAN`, `LESSTHAN` (their values are normally `javascript:` expressions), `VALCHANGES`/`CHANGESFROM`/`CHANGESTO`, and `RELATIVEEE`. Date filtering uses `>=`/`<`/`BETWEEN` and `RELATIVEGE`/`RELATIVEGT`/`RELATIVELT`/`RELATIVELE`.
  - **Field-to-field operators:** `SAMEAS`, `NSAMEAS`, `GT_FIELD`, `LT_FIELD`, `GT_OR_EQUALS_FIELD`, `LT_OR_EQUALS_FIELD` are allowed. Their value fields are added to `referencedFields`, so dictionary validation covers them.
  - **Structured relative dates:** `within_last` (→ `RELATIVEGE@unit@ago@n`) and `older_than` (→ `RELATIVELT@unit@ago@n`).
  - **Text search:** `123TEXTQUERY321` is only accepted when `allowTextSearch` is set (server `text` parameter) and only as the first term.
  - *T-007:* the extension's re-validation (`enforce`) sets `allowTextSearch`, because it can't tell compiled `text` input from other compiled input. The gating against raw model input is the server's `strict` parse.


- *Addendum (T-018, 2026-11-04; confirmed by the user 2026-11-05):* dictionary validation **fails closed**, and the error tells Claude to explain to the user what they can't read. Metadata is read with the user's session; if the user can't read `sys_db_object`/`sys_dictionary`, data queries return that error instead of running unvalidated, because an unknown field can make ServiceNow return every row (T-005). Consequence: users without dictionary read access can't query until this is revisited. Possible relaxation (needs user approval): allow structured-filter queries whose fields can't be verified only on tables the user explicitly trusts. Not implemented.
- *Addendum (T-047, 2026-11-06, requested by the user): native encoded-query compatibility.* Compared with the official SDK's `now-sdk query` (`@servicenow/sdk` 4.14.0), which passes `--query` verbatim as `sysparm_query` with no client-side checks and relays ServiceNow's error body. Our checks stay (the SDK isn't a read-only connector for an AI), but several refused queries that are valid and harmless:
  - **Accepted and rewritten to canonical form:** the trailing `^EQ` marker that "Copy query" adds (only `ORDERBY` may follow it), `NOTLIKE`, `CONTAINS`, `DOES NOT CONTAIN` (→ `NOT LIKE`, `LIKE`, `NOT LIKE`). The server sends the canonical form, so the extension only ever sees operators it already enforced, and the result's hints show the rewrite and the query sent.
  - **Accepted as written:** empty `field=` / `field!=` (ServiceNow's empty tests); `123TEXTQUERY321=` in `encoded_query` where the tool offers text search, before any `^NQ`; `ref_<table>` downcasts in dot-walks, checked against the `super_class` chain.
  - **The `strict` profile is removed.** It refused `gs.`, `${`, `eval(`, `new X` in raw queries, so `short_descriptionLIKEnew laptop` failed. Those strings run nothing: ServiceNow evaluates a value only with the `javascript:` prefix, which every path still refuses in any disguise (attack corpus unchanged, plus new alias cases). This brings raw queries in line with the 2026-11-05 decision on the word "javascript".
  - **Bounds raised** (single-query size only, ADR-011): 8,000 characters (raw input 7,900, leaving room for the server's `ORDERBY`s), 100 terms, 10 `^NQ` groups, 1,000 `IN` items. The 500-character value bound now applies per `IN` item: before, a structured `in` of 16 sys_ids was refused. A URL ServiceNow finds too long fails with a clear HTTP 414 message.
  - **Still refused:** `DYNAMIC`, `ON`/`NOTON`/`DATEPART` (script values), `RLQUERY`/`SUBQUERY`/`JOIN` (fields of other tables escape dictionary validation), `VALCHANGES`/`CHANGESFROM`/`CHANGESTO`, and `MORETHAN`/`LESSTHAN`/`RELATIVEEE`. The last three run no script, but an operator ServiceNow misreads may be ignored, which broadens results (T-005); they can be allowed after a live test shows their value format is applied. `==` and `<>` are now refused instead of being sent as the literal values `=1` / `>1`.
  - **Diagnostics:** each refusal names the condition, its position and reason, and where one exists the native rewrite (e.g. `>=javascript:gs.daysAgoStart(7)` → `RELATIVEGE@day@ago@7`). Rewrites are suggestions, never applied (rule 8). Likely mistakes that parse become warning hints. An empty `query_records` result gets hints about choice labels vs values, names vs sys_ids on references, and `=` on date-times. The extension relays ServiceNow's `error.detail` with `error.message`.
  - **Unchanged:** GET-only templates, operation descriptors, dictionary validation of every field and hop, the filter check on returned rows, and the same rules in server and extension.
  - **Not verified live:** that ServiceNow applies `field=` as an empty test and `ref_` downcasts as expected, the URL length it accepts near 8,000 characters, and the error-detail text it returns. Mocks are not evidence (rule 11); T-047 records the live check.

## ADR-006 — Response budgets, signed cursors, ambiguity errors

- **Status:** Superseded in part by ADR-011 (2026-11-04). Still in force: default projection, HMAC-signed cursors with stable ordering, `AMBIGUOUS_MATCH` and table suggestions. Replaced: hard row limits, PROD limits, the offset ceiling, per-scope rate budgets, fan-out caps, the 30 s dedup and "record data is never cached".
- **Original status:** Accepted (2026-11-04)
- **Decision:**
  - Default projection; limits of 20 default, 100 max, 50 on PROD; long fields truncated at 1,000 chars, with `get_field_content` for chunks.
  - Response budget of about 24k chars with truncation indicators.
  - HMAC-signed cursors bound to query + scope; stable ordering.
  - Per-scope rate and concurrency budgets, fan-out caps, 30 s dedup, metadata-only cache.
  - Non-unique matches return `AMBIGUOUS_MATCH` with ≤5 candidates and are never auto-picked. Unknown tables get suggestions and are never auto-selected.
- **Consequences:** Claude sometimes needs follow-up calls. That's intentional, because it keeps context small and correct.

## ADR-007 — Repository and tooling

- **Status:** Accepted (2026-11-04)
- **Decision:**
  - npm workspaces with three packages (`shared`, `server`, `extension`); the shared package holds the protocol and validation code used by both sides.
  - TypeScript strict, esbuild (server bundle, extension, .mcpb single file), vitest, Biome (lint + format).
  - The extension is plain TS + HTML (no UI framework).
  - *Addendum (T-001, 2026-11-04):* TypeScript 7.0.2 (native compiler) is used, since it was the current release. If a TS 7 incompatibility blocks a later task, pin `typescript@5.9` and record it here. Biome excludes `*.md`, so doc formatting stays hand-controlled.
  - *Addendum (T-004, 2026-11-04):*
    - **Extension bundling:** esbuild 0.28.2 bundles `background.js` (module service worker) and `popup.js` as ESM for `chrome116`. Its npm `postinstall` script is denied (`allowScripts.esbuild: false`); the platform binary comes from the `@esbuild/darwin-arm64` optional dependency and works without it.
    - **zod in the extension runs `jitless`:** zod v4 otherwise probes `new Function("")`, which MV3's CSP reports as an error on `chrome://extensions`. `src/csp.ts` must be the first import of every entry point, and a test enforces this.
    - **Stable ID:** a 2048-bit RSA public key in `manifest.json` `key`; ID `clipfeocpiljpcngmjpdbegciimchbol` in `packages/extension/EXTENSION_ID`. The private key is never written (not needed for unpacked loading or the Web Store, which is out of scope).
    - **Registry host rules (minor):** instance hosts are https, default port, no credentials, and not IP literals. Tab suggestions are deferred to T-010, because reading tab URLs needs `tabs` or `activeTab`, which T-004 does not add. Users paste the instance URL instead.
  - *Addendum (T-010, 2026-11-04, user-approved):* **`activeTab` is added** for tab suggestions; `tabs` is not. When the user opens the popup, it reads only that tab's URL and, if it looks like ServiceNow (`*.service-now.com`, `*.servicenowservices.com`, or a ServiceNow UI path such as `/now/…` or `*.do` for custom domains), offers to fill in the form. A suggestion never registers anything and never selects a target (FR-3.9). `activeTab` shows no install warning. With `scripting` it would also allow injecting into that tab; the popup never calls `chrome.scripting` or any `chrome.tabs` API other than `query({active, currentWindow})`, and a test enforces this.
- **Alternatives considered:**
  - pnpm: not needed for distribution.
  - WXT/CRXJS: more abstraction than needed.
  - ESLint + Prettier: two tools where Biome is one.

## ADR-008 — MCP TypeScript SDK v2

- **Status:** Accepted (2026-11-04). Compatibility is verified in T-009.
- **Decision:** `@modelcontextprotocol/server` v2 (2.4.0 at planning time, spec 2026-07-28, zod v4), using stdio transport.
- **Fallback:** if Claude Desktop protocol negotiation fails, use `@modelcontextprotocol/sdk` v1.x (1.32.2), which is still maintained, and record the change here.

- *Addendum (T-008, 2026-11-04):*
  - `@modelcontextprotocol/server@2.4.0` is used with `McpServer.registerTool(name, {inputSchema: z.strictObject(...), outputSchema, annotations}, cb)` and `StdioServerTransport` from `@modelcontextprotocol/server/stdio`.
  - Tests use `@modelcontextprotocol/client@2.4.0` (`InMemoryTransport.createLinkedPair`, `StdioClientTransport`).
  - **Confirmed in T-009:** SDK v2 works with Claude Desktop and Claude Code 2.1.317. No v1 fallback needed.

## ADR-009 — Skills strategy

- **Status:** Accepted (2026-11-04)
- **Decision:**
  - A custom `servicenow-readonly-troubleshooting` skill: guidance only, references loaded on demand, packaged as a Claude Code plugin and a Claude Desktop zip.
  - *Addendum (2026-11-05, user decision):* also ship the third-party `servicenow-development-guide` skill, for building work and product knowledge. It's copied and pinned to a commit rather than linked, so its text can't change unreviewed (it's loaded into Claude's context). Its code examples can write to ServiceNow, but only if a person runs them: the connector stays read-only.
  - *Addendum (2026-11-05): the official skill was dropped by the user (T-039). Replaced by the third-party development guide below.*
  - The official `ServiceNow/sdk` `now-sdk` skill is optional, Claude Code only, and limited to `explain` (offline, read-only docs). No `now-sdk auth`; `query` isn't used because it needs SDK credentials.
  - Deny rules block SDK `auth|init|build|install|deploy|transform|dependencies|download`.
  - Skills never become mandatory workflows.
- **Consequences:** Desktop users get only the custom skill, because the official skill needs a local CLI.

## ADR-010 — No persistent knowledge or memory subsystem

- **Status:** Accepted (2026-11-04, user decision)
- **Context:** Rev. 1 proposed PostgreSQL + pgvector + local embeddings for saved troubleshooting cases. The user removed it.
- **Decision:**
  - No knowledge database, schemas, embeddings, Docker Compose, or knowledge tools (`search_knowledge`, `save_knowledge_case`, `get_knowledge_case`, `update_knowledge_validation`).
  - No replacement either (no SQLite, JSON memory, or other persistence).
  - Continuity comes from native Claude conversation history and Projects.
- **Consequences:** reintroducing any persistent memory needs explicit user approval and a new ADR.

## ADR-011 — Retrieval efficiency without volume limits

- **Status:** Accepted (2026-11-04, user-directed revision)
- **Principle:** optimize *how* Claude retrieves information, not *how much* it may investigate.
- **Context:** ADR-006 and the ADR-005 cost guards put hard caps on investigation volume: max 100 rows (PROD 50), offset ≤2,000, ≤7-day windows on high-volume tables, 60/20 requests per minute, fan-out caps, a 400-line chunk limit. These would stop legitimate investigations, such as reading a year of `syslog` entries for one source, a whole 5,000-line script include, or every related record of a CI. Most of these caps did not protect anything that per-request safeguards don't already protect.
- **Decision:**
  1. **No caps on the total amount investigated.**
     - `limit` is the number of rows wanted, with no maximum.
     - Offsets have no ceiling, and queries have no time-window requirement.
     - Composite tools have no relation, table or history caps.
     - DEV and PROD get the same operational defaults. PROD stays stricter only for *authorization* (typed confirmation, short TTL, badge; ADR-003).
  2. **Per-request safeguards only**, enforced in the extension and configurable by the user (popup settings, globally or per instance; the MCP server cannot change them):
     - Request timeout: default 30 s.
     - Maximum raw response size per HTTP response: default 10 MB.
     - Maximum concurrent requests per instance: default 4. Extra requests **queue**; they are not rejected.
     - Upstream page size: at most 1,000 rows per HTTP request (wire limit).
     - ServiceNow's own `429`/transaction-quota responses map to `RATE_LIMITED`, with a retry hint.
     - There is no per-minute quota. Concurrency plus timeouts bound the load on the instance, and a quota can be added later only if live use shows a need (point 10).
  3. **Responses are shaped, not capped.**
     - Each tool result has a size budget: default 24k chars, configurable in the server. Claude may pass `max_chars` per call, up to a configurable ceiling (default 100k).
     - When more data exists, the response always carries a continuation.
     - The server pages upstream automatically (default 100 rows per request) until `limit` is reached or the budget is full. Claude never manages offsets.
     - If a response exceeds the byte cap, the server halves the page size and retries, down to 1 row.
     - A single record still over the cap is returned without its largest fields, each listed under `omitted` with a `get_field_content` call to fetch it.
  4. **No silent truncation (completeness contract).** Every result has `complete: true|false`. When it's false:
     - `page.has_more` and `next_cursor` say whether more rows exist. One extra row is fetched to detect this, so no count is needed.
     - Each `omitted[]` entry says what is missing (rows, field text, a relation, a table, a source that ACLs denied) and gives the exact tool call that retrieves it.
  5. **Complete content.** `get_field_content` can read any field in full:
     - Chunks are line windows, and lines longer than the budget are split by character offset (minified scripts, one-line payloads).
     - Each chunk reports `total_lines`, `total_chars`, the next position and `complete`.
     - To avoid refetching per chunk, the server keeps field content in a short-lived **in-process** cache: 10 min TTL, 64 MB LRU, keyed by instance, table, sys_id and field; `refresh: true` bypasses it. This is transient memory, not persistence, so ADR-010 is unaffected.
  6. **Intelligent retrieval over restriction.**
     - Default projection, previews of long fields (1,000 chars, configurable).
     - Structured filters, `aggregate_records` for counts and distributions, `sysparm_no_count` by default.
     - On configured high-volume tables, a default order of `ORDERBYDESCsys_created_on` (indexed) plus hints that suggest filters or aggregates.
     - Hints advise; they never reject a query.
  7. **Cursors** are HMAC-signed and bind table, query, fields, order and *instance* (not scope ID). After a PROD grant expires and the user re-approves, pagination continues with the new scope, and every request still needs a valid scope for that instance. Ordering always ends with a `sys_id` tiebreak.
- **Still fixed (validation, not volume):**
  - Encoded query ≤2 KB, ≤20 terms, ≤3 `^NQ` groups, ≤100 `IN` items, ≤50 named fields (`["*"]` is allowed), dot-walk ≤3. *(T-047 raised the query bounds to 8,000 characters, 100 terms, 10 groups and 1,000 `IN` items; see the ADR-005 addendum.)*
  - These bound the size of one query and its URL, not the amount of data. Larger needs are split across queries.
- **Removed:** `QUERY_TOO_BROAD`, `BUDGET_EXCEEDED` (replaced by `RATE_LIMITED`), PROD row limits, the offset ceiling, the `fields:["*"]` limit of 10, the no-condition limit of 20, fan-out caps, the 30 s dedup.
- **Consequences:**
  - Large investigations take several tool calls, each bounded in size and time, and Claude always knows how to continue.
  - Deep offset pages on very large tables can be slow. The per-request timeout protects the instance, and the timeout hint suggests narrowing the order or range. Keyset pagination is a possible later optimization if live use shows a need.
  - Offset pagination over data that changes during the walk can skip or repeat rows. Each page reports `retrieved_at`.


- *Addendum (T-023, 2026-11-04): ACL-hidden rows and paging.* ServiceNow applies row-level ACLs after windowing (`sysparm_offset` counts rows before ACL filtering), so short or empty pages don't prove the end. The paginator counts a short window as read and, after a short or empty page, uses the total count (which includes hidden rows) to decide whether to skip a fully hidden window. **To verify live in T-034:** that `sysparm_offset` counts pre-ACL rows. If it counts post-ACL rows, advancing by the window would skip readable rows, and the window advance must change to rows received. Accepted cost: one extra request (a count) at the end of a read.
## ADR-012 — Role-agnostic connector

- **Status:** Accepted (2026-11-04, user-directed)
- **Context:** T-022 planned an optional evaluation of a dedicated `admin + snc_read_only` ServiceNow user as extra hardening. That ties the design to a specific ServiceNow role and adds account-management steps the connector shouldn't own.
- **Decision:**
  - **ServiceNow determines what the user can access. The connector determines what Claude is allowed to do.**
  - The connector uses the currently signed-in browser session and respects that user's roles, ACLs and permissions. It never requires, assigns, validates or manages any ServiceNow role.
  - No dedicated read-only accounts, authentication flows or impersonation features. Users may sign in with a read-only account, or use ServiceNow's native impersonation, on their own.
  - Read-only enforcement is entirely independent of roles: closed tool set, GET-only templates, validation, denylist, and grants enforced in the extension. An admin session gives Claude no way to mutate anything.
  - Access-denied and insufficient-permission responses become clear errors (`ACL_DENIED` with an explanatory hint).
  - A session change is handled by the existing session lifecycle (T-013): token re-read on `401`, `SESSION_EXPIRED` and token cleared for that instance only.
- **Consequences:**
  - T-022's `snc_read_only` evaluation and its acceptance criterion are removed; its general read-only tests stay.
  - PRODUCT_SPEC S-10, ARCHITECTURE §9 item 6 and SECURITY.md §5a are rewritten accordingly.
  - Don't add replacement authentication features.

## ADR-013 — Compare within one instance, and record versions

- **Status:** Accepted (2026-11-05). Requested by the user. The version format was corrected after live runs (T-042, below).
- **Context:** The user wants to compare two records, or two versions of a record, on one instance. `compare_records` refused single-instance scopes, and `tools/list` has a 12,000-byte limit, with 175 bytes left.
- **Decision:**
  - A single-instance scope reads both sides from its one instance, and `match_b` is required. A record compared with itself is `INVALID_INPUT`, not `identical: true`. The extension, shared rules and grants are unchanged, so a single scope can't reach another instance, and comparing two instances still needs a compare grant the user approved.
  - Versions get **no new input and no new tool**: `compare_records` on two `sys_update_version` rows. That table's `payload` is compared element by element when both sides parse.
  - The reader in `update-payload.ts` is small and hand-written, for one shape only, so there's no new dependency. Anything else falls back to a raw text diff with a hint: never a guess, never an error. It refuses DTDs and decodes only the standard entities.
  - **No guard on payloads (user's decision).** Field-level credential protection doesn't look inside them, whether raw or by element. Filtering elements by name would suggest a protection that the raw read doesn't have.
- **Consequences:**
  - `tools/list` is 11,938 bytes, with 62 bytes left.
  - The task said to confirm the real fields and format live first. This was built first instead, because the live test is the user's, later. The first live run confirmed it for one script include (`mode: elements`, no assumed field missing). The second met a `sys_script` pair where one payload didn't parse, and the fallback worked: a less readable diff, not a wrong one.
  - **"One record" was wrong (third live run).** 21 of 25 pairs fell back to raw text, because a payload often holds other records after the main one (`sys_translated_text`, `sys_es_latest_script`). The main record is now the only one, or the one the root's `table` attribute names; with no way to tell, it's still raw text, never a guess. The others stay in the comparison as whole XML, so nothing is dropped. The fourth live run read all 9 pairs it checked by element.
  - Finding the versions takes a `query_records` call first.

## ADR-014 — ChatGPT Desktop as a local STDIO client

- **Status:** Accepted (2026-11-05). Requested by the user, including "no remote hosting, tunnels, or additional MCP transports".
- **Context:** ChatGPT Desktop's settings can register a local server over STDIO. The app bundles the Codex engine and shares its `~/.codex/config.toml` format. OpenAI's help for ChatGPT on the web says it only connects to remote servers; that doesn't apply to this path.
- **Decision:**
  - Same server entry as Claude Code (`packages/server/dist/bin/mcp-server.js`), with `SN_MCP_CLIENT_NAME=ChatGPT Desktop`. No code path depends on the client.
  - `npm run setup` prints the exact values. The command is an absolute Node path, since desktop apps don't get the shell's PATH, using the PATH entry where one exists, because Homebrew's resolved path names the version.
  - Timeouts of 30 s and 360 s where they can be set (`config.toml`): the engine's 60 s tool default is shorter than a long paged read.
  - The extension's wording says "AI assistant", not "Claude". The label stays self-reported display text; authorization is by per-process client key, as before.
  - This registers no model provider and adds no chat or backend, so rule 10 is unaffected.
- **Consequences:** **Only Codex chats can use it (the user's test, 2026-11-05).** In the same app, a normal chat with the server registered said it had no such connection, and the engine's logs and the broker saw nothing from it. OpenAI's docs don't describe this split, so it may change. The engine runs one server process per conversation, so each conversation needs its own approval, which is stricter, not looser. Live testing can use the app's own engine through `app-server`, without a model or a sign-in. Skills are installed separately for Codex, by copying them to `~/.agents/skills` (T-045). They're the same files as for Claude. A skill that already exists under that name is replaced only if it really is that skill.

## ADR-015 — Windows support

- **Status:** Accepted (2026-11-05), requested by the user. Passes in Windows CI; **never run on a real PC with real Chrome** (T-044 is BLOCKED).
- **Context:** The broker's protection relies on a 0700 folder, a 0600 socket file and owner checks, none of which exist on Windows.
- **Decision:** Same broker, handshake and protocol, with these replacements:
  - **Endpoint:** a named pipe named from a hash of the runtime folder. Node can't set a pipe's DACL, so the Windows default applies: full control for the creator, SYSTEM and administrators, read for others. A process can only use the pipe with write access, and it must then pass the mutual HMAC proof, whose key is in the protected folder. An impostor pipe learns only the `hello` metadata, as on macOS; libuv's first-instance flag makes the broker's own listen fail rather than share a name.
  - **Runtime folder:** `%USERPROFILE%\AppData\Local\sn-mcp`, from the home folder rather than `%LOCALAPPDATA%`, because Chrome and AI clients pass different environments. `icacls` resets the folder and its contents, then limits it to the current user's SID, at every start, failing closed (exit 78). Without the reset, entries set directly on the folder stayed (found in CI). It enforces rather than checks, and SIDs avoid localized names.
  - **Install safety:** every folder above the node, host, wrapper and manifest paths is read through PowerShell's `Get-Acl`, by SID. Write access for anyone but the user, SYSTEM, administrators and TrustedInstaller refuses the install, the same rule as macOS. So does a failed check, or a folder with no answer. PowerShell runs without the inherited `PSModulePath`, which breaks `Get-Acl` when started from PowerShell 7. The drive root is skipped.
  - **Chrome:** `native-host.cmd` plus `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.snmcp.bridge`, for this user only.
- **Consequences:** A clone in `C:\src` or a Node in a shared tools folder is refused, since they inherit "Authenticated Users: Modify" from `C:\`. The code stays in the home folder, as on macOS. Chrome only; Edge has a separate registry path.

## ADR-016 — Mistral Vibe as a local STDIO client

- **Status:** Accepted (2026-11-05), requested by the user. Tested on Vibe 3.1.0, on a Mac, with a scripted model and in one real run with Mistral Medium 3.5 (T-046).
- **Context:** Vibe supports STDIO servers, but differs from the other clients in ways that matter here, all read from its installed source and measured on the real binary:
  - It doesn't pass the server's `instructions` to its model. Rule 7's warning and the approval steps would be missing.
  - Its model doesn't get MCP tools directly. It finds them with `search_tool_functions` and calls `tools.mcp_sn_mcp.<name>()` from TypeScript in `run_typescript`.
  - It keeps one server process per Vibe process, shared by that process's sessions, so a scope lasts between turns.
  - A large result is saved whole to a private file, and the model is told where. Rule 8 holds: nothing is cut without saying so.
- **Decision:**
  - Same server entry, with `SN_MCP_CLIENT_NAME=Mistral Vibe`. No code path depends on the client, and the server, broker and extension are unchanged.
  - `npm run setup` prints a `config.toml` block rather than a `vibe mcp add` command, because `vibe mcp add` can't set `prompt`.
  - `prompt` holds the text of `INSTRUCTIONS`. Vibe gives it to the model as connector guidance when it searches for tools.
  - `command` is an array, because Vibe splits a string on spaces. Timeouts of 30 s and 360 s, as in ADR-014.
  - We don't set Vibe's per-tool `permission = "always"`. Whether Vibe asks before a tool is the user's choice, and it never replaces the popup (rule 4).
  - This registers no model provider. The local model in `test/e2e/vibe-client.ts` is a test script and isn't shipped, so rule 10 is unaffected.
- **Consequences:** `prompt` is a copy, so it goes stale until the user replaces the block after an update. Each Vibe tool call asks for permission by default, including `claim_scope` while polling. `vibe -p` shows only the final answer, so it can't show the approval code in time; interactive sessions are the supported use. Tool results go to whichever model Vibe uses and stay in its session files, as with any client's transcripts. Vibe is young and changes quickly, and this relies on its current behaviour, so re-run `npm run e2e:vibe` after upgrading it. In the one real run the model didn't show the approval code, despite being told to, so the user couldn't match it. Server 0.1.7 and the popup address this, and in one retest the model showed the code and waited (T-046). In that first run it also released its access straight after answering, which it didn't do in the retest.

## ADR-017 — Tool definitions: real client limits, not a size budget

- **Status:** Accepted (2026-11-06), requested by the user (T-048). Supersedes the 12 KB `tools/list` criterion of T-033.
- **Context:** T-033 set a 12,000-byte budget for the whole `tools/list`. It was our own target to save context, not a client requirement. To meet it, input schemas were published as untyped stubs (`where` as "array of objects"), descriptions were cut to one line, and the result type was `{ok}` only. Vibe's model saw `where?: Array<Record<string, unknown>>`. Each new tool or input needed a cut elsewhere (62 bytes were left).
- **What the supported clients actually do** (measured on 2026-11-06, with real binaries in a Linux container):
  - **Codex engine** (codex-cli 0.166.0-alpha.6, the version in the user's ChatGPT Desktop): passes MCP schemas to the model nearly unchanged (`strict: false`), except that **a tool input schema over about 5,000 bytes loses every description and nested type**. A stub server kept 4,984 bytes intact and simplified about 5,100. The fully expanded filter schema (11.8 KB for `query_records`) reached the model as `where: anyOf [{}, {}]` with no descriptions: less than the old stub.
  - **Claude Code** 2.1.318: passes a tool description, and the server instructions, to the model up to 4,096 characters (16,384 once loaded through tool search), from its own source.
  - **Vibe** 3.1.0: passes the schema through and renders it as a TypeScript declaration for its model, result type included.
  - Model APIs take tool names of at most 64 characters, and clients add a prefix.
  - Tuples (`prefixItems`, `items: false`) and `propertyNames` are rejected or unsupported by some model APIs; `anyOf`, `enum` and `pattern` were already published and work live in every client.
- **Decision:**
  - No size budget. Tests check the limits above instead: each description and the instructions ≤ 4,096 characters; each input schema ≤ 4,500 bytes (a margin under Codex's ~5,000); names ≤ 64 with the longest prefix; only portable keywords, every array typed. A 256 KB ceiling only catches an accidental blow-up.
  - Inputs are published as the schema that validates them, with descriptions. Pairs are 2-item arrays, not tuples; `{field: value}` objects check their keys by refinement, not `propertyNames`.
  - `where` is published in a compact, faithful form: one condition shape with every operator, every value type and the relative-date units. The per-operator value rules are in `query_records`' description, which no client limits below 4,096 characters. `any_of` is published as lists shaped like `where`. Validation is still the strict per-operator schema, and a test checks that the published form accepts everything the strict one does, unchanged.
  - The result envelope publishes its shared fields (`data`, `complete`, `omitted`, `page`, `hints`, `error`), all optional except `ok`, so every result validates.
- **Consequences:** `tools/list` is about 34 KB (was 12 KB), roughly 8,000 more tokens when a client loads every tool at once; Claude Code can load them on demand. A new tool needs no cut elsewhere. A filter's per-operator rules are prose, not types, because of Codex's limit. Codex and Vibe were checked with real binaries but not in the user's apps or with a real model; Claude Desktop and Claude Code weren't run with these schemas yet (T-048). Nothing about access, read-only enforcement or query validation changed.
