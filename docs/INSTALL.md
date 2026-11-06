# Installing sn-mcp

sn-mcp lets Claude, ChatGPT Desktop or Mistral Vibe read your ServiceNow instances through your own Chrome session. It has three parts: a Chrome extension, a small native host that Chrome starts, and an MCP server that your AI client runs. It only reads, and it reaches an instance only after you approve a request in the extension.

## Requirements

- macOS, or Windows, which passes automated tests but **hasn't been tried on a real PC yet**: see [Windows](#windows)
- Google Chrome
- Node.js 22.18 or newer (`node --version`)
- A ServiceNow instance you can sign in to
- Claude Desktop, Claude Code, ChatGPT Desktop or Mistral Vibe

You don't need any API key, corporate credential or Docker.

## 1. Run the setup

If you already have the project folder, skip the clone. Keep it somewhere private to you, such as your home folder: setup refuses folders other users can write to, such as `/tmp`.

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

## 4. Connect your AI client

Choose any of these.

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

Code sessions inside the Claude Desktop app use the Claude Desktop connector and need nothing extra. Don't also register it with `claude mcp add` if you use those sessions: they'd see two connectors, and access approved through one doesn't work with the other.

### ChatGPT Desktop

ChatGPT Desktop starts the same local server over STDIO, with no remote hosting or tunnel. `npm run setup` prints these values with the real paths for your machine.

In **Settings → MCP servers**, add a server:

| Field | Value |
| ----- | ----- |
| Name | `sn-mcp` |
| Type | STDIO |
| Command | Absolute path of Node, such as `/opt/homebrew/opt/node@24/bin/node`. Plain `node` may not be found, because desktop apps don't get your shell's PATH |
| Arguments | `/ABSOLUTE/PATH/TO/AssistMe/packages/server/dist/bin/mcp-server.js` |
| Environment variable | `SN_MCP_CLIENT_NAME` = `ChatGPT Desktop` |
| Working directory | `/ABSOLUTE/PATH/TO/AssistMe` |

Save, then restart ChatGPT Desktop.

**Use a Codex chat.** The tools work in the app's Codex chats, not in its normal chats: a normal chat doesn't start local servers, and it will say it can't find your instances.

If you'd rather edit `~/.codex/config.toml`, setup prints a block for that too. It also sets longer timeouts, so a long read of many pages isn't cut off.

Each client has its own access: what you approve for ChatGPT doesn't work in Claude, and the other way round. Each ChatGPT conversation also has its own, so a new conversation asks for a new approval. The popup shows which client is asking. To add the optional skills to Codex chats, run `npm run codex-skills`: see [SKILLS.md](SKILLS.md#in-codex).

### Mistral Vibe

Vibe starts the same local server over STDIO. `npm run setup` prints a block with the real paths for your machine. Add it to the end of `~/.vibe/config.toml`, then start a new `vibe` session:

```toml
[[mcp_servers]]
name = "sn-mcp"
transport = "stdio"
command = ["/ABSOLUTE/PATH/TO/node"]
args = ["/ABSOLUTE/PATH/TO/AssistMe/packages/server/dist/bin/mcp-server.js"]
cwd = "/ABSOLUTE/PATH/TO/AssistMe"
startup_timeout_sec = 30
tool_timeout_sec = 360
prompt = "(setup prints the text)"

[mcp_servers.env]
SN_MCP_CLIENT_NAME = "Mistral Vibe"
```

Use the block from setup rather than `vibe mcp add`. That command can't set `prompt`, and Vibe doesn't pass the server's own instructions to its model, so `prompt` is how the model learns the approval steps and that ServiceNow content is untrusted. That text can change when the project does, so after updating, replace the old `sn-mcp` block with the new one.

To remove it, run `vibe mcp remove sn-mcp`. That leaves a line reading `mcp_servers = []`. If you add the block again later, delete that line first: the file isn't valid with both.

Tested with Vibe 3.1.0 on a Mac. Some things work differently here:

- **Two different approvals.** Vibe asks before it runs each tool, including the ones that only read. That prompt controls what Vibe may run. It doesn't give access to an instance: only the popup does that, so choosing "always allow" in Vibe doesn't skip it. While the model waits for your approval it calls `claim_scope` repeatedly, so that tool is the one most worth allowing.
- **Check you can see the code.** A model may not show the approval code, even though it's told to: this happened in a real run. If a request appears in the popup with no code in Vibe, ask Vibe for the code and compare before approving, or deny it.
- **Use an interactive session.** The model has to show you the approval code and wait. In `vibe -p`, you see only the final answer, and the access ends when that run ends.
- **Each `vibe` you start has its own access**, which ends when you exit it. So `vibe --continue` asks for a new approval. Sessions served by one Vibe process, as in an editor using `vibe-acp`, share one connection, as conversations in Claude Desktop do.
- **Where your data goes.** What the tools return goes to the model Vibe is set to use, which is Mistral's service unless you've set up another. Vibe also keeps it in its session files under `~/.vibe/logs/session`, readable only by you, so that a large result can be read back from a file there.

To add the optional skills to Vibe, run `npm run codex-skills`: see [SKILLS.md](SKILLS.md#in-mistral-vibe).

## 5. Try it

Ask your AI client:

> List my ServiceNow instances, then show me the five most recent incidents on dev.

It requests access and gives you a code. Open the extension popup, check that the code matches, and approve it. Access ends when it expires, when you revoke it in the popup, or when Chrome restarts.

## Optional: the troubleshooting skill

The skill gives your AI client a method for investigating ServiceNow problems. It adds no access and can't change anything. See [SKILLS.md](SKILLS.md).

## Settings

**In the extension popup** (only you can change these): request timeout (30 s), maximum response per request (10 MB), and concurrent requests per instance (4).

**Server environment variables** (or the Claude Desktop extension settings): `SN_MCP_RESPONSE_CHARS`, `SN_MCP_MAX_RESPONSE_CHARS`, `SN_MCP_PAGE_SIZE`, `SN_MCP_FIELD_PREVIEW_CHARS`, `SN_MCP_DOCS`, `SN_MCP_DOCS_TIMEOUT_S`, `SN_MCP_FIELD_CACHE_MB`, `SN_MCP_FIELD_CACHE_TTL_S`, `SN_MCP_HIGH_VOLUME_TABLES`, `SN_MCP_DENIED_TABLES`. See [TOOLS.md](TOOLS.md#limits). They shape responses or block more tables. None can widen access.

**Documentation research (optional, off by default):** adds `docs_search` and `docs_read` for ServiceNow's published documentation. In Claude Desktop, turn on **Documentation research** in Claude Desktop's settings for this extension (not the Chrome popup), then restart it. Elsewhere, set `SN_MCP_DOCS` = `1` in the server's environment. There's no key or download. Search terms are sent to gitmcp.io and GitHub. It's a free community service with no guarantee, so search can be slow or unavailable; nothing else depends on it. **Documentation time limit** (`SN_MCP_DOCS_TIMEOUT_S`, 55 seconds by default, 5 to 600) sets how long one call may take before the AI is told it's unavailable and carries on. Clients have their own limits: above 60 seconds, a client may stop the call first.

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

## Windows

**Not tried on a real PC yet.** Install, the host, its permissions and the connection to the server pass automated tests on Windows, but real Chrome, your AI client and a real instance haven't been tested together. The steps are the same, in PowerShell:

- Keep the project and Node where only you can write. Your home folder is fine. `C:\src` isn't, because every user can write to new folders under `C:\`, and setup refuses it. Node in `C:\Program Files\nodejs` is fine.
- Setup registers the host for your user, under `HKCU\Software\Google\Chrome\NativeMessagingHosts`, and runtime files go in `%USERPROFILE%\AppData\Local\sn-mcp`.
- Use the setup output for the ChatGPT Desktop, Mistral Vibe and Claude Code values: the paths differ. For Claude Desktop, install the same bundle.
- Google Chrome only, not Edge.

## Uninstalling

```bash
npm run uninstall
```

This stops the native host and removes its Chrome manifest, program files, socket, key and logs. It then lists what's left for you to remove, because only you can: the extension (on `chrome://extensions`) and the Claude registration.

## Troubleshooting

Logs are in `~/Library/Application Support/sn-mcp/broker.log` (on Windows, `%USERPROFILE%\AppData\Local\sn-mcp\broker.log`). They hold metadata only, never record content or credentials.

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
| `SCOPE_UNKNOWN` right after you approved, in a Code session inside Claude Desktop | That session has two connectors, usually the Desktop one plus a `claude mcp add` registration. Access approved through one doesn't work with the other | Remove the extra one with `claude mcp remove sn-mcp`, fully quit and reopen Claude Desktop (Cmd+Q), then start a new session |
| ChatGPT Desktop says it can't find your instances, and no approval code appears | It's a normal chat, which doesn't use local servers | Ask in a Codex chat |
| Vibe reports an error reading `config.toml` after you added the block | The file also has `mcp_servers = []`, left by `vibe mcp remove` | Delete that line |
| Vibe's model says it has no ServiceNow tools | The session started before you added the block, or `sn-mcp` failed to start | Start a new session. Check `~/.vibe/logs/vibe.log` |
| ChatGPT Desktop can't start `sn-mcp` | Usually the Command is plain `node`, or Node was upgraded and the path changed | Run `npm run setup` again and copy the printed Command |
| Tools are missing or out of date in Claude | Claude is running an old build | Fully quit and reopen Claude Desktop (Cmd+Q), or start a new Claude Code session |
| You moved the project, and the extension still uses the old folder | Reloading doesn't change the folder | Remove the extension and use **Load unpacked** on the new folder, then add your instance again |
| The extension shows a different ID | It was loaded from another folder or build | Remove it, and load `packages/extension/dist` again |
| Chrome shows a sign-in dialog for ServiceNow | Not expected | Please report it with the instance type (`docs/DECISIONS.md`, ADR-002 addendum, has the fallback) |

Every error also has an entry in the [error catalog](TOOLS.md#error-catalog).
