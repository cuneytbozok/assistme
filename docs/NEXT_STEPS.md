# What's left for you

The connector is installed and working in Claude Desktop, and every required step is done. All of these are optional.

## 1. Install version 0.1.5

Comparing on one instance, and comparing record versions, passed live. To use them in Claude Desktop, install `packages/server/sn-mcp.mcpb` (version 0.1.5), then Cmd+Q and reopen.

## ChatGPT Desktop

Run `npm run setup`, and copy the printed values into **Settings → MCP servers**: see [INSTALL.md](INSTALL.md#chatgpt-desktop). Then ask it to list your instances.

## Windows

Left for later, because you don't have a Windows PC. The code is written but has never run on Windows. When someone has a PC, they can try the install using [INSTALL.md](INSTALL.md#windows). Pushing also runs the Windows CI job, which needs no PC but doesn't cover real Chrome or a real instance.

## 2. A second instance

Without one, three checks stay open: that switching Chrome tabs can't change the instance (AC-6), that production can't be reached with only dev approved (AC-7), and `compare_records` running live between two instances (AC-8). Until then, treat comparing two instances as untested.

1. Get a second free developer instance from [developer.servicenow.com](https://developer.servicenow.com).
2. Sign in to it in Chrome.
3. Add it in the extension popup, with the environment **Prod**.
4. Tell me its alias, and I'll run the checks. You'd approve a code or two.

## 3. Try it on a real instance

Everything so far ran on one quiet developer instance, signed in as admin. Before relying on it elsewhere:

- Register production as **Prod**, or **Other** if unsure, so it gets short access and you type the host name to approve.
- Keep matching the approval codes.
- Start with a question you can check yourself.
- On busy logs, ask for a short time window. A long read of a busy table can repeat or miss rows.

Tell me if anything looks wrong, especially `FILTER_NOT_APPLIED`, or an answer that doesn't match what you see in ServiceNow.

## When you update the project

See "Updating" in [INSTALL.md](INSTALL.md).
