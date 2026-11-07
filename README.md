# sn-mcp: let your AI read your ServiceNow

https://github.com/user-attachments/assets/7fcee793-bfbb-4c07-93be-21e29cacea2c

Ask your AI client questions about your ServiceNow instance, such as "why did this incident change?" or "which scripts touch this field?". It finds the answer through your own browser session. It works with Claude Desktop, Claude Code, ChatGPT Desktop (Codex chats) and Mistral Vibe.

- **You stay in control.** Your AI client can't reach an instance until you approve a request in Chrome.
- **Your password stays in Chrome.** Your AI client never sees your password, cookies or session tokens.
- **What you can see is all it can see.** It reads as you, with your ServiceNow permissions.
- **Read-only tools, with one exception.** It has no tool that creates, changes or deletes anything. But a query may contain a `javascript:` value or a `DYNAMIC` filter, as ServiceNow's own list filters do, and ServiceNow runs those as server-side script in your session. A script can do whatever your account can, so a query isn't guaranteed to only read. Keep this in mind before using it on production.

sn-mcp is free and open source under the [MIT License](LICENSE). It's an independent project, not affiliated with or endorsed by ServiceNow.

## How is this different from the ServiceNow SDK?

They solve different problems. The [ServiceNow SDK](https://servicenow.github.io/sdk/) (`now-sdk`) is for **building applications as source code** and deploying them. sn-mcp is for **asking an AI client what's on an instance and why**, using the access you already have in your browser.

| | sn-mcp | ServiceNow SDK |
| --- | ------ | -------------- |
| **Made for** | Investigating and understanding an instance | Developing and deploying applications |
| **How you use it** | Ask questions in plain language in a chat | Work in a code project with TypeScript and command-line tools |
| **Signing in** | Uses your existing Chrome session, with no separate sign-in | Needs its own sign-in with `now-sdk auth` (basic or OAuth), saved on your computer in encrypted form |
| **Access** | You approve each request in Chrome, for a limited time | Comes from the saved sign-in |
| **Reading data** | Records, history, scripts, related records, counts and comparisons, on tables your account can read, except those holding credentials | `now-sdk query` for read-only table queries |
| **Global scope** | Reads global and scoped records alike | Built around application projects. Its config accepts `global`, with a specific setting required |
| **Changing the instance** | No tool for it, apart from the script exception above | Yes: installing and updating applications is its purpose |

**What sn-mcp is for:** letting people who work with ServiceNow get answers from an instance without writing code or learning its tables first, while they keep control of what the AI can reach. That includes people who don't build applications, such as business analysts.

**Two honest limits:** setup still takes one Terminal session and Chrome's developer mode, so someone less technical may want help with it. It has also only been tested with an admin account so far, and it needs read access to table definitions, which not every account has.

**You can use both.** If you build applications, the SDK is the right tool for that, and sn-mcp can help you find out what's on the instance. The SDK's sign-in and deployments are separate from sn-mcp's approvals.

The SDK details are from its documentation for version 4.14.

## What you need

- A Mac with Google Chrome. Windows passes automated tests, but hasn't been tried on a real PC yet.
- [Node.js](https://nodejs.org) 22.18 or newer. Run `node --version` to check.
- A ServiceNow instance you can sign in to. If you don't have one to test with, you can request a free developer instance at [developer.servicenow.com](https://developer.servicenow.com).
- An AI client: [Claude Desktop](https://claude.ai/download), Claude Code, ChatGPT Desktop (Codex chats only) or Mistral Vibe.

You don't need an API key or Docker. Your ServiceNow account has to be able to read table definitions (`sys_db_object` and `sys_dictionary`). So far the connector has only been tested with an admin account.

## Set it up

It takes about 10 minutes, and has four parts. Here it is on video:

https://github.com/user-attachments/assets/c9b03ae5-326e-464f-9f9d-b0b40fcf1e20

There are two things called an "extension" below: one you add to **Chrome**, and, if you use it, one you add to **Claude Desktop**.

### 1. Download and install

Open Terminal and run these one at a time:

```bash
cd ~
```

```bash
git clone https://github.com/cuneytbozok/assistme.git AssistMe
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

The setup builds everything and prints the exact paths for your Mac. Keep that window open for the next steps.

- **Keep this folder where it is.** Chrome and the connector run from it, so moving or deleting it stops them working. Setup refuses folders other users can write to, such as `/tmp`, so your home folder is a good place.
- **`npm install` may warn about `fsevents` install scripts.** You can ignore that.

### 2. Add the extension to Chrome

The extension isn't in the Chrome Web Store, so you load it from the folder you just downloaded.

1. In Chrome, go to `chrome://extensions`.
2. Turn on **Developer mode**, at the top right.
3. Click **Load unpacked**.
4. Choose the folder `packages/extension/dist` inside `AssistMe`. The setup printed its full path.
5. Check the card: the ID should be `clipfeocpiljpcngmjpdbegciimchbol`, with no red **Errors** button.
6. Click the puzzle-piece icon in the toolbar and pin **sn-mcp Session Bridge**. Its icon is a magnifying glass.

### 3. Add your ServiceNow instance

1. Sign in to your instance in a Chrome tab.
2. Click the magnifying glass icon.
3. Paste the instance's web address, choose a short name (an alias, such as `dev`), pick its environment, and click **Register**.
4. Chrome asks for access to that one site. Allow it.

If an instance isn't clearly development or test, choose **Other**. It gets the same strict rules as production: shorter access, and you type the host name to approve.

### 4. Connect your AI client

**Claude Desktop:**

1. In Terminal, run:

   ```bash
   npm run pack:mcpb
   ```

2. In Claude Desktop, go to **Settings → Extensions → Advanced → Install Extension**.
3. Choose `packages/server/sn-mcp.mcpb` inside `AssistMe`.
4. Quit Claude Desktop completely with **Cmd+Q**, then open it again. Closing the window isn't enough.

**Other AI clients:**

- **Claude Code:** run the `claude mcp add` command that the setup printed, then start a new session.
- **ChatGPT Desktop:** see [how to connect it](docs/INSTALL.md#chatgpt-desktop). It only works in Codex chats.
- **Mistral Vibe:** see [how to connect it](docs/INSTALL.md#mistral-vibe).

## Your first question

Start a new chat in your AI client and ask:

> List my ServiceNow instances, then show me the five most recent incidents.

1. Your AI client asks for access and shows you an **approval code**, such as `K7QF-2M`.
2. Click the magnifying glass icon in Chrome. You'll see the request.
3. **Check that the code matches what it showed you**, then approve it.
4. It carries on.

Keep the instance open in a Chrome tab while you work. That's how the connector uses your session.

## Optional extras

Everything above works without these.

### Skills

Skills teach your AI client how to investigate and build on ServiceNow. They add no access. There are two: a troubleshooting method from this project, and a development guide from a third party, whose content hasn't been checked for accuracy.

| AI client | How to add them |
| --------- | --------------- |
| **Claude Desktop** | Run `npm run pack:skill`, then upload each zip from `dist-skill` in the skills section of Claude Desktop's settings |
| **Claude Code** | Run `/plugin marketplace add` with this folder's path, then `/plugin install sn-mcp-skills@sn-mcp` |
| **Codex and Mistral Vibe** | Run `npm run codex-skills`, then start a new chat or session |

[docs/SKILLS.md](docs/SKILLS.md) explains each one.

### Documentation research

Off by default. This lets your AI client search ServiceNow's published documentation through GitMCP, and read its pages from GitHub, with no key or download. It's one more source, alongside anything else your AI client can use.

1. In Claude Desktop, go to **Settings → Extensions → ServiceNow (read-only)** and open its settings. For other AI clients, [set `SN_MCP_DOCS`](docs/INSTALL.md#documentation-research).
2. Turn on **Documentation research**.
3. Quit with **Cmd+Q** and open it again. Saving the setting isn't enough.

Good to know:

- Search terms are sent to gitmcp.io and GitHub, so leave customer data out of them.
- Your AI client may choose web search on its own. To ask for documentation, say so, for example: "Check the ServiceNow documentation with `docs_search`. If it isn't there, search the web."
- A search usually takes 10 to 25 seconds. It depends on a free community service, so it can sometimes be slow or unavailable. Nothing else depends on it.

More in [docs/INSTALL.md](docs/INSTALL.md#documentation-research).

## Good to know

- **Follow-up questions:** access stays open for the time you chose when approving, so follow-ups in the same chat don't need a new code. A new chat asks again.
- **Ending access:** access ends when it expires, when you click **Revoke** in the popup, when you tell your AI client you're finished, or when Chrome restarts. The popup's **Active access** section and its **Revoke** button only show while access is open.
- **How long it lasts:** 4 hours by default on development and test, 15 minutes on production. You can choose when you approve.
- **"Part of the query has been ignored" banners:** after a wide script search, these can appear the next time you load a ServiceNow page. They're harmless, and nothing is changed. Asking your AI client to search specific tables avoids most of them.
- **Tables it can't read:** your AI client is told, so you know an answer may be partial. Tables that hold credentials are always blocked.
- **Where your data goes:** what the tools read goes to the model behind your AI client, under that provider's terms. Choose one you trust with that data.
- **Treat answers like any other research:** your AI client reads what's in your records, and records can contain anything. The connector tells it to treat that content as data, not instructions, but check anything important.

## If something goes wrong

| What you see | What to do |
| ------------ | ---------- |
| An error mentioning `.ts` when you run `npm run setup` | Your Node.js is too old. Install 22.18 or newer, then run it again |
| "Refusing to install" during setup | Keep the project somewhere only you can write to, such as your home folder |
| `BRIDGE_UNAVAILABLE`, or "host not found" in the popup | Run `npm run setup`, then press the reload icon on the extension's card at `chrome://extensions` |
| `NO_INSTANCE_TAB` | Open your instance in Chrome and sign in |
| `SESSION_EXPIRED` | Sign in to ServiceNow again. Your approval still works |
| `SCOPE_UNKNOWN` or `SCOPE_EXPIRED` | Ask your AI client to request access again, then approve the new code |
| Tools are missing or out of date, including the documentation tools | Quit Claude Desktop with Cmd+Q, reopen it, and start a new chat |
| `DOCS_UNAVAILABLE` | Documentation search is slow or down. Your AI client can use other sources, and you can try again later |

There's more in [docs/INSTALL.md](docs/INSTALL.md#troubleshooting).

## Help test it

So far this has been tested on one Mac, with one developer instance and an admin account. Other setups are exactly what's useful to try: a different Mac, a non-admin account, or Windows.

- **Start with a development instance.** Check answers you can verify yourself before relying on it, and read the script exception at the top of this page before trying production.
- **Report problems** in [GitHub Issues](https://github.com/cuneytbozok/assistme/issues). Say what you did, what you expected, and the exact error. Include your macOS, Chrome, Node.js and AI client versions.
- **Issues are public, so leave out** instance names, record contents, passwords and tokens. `~/Library/Application Support/sn-mcp/broker.log` holds metadata only, but check it before sharing.
- **Report security problems privately,** as described in [docs/SECURITY.md](docs/SECURITY.md#7-reporting-a-vulnerability).

## Updating

Run these in the `AssistMe` folder:

```bash
git pull
```

```bash
npm install
```

```bash
npm run setup
```

Then reload the extension at `chrome://extensions`, and follow [the remaining steps](docs/INSTALL.md#updating) for your AI client.

## Removing it

```bash
npm run uninstall
```

Then remove the extension at `chrome://extensions`, and remove sn-mcp from your AI client. The command lists what's left. After that you can delete the `AssistMe` folder.

## More

| Document | What's in it |
| -------- | ------------ |
| [Project site](https://cuneytbozok.github.io/assistme/) | A short introduction to share with others |
| [docs/INSTALL.md](docs/INSTALL.md) | Full install, updates, settings and troubleshooting |
| [docs/TOOLS.md](docs/TOOLS.md) | What each tool does, and every error |
| [docs/SECURITY.md](docs/SECURITY.md) | The threat model and protections |
| [docs/SKILLS.md](docs/SKILLS.md) | The optional skills |
