# What's left for you

Do these in order. Everything else is done. Parts C and D are about 10 minutes each, and Parts E to G are optional.

## A. Chrome: load the latest extension

**Status:** done.

**Where:** Chrome, at `chrome://extensions`

1. Find **sn-mcp Session Bridge**.
2. Click its round reload arrow.
3. **Check:** the toolbar icon is now a teal magnifying glass, and there's no red **Errors** button.

## B. Claude Desktop: install the connector and skills

**Status:** all of B done on 2026-11-05. It worked. Go to part C.

**B1. Install the connector**

1. Open **Settings → Extensions → Advanced → Install Extension**.
2. Choose this file, in Finder press Cmd+Shift+G and paste the path:

   ```text
   /Users/cuneytbozok/AssistMe/packages/server/sn-mcp.mcpb
   ```

3. Accept the install, and leave the settings at their defaults.

**B2. Upload the two skills**

1. Open the skills section of Settings. It's usually under **Capabilities**; the label may differ in your version.
2. Upload these two files from `/Users/cuneytbozok/AssistMe/dist-skill/`, one at a time:
   - `servicenow-readonly-troubleshooting.zip`
   - `servicenow-development-guide.zip`

**B3. Remove the old connector entry**

Otherwise the connector runs twice. You can do this yourself, or tell me "B1 is done" and I'll do it.

1. In Finder, press Cmd+Shift+G and paste:

   ```text
   ~/Library/Application Support/Claude/claude_desktop_config.json
   ```

2. Open the file in TextEdit and delete the `"sn-mcp": { … }` block inside `mcpServers`. Keep the rest of the file valid: `"mcpServers": {}` is fine if nothing else is there.

**B4. Restart**

1. Press Cmd+Q in Claude Desktop, and reopen it.
2. **Check:** in a new chat, ask:

   > List my ServiceNow instances.

   You should see `dev469966`.

3. Then ask:

   > Find out why INC0000060 was closed on dev469966.

   Approve the code in the popup after checking that it matches. You should get the VPN timeout story, with evidence.

**Tell me:** whether both worked, and any error, exactly as shown.

## Latest update (do this first)

Access now stays open for follow-up questions. To get that in Claude Desktop:

1. **Settings → Extensions:** remove the sn-mcp extension, then install this file again:

   ```text
   /Users/cuneytbozok/AssistMe/packages/server/sn-mcp.mcpb
   ```

2. **Skills:** replace `servicenow-readonly-troubleshooting` with the new zip from `/Users/cuneytbozok/AssistMe/dist-skill/`.
3. Press Cmd+Q and reopen.

## C. Chrome: test revoking and logging out

**Where:** a Claude Desktop chat, plus Chrome.

First install the update from "Latest update" above, so access stays open for follow-ups. The popup shows **Revoke** only while access is open.

**C1. Revoke**

1. In a new chat, ask:

   > Find out why INC0000060 was closed on dev469966.

2. Check the code, and approve it in the popup.
3. **Check follow-ups:** ask "Who first handled it?". Claude should answer with no new code.
4. Click the magnifying glass icon. **Check:** an **Active access** section shows, with a **Revoke** button.
5. Click **Revoke**.
6. In the chat, ask:

   > Using the access you already have, show me INC0000055. Don't request new access.

7. **Check:** Claude says access has ended (`SCOPE_UNKNOWN`). It must not show the incident.

**C2. Log out**

1. Ask Claude a question about the instance, and approve the new code.
2. In your ServiceNow tab, log out. Stay on the logged-out page.
3. Ask Claude:

   > Show me INC0000055.

4. **Check:** Claude reports `SESSION_EXPIRED`, and **no sign-in dialog pops up in Chrome**.
5. Log back in, and ask again.
6. **Check:** it works with no new approval.

**Tell me:** the result of each check. If a sign-in dialog appears, that's the most important one to report.

## D. Claude Code: test in a terminal

The connector and skills are already registered for Claude Code. This Mac has no `claude` command on its path, so you may need to install it first.

**Where:** Terminal

1. Run `claude --version`. If it isn't found, install it from [claude.com/claude-code](https://claude.com/claude-code).
2. Start it from any folder, and sign in if asked:

   ```bash
   claude
   ```

3. Type `/mcp`. **Check:** `sn-mcp` is listed as connected.
4. Ask:

   > Find out why INC0000060 was closed on dev469966.

5. Approve the code in the popup. **Check:** you get an answer, and it uses the troubleshooting skill.

**Tell me:** whether it worked. If you never use Claude Code in a terminal, tell me and I'll mark this as not tested.

## E. Optional: Cowork

If you use Cowork in Claude Desktop, ask it the question from B4. **Tell me:** whether it can see the tools. Either answer is fine: I'll record it.

## F. Optional: a second instance

Needed for `compare_records` to run live, and for the production-rule checks (T-015). A second free developer instance works, from [developer.servicenow.com](https://developer.servicenow.com). Register it in the popup as **prod**, and tell me its alias.

Without one, `compare_records` stays tested only against mocks.

## G. Optional: back up the code

The project exists only on this Mac. Create an empty private repository (GitHub or similar), and give me its address. I'll connect it and push.

## After that

Tell me "next steps done", with your results. I'll record them and do the last two tasks: the acceptance matrix (T-040) and the install-from-scratch and recovery drill (T-041).
