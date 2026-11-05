import {
  appear, boot, caption, cursorPath, eo, grantRow, h, instanceRow, LOGO, on, p, popupHost,
  requestCard, scene, sfx, stage, terminal,
} from './engine.js';

const HOST = 'dev12345.service-now.com';
const URL = `https://${HOST}`;
const CODE = 'K7QF-2M';
const ID = 'clipfeocpiljpcngmjpdbegciimchbol';

const css = `
.browser{position:absolute;left:120px;top:330px;width:1680px;height:720px;border-radius:18px;overflow:hidden;background:#f3f4f6;box-shadow:0 40px 120px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);font-family:Inter,sans-serif;color:#1f2328}
.tabs{height:50px;background:#dfe3e8;display:flex;align-items:flex-end;padding:0 16px;gap:4px}
.tabs .dots{display:flex;gap:9px;align-self:center;margin-right:18px}.tabs .dots i{width:14px;height:14px;border-radius:50%;display:block}
.tabs .dots i:nth-child(1){background:#ff5f57}.tabs .dots i:nth-child(2){background:#febc2e}.tabs .dots i:nth-child(3){background:#28c840}
.tab{height:40px;padding:0 22px;display:flex;align-items:center;gap:10px;border-radius:10px 10px 0 0;font-size:17px;color:#4b5563;min-width:250px}
.tab.on{background:#fff;color:#111}
.tab .fav{width:18px;height:18px;border-radius:4px;background:#9ca3af}
.omni{height:60px;background:#fff;display:flex;align-items:center;gap:16px;padding:0 18px;border-bottom:1px solid #e5e7eb}
.omni .nav{color:#9ca3af;font-size:22px;letter-spacing:10px}
.omni .url{flex:1;height:40px;border-radius:20px;background:#f1f3f4;display:flex;align-items:center;padding:0 20px;font-size:18px;color:#202124}
.tbi{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;position:relative}
.tbi.pinned{background:#0f3d3e;border-radius:10px;width:36px;height:36px}
.page{position:absolute;left:0;right:0;top:110px;bottom:0;background:#fff}
.xhead{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid #e5e7eb;font-size:24px;font-weight:600}
.dev{display:flex;align-items:center;gap:14px;font-size:18px;font-weight:500;color:#374151}
.tog{width:44px;height:24px;border-radius:12px;background:#c4c7cc;position:relative}
.tog i{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.tog.on{background:#1a73e8}
.xbar{height:0;overflow:hidden;display:flex;align-items:center;gap:14px;padding:0 28px;border-bottom:1px solid #e5e7eb}
.xbtn{padding:9px 18px;border:1px solid #c9ccd1;border-radius:8px;font-size:17px;color:#1a73e8;font-weight:500;background:#fff}
.xcard{position:absolute;left:28px;top:150px;width:560px;border:1px solid #e5e7eb;border-radius:12px;padding:22px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.xcard .row{display:flex;gap:16px;align-items:flex-start}
.xcard .ic{width:52px;height:52px;border-radius:12px;background:#0f3d3e;display:grid;place-items:center;flex:none}
.xcard .nm{font-size:21px;font-weight:600}.xcard .ver{color:#6b7280;font-weight:400;font-size:17px;margin-left:8px}
.xcard .ds{color:#4b5563;font-size:16px;margin-top:4px}
.xcard .id{margin-top:10px;font:15px/1.4 "JetBrains Mono",monospace;color:#374151;padding:2px 6px;border-radius:6px}
.xcard .ft{display:flex;justify-content:space-between;align-items:center;margin-top:18px}
.xcard .ft span{color:#1a73e8;font-size:16px;font-weight:500}
.pick{position:absolute;left:50%;top:40px;width:820px;margin-left:-410px;background:#fff;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.08);overflow:hidden}
.pick .crumb{padding:18px 24px;border-bottom:1px solid #e5e7eb;font-size:18px;color:#4b5563}
.pick .crumb b{color:#111}
.pick .it{display:flex;align-items:center;gap:14px;padding:12px 24px;font-size:18px}
.pick .it .fd{width:24px;height:19px;border-radius:3px;background:#7aa7e0}
.pick .it.sel{background:#dbe8fd}
.pick .act{display:flex;justify-content:flex-end;gap:12px;padding:16px 24px;border-top:1px solid #e5e7eb}
.pick .b{padding:9px 22px;border-radius:8px;font-size:17px;border:1px solid #d1d5db}.pick .b.pr{background:#1a73e8;color:#fff;border-color:#1a73e8}
.menu{position:absolute;right:20px;top:110px;width:440px;background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.06);padding:12px 0;font-size:18px}
.menu .mh{padding:6px 20px 12px;color:#6b7280;font-size:15px}
.menu .mi{display:flex;align-items:center;gap:14px;padding:12px 20px}
.menu .mi .ic{width:28px;height:28px;border-radius:7px;background:#0f3d3e;display:grid;place-items:center}
.menu .mi .pin{margin-left:auto;color:#9ca3af}.menu .mi .pin.on{color:#1a73e8}
.sn{position:absolute;inset:0;background:#f7f8fa}
.sn .top{height:56px;background:#293e40;display:flex;align-items:center;padding:0 24px;color:#e5f0ef;font-size:18px;font-weight:600;gap:12px}
.sn .sk{position:absolute;left:24px;right:24px;top:90px;display:grid;gap:14px}
.sn .sk i{height:22px;border-radius:6px;background:#e7e9ee;display:block}
.perm{position:absolute;left:520px;top:56px;z-index:3;width:470px;background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.08);padding:22px 24px;font-size:17px}
.perm .t{font-weight:600;font-size:19px;margin-bottom:10px}
.perm .act{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.perm .b{padding:9px 22px;border-radius:18px;border:1px solid #d1d5db;color:#1a73e8;font-weight:500}.perm .b.pr{background:#1a73e8;color:#fff;border-color:#1a73e8}
`;

boot(async () => {
  document.head.append(h('style', '', css));
  const T = { s1: [0, 4.4], s2: [4.4, 12.6], s3: [12.6, 16.6], s4: [16.6, 25.0], s5: [25.0, 31.4], s6: [31.4, 35.2] };
  const { scenes, cursor } = stage({
    client: 'Chrome extension',
    steps: [
      { label: 'Load', a: T.s2[0], b: T.s2[1] },
      { label: 'Pin', a: T.s3[0], b: T.s3[1] },
      { label: 'Add instance', a: T.s4[0], b: T.s4[1] },
      { label: 'Approve', a: T.s5[0], b: T.s5[1] },
    ],
  });
  const clicks = [];
  const keys = [];

  // ---- S1 hook ------------------------------------------------------------------------
  {
    const sc = scene(scenes, T.s1[0], T.s1[1], { fin: 0.01 });
    caption(sc, {
      title: 'The part of <em>sn-mcp</em><br>that lives in Chrome.',
      sub: 'It uses your signed-in ServiceNow tab, so your password, cookies and tokens never leave the browser.',
      a: 0.15, b: 99, x: 120, y: 330, w: 900,
    });
    const pop = popupHost(sc, { x: 1150, y: 230, scale: 1.45 });
    pop.main.innerHTML = `<section><div class="section-head"><h2>Instances</h2><button class="ghost small">+ Add</button></div><ul class="card list" style="margin-top:8px">${instanceRow('dev', HOST, 'dev', 'connected', 'My PDI')}</ul></section><section><h2>Access requests</h2><ul class="stack" style="margin-top:8px"><li class="card req"><div class="req-head"><div class="code">${CODE}</div><div class="req-meta"><div>Claude Code · 10:42</div><div>expires in 4:58</div></div></div><div class="buttons"><button class="ghost">Deny</button><button class="primary">Approve</button></div></li></ul></section>`;
    appear(pop.pbody, 0.5, 0.6);
    sfx(0.5, 'whoosh', 0.6);
  }

  // ---- S2–S4: one persistent browser ---------------------------------------------------
  const bsc = scene(scenes, T.s2[0], T.s4[1]);
  caption(bsc, {
    kicker: 'Step 1', title: 'Load it unpacked from <code>packages/extension/dist</code>',
    sub: 'Run <code>npm install</code> and <code>npm run setup</code> first: setup builds it and installs the native host.',
    a: T.s2[0] + 0.1, b: T.s2[1] - 0.35, x: 120, y: 100, w: 1700,
  });
  caption(bsc, { kicker: 'Step 2', title: 'Pin it to the toolbar', a: T.s3[0], b: T.s3[1] - 0.35, x: 120, y: 100, w: 1700 });
  caption(bsc, {
    kicker: 'Step 3', title: 'Sign in, then add your instance',
    sub: 'Not clearly dev or test? Pick <b style="color:#e9f3f2">Other</b>: it gets production’s strict rules.',
    a: T.s4[0], b: 99, x: 120, y: 100, w: 1700,
  });
  const br = h('div', 'browser');
  bsc.append(br);
  br.innerHTML = `
  <div class="tabs"><span class="dots"><i></i><i></i><i></i></span>
    <div class="tab t-ext on"><span class="fav" style="background:#5f6368"></span>Extensions</div>
    <div class="tab t-sn"><span class="fav" style="background:#62d84e"></span>${HOST}</div></div>
  <div class="omni"><span class="nav">‹ › ↻</span><div class="url"><span class="u">chrome://extensions</span></div>
    <div class="tbi pinned" style="opacity:0">${LOGO(22)}</div>
    <div class="tbi puzzle"><svg width="26" height="26" viewBox="0 0 24 24" fill="#5f6368"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z"/></svg></div>
    <div class="tbi"><span style="width:30px;height:30px;border-radius:50%;background:#c7d2fe;display:block"></span></div></div>
  <div class="page p-ext">
    <div class="xhead">Extensions<div class="dev">Developer mode <span class="tog"><i></i></span></div></div>
    <div class="xbar"><span class="xbtn lu">Load unpacked</span><span class="xbtn">Pack extension</span><span class="xbtn">Update</span></div>
    <div class="xcard"><div class="row"><div class="ic">${LOGO(30)}</div><div><div class="nm">sn-mcp Session Bridge<span class="ver">0.0.1</span></div><div class="ds">Read-only ServiceNow access for your AI assistant</div><div class="id">ID: ${ID}</div></div></div>
      <div class="ft"><span>Details · Remove</span><span class="tog on"><i style="left:23px"></i></span></div></div>
    <div class="pick"><div class="crumb">AssistMe › packages › extension › <b>dist</b></div>
      <div class="it"><span class="fd"></span>background</div><div class="it"><span class="fd"></span>icons</div><div class="it"><span class="fd"></span>popup</div>
      <div class="act"><span class="b">Cancel</span><span class="b pr sel-btn">Select</span></div></div>
  </div>
  <div class="page p-sn"><div class="sn"><div class="top">${HOST}</div><div class="sk"><i style="width:40%"></i><i style="width:85%"></i><i style="width:70%"></i><i style="width:78%"></i><i style="width:55%"></i></div></div></div>
  <div class="menu"><div class="mh">Extensions · Full access</div><div class="mi"><span class="ic">${LOGO(18)}</span>sn-mcp Session Bridge<span class="pin">📌</span></div></div>
  <div class="perm"><div class="t">sn-mcp Session Bridge</div>wants to: Read and change your data on ${HOST}<div class="act"><span class="b">Deny</span><span class="b pr allow">Allow</span></div></div>`;
  const q = (s) => br.querySelector(s);
  const [togDev] = [q('.dev .tog')];
  const xbar = q('.xbar');
  const card = q('.xcard');
  const pick = q('.pick');
  const menu = q('.menu');
  const pinned = q('.pinned');
  const perm = q('.perm');
  const pExt = q('.p-ext');
  const pSn = q('.p-sn');
  const url = q('.u');
  const pinIcon = q('.menu .pin');
  const idEl = q('.xcard .id');

  // Step 1 timings
  const a = T.s2[0];
  const tTog = a + 1.5;
  const tLU = a + 2.7;
  const tSel = a + 4.2;
  // Step 2
  const tPuz = T.s3[0] + 0.7;
  const tPin = T.s3[0] + 1.7;
  // Step 3
  const tTab = T.s4[0] + 0.3;
  const tIcon = T.s4[0] + 1.0;
  const tAdd = T.s4[0] + 1.9;
  const tUrl = tAdd + 0.5;
  const tAlias = tUrl + URL.length / 28 + 0.3;
  const tEnv = tAlias + 0.8;
  const tSubmit = tEnv + 0.8;
  const tAllow = tSubmit + 1.4;

  // popup (step 3), attached to the browser frame
  const pop = popupHost(bsc, { x: 1250, y: 436, scale: 1.1 });
  pop.main.innerHTML = `<section><div class="section-head"><h2>Instances</h2><button class="ghost small addb">+ Add</button></div>
    <form class="card form" style="margin-top:8px"><div class="form-title">Add an instance</div>
      <label class="field"><span>Instance URL</span><input class="iu" type="text" placeholder="https://dev12345.service-now.com"></label>
      <div class="row2"><label class="field"><span>Alias</span><input class="ia" type="text" placeholder="dev"></label><label class="field"><span>Label <em>optional</em></span><input type="text" placeholder="My PDI"></label></div>
      <div class="field"><span>Environment</span><div class="segmented envs"><button type="button">DEV</button><button type="button">TEST</button><button type="button">PROD</button><button type="button">Other</button></div><small class="hint eh">Pick one. PROD and Other get the strictest approval rules.</small></div>
      <div class="buttons"><button type="button" class="ghost">Cancel</button><button type="button" class="primary sub">Add and allow access</button></div></form>
    <div class="empty"><p><strong>No instances yet.</strong></p><p>Add the ServiceNow instance you want your AI assistant to read from. Chrome will ask you to allow that one site.</p></div>
    <ul class="card list il" style="margin-top:8px">${instanceRow('dev', HOST, 'dev', 'connected')}</ul></section>`;
  const P = (s) => pop.main.querySelector(s);
  const form = P('form');
  const empty = P('.empty');
  const il = P('.il');
  const iu = P('.iu');
  const ia = P('.ia');
  const envDev = P('.envs button');
  const eh = P('.eh');
  const addb = P('.addb');
  for (let i = 0; i < URL.length; i += 3) sfx(tUrl + i / 28, 'key', 0.45);
  sfx(tAlias, 'key', 0.45);
  sfx(tAlias + 0.1, 'key', 0.45);
  sfx(tIcon + 0.1, 'whoosh', 0.5);
  sfx(tSubmit + 0.15, 'chime', 0.5);
  sfx(tAllow + 0.2, 'tick', 0.7);

  on((t) => {
    const devOn = t >= tTog;
    togDev.classList.toggle('on', devOn);
    togDev.firstChild.style.left = devOn ? '23px' : '3px';
    const xb = eo(p(t, tTog, tTog + 0.35));
    xbar.style.height = `${xb * 64}px`;
    const pk = eo(p(t, tLU + 0.1, tLU + 0.4)) * (1 - p(t, tSel + 0.05, tSel + 0.25));
    pick.style.opacity = pk;
    pick.style.display = pk > 0 ? 'block' : 'none';
    pick.querySelectorAll('.it').forEach((it) => it.classList.remove('sel'));
    const cv = eo(p(t, tSel + 0.3, tSel + 0.7));
    card.style.opacity = cv;
    card.style.transform = `translateY(${(1 - cv) * 20 + (1 - xb) * -64}px)`;
    const idHl = p(t, tSel + 1.0, tSel + 1.3) * (1 - p(t, T.s2[1] - 0.6, T.s2[1] - 0.2));
    idEl.style.background = `rgba(94,234,212,${0.35 * idHl})`;
    // pin
    const mv = eo(p(t, tPuz + 0.05, tPuz + 0.3)) * (1 - p(t, tPin + 0.5, tPin + 0.8));
    menu.style.opacity = mv;
    menu.style.display = mv > 0 ? 'block' : 'none';
    pinIcon.classList.toggle('on', t >= tPin);
    const pv = eo(p(t, tPin + 0.1, tPin + 0.45));
    pinned.style.opacity = pv;
    pinned.style.transform = `scale(${0.6 + 0.4 * pv})`;
    pinned.style.boxShadow = t > tPin && t < T.s3[1] ? `0 0 0 ${4 + 4 * Math.sin((t - tPin) * 6)}px rgba(94,234,212,.35)` : 'none';
    // tab switch
    const onSn = t >= tTab;
    q('.t-ext').classList.toggle('on', !onSn);
    q('.t-sn').classList.toggle('on', onSn);
    pExt.style.display = onSn ? 'none' : 'block';
    pSn.style.display = onSn ? 'block' : 'none';
    url.textContent = onSn ? URL : 'chrome://extensions';
    // popup
    const po = eo(p(t, tIcon + 0.05, tIcon + 0.35));
    pop.host.style.opacity = po;
    pop.host.style.display = po > 0 ? 'block' : 'none';
    pop.host.style.transform = `translateY(${(1 - po) * -14}px) scale(1.1)`;
    const added = t >= tAllow + 0.15;
    const formOpen = t >= tAdd && !added;
    form.style.display = formOpen ? 'grid' : 'none';
    empty.style.display = t < tAdd ? 'block' : 'none';
    il.style.display = added ? 'block' : 'none';
    addb.textContent = formOpen ? 'Close' : '+ Add';
    iu.value = URL.slice(0, Math.max(0, Math.floor((t - tUrl) * 28)));
    ia.value = t >= tAlias + 0.1 ? 'dev' : t >= tAlias ? 'd' : '';
    envDev.setAttribute('aria-pressed', String(t >= tEnv));
    eh.textContent = t >= tEnv ? 'Each approval lasts up to 4 h.' : 'Pick one. PROD and Other get the strictest approval rules.';
    const pm = eo(p(t, tSubmit + 0.15, tSubmit + 0.4)) * (1 - p(t, tAllow + 0.05, tAllow + 0.2));
    perm.style.opacity = pm;
    perm.style.display = pm > 0 ? 'block' : 'none';
  });

  // cursor: positions measured from the laid-out DOM (stage has no offset)
  const c = (el, fx = 0.5, fy = 0.5) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  };
  // temporarily show hidden pieces to measure them
  for (const el of [pick, menu, perm]) el.style.display = 'block';
  form.style.display = 'grid';
  const pos = {
    tog: c(togDev), lu: c(q('.lu')), sel: c(q('.sel-btn')), puz: c(q('.puzzle')),
    pin: c(pinIcon), icon: c(pinned), add: c(addb), url: c(iu, 0.3), alias: c(ia, 0.3),
    env: c(envDev), sub: c(P('.sub'), 0.4), allow: c(q('.allow')),
  };
  for (const el of [pick, menu, perm]) el.style.display = 'none';
  const k = (t, o) => keys.push({ t, x: o.x, y: o.y });
  k(a + 0.6, { x: 1200, y: 900 });
  k(tTog - 0.05, pos.tog); clicks.push(tTog);
  k(tLU - 0.05, pos.lu); clicks.push(tLU);
  k(tSel - 0.05, pos.sel); clicks.push(tSel);
  k(tSel + 0.9, { x: pos.sel.x - 300, y: 560 });
  k(tPuz - 0.05, pos.puz); clicks.push(tPuz);
  k(tPin - 0.05, pos.pin); clicks.push(tPin);
  k(tIcon - 0.05, pos.icon); clicks.push(tIcon);
  k(tAdd - 0.05, pos.add); clicks.push(tAdd);
  k(tUrl - 0.05, pos.url); clicks.push(tUrl - 0.05);
  k(tAlias - 0.1, pos.alias); clicks.push(tAlias - 0.1);
  k(tEnv - 0.05, pos.env); clicks.push(tEnv);
  k(tSubmit - 0.05, pos.sub); clicks.push(tSubmit);
  k(tAllow - 0.05, pos.allow); clicks.push(tAllow);
  keys.push({ t: tAllow + 0.6, x: pos.allow.x + 80, y: pos.allow.y + 260, hold: 0.8 });

  // ---- S5 approve ---------------------------------------------------------------------
  {
    const a5 = T.s5[0];
    const sc = scene(scenes, a5, T.s5[1]);
    caption(sc, {
      kicker: 'Step 4', title: 'When your AI asks, approve only a <em>matching code</em>.',
      a: a5 + 0.1, b: 99, x: 80, y: 130, w: 1760,
    });
    const tCode = a5 + 0.9;
    const tClick = tCode + 2.8;
    terminal(sc, {
      x: 80, y: 290, w: 1040, hgt: 520, title: 'your AI client',
      lines: [
        { at: a5 + 0.3, kind: 'tool', text: '● sn-mcp · request_scope  dev · read-only' },
        { at: tCode, kind: 'ai', text: '', html: `Approve the request in the Chrome extension.<br>Approval code: <span class="code-badge">${CODE}</span>` },
        { at: tClick + 0.5, kind: 'ok', text: '✓ Access granted for 4 hours' },
      ],
    });
    const n = h('div', 'note', '<b>Access ends</b> when it expires, when you click Revoke, or when Chrome restarts.');
    n.style.cssText = 'left:80px;top:860px;width:1040px';
    sc.append(n);
    appear(n, tClick + 0.6);
    const pop5 = popupHost(sc, { x: 1200, y: 290, scale: 1.3 });
    pop5.main.innerHTML = `<section class="reqs"><h2>Access requests</h2><p class="hint" style="margin:4px 0 10px">Approve only if the code matches the one your AI assistant showed you.</p><ul class="stack">${requestCard({ code: CODE, client: 'Claude Code', alias: 'dev', host: HOST, purpose: 'List the five most recent incidents.' })}</ul></section><section class="grants" style="display:none"><h2>Active access</h2><ul class="card list" style="margin-top:8px">${grantRow('dev', HOST, 'Claude Code')}</ul></section><div class="toast" style="display:none;position:static;margin:0">Approved for 4 hours. It can now use it.</div>`;
    const reqs = pop5.main.querySelector('.reqs');
    const grants = pop5.main.querySelector('.grants');
    const toast = pop5.main.querySelector('.toast');
    const cc = pop5.main.querySelector('.cc');
    const approve = pop5.main.querySelector('.approve');
    sfx(tCode + 0.2, 'chime', 0.9);
    on((t) => {
      const v = eo(p(t, a5 + 0.4, a5 + 0.8));
      pop5.host.style.opacity = v;
      pop5.host.style.transform = `translateY(${(1 - v) * 30}px) scale(1.3)`;
      const done = t >= tClick + 0.15;
      reqs.style.display = done ? 'none' : 'block';
      grants.style.display = done ? 'block' : 'none';
      toast.style.display = done && t < tClick + 3 ? 'block' : 'none';
      cc.className = t > tCode + 0.6 && !done ? 'cc hlcode' : 'cc';
      approve.style.filter = t >= tClick - 0.1 && t < tClick + 0.15 ? 'brightness(0.85)' : '';
    });
    const ar = approve.getBoundingClientRect();
    const cr = cc.getBoundingClientRect();
    keys.push({ t: tCode + 0.6, x: ar.left + 40, y: 1060 });
    keys.push({ t: tCode + 1.2, x: cr.right + 20, y: cr.bottom - 5 });
    keys.push({ t: tCode + 1.9, x: cr.right + 20, y: cr.bottom - 5 });
    keys.push({ t: tClick - 0.05, x: ar.left + ar.width * 0.45, y: ar.top + ar.height * 0.45, hold: 0.9 });
    clicks.push(tClick);
  }
  cursorPathSplit(cursor, keys, clicks);

  // ---- S6 outro -----------------------------------------------------------------------
  {
    const [a6] = T.s6;
    const sc = scene(scenes, a6, T.s6[1] + 1, { fin: 0.5 });
    const logo = h('div', 'outro-logo', LOGO(92));
    sc.append(logo);
    appear(logo, a6 + 0.1, 0.5);
    caption(sc, {
      title: 'Bridge installed. Now <em>connect your AI</em>.',
      sub: 'Claude Code · Codex CLI · Mistral Vibe: each has its own setup video.',
      a: a6 + 0.3, b: 99, x: 0, y: 460, w: 1920, align: 'center',
    });
    const chips = h('div', 'chips');
    chips.style.top = '760px';
    ['<b>Read-only</b>', 'You approve every instance', 'Your password stays in Chrome'].forEach((cl, i) => {
      const el = h('div', 'chip', cl);
      chips.append(el);
      appear(el, a6 + 0.9 + i * 0.18, 0.4);
    });
    sc.append(chips);
    sfx(a6 + 0.1, 'swell', 1);
  }
  return T.s6[1];
});

// Cursor that hides between far-apart keyframe groups (gap > 2.5 s).
function cursorPathSplit(cursor, keys, clicks) {
  keys.sort((x, y) => x.t - y.t);
  const groups = [[keys[0]]];
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].t - keys[i - 1].t > 2.5) groups.push([]);
    groups[groups.length - 1].push(keys[i]);
  }
  // one cursor element per group, sharing the same look
  groups.forEach((g, i) => {
    const el = i === 0 ? cursor : cursor.cloneNode(true);
    if (i) cursor.parentNode.append(el);
    const lo = g[0].t - 0.3;
    const hi = g[g.length - 1].t + (g[g.length - 1].hold ?? 0.6);
    cursorPath(el, g, clicks.filter((c) => c >= lo && c <= hi));
  });
}
