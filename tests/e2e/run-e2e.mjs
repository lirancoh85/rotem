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
    const card = await page.evaluate(() => document.querySelector('.cal-wrap').clientWidth);
    assert.ok(cal.width >= card - 24, `calendar ${cal.width} does not fill its card ${card}`);
    const share = viewport.width >= 1100 ? 0.7 : 0.9; // side panel takes the rest on wide screens
    assert.ok(cal.width >= viewport.width * share, `calendar width ${cal.width}`);
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
  await check('date bar right→left: תאריך → יום קודם → היום → יום הבא', async () => {
    const [d, p, t, n] = await Promise.all(['nav-date', 'prev-day', 'today', 'next-day'].map((id) => box(page, `[data-testid=${id}]`)));
    assert.ok(d.x > p.x && p.x > t.x && t.x > n.x, `date ${d.x} prev ${p.x} today ${t.x} next ${n.x}`);
    const before = await page.getByTestId('date-label').innerText();
    await page.getByTestId('next-day').click();
    const after = await page.getByTestId('date-label').innerText();
    assert.notEqual(before, after);
    await page.getByTestId('prev-day').click();
    assert.equal(await page.getByTestId('date-label').innerText(), before);
  });
  await check('full-day view fits opening→closing without vertical scrolling, then back to normal', async () => {
    await page.getByTestId('view-toggle').click();
    assert.equal(await page.getByTestId('view-toggle').innerText(), 'תצוגה רגילה');
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const w = document.querySelector('.cal-wrap');
      const short = document.querySelector('[data-duration="15"] .appt-name');
      return { wrapH: w.clientHeight, scrollH: w.scrollHeight, font: parseFloat(getComputedStyle(short).fontSize),
        heads: [...document.querySelectorAll('[role=columnheader]')].map((h) => h.textContent),
        quarters: document.querySelectorAll('[data-testid=appt][data-duration="15"]').length };
    });
    assert.ok(m.scrollH <= m.wrapH + 1, `scrolls: ${m.scrollH} > ${m.wrapH}`);
    assert.ok(m.font >= 11, `name font ${m.font}px`);
    assert.deepEqual(m.heads, ['שעה', 'רותם', 'סיון']);
    assert.equal(m.quarters, 2);
    await page.screenshot({ path: `${OUT}/${label}-full-day.png` });
    await page.getByTestId('view-toggle').click();
    assert.equal(await page.getByTestId('view-toggle').innerText(), 'הצג יום מלא');
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
  const dragTo = async (page, sel, targetStaff, targetTime, touch) => {
    const card = page.locator(sel);
    await card.scrollIntoViewIfNeeded();
    const from = await card.boundingBox();
    const head = await page.locator(`.cal-head-staff[data-staff-id="${targetStaff}"]`).boundingBox();
    const row = await page.locator(`.cal-time[data-minute="${targetTime}"]`).boundingBox();
    const x0 = from.x + from.width / 2, y0 = from.y + 8, x1 = head.x + head.width / 2, y1 = row.y + 8;
    if (!touch) {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
      await page.mouse.move(x1, y1, { steps: 4 });
      await page.mouse.up();
      return;
    }
    // touch: press, hold (long-press), then drag
    const cdp = await page.context().newCDPSession(page);
    const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', x0, y0);
    await page.waitForTimeout(500);
    for (let i = 1; i <= 6; i++) await tp('touchMove', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6);
    await tp('touchEnd');
  };

  await check('drag-and-drop with the mouse (tablet): Rotem → Sivan after confirmation, synced to the phone', async () => {
    await tablet.click(`[data-testid=free][data-staff-id="${ROTEM}"][data-start="17:00"] .free-main`);
    await tablet.fill('[role=combobox]', 'גרירה');
    await tablet.keyboard.press('Enter');
    await tablet.getByRole('button', { name: /גרירה אצל רותם, 17:00/ }).waitFor();
    await dragTo(tablet, '[data-testid=appt]:has-text("גרירה")', SIVAN, 1110, false);
    const dlg = tablet.getByRole('dialog', { name: 'אישור העברה' });
    await dlg.waitFor({ timeout: 3000 });
    assert.match(await dlg.innerText(), /להעביר את התור של גרירה אל סיון/);
    await dlg.getByRole('button', { name: 'העבר' }).click();
    await tablet.getByRole('button', { name: /גרירה אצל סיון, 18:30–19:00/ }).waitFor({ timeout: 3000 });
    await phone.getByRole('button', { name: /גרירה אצל סיון, 18:30–19:00/ }).waitFor({ timeout: 3000 });
  });

  await check('drag-and-drop by touch (long-press, then drag): Rotem → Sivan', async () => {
    const t = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, timezoneId: 'Asia/Jerusalem' });
    const p = await t.newPage();
    await p.goto(URL);
    await p.waitForSelector('[data-testid=appt]');
    await dragTo(p, '[data-testid=appt]:has-text("שרון")', SIVAN, 660, true);
    const dlg = p.getByRole('dialog', { name: 'אישור העברה' });
    await dlg.waitFor({ timeout: 3000 });
    await dlg.getByRole('button', { name: 'העבר' }).click();
    await p.getByRole('button', { name: /שרון אצל סיון, 11:00–11:30/ }).waitFor({ timeout: 3000 });
    await t.close();
  });

  await check('a quick touch swipe still scrolls the calendar instead of dragging', async () => {
    const t = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'Asia/Jerusalem' });
    const p = await t.newPage();
    await p.goto(URL);
    await p.waitForSelector('[data-testid=appt]');
    const card = await p.locator('[data-testid=appt]').first().boundingBox();
    const cdp = await t.newCDPSession(p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: card.x + 20, y: card.y + 10 }] });
    for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: card.x + 20, y: card.y + 10 - i * 30 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(300);
    assert.equal(await p.getByRole('dialog').count(), 0, 'no move dialog after a swipe');
    await t.close();
  });

  await check('autocomplete suggests a returning customer and fills the phone', async () => {
    await phone.click(`[data-testid=free][data-staff-id="${SIVAN}"][data-start="16:00"] .free-main`);
    await phone.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
    await phone.keyboard.type('נוע');
    await phone.getByRole('option', { name: /נועה/ }).click();
    assert.match(await phone.getByTestId('picked-customer').innerText(), /054-7654321/);
    await phone.getByRole('button', { name: 'שמור', exact: true }).click();
    await tablet.getByRole('button', { name: /נועה אצל סיון, 16:00/ }).waitFor({ timeout: 3000 });
  });

  await check('search finds past appointments and jumps to them', async () => {
    await tablet.getByTestId('search-btn').click();
    await tablet.waitForFunction(() => document.activeElement?.getAttribute('type') === 'search');
    await tablet.keyboard.type('דניאל');
    const past = tablet.locator('[data-testid=search-results] .result', { hasText: 'עבר' });
    await past.first().waitFor({ timeout: 3000 });
    await past.first().click();
    await tablet.locator('[data-testid=appt].is-highlight', { hasText: 'דניאל' }).waitFor({ timeout: 3000 });
    await tablet.getByTestId('today').click();
  });

  await check('crossing out a slot on the phone shows it crossed out on the tablet', async () => {
    await phone.click(`[data-testid=free][data-staff-id="${ROTEM}"][data-start="16:00"] .free-main`);
    await phone.getByRole('button', { name: 'חסום משבצת' }).click();
    await tablet.locator(`[data-testid=blocked][data-staff-id="${ROTEM}"][data-start="16:00"]`).waitFor({ timeout: 3000 });
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
