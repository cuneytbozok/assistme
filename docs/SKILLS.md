# Skills

| Skill | Use it for | Source |
| ----- | ---------- | ------ |
| `servicenow-readonly-troubleshooting` | Finding out why something happened on an instance, with the connector | This project |
| `servicenow-development-guide` | Building on ServiceNow, and how products are meant to work | Third party, pinned |

They're separate on purpose: each loads only when its description fits the task, and the third-party one stays traceable to its source. `dist-skill/` is build output and isn't in git; the source is `skills/`.

Skills give Claude expertise. They add no tools and no access: everything still goes through the read-only connector and the scopes you approve. All the skills here are optional.

## `servicenow-readonly-troubleshooting` (ours)

A method for investigating ServiceNow problems, with references Claude loads only when needed: logs and transactions, business rules, Discovery and the ECC queue, CMDB identification, Flow Designer, and ACLs. It's guidance only: it never tells Claude to write anything.

**Claude Code:** this also installs the `servicenow-development-guide` skill below.

```text
/plugin marketplace add /ABSOLUTE/PATH/TO/AssistMe
```

```text
/plugin install sn-mcp-skills@sn-mcp
```

**Claude Desktop:** build the zips, then upload `dist-skill/servicenow-readonly-troubleshooting.zip` in the skills section of Claude Desktop's settings.

```bash
npm run pack:skill
```

## `servicenow-development-guide` (third-party)

General ServiceNow development and product knowledge: scripting, business rules, flows, portals, ITSM, ITOM, HRSD, CSM, SecOps and more, in 28 references. It helps when you build things, and when Claude needs to know how a feature is meant to work.

It's by a third party ([Vanka07/servicenow-skill](https://github.com/Vanka07/servicenow-skill), MIT), where it's called `servicenow`. The copy in `skills/servicenow-development-guide` is pinned to one commit: [PROVENANCE.md](../skills/servicenow-development-guide/PROVENANCE.md) records it, along with the one local change and how far it was reviewed.

- **It can't write through the connector.** It can suggest code that changes data, including background scripts. Those change real data if you run them yourself, so review them and try them in a development instance first.
- **Its ServiceNow content hasn't been checked for accuracy.** It's a small project. The note added to it tells Claude to confirm table and field names against the instance.
- **Installing:** in Claude Code, it comes with the plugin above. In Claude Desktop, upload `dist-skill/servicenow-development-guide.zip` after `npm run pack:skill`.

## The official ServiceNow SDK skill

ServiceNow's `now-sdk` skill gives Claude current documentation for the ServiceNow SDK and Fluent, through the `now-sdk explain` command. It is useful when you write Fluent apps, and it works in Claude Code only.

**Use it only for `explain`.** The SDK can also sign in to instances and deploy to them, which is outside this project's read-only scope: if it ran, it wouldn't go through the connector, its approvals or its safeguards. So don't run `now-sdk auth`, and deny the commands that can change things.

### Set up

1. Copy the rules in `.claude/settings.example.json` into your project's `.claude/settings.json`. They deny `auth`, `init`, `build`, `install`, `deploy`, `transform`, `dependencies` and `download`, and allow `explain`.
2. Install the plugin in Claude Code:

```text
/plugin install servicenow-sdk@claude-plugins-official
```

If the marketplace isn't known yet, add it first with `/plugin marketplace add anthropics/claude-plugins-official`.

### Know the limits

- These rules are a guardrail for Claude Code's Bash tool, not a security boundary. They match command text, so an unusual spelling of a command, such as through another script, may not match. The boundary that matters is not signing in: without `now-sdk auth`, the SDK has no credentials for an instance.
- If you've already signed in with `now-sdk auth` on this machine, the SDK can use those credentials. Clear them with the SDK's own commands, outside Claude, if you want this guarantee.

### What is known

| Fact | Status |
| ---- | ------ |
| `@servicenow/sdk` latest is 4.14.0, MIT license, Node ≥20.18, binaries `now-sdk`, `sdk` | Checked with `npm view` on 2026-11-05 |
| The skill needs SDK 4.6.0 or newer | From public summaries of the ServiceNow/sdk repository. Not checked first-hand |
| Install name `servicenow-sdk@claude-plugins-official` | From a public listing. Not checked first-hand |
| Whether the plugin's skills are named `now-sdk`, or `now-sdk-explain` and `now-sdk-setup` | Sources differ. Check the installed plugin |
| The plugin's own license | Not checked. See the plugin listing |
| `explain` works with no credentials | **Not yet verified** (T-039) |
| The deny rules block the commands in Claude Code | **Not yet verified** (T-039) |
| Not available in Claude Desktop | From the project's earlier research (FR-8.2). Not re-checked |
