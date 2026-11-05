# sn-mcp: let Claude read your ServiceNow

Ask Claude questions about your ServiceNow instance, such as "why did this incident change?" or "which scripts touch this field?". Claude reads the answer through your own browser session.

- **Read-only.** It can't create, change or delete anything, or run scripts.
- **You stay in control.** Claude can't reach an instance until you approve a request in Chrome.
- **Your password stays in Chrome.** Claude never sees your password, cookies or session tokens.
- **What you can see is all it can see.** It reads as you, with your ServiceNow permissions.

sn-mcp is an independent project, not affiliated with or endorsed by ServiceNow.

## What you need

- A Mac with Google Chrome (Windows support is new and hasn't been tested on a real PC yet)
- [Node.js](https://nodejs.org) 22.18 or newer (run `node --version` to check)
- A ServiceNow instance you can sign in to
- [Claude Desktop](https://claude.ai/download), Claude Code, or ChatGPT Desktop, in its Codex chats only ([how to connect it](docs/INSTALL.md#chatgpt-desktop))

You don't need an API key or Docker. Your ServiceNow account needs to be able to read table definitions (`sys_db_object` and `sys_dictionary`). So far the connector has only been tested with an admin account.

## Set it up

It takes about 10 minutes, and has four parts.

### 1. Install

Open Terminal, go to this project's folder, and run:

```bash
npm install
```

```bash
npm run setup
```

The setup prints the exact paths for your Mac. Keep that window open for the next steps.

### 2. Add the extension to Chrome

The extension isn't in the Chrome Web Store, so you load it from this folder.

1. In Chrome, go to `chrome://extensions`.
2. Turn on **Developer mode**, at the top right.
3. Click **Load unpacked**.
4. Choose the folder `packages/extension/dist` in this project.
5. Check the card: the ID should be `clipfeocpiljpcngmjpdbegciimchbol`, with no red **Errors** button.
6. Click the puzzle-piece icon in the toolbar and pin **sn-mcp Session Bridge**. Its icon is a magnifying glass.

### 3. Add your ServiceNow instance

1. Sign in to your instance in a Chrome tab.
2. Click the magnifying glass icon.
3. Add the instance: paste its web address, choose a short name (an alias), and pick its environment.
4. Chrome asks for access to that one site. Allow it.

If an instance isn't clearly development or test, choose **Other**. It gets the same strict rules as production: shorter access, and you type the host name to approve.

### 4. Connect Claude

**Claude Desktop:**

1. In Terminal, run:

   ```bash
   npm run pack:mcpb
   ```

2. In Claude Desktop, go to **Settings → Extensions → Advanced → Install Extension**.
3. Choose `packages/server/sn-mcp.mcpb` in this project.

**Claude Code:** run the `claude mcp add` command that the setup printed, then start a new session.

## Your first question

Ask Claude:

> List my ServiceNow instances, then show me the five most recent incidents.

1. Claude asks for access and shows you an **approval code**, such as `K7QF-2M`.
2. Click the magnifying glass icon in Chrome. You'll see the request.
3. **Check that the code matches what Claude showed you**, then approve it.
4. Claude carries on.

Keep the instance open in a Chrome tab while you work. That's how the connector uses your session.

## Good to know

- **Follow-up questions:** access stays open for the time you chose when approving, so follow-ups in the same chat don't need a new code. A new chat asks again.
- **Ending access:** access ends when it expires, when you click **Revoke** in the popup, when you tell Claude you're finished, or when Chrome restarts. The popup's **Active access** section and its **Revoke** button only show while access is open.
- **How long it lasts:** 4 hours by default on development and test, 15 minutes on production. You can choose when you approve.
- **"Part of the query has been ignored" banners:** after a wide script search, these can appear the next time you load a ServiceNow page. They're harmless, and nothing is changed. Asking Claude to search specific tables avoids most of them.
- **Tables Claude can't read:** Claude tells you, so you know an answer may be partial. Tables that hold credentials are always blocked.
- **Treat answers like any other research:** Claude reads what's in your records, and records can contain anything. The connector tells it to treat that content as data, not instructions, but check anything important.

## Optional: skills

Skills teach Claude how to investigate and build on ServiceNow. They add no access. See [docs/SKILLS.md](docs/SKILLS.md).

## If something goes wrong

| What you see | What to do |
| ------------ | ---------- |
| `BRIDGE_UNAVAILABLE`, or "host not found" in the popup | Run `npm run setup`, then press the reload icon on the extension's card at `chrome://extensions` |
| `NO_INSTANCE_TAB` | Open your instance in Chrome and sign in |
| `SESSION_EXPIRED` | Sign in to ServiceNow again. Your approval still works |
| `SCOPE_UNKNOWN` or `SCOPE_EXPIRED` | Ask Claude to request access again, then approve the new code |
| Tools are missing or out of date | Fully quit Claude Desktop (Cmd+Q) and reopen it |

There's more in [docs/INSTALL.md](docs/INSTALL.md).

## Removing it

```bash
npm run uninstall
```

Then remove the extension at `chrome://extensions`, and remove sn-mcp from Claude. The command lists what's left.

## More

| Document | What's in it |
| -------- | ------------ |
| [docs/INSTALL.md](docs/INSTALL.md) | Full install, updates, settings and troubleshooting |
| [docs/TOOLS.md](docs/TOOLS.md) | What each tool does, and every error |
| [docs/SECURITY.md](docs/SECURITY.md) | The threat model and protections |
| [docs/SKILLS.md](docs/SKILLS.md) | The optional skills |
