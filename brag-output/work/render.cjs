// usage: node render.mjs <name> stills t1,t2,... | node render.mjs <name> frames
(async () => {
const { chromium } = require('playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const [name, mode, list] = process.argv.slice(2);
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
pg.on('pageerror', (e) => console.error('PAGEERR', e.message));
pg.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
await pg.goto(`http://localhost:8765/v-${name}.html`);
await pg.waitForFunction('window.READY === true', null, { timeout: 20000 });
const dur = await pg.evaluate('window.DURATION');
writeFileSync(`${name}.sfx.json`, JSON.stringify({ dur, sfx: await pg.evaluate('window.SFX') }));
const stage = await pg.$('#stage');
if (mode === 'stills') {
  mkdirSync('stills', { recursive: true });
  for (const t of list.split(',').map(Number)) {
    await pg.evaluate((t) => window.seek(t), t);
    await stage.screenshot({ path: `stills/${name}-${t}.png` });
  }
} else {
  const dir = `frames-${name}`;
  mkdirSync(dir, { recursive: true });
  const n = Math.round(dur * 30);
  for (let i = 0; i < n; i++) {
    await pg.evaluate((t) => window.seek(t), i / 30);
    await stage.screenshot({ path: `${dir}/f${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 93 });
    if (i % 150 === 0) console.log(name, i, '/', n);
  }
}
await b.close();
console.log('done', name, dur);
})();
