// End-to-end check in real Chromium against the production (demo-mode) build.
// Usage: npm run build:preview && npm run test:e2e
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }

const PORT = 4174;
const URL = `http://localhost:${PORT}/`;
const OUT = process.env.E2E_OUT ?? 'test-results';
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--outDir', 'dist-demo', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  server.on('exit', (c) => rej(new Error(`preview exited ${c}`)));
  setTimeout(() => rej(new Error('preview did not start')), 15000);
});

const browser = await playwright.chromium.launch();
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const box = async (page, sel) => (await page.locator(sel).first().boundingBox());

for (const [label, viewport] of [['tablet', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  console.log(`${label} ${viewport.width}x${viewport.height}`);
  const ctx = await browser.newContext({ viewport, timezoneId: 'Asia/Jerusalem', locale: 'he-IL' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('[data-testid=appt]');

  await check('RTL order on screen: שעה (right) → רותם → סיון (left)', async () => {
    const t = await box(page, '[data-col=time]');
    const r = await box(page, '[data-col=staff-0]');
    const s = await box(page, '[data-col=staff-1]');
    assert.equal(await page.locator('[data-col=staff-0]').innerText(), 'רותם');
    assert.equal(await page.locator('[data-col=staff-1]').innerText(), 'סיון');
    assert.ok(t.x > r.x && r.x > s.x, `x: time ${t.x}, rotem ${r.x}, sivan ${s.x}`);
    assert.ok(Math.abs(r.width - s.width) <= 1, `staff widths ${r.width} vs ${s.width}`);
    assert.ok(t.width < r.width / 1.5, 'time column is narrower');
  });
  await check('uses the full width without horizontal scrolling', async () => {
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    assert.ok(sw <= iw, `scrollWidth ${sw} > ${iw}`);
    const cal = await box(page, '[data-testid=calendar]');
    assert.ok(cal.width >= viewport.width - 32, `calendar width ${cal.width}`);
  });
  await check('split block shows two distinct 15-minute cells, names readable', async () => {
    const quarter = page.locator('[data-testid=appt][data-duration="15"]');
    assert.equal(await quarter.count(), 2);
    const [a, b] = [await quarter.nth(0).boundingBox(), await quarter.nth(1).boundingBox()];
    assert.ok(b.y >= a.y + a.height - 1, 'second quarter below first');
    const half = await box(page, '[data-testid=appt][data-duration="30"]');
    assert.ok(half.height > a.height * 1.8, '30-minute cell is ~twice a 15-minute cell');
    const fontSize = await quarter.first().locator('.appt-name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(fontSize >= 15, `name font ${fontSize}px`);
    assert.ok(a.height >= 36, `touch target height ${a.height}`);
  });
  await check('every visible text is Hebrew/RTL (document dir + lang)', async () => {
    const { dir, lang } = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
    assert.equal(dir, 'rtl'); assert.equal(lang, 'he');
  });
  await page.screenshot({ path: `${OUT}/${label}-calendar.png` });
  assert.deepEqual(errors, []);
  await ctx.close();
}

console.log('two devices (two windows sharing the demo backend)');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Jerusalem' });
  const tablet = await ctx.newPage();
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await tablet.goto(URL);
  await phone.goto(URL);
  await tablet.waitForSelector('[data-testid=appt]');
  await phone.waitForSelector('[data-testid=appt]');
  const ROTEM = '5a10a000-0000-4000-8000-0000000000a1';
  const SIVAN = '5a10a000-0000-4000-8000-0000000000a2';

  await check('booking on the tablet appears on the phone', async () => {
    await tablet.click(`[data-testid=free][data-staff-id="${SIVAN}"][data-start="14:00"] .free-main`);
    await tablet.fill('input[placeholder="לדוגמה: דניאל"]', 'בדיקת סנכרון');
    await tablet.keyboard.press('Enter');
    await phone.getByRole('button', { name: /בדיקת סנכרון אצל סיון, 14:00–14:30/ }).waitFor({ timeout: 3000 });
  });
  await check('splitting on the phone appears on the tablet (Rotem only)', async () => {
    await phone.getByRole('button', { name: 'פיצול 15:00 של רותם לשני תורים של 15 דקות' }).click();
    await tablet.locator(`[data-testid=free][data-staff-id="${ROTEM}"][data-start="15:15"]`).waitFor({ timeout: 3000 });
    assert.equal(await tablet.locator(`[data-testid=free][data-staff-id="${SIVAN}"][data-start="15:00"]`).getAttribute('data-len'), '30');
  });
  await check('reverting to 30 minutes on the tablet appears on the phone', async () => {
    await tablet.getByRole('button', { name: 'החזרת 15:00 של רותם לתור של 30 דקות' }).click();
    await phone.locator(`[data-testid=free][data-staff-id="${ROTEM}"][data-start="15:00"][data-len="30"]`).waitFor({ timeout: 3000 });
  });
  await check('deleting on the phone removes it from the tablet', async () => {
    await phone.getByRole('button', { name: /בדיקת סנכרון/ }).click();
    await phone.getByRole('button', { name: 'מחק תור' }).click();
    await phone.getByRole('button', { name: 'מחק', exact: true }).click();
    await tablet.getByRole('button', { name: /בדיקת סנכרון/ }).waitFor({ state: 'detached', timeout: 3000 });
  });
  await tablet.screenshot({ path: `${OUT}/tablet-after-sync.png` });
  await ctx.close();
}

await browser.close();
server.kill();
console.log(failures ? `\n${failures} e2e check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
