import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [dist, profile, outDir] = process.argv.slice(2);
const ID = 'clipfeocpiljpcngmjpdbegciimchbol',
  port = 9340;
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
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
await sleep(1200);
async function attach(prefix, type) {
  for (let i = 0; i < 30; i++) {
    const { result } = await send('Target.getTargets');
    const t = result.targetInfos.find(
      (x) => x.url.startsWith(prefix) && (!type || x.type === type),
    );
    if (t) {
      const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const sid = a.result.sessionId;
      await send('Runtime.enable', {}, sid);
      return sid;
    }
    await sleep(300);
  }
  throw new Error('no target ' + prefix);
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
await send('Target.createTarget', { url: 'chrome://extensions' });
const extPage = await attach('chrome://extensions');
await sleep(800);
out.info = await ev(
  extPage,
  `new Promise(r=>chrome.developerPrivate.getExtensionInfo('${ID}',i=>r({state:i.state,installWarnings:i.installWarnings,manifestErrors:i.manifestErrors,runtimeErrors:i.runtimeErrors,icon:i.iconUrl})))`,
);
const sw = await attach(`chrome-extension://${ID}/background.js`, 'service_worker');
out.notification = await ev(
  sw,
  `chrome.notifications.create('req:test',{type:'basic',iconUrl:chrome.runtime.getURL('icons/icon128.png'),title:'Claude is asking for ServiceNow access',message:'Claude Desktop → dev · code K7QF-2M',priority:2}).then(id=>'created '+id,e=>'error '+e.message)`,
);
const now = Date.now();
out.seed = await ev(
  sw,
  `(async()=>{await chrome.storage.session.set({'grants.v1':{requests:[],grants:[{grantId:'g1',scopeHash:'x',clientKeyId:'${'a'.repeat(64)}',clientLabel:{name:'Claude Desktop',pid:1},instances:['prod'],mode:'single',createdAt:${now},expiresAt:${now + 30 * 60000},targets:[{alias:'prod',host:'prod.service-now.com',env:'prod'}],env:'prod',purpose:'p',approvedAt:${now}}]}});
await chrome.storage.local.set({'registry.v1':[{alias:'prod',host:'prod.service-now.com',label:'',env:'prod',addedAt:'x'}]});return 'ok'})()`,
);
await sleep(1500);
out.badge = await ev(
  sw,
  `Promise.all([chrome.action.getBadgeText({}),chrome.action.getBadgeBackgroundColor({})])`,
);
// popup visual with stubbed state
const t = await send('Target.createTarget', { url: 'about:blank' });
const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const pop = a.result.sessionId;
await send('Runtime.enable', {}, pop);
await send('Page.enable', {}, pop);
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 380, height: 2400, deviceScaleFactor: 2, mobile: false },
  pop,
);
await ev(
  sw,
  `chrome.storage.local.set({'registry.v1':[{alias:'dev',host:'dev469966.service-now.com',label:'My PDI',env:'dev',addedAt:'x'},{alias:'uat',host:'acmeuat.service-now.com',label:'',env:'unclassified',envName:'UAT',addedAt:'x'},{alias:'prod',host:'acme.service-now.com',label:'',env:'prod',addedAt:'x'}]})`,
);
const fake = {
  ok: true,
  bridge: { state: 'connected' },
  pending: [
    {
      requestId: 'req_c',
      approvalCode: 'K7QF2M',
      clientLabel: { name: 'Claude Desktop', pid: 1 },
      instances: ['dev', 'uat'],
      mode: 'compare',
      purpose: 'Compare the incident assignment rules between DEV and UAT',
      createdAt: now - 40000,
      expiresAt: now + 260000,
    },
  ],
  grants: [
    {
      grantId: 'g1',
      clientLabel: { name: 'Claude Desktop', pid: 1 },
      instances: ['prod'],
      mode: 'single',
      env: 'prod',
      purpose: 'Check why INC0010023 was reassigned overnight',
      approvedAt: now - 5 * 60000,
      expiresAt: now + 25 * 60000,
    },
    {
      grantId: 'g2',
      clientLabel: { name: 'Claude Code', pid: 2 },
      instances: ['dev'],
      mode: 'single',
      env: 'dev',
      purpose: 'Review business rules on incident',
      approvedAt: now - 20 * 60000,
      expiresAt: now + 3.6 * 3600000,
    },
  ],
};
await send(
  'Page.addScriptToEvaluateOnNewDocument',
  {
    source: `const o=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(m)=>m&&m.type==='popup.state'?Promise.resolve(${JSON.stringify(fake)}):o(m);`,
  },
  pop,
);
await send('Page.navigate', { url: `chrome-extension://${ID}/popup.html` }, pop);
await sleep(2500);
for (const [name, scheme] of [
  ['t011-light', 'light'],
  ['t011-dark', 'dark'],
]) {
  await send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: scheme }] },
    pop,
  );
  await sleep(400);
  const h = await ev(pop, 'document.body.scrollHeight');
  const r = await send(
    'Page.captureScreenshot',
    { format: 'png', clip: { x: 0, y: 0, width: 380, height: Math.min(h, 1100), scale: 1 } },
    pop,
  );
  out['width_' + name] = await ev(pop, 'document.documentElement.scrollWidth');
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.result.data, 'base64'));
}
out.errors = events
  .filter(
    (e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'),
  )
  .map((e) => JSON.stringify(e.params).slice(0, 300));
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill();
