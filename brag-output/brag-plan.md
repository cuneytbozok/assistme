# sn-mcp setup videos: plan

Four separate English setup videos, 1920×1080 at 30 fps, about 35 s each. They are longer than a teaser so every command stays on screen long enough to read.

- **Angle:** "Ask <client> about your ServiceNow, read-only, set up in four steps." Each video opens on the end result (a question answered through sn-mcp tools) and closes on the three guarantees: read-only, you approve every instance, your password stays in Chrome.
- **Visual identity:** the extension's own colours (deep teal `#0f3d3e`, teal `#5eead4`, accent blue) and its magnifying-glass logo, with Inter and JetBrains Mono. Every popup is drawn with the extension's real `popup.css` and its real class structure.
- **Fictional stand-ins:** `/Users/you/AssistMe`, `dev12345.service-now.com` (the extension's own placeholder), approval code `K7QF-2M` (the example from the README) and made-up INC numbers. No real data is shown.

## CLI videos (Claude Code, Codex CLI, Mistral Vibe)
| Time | Scene |
|---|---|
| 0–4.4 | Hook: a question answered by sn-mcp tools. Title: "Ask <client> about your ServiceNow." |
| 4.4–10.4 | Step 1, Install: `npm install`, then `npm run setup` (native host installed, next steps printed) |
| 10.4–19.6 | Step 2, Connect: `claude mcp add …` / the `~/.codex/config.toml` block / the `~/.vibe/config.toml` block |
| 19.6–24.2 | Step 3, Check: `/mcp` / `codex mcp list` / start an interactive `vibe` session |
| 24.2–32.2 | Step 4, Approve: the client shows the code, the popup shows the same code, click Approve, results come back |
| 32.2–36 | Outro: guarantees and `docs/INSTALL.md` |

## Chrome extension video
| Time | Scene |
|---|---|
| 0–4.4 | Hook: the popup. "The part of sn-mcp that lives in Chrome." |
| 4.4–12.6 | Step 1: Developer mode, Load unpacked, `packages/extension/dist`, check the ID |
| 12.6–16.6 | Step 2: pin it from the puzzle menu |
| 16.6–25 | Step 3: open the instance tab, then + Add with URL, alias `dev` and DEV. Chrome's site permission, Allow, instance shows Connected |
| 25–31.4 | Step 4: approve only a matching code |
| 31.4–35.2 | Outro: "Bridge installed. Now connect your AI." |
