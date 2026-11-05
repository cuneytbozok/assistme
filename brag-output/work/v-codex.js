import { cliVideo } from './cli.js';
cliVideo({
  client: 'Codex CLI', bin: 'codex', label: 'Codex CLI', setupLine: 'Claude / ChatGPT / Codex',
  connect(sc, a, { ROOT, SERVER, caption, editor, tomlHl, h, appear }) {
    caption(sc, {
      kicker: 'Step 2', title: 'Add sn-mcp to<br><code>~/.codex/config.toml</code>',
      sub: 'Paste the block setup printed. It also sets longer timeouts for long reads.',
      a: a + 0.1, b: 99, x: 120, y: 250, w: 660,
    });
    editor(sc, {
      x: 860, y: 200, w: 960, hgt: 640, title: '~/.codex/config.toml', at: a + 1.2, hl: tomlHl,
      pre: ['# your existing settings stay as they are', ''],
      lines: [
        '[mcp_servers.sn-mcp]',
        'command = "/opt/homebrew/bin/node"',
        'args = ["…/AssistMe/packages/server/dist/bin/mcp-server.js"]',
        `cwd = "${ROOT}"`,
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 360',
        '',
        '[mcp_servers.sn-mcp.env]',
        'SN_MCP_CLIENT_NAME = "Codex CLI"',
      ],
    });
    const n = h('div', 'note', '<b>Use the absolute Node path</b> setup printed.<br><code>SN_MCP_CLIENT_NAME</code> is the label the Chrome popup shows.');
    n.style.cssText = 'left:860px;top:880px;width:960px';
    sc.append(n);
    appear(n, a + 3.2);
  },
  check(sc, a, { caption, terminal }) {
    caption(sc, {
      kicker: 'Step 3', title: 'Check that Codex<br>sees it',
      sub: 'Then start <code>codex</code> in a new terminal.', a: a + 0.1, b: 99, x: 120, y: 260, w: 640,
    });
    terminal(sc, {
      x: 860, y: 230, w: 940, hgt: 600, title: 'Terminal — ~/AssistMe',
      lines: [
        { at: a + 0.5, kind: 'cmd', text: 'codex mcp list', cps: 22 },
        { at: a + 1.5, kind: 'ok', text: 'sn-mcp   /opt/homebrew/bin/node   enabled' },
        { at: a + 2.4, kind: 'cmd', text: 'codex', cps: 16 },
      ],
    });
  },
});
