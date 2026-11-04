# @sn-mcp/extension

Chrome MV3 extension: the ServiceNow session bridge, user-managed instance registry and (from
T-007/T-011) the approval UI. It is the policy enforcement point (ARCHITECTURE §2).

## Build

```bash
npm run build -w @sn-mcp/extension
```

This type-checks and bundles into `packages/extension/dist/` (esbuild).

## Load unpacked in Chrome

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose `packages/extension/dist`.
3. Check that the card shows **ID `clipfeocpiljpcngmjpdbegciimchbol`**, the same as `EXTENSION_ID`,
   and that there is no red **Errors** button.
4. Pin the extension and open its popup.

After rebuilding, press the reload icon on the extension card.

## Register an instance

Paste the instance URL (for example `https://dev12345.service-now.com`), choose an alias and an
environment, and click **Register**. Chrome asks for access to **that one host only**. If you
decline, nothing is saved. **Remove** deletes the entry and revokes the host permission.

Unclassified instances are treated as PROD. The active tab is never used to pick a target.

## Permissions

`storage`, `scripting`, `nativeMessaging`, `notifications`, plus optional `https://*/*`, from
which only exact registered hosts are ever requested. There is no `cookies` permission, no
`externally_connectable`, no content scripts and no web-accessible resources. The manifest unit
test (`test/manifest.test.ts`) enforces this set.

## Stable ID

`manifest.json` carries a public `key`, so the ID is the same on every machine. It was made with:

```bash
npm run gen-key -w @sn-mcp/extension
```

The private key is never written to disk; an unpacked extension does not need it. The script
refuses to replace an existing key without `--force`, because a new ID breaks the native
messaging host's `allowed_origins`.
