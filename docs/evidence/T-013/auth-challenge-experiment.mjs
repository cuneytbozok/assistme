// Experiment: does an extension SW fetch to a logged-out ServiceNow instance raise an auth
// challenge, and does a DNR session rule removing WWW-Authenticate prevent it?
// Uses a throwaway copy of the extension with a test-only manifest (host permission + DNR).
import { spawn } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';

const [src, work, profile] = process.argv.slice(2);
cpSync(src, work, { recursive: true });
const m = JSON.parse(readFileSync(`${work}/manifest.json`, 'utf8'));
m.host_permissions = ['https://dev469966.service-now.com/*'];
m.permissions.push('declarativeNetRequestWithHostAccess');
writeFileSync(`${work}/manifest.json`, JSON.stringify(m));
const port = 9342;
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
const load = await send('Extensions.loadUnpacked', { path: work });
const ID = load.result.id;
await sleep(1500);
let sw;
for (let i = 0; i < 30 && !sw; i++) {
  const { result } = await send('Target.getTargets');
  const t = result.targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(ID));
  if (t) {
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    sw = a.result.sessionId;
  } else await sleep(300);
}
await send('Runtime.enable', {}, sw);
// Observe auth challenges for SW requests (we answer CancelAuth so nothing ever hangs here).

const auths = [];
ws.addEventListener('message', (e) => {
  const x = JSON.parse(e.data);
  if (x.sessionId !== sw) return;
  if (x.method === 'Fetch.authRequired') {
    auths.push(x.params.request.url);
    send(
      'Fetch.continueWithAuth',
      { requestId: x.params.requestId, authChallengeResponse: { response: 'CancelAuth' } },
      sw,
    );
  } else if (x.method === 'Fetch.requestPaused') {
    send('Fetch.continueRequest', { requestId: x.params.requestId }, sw);
  }
});
const ev = async (expr) => {
  const r = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    sw,
  );
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
};
const probe = `(async()=>{const t0=Date.now();const c=new AbortController();setTimeout(()=>c.abort(),15000);const r=await fetch('https://dev469966.service-now.com/api/now/table/sys_db_object?sysparm_limit=1&sysparm_fields=sys_id',{credentials:'include',redirect:'manual',cache:'no-store',headers:{Accept:'application/json'},signal:c.signal}).then(r=>({status:r.status,www:r.headers.get('www-authenticate')}),e=>'err '+e);return {...(typeof r==='object'?r:{r}),ms:Date.now()-t0};})()`;
const out = {};
out.withoutRule = await ev(probe);
out.withoutRule2 = await ev(probe);
out.authsWithout = [...auths];
auths.length = 0;
out.addRule = await ev(
  `chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[1],addRules:[{id:1,priority:1,action:{type:'modifyHeaders',responseHeaders:[{header:'www-authenticate',operation:'remove'}]},condition:{requestDomains:['dev469966.service-now.com'],tabIds:[-1],resourceTypes:['xmlhttprequest','other']}}]}).then(()=>'ok',e=>'err '+e.message)`,
);
out.withRule = await ev(probe);
out.withRule2 = await ev(probe);
out.authsWith = [...auths];
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill();
