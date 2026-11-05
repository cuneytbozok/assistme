# Skills

| Skill | Use it for | Source |
| ----- | ---------- | ------ |
| `servicenow-readonly-troubleshooting` | Finding out why something happened on an instance, with the connector | This project |
| `servicenow-development-guide` | Building on ServiceNow, and how products are meant to work | Third party, pinned |

They're separate on purpose: each loads only when its description fits the task, and the third-party one stays traceable to its source. `dist-skill/` is build output and isn't in git; the source is `plugin/skills/`.

Skills give Claude expertise. They add no tools and no access: everything still goes through the read-only connector and the scopes you approve. All the skills here are optional.

## `servicenow-readonly-troubleshooting` (ours)

A method for investigating ServiceNow problems, with references Claude loads only when needed: logs and transactions, business rules, Discovery and the ECC queue, CMDB identification, Flow Designer, and ACLs. It's guidance only: it never tells Claude to write anything.

**Claude Code in a terminal:** this also installs the `servicenow-development-guide` skill below. Code sessions inside the Claude Desktop app already see the skills uploaded to Desktop, so they don't need it.

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

It's by a third party ([Vanka07/servicenow-skill](https://github.com/Vanka07/servicenow-skill), MIT), where it's called `servicenow`. The copy in `plugin/skills/servicenow-development-guide` is pinned to one commit: [PROVENANCE.md](../plugin/skills/servicenow-development-guide/PROVENANCE.md) records it, along with the one local change and how far it was reviewed.

- **It can't write through the connector.** It can suggest code that changes data, including background scripts. Those change real data if you run them yourself, so review them and try them in a development instance first.
- **Its ServiceNow content hasn't been checked for accuracy.** It's a small project. The note added to it tells Claude to confirm table and field names against the instance.
- **Installing:** in Claude Code, it comes with the plugin above. In Claude Desktop, upload `dist-skill/servicenow-development-guide.zip` after `npm run pack:skill`.

## The official ServiceNow SDK skill: not used

The user decided on 2026-11-05 to skip it (T-039). It isn't part of this project.

If an SDK plugin such as `fluent@servicenow` is installed anyway, know that the SDK can sign in to instances and deploy to them, outside the connector and its approvals. Don't run `now-sdk auth`. `.claude/settings.example.json` has deny rules for the SDK's commands that can change things. Those rules match command text, so they're a guardrail and not a security boundary. They haven't been tested against Claude Code.
