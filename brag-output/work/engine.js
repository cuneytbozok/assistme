// Shared frame-pure video engine. Every visual is a pure function of time t (seconds).
export const W = 1920;
export const H = 1080;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const p = (t, a, b) => clamp((t - a) / (b - a));
export const eo = (x) => 1 - (1 - x) ** 3;
export const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const lerp = (a, b, x) => a + (b - a) * x;

const U = [];
export const SFX = [];
export const on = (fn) => U.push(fn);
export const sfx = (t, kind, gain = 1) => SFX.push({ t: +t.toFixed(3), kind, gain });

export function h(tag, cls = '', html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const LOGO = (size = 22, stroke = '#5eead4') =>
  `<svg viewBox="0 0 100 100" width="${size}" height="${size}" fill="none" stroke="${stroke}" stroke-width="15" stroke-linecap="round"><circle cx="44" cy="44" r="23"/><line x1="63" y1="63" x2="79" y2="79"/></svg>`;

// ---- stage ------------------------------------------------------------------------------
export function stage({ client, steps }) {
  const root = document.getElementById('stage');
  root.append(h('div', 'bg'), h('div', 'grain'));
  const bar = h('header', 'bar');
  bar.innerHTML = `<div class="brandchip"><span class="logo">${LOGO(30)}</span><span class="bname">sn-mcp</span>${client ? `<span class="x">×</span><span class="client">${client}</span>` : ''}</div>`;
  const stepsEl = h('div', 'steps');
  steps.forEach((s, i) => {
    const el = h('div', 'step', `<span class="n">${i + 1}</span><span class="l">${s.label}</span>`);
    stepsEl.append(el);
    on((t) => {
      el.classList.toggle('active', t >= s.a && t < s.b);
      el.classList.toggle('done', t >= s.b);
    });
  });
  bar.append(stepsEl);
  root.append(bar);
  const barShow = steps.length ? [steps[0].a - 0.4, steps[steps.length - 1].b + 0.1] : [0, 0];
  on((t) => {
    const v = p(t, barShow[0], barShow[0] + 0.4) * (1 - p(t, barShow[1], barShow[1] + 0.4));
    stepsEl.style.opacity = v;
    stepsEl.style.transform = `translateY(${(1 - v) * -12}px)`;
  });
  const scenes = h('div', 'scenes');
  root.append(scenes);
  const cursor = h('div', 'cursor', '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M4 2 L4 19 L8.6 14.8 L11.6 21.6 L14.6 20.3 L11.7 13.6 L18 13.4 Z" fill="#fff" stroke="#0b1214" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="ring"></span>');
  root.append(cursor);
  return { root, scenes, cursor };
}

// A scene fades/slides in at a, out at b (staggered: old content out before new in).
export function scene(parent, a, b, { fin = 0.45, fout = 0.35, dy = 26 } = {}) {
  const el = h('div', 'scene');
  parent.append(el);
  on((t) => {
    const vin = eo(p(t, a, a + fin));
    const vout = 1 - eio(p(t, b - fout, b));
    const v = Math.min(vin, vout);
    el.style.opacity = v;
    el.style.visibility = v <= 0.001 ? 'hidden' : 'visible';
    el.style.transform = `translateY(${(1 - vin) * dy - (1 - vout) * dy * 0.6}px)`;
  });
  return el;
}

// Fade an element in (with lift) between a and a+d, optionally out at b.
export function appear(el, a, d = 0.4, b = Infinity, dy = 18) {
  on((t) => {
    const v = eo(p(t, a, a + d)) * (1 - eio(p(t, b, b + 0.3)));
    el.style.opacity = v;
    el.style.transform = `translateY(${(1 - eo(p(t, a, a + d))) * dy}px)`;
  });
}

export function caption(parent, { kicker, title, sub, a, b, x = 120, y = 150, w = 1680, align = 'left' }) {
  const el = h('div', `caption ${align}`);
  el.style.cssText = `left:${x}px;top:${y}px;width:${w}px`;
  if (kicker) el.append(h('div', 'kicker', kicker));
  const ti = h('div', 'title', title);
  el.append(ti);
  let su;
  if (sub) {
    su = h('div', 'sub', sub);
    el.append(su);
  }
  parent.append(el);
  appear(ti, a, 0.5, b);
  if (su) appear(su, a + 0.25, 0.5, b);
  if (kicker) appear(el.firstChild, a, 0.4, b);
  return el;
}

export function win(parent, { x, y, w, hgt, title = '', kind = 'term', icon = '' }) {
  const el = h('div', `win ${kind}`);
  el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${hgt}px`;
  el.innerHTML = `<div class="tb"><span class="dots"><i></i><i></i><i></i></span><span class="wt">${icon}${title}</span></div>`;
  const body = h('div', 'body');
  el.append(body);
  parent.append(el);
  return { el, body };
}

// Terminal: lines [{at, text, kind, cps, prompt}] — kind: cmd | out | ok | dim | hl | warn | user | tool | ai | raw
export function terminal(parent, opts) {
  const { body, el } = win(parent, opts);
  body.classList.add('term-body');
  const inner = h('div', 'term-inner');
  body.append(inner);
  const rows = opts.lines.map((ln) => {
    const r = h('div', `ln ${ln.kind || 'out'}`);
    inner.append(r);
    const typedKinds = ['cmd', 'user'];
    const isTyped = typedKinds.includes(ln.kind) && ln.cps !== 0;
    const cps = ln.cps || 26;
    const dur = isTyped ? ln.text.length / cps : 0;
    if (isTyped) {
      for (let i = 0; i < ln.text.length; i += 3) sfx(ln.at + i / cps, 'key', 0.5);
      sfx(ln.at + dur + 0.12, 'enter', 0.7);
    } else if (ln.sound !== false && ln.kind !== 'raw') {
      sfx(ln.at, ln.kind === 'ok' ? 'tick' : 'blip', 0.35);
    }
    return { r, ln, isTyped, dur };
  });
  on((t) => {
    let last = null;
    for (const { r, ln, isTyped, dur } of rows) {
      const vis = t >= ln.at;
      r.style.display = vis ? 'block' : 'none';
      if (!vis) continue;
      const prompt = ln.prompt ?? (ln.kind === 'cmd' ? '<span class="pr">$</span> ' : ln.kind === 'user' ? '<span class="pr">&gt;</span> ' : '');
      if (isTyped) {
        const n = Math.min(ln.text.length, Math.floor((t - ln.at) * (ln.text.length / Math.max(dur, 1e-6))));
        r.innerHTML = prompt + esc(ln.text.slice(0, n));
        last = { r, typing: t < ln.at + dur + 0.12 };
      } else {
        r.innerHTML = prompt + (ln.html ?? esc(ln.text));
        r.style.opacity = eo(p(t, ln.at, ln.at + 0.18));
        last = { r, typing: false };
      }
    }
    for (const c of inner.querySelectorAll('.caret')) c.remove();
    if (last && opts.caret !== false) {
      const c = h('span', 'caret');
      const blink = last.typing || Math.floor(t * 2) % 2 === 0;
      c.style.opacity = blink ? 1 : 0;
      last.r.append(c);
    }
    const over = inner.scrollHeight - body.clientHeight + 40;
    inner.style.transform = `translateY(${-Math.max(0, over)}px)`;
  });
  return el;
}

// Editor showing a file; lines pasted in with a stagger at `at`.
export function editor(parent, opts) {
  const { body, el } = win(parent, { ...opts, kind: 'term editor' });
  const inner = h('div', 'ed-inner');
  body.append(inner);
  const rows = [...(opts.pre || []), ...opts.lines];
  const pre = (opts.pre || []).length;
  rows.forEach((txt, i) => {
    const r = h('div', 'eln', `<span class="no">${i + 1}</span><span class="tx">${opts.hl ? opts.hl(txt) : esc(txt)}</span>`);
    inner.append(r);
    if (i < pre) return;
    const at = opts.at + (i - pre) * 0.07;
    on((t) => {
      r.style.display = t >= at ? 'flex' : 'none';
      const hlv = 1 - p(t, opts.at + 1.0, opts.at + 2.2);
      r.style.background = `rgba(94,234,212,${0.13 * hlv})`;
    });
  });
  if (opts.lines.length) sfx(opts.at, 'paste', 0.8);
  return el;
}

export function tomlHl(s) {
  if (/^\s*\[/.test(s)) return `<span class="tk-sec">${esc(s)}</span>`;
  if (/^\s*#/.test(s)) return `<span class="tk-com">${esc(s)}</span>`;
  const m = s.match(/^(\s*[\w.-]+)(\s*=\s*)(.*)$/);
  if (!m) return esc(s);
  const val = m[3]
    .split(/("[^"]*")/)
    .map((part) => (part.startsWith('"') ? `<span class="tk-str">${esc(part)}</span>` : /^\d+$/.test(part) ? `<span class="tk-num">${part}</span>` : esc(part)))
    .join('');
  return `<span class="tk-key">${esc(m[1])}</span>${m[2]}${val}`;
}

// Cursor keyframes: [{t, x, y}], clicks: [t]
export function cursorPath(cursor, keys, clicks = []) {
  const ring = cursor.querySelector('.ring');
  clicks.forEach((c) => sfx(c, 'click', 0.8));
  on((t) => {
    if (!keys.length || t < keys[0].t - 0.3 || t > keys[keys.length - 1].t + (keys[keys.length - 1].hold ?? 0.6)) {
      cursor.style.opacity = 0;
      return;
    }
    let x = keys[0].x;
    let y = keys[0].y;
    for (let i = 0; i < keys.length - 1; i++) {
      const k0 = keys[i];
      const k1 = keys[i + 1];
      if (t >= k0.t && t <= k1.t) {
        const m = eio(p(t, k0.t, k1.t));
        x = lerp(k0.x, k1.x, m);
        y = lerp(k0.y, k1.y, m);
      } else if (t > k1.t) {
        x = k1.x;
        y = k1.y;
      }
    }
    const fade = p(t, keys[0].t - 0.3, keys[0].t) * (1 - p(t, keys[keys.length - 1].t + (keys[keys.length - 1].hold ?? 0.6) - 0.3, keys[keys.length - 1].t + (keys[keys.length - 1].hold ?? 0.6)));
    cursor.style.opacity = fade;
    let press = 0;
    let rv = 0;
    for (const c of clicks) {
      if (t >= c - 0.08 && t < c + 0.12) press = 1;
      if (t >= c && t < c + 0.5) rv = p(t, c, c + 0.5);
    }
    cursor.style.transform = `translate(${x}px,${y}px) scale(${press ? 0.86 : 1})`;
    ring.style.opacity = rv > 0 ? 1 - rv : 0;
    ring.style.transform = `translate(-50%,-50%) scale(${0.3 + rv * 1.4})`;
  });
}

// ---- the extension popup, rendered with the extension's real popup.css -------------------
let popupCss = '';
export async function loadPopupCss() {
  const css = await (await fetch('popup.css')).text();
  popupCss = css
    .replace(/:root/g, ':host')
    .replace(/(^|\n)body\s*\{/g, '$1.pbody {')
    .replace(/@media \(prefers-color-scheme: dark\)[\s\S]*?\n\}\n/, '');
}

const HEADER = `<header class="top"><div class="brand"><div class="logo">${LOGO(22)}</div><div><h1>ServiceNow Bridge</h1><p class="tagline">Read-only access for your AI assistant</p></div></div><span class="pill ok"><span class="dot"></span><span>Connected</span></span></header>`;

export function popupHost(parent, { x, y, scale = 1.6, w = 380 }) {
  const host = h('div', 'popup-host');
  host.style.cssText = `left:${x}px;top:${y}px;transform-origin:top left;transform:scale(${scale})`;
  const sr = host.attachShadow({ mode: 'open' });
  sr.innerHTML = `<style>${popupCss}
  .pbody{width:${w}px;border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.08)}
  main{display:grid;gap:14px;padding:14px 16px}
  .pulse{box-shadow:0 0 0 3px rgba(37,99,235,.35)}
  .hlcode{background:#fff4c2;border-radius:6px;padding:4px 6px;margin:-4px -6px}
  </style><div class="pbody">${HEADER}<main></main><footer>AI assistants can only use instances you add and approve here.</footer></div>`;
  parent.append(host);
  return { host, main: sr.querySelector('main'), root: sr, pbody: sr.querySelector('.pbody') };
}

export const instanceRow = (alias, host, env = 'dev', status = 'connected', label = '') =>
  `<li class="inst"><div class="inst-row"><span class="env ${env}">${env.toUpperCase()}</span><div class="inst-main"><div class="inst-title"><span>${alias}</span>${label ? `<span class="label">${label}</span>` : ''}</div><div class="inst-host mono">${host}</div><div class="status ${status}"><span class="dot"></span>${status === 'connected' ? 'Connected · signed in' : 'Allow access to read'}</div></div></div></li>`;

export const requestCard = ({ code, client, alias, host, purpose }) =>
  `<li class="card req"><div class="req-head"><div class="code"><span class="cc">${code}</span></div><div class="req-meta"><div>${client} · 10:42</div><div>expires in 4:58</div></div></div><div class="code-check">Approve only if your AI chat shows this same code. If it doesn't, ask it for the code, or deny.</div><div class="hint">wants read-only access to</div><div class="target"><span class="env dev">DEV</span><div class="inst-main"><div class="inst-title"><span>${alias}</span></div><div class="inst-host mono">${host}</div></div></div><div class="purpose"><small>Reason given by the AI assistant (unverified)</small>${purpose}</div><div class="field"><span>Access lasts</span><div class="segmented" style="grid-template-columns:repeat(3,1fr)"><button aria-pressed="false">1 hour</button><button aria-pressed="true">4 hours</button><button aria-pressed="false">8 hours</button></div></div><div class="buttons"><button class="ghost">Deny</button><button class="primary approve">Approve</button></div></li>`;

export const grantRow = (alias, host, client) =>
  `<li class="grant"><div class="badges"><span class="env dev">DEV</span></div><div class="inst-main"><div class="inst-title"><span>${alias}</span><span class="label">${client}</span></div><div class="grant-purpose">Read-only · 4 hours left</div><div class="sub mono">${host}</div></div></li>`;

// ---- boot -------------------------------------------------------------------------------
export async function boot(build) {
  await loadPopupCss();
  await document.fonts.load('600 40px Inter');
  await document.fonts.load('400 24px "JetBrains Mono"');
  const dur = await build();
  window.DURATION = dur;
  window.SFX = SFX.sort((a, b) => a.t - b.t);
  window.seek = (t) => {
    for (const u of U) u(t);
  };
  window.seek(0);
  await document.fonts.ready;
  window.READY = true;
}
