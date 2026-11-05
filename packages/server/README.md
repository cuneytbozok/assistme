# @sn-mcp/server

The local MCP server (from T-008) and the native-messaging host / broker (T-006).

## MCP server (stdio)

```bash
npm run build
node packages/server/dist/bin/mcp-server.js   # speaks MCP on stdin/stdout
```

It needs the native host to be installed and Chrome to be running with the extension (see below). Without them, every bridge-backed tool returns `BRIDGE_UNAVAILABLE` within about 2 seconds.

### Tools

The full contracts are in [docs/TOOLS.md](../../docs/TOOLS.md). All tools are read-only, and none accepts a URL, method or header.

### Registering with Claude

Use absolute paths. Node must be the same one the native host uses; `which node` shows it. After a Node upgrade, re-run `npm run install-native-host`.

**Claude Desktop:** add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then fully quit and reopen Claude Desktop (Cmd+Q):

```json
{
  "mcpServers": {
    "sn-mcp": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/ABSOLUTE/PATH/AssistMe/packages/server/dist/bin/mcp-server.js"],
      "env": { "SN_MCP_CLIENT_NAME": "Claude Desktop" }
    }
  }
}
```

**Code sessions inside the Claude Desktop app** use the server from the Desktop config above; they need nothing extra. All conversations in the app share that one server process, so the approval popup labels their requests "Claude Desktop". Each conversation still gets its own approval code and `scope_id` (T-009 evidence).

**Claude Code CLI (standalone):**

```bash
claude mcp add --scope user sn-mcp --env SN_MCP_CLIENT_NAME="Claude Code" -- node /ABSOLUTE/PATH/AssistMe/packages/server/dist/bin/mcp-server.js
```

`SN_MCP_CLIENT_NAME` sets the client name the approval popup shows.

### Traffic capture (dev only)

Turn capture on:

```bash
npm run install-native-host -- --capture   # then restart the host (reload the extension)
npm run check-capture -w @sn-mcp/server
```

`--capture` writes `broker.capture.jsonl` (0600) next to the socket. Each frame is stored with record values, handshake proofs and scope/request IDs redacted, plus credential-pattern findings and hashes of long strings.

To prove that a specific session token never crossed the bridge, without the token being printed or stored:

1. In the ServiceNow tab, open DevTools and run `copy(g_ck)`.
2. Run:

   ```bash
   SN_MCP_TOKEN="$(pbpaste)" npm run check-capture -w @sn-mcp/server
   ```

Turn capture off with `npm run install-native-host` (no `--capture`), then delete the capture file.

## Native host

```bash
npm run build
npm run install-native-host -- --dry-run   # show what would be written
npm run install-native-host                # install for Chrome
npm run install-native-host -- --uninstall
```

The install writes:

- **Wrapper:** `~/Library/Application Support/sn-mcp/host/native-host`. It contains the resolved Node path, so re-run the installer after upgrading Node.
- **Chrome manifest:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.snmcp.bridge.json`. Its only allowed origin is the extension `clipfeocpiljpcngmjpdbegciimchbol`.

After installing, reload the extension on `chrome://extensions`. Its popup should show **Bridge: connected to the local broker**.

### Runtime files

These are in `~/Library/Application Support/sn-mcp/`, a 0700 directory:

| File | Mode | Purpose |
| --- | --- | --- |
| `broker.sock` | 0600 | The broker's socket |
| `broker.key` | 0600 | Authentication key, regenerated on every broker start |
| `broker.pid` | — | Lock file |
| `broker.log` | 0600 | Metadata only (no message contents) |

## Dev client (T-007 live check)

`dev-client` exercises the bridge the same way the MCP server will. It needs the host installed, the extension connected, a registered instance, and an open, logged-in tab of that instance.

```bash
npm run build
npm run dev-client -w @sn-mcp/server -- --instance dev --table incident
```

What it does:

1. Prints an approval code. Approve that code in the extension popup.
2. Claims the scope.
3. Runs `table.list` with limit 1, and prints only the status, counts and the first record's number.
4. Checks that an unknown scope is refused.
5. Releases the scope.
