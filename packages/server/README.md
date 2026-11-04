# @sn-mcp/server

The local MCP server (from T-008) and the native-messaging host / broker (T-006).

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
