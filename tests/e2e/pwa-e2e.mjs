// PWA checks against the PRODUCTION build (service worker enabled).
// Usage: npm run build && npm run test:pwa   (or PWA_URL=https://… to check a deployment)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }

let server;
let URL = process.env.PWA_URL;
if (!URL) {
  URL = 'http://localhost:4175/';
  server = spawn('npx', ['vite', 'preview', '--port', '4175', '--strictPort'], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    server.stdout.on('data', (d) => String(d).includes('4175') && res());
    setTimeout(() => rej(new Error('preview did not start')), 15000);
  });
}

const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL' });
const page = await ctx.newPage();
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

await page.goto(URL);
console.log(`PWA @ ${URL}`);

await check('manifest is linked, Hebrew, standalone, with loadable icons', async () => {
  const href = await page.getAttribute('link[rel=manifest]', 'href');
  const res = await page.request.get(new globalThis.URL(href, URL).toString());
  assert.equal(res.status(), 200);
  const m = await res.json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.lang, 'he');
  assert.equal(m.short_name, 'רותם עדני');
  for (const i of m.icons) assert.equal((await page.request.get(new globalThis.URL(i.src, URL).toString())).status(), 200, i.src);
});

await check('service worker installs and controls the page', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  assert.ok(controlled, 'page not controlled by the service worker');
});

await check('caches only same-origin static files (no API / customer data)', async () => {
  const urls = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  assert.ok(urls.length > 0, 'nothing cached');
  const origin = new globalThis.URL(URL).origin;
  const bad = urls.filter((u) => !u.startsWith(origin) && !/fonts\.(googleapis|gstatic)\.com/.test(u));
  assert.deepEqual(bad, []);
  assert.ok(!urls.some((u) => /supabase/.test(u)), 'supabase response cached');
});

await check('offline: the app still opens and shows the friendly offline screen', async () => {
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('אין חיבור לאינטרנט').first().waitFor({ timeout: 5000 });
  await page.screenshot({ path: process.env.PWA_SHOT ?? 'test-results/pwa-offline.png' });
  await ctx.setOffline(false);
});

await check('iOS: apple meta and splash screens are served', async () => {
  const links = await page.$$eval('link[rel=apple-touch-startup-image]', (ls) => ls.map((l) => l.getAttribute('href')));
  assert.ok(links.length >= 10);
  assert.equal((await page.request.get(new globalThis.URL(links[0], URL).toString())).status(), 200);
  assert.equal(await page.getAttribute('meta[name=apple-mobile-web-app-capable]', 'content'), 'yes');
});

await browser.close();
server?.kill();
console.log(failures ? `\n${failures} PWA check(s) failed` : '\nall PWA checks passed');
process.exit(failures ? 1 : 0);
