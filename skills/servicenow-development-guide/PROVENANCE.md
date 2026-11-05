# Where this skill comes from

Third-party, MIT licensed (see `LICENSE`). Copied, not linked, so it only changes when someone here updates it.

- **Source:** https://github.com/Vanka07/servicenow-skill, folder `skills/servicenow`
- **Commit:** `bd687c887a7cf71067542c68e93c5ad1f662350b`
- **Added:** 2026-11-05, at the user's request

## Local changes

Two:

- The section "Using this with the sn-mcp connector" in `SKILL.md`.
- The skill is renamed from `servicenow` to `servicenow-development-guide`, in its folder, its `name`, and the paths in its examples.

Everything else is as published.

## Review

Scanned when added: no hidden Unicode, no text aimed at steering the assistant, no encoded blobs, and only placeholder web addresses. `scripts/snow_helper.py` imports no network or process modules; it was not run. The reference files were searched, not read line by line, and the accuracy of their ServiceNow content has not been checked.

## Updating

Download the new commit somewhere separate, repeat the scan, look through the diff, then copy it here, keep the local section, and update the commit above. `packages/server/test/skill.test.ts` repeats the automated parts.
