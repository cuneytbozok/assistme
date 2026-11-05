# What's left for you

The connector is installed and working in Claude Desktop, and every required step is done. All of these are optional.

## 1. The live test for T-042

The fourth run showed what the task asked for: two versions of a script compared by element, and the diff applied back exactly. What remains is your decision on one criterion: that a single-instance scope can't reach another instance can't be tried live without a second instance. It rests on mock tests and the extension being unchanged.

To use this in Claude Desktop, install the new bundle `packages/server/sn-mcp.mcpb` (version 0.1.4), then Cmd+Q and reopen. The extension doesn't need a reload.

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
