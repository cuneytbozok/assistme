# What's left for you

The connector is installed and working in Claude Desktop, and every required step is done. All of these are optional.

## 1. The live test for T-042

The first run passed, but the two versions it found had the same script, so the script diff itself hasn't been shown live. To finish:

1. Run the test again. It now looks through up to 25 records for a pair of versions with a changed script. It needs one approval code in the extension popup.
2. If it reports `SKIP`, none of them changed a script. In ServiceNow, change the script of a script include you can spare and save it, then run it again. That's your edit on your dev instance: the connector only reads.
3. Tell me when it's done. I'll read the numbers, and record the result.

```bash
npm run e2e:live -- --instance dev469966 --only "compare_records"
```

To use this in Claude Desktop, install the new bundle `packages/server/sn-mcp.mcpb` (version 0.1.3), then Cmd+Q and reopen. The test doesn't need it, and the extension doesn't need a reload.

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
