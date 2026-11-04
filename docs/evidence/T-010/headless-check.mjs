// Headless Chrome check for T-010 (throwaway profile). Usage: node check.mjs <extDist> <profileDir>
import { spawn } from 'node:child_process';

const [dist, profile] = process.argv.slice(2);
const ID = 'clipfeocpiljpcngmjpdbegciimchbol';
const port = 9337;
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
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
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  } else events.push(m);
});
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const id = ++seq;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const out = {};
out.load = (await send('Extensions.loadUnpacked', { path: dist })).result;
await sleep(1500);
async function attach(urlPrefix, type) {
  for (let i = 0; i < 30; i++) {
    const { result } = await send('Target.getTargets');
    const t = result.targetInfos.find(
      (x) => x.url.startsWith(urlPrefix) && (!type || x.type === type),
    );
    if (t) {
      const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const sid = a.result.sessionId;
      await send('Runtime.enable', {}, sid);
      return sid;
    }
    await sleep(300);
  }
  throw new Error(`no target ${urlPrefix}`);
}
const evaluate = async (sid, expr) => {
  const r = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    sid,
  );
  if (!r.result) return { error: r.error };
  return r.result.exceptionDetails
    ? { exception: r.result.exceptionDetails.exception?.description }
    : r.result.result.value;
};
// extension page info
await send('Target.createTarget', { url: 'chrome://extensions' });
const extPage = await attach('chrome://extensions');
await sleep(800);
out.info = await evaluate(
  extPage,
  `new Promise(r=>chrome.developerPrivate.getExtensionInfo('${ID}',i=>r({state:i.state,location:i.location,permissions:i.permissions,installWarnings:i.installWarnings,manifestErrors:i.manifestErrors,runtimeErrors:i.runtimeErrors})))`,
);
const sw = await attach(`chrome-extension://${ID}/background.js`, 'service_worker');
out.manifestPerms = await evaluate(sw, `chrome.runtime.getManifest().permissions`);
// Seed one registered entry directly (headless cannot show the permission prompt).
out.seed = await evaluate(
  sw,
  `chrome.storage.local.set({'registry.v1':[{alias:'dev',host:'dev12345.service-now.com',label:'PDI',env:'dev',addedAt:new Date().toISOString()}]}).then(()=>'ok')`,
);
out.openPopup = await evaluate(
  sw,
  `chrome.action.openPopup().then(()=>'opened',e=>'err: '+e.message)`,
);
await sleep(1000);
let pop;
try {
  pop = await attach(`chrome-extension://${ID}/popup.html`);
} catch (e) {
  out.popupError = String(e);
}
if (pop) {
  await sleep(800);
  const msg = (m) => evaluate(pop, `chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  out.rendered1 = await evaluate(
    pop,
    `[...document.querySelectorAll('#instances li')].map(li=>li.innerText.replace(/\\s+/g,' '))`,
  );
  out.suggestionHidden = await evaluate(pop, `document.getElementById('suggestion').hidden`);
  out.addNoPerm = await msg({
    type: 'popup.registry.add',
    entry: { alias: 'acme', host: 'itsm.acme.example', env: 'prod' },
  });
  out.edit = await msg({
    type: 'popup.registry.edit',
    alias: 'dev',
    label: 'Renamed',
    env: 'unclassified',
  });
  out.editBad = await msg({ type: 'popup.registry.edit', alias: 'dev', env: 'staging' });
  out.stateAfterEdit = await evaluate(
    pop,
    `chrome.storage.local.get('registry.v1').then(d=>d['registry.v1'].map(e=>[e.alias,e.label,e.env]))`,
  );
  // UI path: click Edit and Remove panels exist
  await send('Page.reload', {}, pop);
  await sleep(1200);
  out.ui = await evaluate(
    pop,
    `(async()=>{const li=document.querySelector('#instances li');const [edit,remove]=li.querySelectorAll('.row-actions button');edit.click();const hasEdit=!!li.querySelector('.panel select');remove.click();const panel=li.querySelector('.panel');const text=panel.innerText;panel.querySelector('button').click();await new Promise(r=>setTimeout(r,800));return {hasEdit,removePanel:text.replace(/\\s+/g,' '),afterRemove:document.querySelectorAll('#instances li').length,message:document.getElementById('message').textContent}})()`,
  );
  out.storageAfterRemove = await evaluate(
    pop,
    `chrome.storage.local.get('registry.v1').then(d=>d['registry.v1'])`,
  );
}
out.consoleErrors = events
  .filter(
    (e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'),
  )
  .map((e) => JSON.stringify(e.params).slice(0, 300));
out.swLogs = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .map((e) => e.params.args.map((a) => a.value).join(' '))
  .slice(0, 10);
console.log(JSON.stringify(out, null, 2));
ws.close();
chrome.kill();
