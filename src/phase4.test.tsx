import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SalonApp } from './App';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './data/demoBackend';
import { withOfflineGuard, MUTATING } from './lib/offlineGuard';
import { InstallSection } from './components/InstallSection';

const root = join(__dirname, '..');
const setOnline = (v: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });
  window.dispatchEvent(new Event(v ? 'online' : 'offline'));
};
afterEach(() => setOnline(true));

describe('Phase 4 — offline safety', () => {
  it('refuses every write while offline but still allows reading', async () => {
    let online = false;
    const b = withOfflineGuard(new DemoBackend(memoryStore(seedDemoData('2026-11-10')), `g-${Math.random()}`), () => online);
    await expect(b.createAppointment(DEMO_SHOP, { staffId: DEMO_STAFF[0].id, date: '2026-11-20', start: 600, duration: 30, customerName: 'x', customerPhone: '', service: '', notes: '' }))
      .rejects.toMatchObject({ code: 'OFFLINE' });
    await expect(b.acceptOffer('x')).rejects.toMatchObject({ code: 'OFFLINE' });
    await expect(b.loadDay(DEMO_SHOP.id, '2026-11-10')).resolves.toBeTruthy();
    online = true;
    await expect(b.createAppointment(DEMO_SHOP, { staffId: DEMO_STAFF[0].id, date: '2026-11-20', start: 600, duration: 30, customerName: 'x', customerPhone: '', service: '', notes: '' })).resolves.toBeTruthy();
    expect(MUTATING).toEqual(expect.arrayContaining(['createSeries', 'setAppointmentStatus', 'updateCustomer', 'saveWaitlistRequest']));
  });

  it('shows an offline banner and blocks booking from the calendar', async () => {
    const backend = new DemoBackend(memoryStore(seedDemoData('2026-11-10')), `o-${Math.random()}`);
    const user = userEvent.setup();
    render(<SalonApp backend={backend} onSignOut={vi.fn()} initialDate="2026-11-10" />);
    await screen.findAllByTestId('free');
    act(() => setOnline(false));
    expect(await screen.findByTestId('offline-banner')).toHaveTextContent('לא ניתן לקבוע, לערוך או לבטל');
    await user.click(within(screen.getAllByTestId('free')[0]).getByText('פנוי'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText(/אין חיבור לאינטרנט — לא ניתן לשנות תורים/)).toBeInTheDocument();
    act(() => setOnline(true));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});

describe('Phase 4 — installable app', () => {
  it('has a complete Hebrew manifest with real icon files', () => {
    const m = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
    expect(m).toMatchObject({ name: 'רותם עדני — יומן תורים', short_name: 'רותם עדני', lang: 'he', dir: 'rtl', display: 'standalone', start_url: './', scope: './' });
    expect(m.description).toMatch(/יומן התורים/);
    const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    for (const i of m.icons) expect(existsSync(join(root, 'public', i.src))).toBe(true);
  });

  it('declares iPhone/iPad home-screen support and splash screens that exist', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('apple-touch-icon');
    const splash = [...html.matchAll(/apple-touch-startup-image" media="[^"]+" href="\.\/([^"]+)"/g)].map((m) => m[1]);
    expect(splash.length).toBeGreaterThanOrEqual(10);
    for (const f of splash) expect(existsSync(join(root, 'public', f))).toBe(true);
  });

  it('service worker never caches other origins (Supabase) and has an offline page', () => {
    const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
    expect(sw).toContain("if (url.origin !== self.location.origin) return;");
    expect(sw).toContain('./offline.html');
    expect(existsSync(join(root, 'public/offline.html'))).toBe(true);
  });

  it('settings show install steps for iPhone Safari and Android Chrome', () => {
    render(<InstallSection />);
    const s = screen.getByTestId('install-section');
    expect(s).toHaveTextContent('אייפון / אייפד (Safari)');
    expect(s).toHaveTextContent('הוספה למסך הבית');
    expect(s).toHaveTextContent('אנדרואיד (Chrome)');
  });
});
