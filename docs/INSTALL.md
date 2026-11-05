# Installing sn-mcp

sn-mcp lets Claude read your ServiceNow instances through your own Chrome session. It has three parts: a Chrome extension, a small native host that Chrome starts, and an MCP server that Claude runs. It only reads, and it reaches an instance only after you approve a request in the extension.

## Requirements

- macOS
- Google Chrome
- Node.js 22 or newer (`node --version`)
- A ServiceNow instance you can sign in to
- Claude Desktop or Claude Code

You don't need any API key, corporate credential or Docker.

## 1. Run the setup

```bash
git clone <this repository> AssistMe
```

```bash
cd AssistMe
```

```bash
npm install
```

```bash
npm run setup
```

Setup checks your Node version, builds everything, and installs the native host for Chrome. You can run it again at any time. When it finishes, it prints the exact paths and commands for your machine.

## 2. Load the Chrome extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `packages/extension/dist`.
3. Check that the ID is `clipfeocpiljpcngmjpdbegciimchbol` and there is no red **Errors** button.
4. Pin the extension to the toolbar.

## 3. Register an instance

1. Sign in to your instance in a Chrome tab.
2. Open the extension popup and add the instance: paste its URL, choose an alias, and pick an environment. Chrome asks for access to that one host.

Use **Other** for anything that isn't clearly development or test. It always gets production rules: shorter access, and you type the host name to approve.

## 4. Connect Claude

Choose one, or both.

### Claude Desktop

Build the bundle:

```bash
npm run pack:mcpb
```

In Claude Desktop, open **Settings → Extensions → Advanced → Install Extension** and choose `packages/server/sn-mcp.mcpb`.

If you registered sn-mcp by hand in `claude_desktop_config.json` during development, remove that entry so the tools don't appear twice.

To change result sizes, open the extension's settings in Claude Desktop. The defaults suit most uses.

### Claude Code

For all your projects (use the absolute path that setup printed):

```bash
claude mcp add --scope user sn-mcp --env SN_MCP_CLIENT_NAME="Claude Code" -- node /ABSOLUTE/PATH/TO/AssistMe/packages/server/dist/bin/mcp-server.js
```

For one project, copy `.mcp.json.example` to `.mcp.json` in that project and put in the absolute path. `.mcp.json` is ignored by git here.

Start a new session and run `/mcp`: `sn-mcp` should be listed.

Code sessions inside the Claude Desktop app use the Claude Desktop connector and need nothing extra.

## 5. Try it

Ask Claude:

> List my ServiceNow instances, then show me the five most recent incidents on dev.

Claude requests access and gives you a code. Open the extension popup, check that the code matches, and approve it. Access ends when it expires, when you revoke it in the popup, or when Chrome restarts.

## Optional: the troubleshooting skill

The skill gives Claude a method for investigating ServiceNow problems. It adds no access and can't change anything. See [SKILLS.md](SKILLS.md).

## Settings

**In the extension popup** (only you can change these): request timeout (30 s), maximum response per request (10 MB), and concurrent requests per instance (4).

**Server environment variables** (or the Claude Desktop extension settings): `SN_MCP_RESPONSE_CHARS`, `SN_MCP_MAX_RESPONSE_CHARS`, `SN_MCP_PAGE_SIZE`, `SN_MCP_FIELD_PREVIEW_CHARS`, `SN_MCP_FIELD_CACHE_MB`, `SN_MCP_FIELD_CACHE_TTL_S`, `SN_MCP_HIGH_VOLUME_TABLES`, `SN_MCP_DENIED_TABLES`. See [TOOLS.md](TOOLS.md#limits). They shape responses or block more tables. None can widen access.

## Updating

```bash
git pull
```

```bash
npm install
```

```bash
npm run setup
```

Then reload the extension on `chrome://extensions`, and restart Claude. For Claude Desktop, also run `npm run pack:mcpb` and install the new bundle.

After upgrading Node, run `npm run setup` again: the native host records which Node to use.

## Uninstalling

```bash
npm run uninstall
```

This stops the native host and removes its Chrome manifest, program files, socket, key and logs. It then lists what's left for you to remove, because only you can: the extension (on `chrome://extensions`) and the Claude registration.

## Troubleshooting

Logs are in `~/Library/Application Support/sn-mcp/broker.log`. They hold metadata only, never record content or credentials.

| What you see | What it means | What to do |
| ------------ | ------------- | ---------- |
| The popup says the host is not found, or `BRIDGE_UNAVAILABLE` | Chrome can't start the native host | Run `npm run setup`, then reload the extension. Check that Chrome is open and the extension is on |
| `BROKER_CONFLICT` | The connector is active in another Chrome profile | Use one Chrome profile at a time. Close the other one, or turn the extension off there |
| "Refusing to install" during setup | A folder on the path can be written by another user | Fix that folder's permissions, or keep the repository somewhere else, such as your home folder |
| `SESSION_EXPIRED` | Your ServiceNow session ended | Sign in again in Chrome. Your approved access still works afterwards |
| `NO_INSTANCE_TAB` | No tab of that instance is open | Open the instance in Chrome and sign in |
| `SCOPE_UNKNOWN` or `SCOPE_EXPIRED` | Access was revoked, it expired, or Chrome or Claude restarted | Ask Claude to request access again and approve the new code |
| `ACL_DENIED` | Your ServiceNow user can't read this | Ask a ServiceNow admin, or sign in with an account that can. If it mentions table definitions, the connector needs read access to `sys_db_object` and `sys_dictionary` |
| `TIMEOUT` | ServiceNow took too long | Ask Claude to narrow the query, or raise the timeout in the extension settings |
| `RESPONSE_TOO_LARGE` | One value is larger than the per-request limit | Raise "Max response" in the extension settings |
| Tools are missing or out of date in Claude | Claude is running an old build | Fully quit and reopen Claude Desktop (Cmd+Q), or start a new Claude Code session |
| The extension shows a different ID | It was loaded from another folder or build | Remove it, and load `packages/extension/dist` again |
| Chrome shows a sign-in dialog for ServiceNow | Not expected | Please report it with the instance type (`docs/DECISIONS.md`, ADR-002 addendum, has the fallback) |

Every error also has an entry in the [error catalog](TOOLS.md#error-catalog).
