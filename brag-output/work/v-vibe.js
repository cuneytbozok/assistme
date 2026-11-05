import { cliVideo } from './cli.js';
cliVideo({
  client: 'Mistral Vibe', bin: 'vibe', label: 'Mistral Vibe', setupLine: 'Claude / ChatGPT / Vibe',
  connect(sc, a, { ROOT, caption, editor, tomlHl, h, appear }) {
    caption(sc, {
      kicker: 'Step 2', title: 'Add the block to<br><code>~/.vibe/config.toml</code>',
      sub: 'Use the block setup printed, not <code>vibe mcp add</code>: only the block carries the <code>prompt</code> Vibe’s model needs.',
      a: a + 0.1, b: 99, x: 120, y: 230, w: 680,
    });
    editor(sc, {
      x: 860, y: 200, w: 960, hgt: 700, title: '~/.vibe/config.toml', at: a + 1.4, hl: tomlHl,
      pre: ['# …at the end of the file', ''],
      lines: [
        '[[mcp_servers]]',
        'name = "sn-mcp"',
        'transport = "stdio"',
        'command = ["/opt/homebrew/bin/node"]',
        'args = ["…/AssistMe/packages/server/dist/bin/mcp-server.js"]',
        `cwd = "${ROOT}"`,
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 360',
        'prompt = "(setup prints the text)"',
        '',
        '[mcp_servers.env]',
        'SN_MCP_CLIENT_NAME = "Mistral Vibe"',
      ],
    });
    const n = h('div', 'note', 'File has a <code>mcp_servers = []</code> line? <b>Delete it.</b>');
    n.style.cssText = 'left:120px;top:900px;width:700px';
    sc.append(n);
    appear(n, a + 4.0);
  },
  check(sc, a, { caption, terminal }) {
    caption(sc, {
      kicker: 'Step 3', title: 'Start a new,<br>interactive <code>vibe</code>',
      sub: 'Vibe asks before running each tool. That isn’t instance access: only the Chrome popup grants that.',
      a: a + 0.1, b: 99, x: 120, y: 230, w: 680,
    });
    terminal(sc, {
      x: 860, y: 230, w: 940, hgt: 600, title: 'Terminal — ~/AssistMe',
      lines: [
        { at: a + 0.5, kind: 'cmd', text: 'vibe', cps: 14 },
        { at: a + 1.3, kind: 'dim', text: '(sn-mcp starts with the session)' },
        { at: a + 1.6, kind: 'dim', text: 'Not vibe -p: you need to see the approval code.' },
      ],
    });
  },
  extraAsk: (t) => [
    { at: t + 0.55, kind: 'warn', text: '? Allow tool sn-mcp · request_scope  › yes' },
  ],
});
