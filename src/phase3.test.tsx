import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalonApp } from './App';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './data/demoBackend';
import { matchesForRequest, offerMessage, requestsForSlot } from './domain/waitlist';
import { whatsappLink } from './lib/contact';
import type { WaitlistRequest } from './domain/types';

const [ROTEM, SIVAN] = DEMO_STAFF;
const DAY = '2026-11-16'; // a Monday, in the future
const req = (over: Partial<WaitlistRequest> = {}): WaitlistRequest => ({
  id: 'r1', customerId: null, customerName: 'יעל', customerPhone: '052-3434343', service: 'תספורת', duration: 30, staffId: null,
  preferredDates: [DAY], timeFrom: 600, timeTo: 720, notes: null, status: 'waiting', createdAt: '', offers: [], ...over,
});

// keep jsdom from trying to navigate when a WhatsApp link is clicked
const stopNav = (e: Event) => (e.target as Element).closest?.('a[href^="https://wa.me"]') && e.preventDefault();
beforeEach(() => document.addEventListener('click', stopNav, true));
afterEach(() => document.removeEventListener('click', stopNav, true));

describe('Phase 3 — matching rules', () => {
  const ctx = { appointments: [], splits: [], staff: DEMO_STAFF, shop: DEMO_SHOP, today: '2026-11-11', nowMinutes: 600 };
  it('finds free slots on preferred dates within the time range, per staff preference', () => {
    const all = matchesForRequest(req(), ctx, 10);
    expect(new Set(all.map((m) => m.staffId))).toEqual(new Set([ROTEM.id, SIVAN.id]));
    expect(all.every((m) => m.date === DAY && m.start >= 600 && m.start + 30 <= 720)).toBe(true);
    expect(matchesForRequest(req({ staffId: SIVAN.id }), ctx, 10).every((m) => m.staffId === SIVAN.id)).toBe(true);
    expect(matchesForRequest(req({ preferredDates: ['2026-11-14'] }), ctx)).toEqual([]); // Saturday: closed
    expect(matchesForRequest(req({ preferredDates: ['2026-11-01'] }), ctx)).toEqual([]); // past
    // today: only times after now
    expect(matchesForRequest(req({ preferredDates: ['2026-11-11'] }), { ...ctx, nowMinutes: 650 }).every((m) => m.start > 650)).toBe(true);
  });
  it('knows who fits a freed slot and writes the Hebrew WhatsApp offer', () => {
    expect(requestsForSlot([req()], { date: DAY, start: 630, end: 660, staffId: ROTEM.id })).toHaveLength(1);
    expect(requestsForSlot([req()], { date: DAY, start: 720, end: 750, staffId: ROTEM.id })).toHaveLength(0);
    expect(requestsForSlot([req({ duration: 60 })], { date: DAY, start: 630, end: 660, staffId: ROTEM.id })).toHaveLength(0);
    const msg = offerMessage({ customerName: 'יעל כהן', salonName: 'רותם עדני', dateLabel: 'יום שני, 16 בנובמבר', time: '10:30', staffName: 'רותם' });
    expect(msg).toBe('היי יעל, כאן רותם עדני. התפנה תור ביום שני, 16 בנובמבר בשעה 10:30 אצל רותם. מתאים לך? אפשר להשיב כאן ונשריין לך את התור.');
    expect(whatsappLink('052-343-4343', 'שלום')).toBe(`https://wa.me/972523434343?text=${encodeURIComponent('שלום')}`);
    expect(whatsappLink('', 'x')).toBeNull();
  });
});

function setup() {
  const seed = seedDemoData('2026-11-10');
  const store = memoryStore({ ...seed, appointments: [], splits: [], customers: [] });
  const channel = `p3-${Math.random()}`;
  const backend = new DemoBackend(store, channel);
  render(<SalonApp backend={backend} onSignOut={vi.fn()} initialDate={DAY} />);
  return { backend, user: userEvent.setup() };
}

async function addRequest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'רשימת המתנה' }));
  const panel = await screen.findByTestId('waitlist-panel');
  await user.click(within(panel).getByRole('button', { name: 'הוספה לרשימת המתנה' }));
  await user.type(within(panel).getByRole('combobox', { name: 'שם הלקוח' }), 'יעל');
  await user.type(within(panel).getByRole('combobox', { name: 'מספר טלפון' }), '052-3434343');
  // replace today's default date with the target day
  await user.click(within(panel).getAllByRole('button', { name: /^הסרת/ })[0]);
  fireEvent.change(within(panel).getByLabelText('הוסף תאריך', { selector: 'input' }), { target: { value: DAY } });
  await user.click(within(panel).getByRole('button', { name: 'הוסף תאריך' }));
  await user.selectOptions(within(panel).getByRole('combobox', { name: 'מ־' }), '600');
  await user.selectOptions(within(panel).getByRole('combobox', { name: 'עד' }), '660');
  await user.click(within(panel).getByRole('button', { name: 'שמור' }));
  return panel;
}

describe('Phase 3 — waiting list in the app', () => {
  it('adds a request, shows matching slots, offers on WhatsApp and books on acceptance', async () => {
    const { user } = setup();
    const panel = await addRequest(user);
    const card = await within(panel).findByTestId('wl-request');
    expect(card).toHaveTextContent('יעל');
    const matches = await within(card).findAllByTestId('wl-match');
    expect(matches[0]).toHaveTextContent('10:00');
    const link = within(matches[0]).getByRole('link', { name: 'הצע בוואטסאפ' });
    expect(link.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/972523434343\?text=/);
    expect(decodeURIComponent(link.getAttribute('href')!.split('text=')[1])).toContain('התפנה תור');
    await user.click(link);
    const offer = await within(card).findByTestId('wl-offer');
    expect(offer).toHaveTextContent('נשלחה');
    // header badge counts requests with free matches
    expect(screen.getByRole('button', { name: /רשימת המתנה · התאמה אחת/ })).toBeInTheDocument();
    await user.click(within(offer).getByRole('button', { name: 'התקבל — קבע תור' }));
    await screen.findByRole('button', { name: /יעל אצל רותם, 10:00/ });
    await waitFor(() => expect(screen.queryByTestId('waitlist-panel')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'רשימת המתנה' }));
    expect(await within(await screen.findByTestId('waitlist-panel')).findByText('אין כרגע לקוחות ממתינים.')).toBeInTheDocument();
  });

  it('if someone else took the slot first, the offer expires and nothing is double-booked', async () => {
    const { user, backend } = setup();
    const panel = await addRequest(user);
    const card = await within(panel).findByTestId('wl-request');
    await user.click(within((await within(card).findAllByTestId('wl-match'))[0]).getByRole('link'));
    const offer = await within(card).findByTestId('wl-offer');
    await act(async () => void (await backend.createAppointment(DEMO_SHOP, { staffId: ROTEM.id, date: DAY, start: 600, duration: 30, customerName: 'מהיר', customerPhone: '', service: '', notes: '' })));
    await user.click(within(offer).getByRole('button', { name: 'התקבל — קבע תור' }));
    expect(await screen.findByText(/המשבצת כבר נתפסה/)).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByTestId('wl-offer')).toHaveAttribute('data-status', 'expired'));
    const day = await backend.loadDay(DEMO_SHOP.id, DAY);
    expect(day.appointments.filter((a) => a.customerName !== 'מהיר')).toHaveLength(0);
  });

  it('cancelling an appointment alerts about matching waiting customers (with undo kept)', async () => {
    const { user, backend } = setup();
    await act(async () => void (await backend.createAppointment(DEMO_SHOP, { staffId: ROTEM.id, date: DAY, start: 600, duration: 30, customerName: 'מבטל', customerPhone: '', service: '', notes: '' })));
    await act(async () => void (await backend.createAppointment(DEMO_SHOP, { staffId: SIVAN.id, date: DAY, start: 600, duration: 30, customerName: 'תפוס', customerPhone: '', service: '', notes: '' })));
    await act(() => backend.saveWaitlistRequest(DEMO_SHOP, { customerName: 'ממתין', customerPhone: '', customerId: null, service: '', duration: 30, staffId: ROTEM.id, preferredDates: [DAY], timeFrom: 600, timeTo: 630, notes: '' }));
    await user.click(await screen.findByRole('button', { name: /מבטל אצל רותם/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'בטל תור' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'ביטול תור' })).getByRole('button', { name: 'בטל תור' }));
    expect(await screen.findByText(/מתאים\/ה למשבצת שהתפנתה/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ביטול פעולה' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'הצג' }));
    const panel = await screen.findByTestId('waitlist-panel');
    expect(await within(panel).findAllByTestId('wl-match')).toHaveLength(1);
  });

  it('edits and removes a request', async () => {
    const { user } = setup();
    const panel = await addRequest(user);
    const card = await within(panel).findByTestId('wl-request');
    await user.click(within(card).getByRole('button', { name: 'עריכה' }));
    const service = within(panel).getByRole('textbox', { name: 'שירות' });
    await user.type(service, 'זקן');
    await user.click(within(panel).getByRole('button', { name: 'שמור' }));
    await waitFor(() => expect(within(panel).getByTestId('wl-request')).toHaveTextContent('זקן'));
    await user.click(within(within(panel).getByTestId('wl-request')).getByRole('button', { name: 'הסר מהרשימה' }));
    await waitFor(() => expect(within(panel).queryByTestId('wl-request')).toBeNull());
  });
});
