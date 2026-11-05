import {
  appear, boot, caption, cursorPath, editor, eo, grantRow, h, LOGO, on, p, popupHost,
  requestCard, scene, sfx, stage, terminal, tomlHl,
} from './engine.js';

const ROOT = '/Users/you/AssistMe';
const SERVER = `${ROOT}/packages/server/dist/bin/mcp-server.js`;
const HOST = 'dev12345.service-now.com';
const CODE = 'K7QF-2M';

// cfg: { client, short, bin, label, connect(sc, T), check(sc, T), extraAsk: [] }
export function cliVideo(cfg) {
  boot(async () => {
    const T = { s1: [0, 4.4], s2: [4.4, 10.4], s3: [10.4, 19.6], s4: [19.6, 24.2], s5: [24.2, 32.2], s6: [32.2, 36] };
    const { scenes, cursor } = stage({
      client: cfg.client,
      steps: [
        { label: 'Install', a: T.s2[0], b: T.s2[1] },
        { label: 'Connect', a: T.s3[0], b: T.s3[1] },
        { label: 'Check', a: T.s4[0], b: T.s4[1] },
        { label: 'Approve', a: T.s5[0], b: T.s5[1] },
      ],
    });

    // S1 — hook: the question, then the promise.
    {
      const sc = scene(scenes, T.s1[0], T.s1[1], { fin: 0.01 });
      caption(sc, {
        title: `Ask <em>${cfg.client}</em> about your ServiceNow.`,
        sub: 'Read-only, through your own Chrome session. Set up in four steps.',
        a: 0.15, b: 99, y: 170, x: 0, w: 1920, align: 'center',
      });
      terminal(sc, {
        x: 310, y: 400, w: 1300, hgt: 400, title: `${cfg.bin} — ~/AssistMe`,
        lines: [
          { at: 0.7, kind: 'user', text: 'Why did INC0010023 change state yesterday?', cps: 40 },
          { at: 2.1, kind: 'tool', text: '● sn-mcp · get_record_history  incident INC0010023' },
          { at: 2.5, kind: 'tool', text: '● sn-mcp · query_records  sys_audit  (read-only)' },
          { at: 3.0, kind: 'ai', text: 'A business rule moved it to "On Hold" at 16:05 after…', sound: false },
        ],
      });
    }

    // S2 — install
    {
      const sc = scene(scenes, T.s2[0], T.s2[1]);
      caption(sc, {
        kicker: 'Step 1', title: 'Install and<br>run setup',
        sub: 'In the project folder.<br>Needs Node 22.18+ and Google Chrome.',
        a: T.s2[0] + 0.1, b: 99, x: 120, y: 250, w: 640,
      });
      const n = h('div', 'note', '<b>Chrome extension not loaded yet?</b><br>It has its own setup video.');
      n.style.cssText = 'left:120px;top:760px;width:600px';
      sc.append(n);
      appear(n, T.s2[0] + 1.2);
      const a = T.s2[0] + 0.5;
      terminal(sc, {
        x: 800, y: 200, w: 1000, hgt: 760, title: 'Terminal — ~/AssistMe',
        lines: [
          { at: a, kind: 'cmd', text: 'npm install', cps: 22 },
          { at: a + 1.0, kind: 'dim', text: 'added packages, 0 vulnerabilities' },
          { at: a + 1.5, kind: 'cmd', text: 'npm run setup', cps: 22 },
          { at: a + 2.4, kind: 'dim', text: 'Building shared, server, extension…' },
          { at: a + 3.0, kind: 'ok', text: '✓ Native host installed' },
          { at: a + 3.4, kind: 'hl', text: 'Next steps (details in docs/INSTALL.md):' },
          { at: a + 3.6, kind: 'dim', text: '1. Chrome extension …', sound: false },
          { at: a + 3.7, kind: 'dim', text: '2. Register your instance …', sound: false },
          { at: a + 3.8, kind: 'dim', text: `3. Connect ${cfg.setupLine} …`, sound: false },
        ],
      });
    }

    // S3 — client-specific connect
    {
      const sc = scene(scenes, T.s3[0], T.s3[1]);
      cfg.connect(sc, T.s3[0], { ROOT, SERVER, caption, terminal, editor, tomlHl, h, appear });
    }

    // S4 — check
    {
      const sc = scene(scenes, T.s4[0], T.s4[1]);
      cfg.check(sc, T.s4[0], { caption, terminal, h, appear });
    }

    // S5 — first question + approval code
    {
      const a = T.s5[0];
      const sc = scene(scenes, a, T.s5[1]);
      caption(sc, {
        kicker: 'Step 4', title: 'Ask. Then approve the <em>matching code</em> in Chrome.',
        a: a + 0.1, b: 99, x: 80, y: 130, w: 1760,
      });
      const ask = 'List my ServiceNow instances, then show me the five most recent incidents on dev.';
      const tA = a + 0.5;
      const tAsk = tA + ask.length / 48;
      const extra = cfg.extraAsk ? cfg.extraAsk(tAsk) : [];
      const shift = extra.length ? 0.5 : 0;
      const tCode = tAsk + 1.1 + shift;
      const tClick = tCode + 2.3;
      terminal(sc, {
        x: 80, y: 290, w: 1040, hgt: 740, title: `${cfg.bin} — ~/AssistMe`,
        lines: [
          { at: tA, kind: 'user', text: ask, cps: 48 },
          { at: tAsk + 0.3, kind: 'tool', text: '● sn-mcp · list_instances' },
          ...extra,
          { at: tAsk + 0.7 + shift, kind: 'tool', text: '● sn-mcp · request_scope  dev · read-only' },
          {
            at: tCode, kind: 'ai', text: '',
            html: `Approve the request in the Chrome extension.<br>Approval code: <span class="code-badge">${CODE}</span>`,
          },
          { at: tClick + 0.5, kind: 'tool', text: '● sn-mcp · claim_scope  ✓ granted, 4 hours' },
          { at: tClick + 0.8, kind: 'tool', text: '● sn-mcp · query_records  incident' },
          { at: tClick + 1.2, kind: 'raw', html: '<span class="tbl">INC0010031  P2  Email delivery delayed</span>', text: '' },
          { at: tClick + 1.3, kind: 'raw', html: '<span class="tbl">INC0010030  P3  VPN drops on reconnect</span>', text: '' },
          { at: tClick + 1.4, kind: 'raw', html: '<span class="tbl">INC0010029  P4  Printer queue stuck</span>', text: '' },
        ],
      });
      // popup
      const pop = popupHost(sc, { x: 1200, y: 290, scale: 1.3 });
      pop.main.innerHTML = `<section class="reqs"><h2>Access requests</h2><p class="hint" style="margin:4px 0 10px">Approve only if the code matches the one your AI assistant showed you.</p><ul class="stack">${requestCard({ code: CODE, client: cfg.label, alias: 'dev', host: HOST, purpose: 'List the five most recent incidents.' })}</ul></section><section class="grants" style="display:none"><h2>Active access</h2><ul class="card list" style="margin-top:8px">${grantRow('dev', HOST, cfg.label)}</ul></section><div class="toast" style="display:none;position:static;margin:0">Approved for 4 hours. It can now use it.</div>`;
      const reqs = pop.main.querySelector('.reqs');
      const grants = pop.main.querySelector('.grants');
      const toast = pop.main.querySelector('.toast');
      const cc = pop.main.querySelector('.cc');
      const approve = pop.main.querySelector('.approve');
      sfx(tCode + 0.2, 'chime', 0.9);
      on((t) => {
        const v = eo(p(t, tCode + 0.15, tCode + 0.6));
        pop.host.style.opacity = v;
        pop.host.style.transform = `translateY(${(1 - v) * 30}px) scale(1.3)`;
        const done = t >= tClick + 0.15;
        reqs.style.display = done ? 'none' : 'block';
        grants.style.display = done ? 'block' : 'none';
        toast.style.display = done && t < tClick + 3 ? 'block' : 'none';
        cc.className = t > tCode + 0.9 && !done ? 'cc hlcode' : 'cc';
        approve.style.filter = t >= tClick - 0.1 && t < tClick + 0.15 ? 'brightness(0.85)' : '';
      });
      // Approve button location (popup scaled 1.4): measured from stills.
      const ar = approve.getBoundingClientRect();
      const cr = cc.getBoundingClientRect();
      cursorPath(cursor, [
        { t: tCode + 0.6, x: ar.left + 40, y: 1060 },
        { t: tCode + 1.2, x: cr.right + 20, y: cr.bottom - 5 },
        { t: tCode + 1.7, x: cr.right + 20, y: cr.bottom - 5 },
        { t: tClick - 0.05, x: ar.left + ar.width * 0.45, y: ar.top + ar.height * 0.45, hold: 0.9 },
      ], [tClick]);
    }

    // S6 — outro
    {
      const [a] = T.s6;
      const sc = scene(scenes, a, T.s6[1] + 1, { fin: 0.5 });
      const logo = h('div', 'outro-logo', LOGO(92));
      sc.append(logo);
      appear(logo, a + 0.1, 0.5);
      caption(sc, {
        title: `Your ServiceNow, readable by <em>${cfg.client}</em>.`,
        sub: 'Full guide and troubleshooting: <code>docs/INSTALL.md</code>',
        a: a + 0.3, b: 99, x: 0, y: 460, w: 1920, align: 'center',
      });
      const chips = h('div', 'chips');
      chips.style.top = '760px';
      ['<b>Read-only</b>', 'You approve every instance', 'Your password stays in Chrome'].forEach((c, i) => {
        const el = h('div', 'chip', c);
        chips.append(el);
        appear(el, a + 0.9 + i * 0.18, 0.4);
      });
      sc.append(chips);
      sfx(a + 0.1, 'swell', 1);
    }
    return T.s6[1];
  });
}
