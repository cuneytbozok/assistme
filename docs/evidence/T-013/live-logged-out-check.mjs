// Throwaway headed Chrome: logged-out PDI (guest session from login.do), real extension code
// (test-only manifest copy with a host permission). Asks the popup for status (probe).
import { spawn } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';

const [src, work, profile] = process.argv.slice(2);
cpSync(src, work, { recursive: true });
const m = JSON.parse(readFileSync(`${work}/manifest.json`, 'utf8'));
m.host_permissions = ['https://dev469966.service-now.com/*'];
writeFileSync(`${work}/manifest.json`, JSON.stringify(m));
const port = 9346;
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50; i++) {
  try {
    ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await sleep(200);
  }
}
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const waiting = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const x = JSON.parse(e.data);
  if (x.id && waiting.has(x.id)) {
    waiting.get(x.id)(x);
    waiting.delete(x.id);
  } else events.push(x);
});
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const id = ++seq;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const ID = (await send('Extensions.loadUnpacked', { path: work })).result.id;
await sleep(1500);
async function attach(pred) {
  for (let i = 0; i < 30; i++) {
    const { result } = await send('Target.getTargets');
    const t = result.targetInfos.find(pred);
    if (t) {
      const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await send('Runtime.enable', {}, a.result.sessionId);
      return a.result.sessionId;
    }
    await sleep(300);
  }
  throw new Error('no target');
}
const ev = async (sid, expr) => {
  const r = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    sid,
  );
  return r.result?.exceptionDetails
    ? { exception: r.result.exceptionDetails.exception?.description }
    : r.result?.result?.value;
};
const sw = await attach((t) => t.type === 'service_worker' && t.url.includes(ID));
const out = {};
await ev(
  sw,
  `chrome.storage.local.set({'registry.v1':[{alias:'dev',host:'dev469966.service-now.com',label:'PDI',env:'dev',addedAt:'x'}]})`,
);
await send('Target.createTarget', { url: 'https://dev469966.service-now.com/login.do' });
await sleep(7000);
const tab = await attach((t) => t.type === 'page' && t.url.includes('dev469966'));
out.tabHasGck = await ev(tab, `typeof window.g_ck==='string' && window.g_ck.length>0`);
out.openPopup = await ev(sw, `chrome.action.openPopup().then(()=>'opened',e=>'err '+e.message)`);
await sleep(1500);
const pop = await attach((t) => t.url === `chrome-extension://${ID}/popup.html`);
const t0 = Date.now();
out.checkStatus = await ev(pop, `chrome.runtime.sendMessage({type:'popup.checkStatus'})`);
out.ms = Date.now() - t0;
await sleep(800);
out.statusText = await ev(
  pop,
  `[...document.querySelectorAll('#instances .status')].map(s=>s.textContent)`,
);
out.errors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => JSON.stringify(e.params).slice(0, 200));
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill();
