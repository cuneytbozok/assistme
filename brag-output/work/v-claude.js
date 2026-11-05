import { cliVideo } from './cli.js';
cliVideo({
  client: 'Claude Code', bin: 'claude', label: 'Claude Code', setupLine: 'Claude',
  connect(sc, a, { SERVER, caption, terminal, h, appear }) {
    caption(sc, {
      kicker: 'Step 2', title: 'Register sn-mcp<br>with Claude Code',
      sub: 'Paste the <code>claude mcp add</code> command setup printed. It has your real path.',
      a: a + 0.1, b: 99, x: 120, y: 230, w: 1680,
    });
    terminal(sc, {
      x: 120, y: 560, w: 1680, hgt: 330, title: 'Terminal — ~/AssistMe',
      lines: [
        { at: a + 1.0, kind: 'cmd', cps: 62, text: `claude mcp add --scope user sn-mcp --env SN_MCP_CLIENT_NAME="Claude Code" -- node ${SERVER}` },
        { at: a + 3.6, kind: 'ok', text: 'Added stdio MCP server sn-mcp to user config' },
      ],
    });
    const n = h('div', 'note', '<b>Using Claude Desktop instead?</b> Run <code>npm run pack:mcpb</code>, then Settings → Extensions → Advanced → Install Extension.');
    n.style.cssText = 'left:120px;top:935px;width:1700px';
    sc.append(n);
    appear(n, a + 4.4);
  },
  check(sc, a, { caption, terminal }) {
    caption(sc, {
      kicker: 'Step 3', title: 'Start a new session.<br>Run <code>/mcp</code>.',
      sub: 'sn-mcp should be listed.', a: a + 0.1, b: 99, x: 120, y: 260, w: 640,
    });
    terminal(sc, {
      x: 860, y: 230, w: 940, hgt: 600, title: 'claude — ~/AssistMe',
      lines: [
        { at: a + 0.5, kind: 'cmd', text: 'claude', cps: 20 },
        { at: a + 1.3, kind: 'user', text: '/mcp', cps: 14 },
        { at: a + 2.0, kind: 'dim', text: 'MCP servers' },
        { at: a + 2.2, kind: 'ok', text: '  sn-mcp   ✔ connected · 14 tools' },
      ],
    });
  },
});
