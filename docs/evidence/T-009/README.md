# T-009 evidence — PoC end to end (2026-11-04)

**Chain:** Claude (Desktop chat and a Claude Code session) → `sn-mcp` MCP server (stdio) → native broker (Unix socket, HMAC-authenticated) → Chrome extension (user's Chrome 156) → `dev469966.service-now.com` Table API.

All components were real; no mocks were used.

## Files

- `check-capture.txt`: output of `npm run check-capture -w @sn-mcp/server` on the broker capture (`SN_MCP_CAPTURE=metadata+bodies-redacted`).
- `broker-log-excerpt.jsonl`: broker log from 18:26 UTC onward. It holds metadata only: request kinds, result codes, durations, and 8-character client prefixes.
- `claude-desktop-chat.md`: the Desktop chat's final answer, as pasted by the user.

## Claude Desktop chat (≈18:26–18:27 UTC)

1. The user pasted the T-009 prompt into a Desktop chat.
2. Claude called `list_instances`, then `request_scope`.
3. The user approved the code in the popup.
4. Claude called `claim_scope`, then `query_records` on `incident` with limit 1.
5. Result: `INC0000060` "Unable to connect to email", state Closed (`7`), `sys_updated_on` 2016-12-14 02:46:44 UTC.
6. Provenance: `dev` / `dev469966.service-now.com` / env `dev`, scope `…prFA`, retrieved 18:27:10 UTC, 1 of 67, `complete:false` (PoC limit).
7. Broker: `scope.request` at 18:26:37, `sn.op` at 18:27:09 → OK in 620 ms. Client `Claude Desktop` (key `31260728…`).

## Claude Code session (18:27:58–18:28:39 UTC)

This was a new Code session in the Claude Desktop app (Claude Code 2.1.317, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`), in the `AssistMe` folder. Summary of its tool calls, read from the session transcript:

| Time (UTC) | Call | Result |
| --- | --- | --- |
| 18:28:03 | `list_instances` | `dev` (dev469966.service-now.com, env dev) |
| 18:28:06 | `request_scope {instance: dev, purpose: "T-009 PoC"}` | approval code `4RH4-2P`, pending, 300 s |
| 18:28:25 | (user replied "approved" after approving the code in the popup) | |
| 18:28:28 | `claim_scope` | approved; scope `…3IuA` for `dev` until 22:28:15 UTC |
| 18:28:31 | `query_records {table: incident, limit: 1, fields: number, short_description, state, sys_updated_on}` | `INC0000060`, provenance `dev` / `dev469966.service-now.com` / `dev` / scope `…3IuA` / retrieved 18:28:32 UTC |

Broker: `scope.request` at 18:28:06, `sn.op` at 18:28:31 → OK in 550 ms.

## Finding: Code sessions in the Desktop app share the Desktop's MCP server

Both runs were served by the same `sn-mcp` process: pid 92984, started by Claude Desktop from `claude_desktop_config.json`, client name "Claude Desktop", client key `31260728…`.

- The project `.mcp.json` server (client name "Claude Code") was also started by the Code sessions, but it never received a call.
- A further `list_instances` from another Code session went to the same Desktop process and reported `active_access: true`.

**Consequences:**

1. **Shared client identity.** In the Desktop app, every conversation (chat and Code) shares one client identity, and so one `client_key_id`.
   - Each conversation still got its own approval code and its own `scope_id`, and the scope id remains the per-conversation bearer handle (ARCHITECTURE §5.5).
   - The popup labels every grant "Claude Desktop", even the one approved for the Code session.
2. **Misleading field name.** `list_instances.this_session` really means "this MCP server process", not "this conversation".
3. **Standalone CLI not covered.** A standalone Claude Code CLI (its own process, registered with `claude mcp add`) was not exercised: the bundled CLI was not logged in on its own. Its server would get its own client identity.

These points are recorded for T-011, T-012 and T-015.

## Capture

The capture was taken during both runs: 149 frames in all four directions, 2 successful `sn.op` (HTTP 200) responses, and no `Cookie`, `JSESSIONID`, `glide_`, `g_ck` or `X-UserToken` in any raw frame.

**Exact session-token check:** the user ran it in their own terminal, with the active `g_ck` (the user reported no re-login since the runs) taken from the clipboard and never shown. Result: `Session token value check: performed` → PASS (152 frames).

Afterwards, capture was disabled (reinstalled without `--capture`), the capture file was deleted, and the project `.mcp.json` was removed.
