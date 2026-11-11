import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalonApp } from './App';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './data/demoBackend';
import { israelDayInfo, ELECTION_DAYS } from './lib/holidays';
import { firstVisitIdsOn } from './domain/customers';
import { D, ROTEM, SIVAN, appt } from './test/fixtures';

function setup(date = D, withSeed = true) {
  const seed = seedDemoData(D);
  const store = memoryStore(withSeed ? seed : { ...seed, appointments: [], splits: [], customers: [] });
  const channel = `u-${Math.random()}`;
  const backend = new DemoBackend(store, channel);
  const other = new DemoBackend(store, channel);
  render(<SalonApp backend={backend} onSignOut={vi.fn()} initialDate={date} />);
  return { backend, other, user: userEvent.setup() };
}
const input = (staffId: string, date: string, start: number, customerName: string, customerPhone = '') => ({
  staffId, date, start, duration: 30, customerName, customerPhone, service: '', notes: '',
});

describe('1. staff name סיוון', () => {
  it('shows סיוון in the column header, staff selector and filter', async () => {
    const { user } = setup();
    await screen.findAllByTestId('appt');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['שעה', 'רותם', 'סיוון']);
    expect(screen.getAllByRole('radio', { name: 'סיוון' }).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/סיון/);
    await user.click(screen.getByRole('button', { name: /משה אצל סיוון/ }));
    expect(within(await screen.findByRole('dialog')).getByRole('radio', { name: 'סיוון' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('2. Israeli holidays and non-working days', () => {
  it('names holidays and marks only statutory rest days as days off', () => {
    expect(israelDayInfo('2026-09-21')).toEqual({ names: ['יום כיפור'], dayOff: true });
    expect(israelDayInfo('2026-09-12')).toEqual({ names: ['ראש השנה'], dayOff: true });
    expect(israelDayInfo('2027-04-22')).toEqual({ names: ['פסח א׳'], dayOff: true });
    expect(israelDayInfo('2027-05-12')).toEqual({ names: ['יום העצמאות'], dayOff: true });
    expect(israelDayInfo('2026-10-27')).toEqual({ names: ['יום הבחירות לכנסת'], dayOff: true });
    // observances that are NOT days off
    expect(israelDayInfo('2026-09-28')).toEqual({ names: ['סוכות ג׳ (חול המועד)'], dayOff: false });
    expect(israelDayInfo('2026-12-05')).toEqual({ names: ['חנוכה'], dayOff: false });
    expect(israelDayInfo('2027-03-23')).toEqual({ names: ['פורים'], dayOff: false });
    expect(israelDayInfo('2027-05-11')).toEqual({ names: ['יום הזכרון'], dayOff: false });
    expect(israelDayInfo('2026-09-20')).toEqual({ names: ['ערב יום כיפור'], dayOff: false });
    expect(israelDayInfo('2027-08-12')).toEqual({ names: ['תשעה באב'], dayOff: false });
  });

  it('uses the Israeli schedule (one-day yom tov) and works for future years', () => {
    expect(israelDayInfo('2026-10-04')).toBeNull(); // 2nd day of Shmini Atzeret is only outside Israel
    expect(israelDayInfo('2027-04-23')?.dayOff).toBe(false); // Pesach II = Chol HaMoed in Israel
    expect(israelDayInfo('2030-09-28')).toEqual({ names: ['ראש השנה'], dayOff: true });
    expect(israelDayInfo('2030-04-18')).toEqual({ names: ['פסח א׳'], dayOff: true });
    expect(israelDayInfo('2031-12-10')?.names).toEqual(['חנוכה']);
  });

  it('shows nothing on ordinary days (Rosh Chodesh is not a holiday) and lists election days', () => {
    expect(israelDayInfo('2026-11-10')).toBeNull();
    expect(israelDayInfo('2026-11-11')).toBeNull(); // Rosh Chodesh Kislev
    expect(Object.keys(ELECTION_DAYS)).toContain('2026-10-27');
  });

  it('appears right after "יום הבא" and updates while navigating', async () => {
    const { user } = setup('2026-09-20', false); // Erev Yom Kippur
    await screen.findAllByTestId('free');
    const nav = screen.getByTestId('date-nav');
    expect(Array.from(nav.children).map((c) => (c as HTMLElement).dataset.testid)).toEqual([
      'nav-date', 'prev-day', 'today', 'next-day', 'holiday',
    ]);
    expect(screen.getByTestId('holiday')).toHaveTextContent('ערב יום כיפור');
    expect(screen.getByTestId('holiday')).not.toHaveTextContent('יום שבתון');
    await user.click(screen.getByRole('button', { name: 'יום הבא' }));
    expect(screen.getByTestId('holiday')).toHaveTextContent('יום כיפור');
    expect(screen.getByTestId('holiday')).toHaveTextContent('יום שבתון');
    await user.click(screen.getByRole('button', { name: 'יום הבא' }));
    expect(screen.queryByTestId('holiday')).toBeNull(); // ordinary day: nothing shown
  });
});

describe('3. first-time customers in green', () => {
  it('marks only each customer’s earliest remaining appointment', () => {
    const a1 = { ...appt(ROTEM, '10:00', 30, 'דן', '2026-11-03'), customerId: 'c1' };
    const a2 = { ...appt(SIVAN, '09:00', 30, 'דן', D), customerId: 'c1' };
    const b1 = { ...appt(ROTEM, '11:00', 30, 'רון', D), customerId: 'c2' };
    const blocked = { ...appt(ROTEM, '08:00', 30, 'חסום', D), isBlocked: true, customerId: null };
    expect(firstVisitIdsOn([a1, a2, b1, blocked], D, 'Asia/Jerusalem')).toEqual([b1.id]);
    // cancelling (deleting) the first visit makes the next one the first
    expect(firstVisitIdsOn([a2, b1], D, 'Asia/Jerusalem').sort()).toEqual([a2.id, b1.id].sort());
  });

  it('shows a new customer in green; the second booking is normal; the first stays green', async () => {
    const { user, other } = setup(D, false);
    await screen.findAllByTestId('free');
    await act(() => other.createAppointment(DEMO_SHOP, input(DEMO_STAFF[0].id, D, 600, 'לקוח חדש', '052-1112233')));
    const first = await screen.findByRole('button', { name: /לקוח חדש אצל רותם, 10:00/ });
    await waitFor(() => expect(first).toHaveClass('is-first'));
    expect(first).toHaveAccessibleName(/תור ראשון/);
    // second visit, same phone, written differently — same customer
    await act(() => other.createAppointment(DEMO_SHOP, input(DEMO_STAFF[1].id, D, 720, 'לקוח חדש', '+972 52 111 2233')));
    const second = await screen.findByRole('button', { name: /לקוח חדש אצל סיוון, 12:00/ });
    await waitFor(() => expect(screen.getByRole('button', { name: /אצל רותם, 10:00/ })).toHaveClass('is-first'));
    expect(second).not.toHaveClass('is-first');
    // a later visit on another day does not change the first one
    await act(() => other.createAppointment(DEMO_SHOP, input(DEMO_STAFF[0].id, '2026-11-20', 600, 'לקוח חדש', '0521112233')));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByRole('button', { name: /אצל רותם, 10:00/ })).toHaveClass('is-first');
    // cancelling the first visit makes the next one the first
    const firstId = screen.getByRole('button', { name: /אצל רותם, 10:00/ }).getAttribute('data-appt-id')!;
    await act(() => other.deleteAppointment(firstId));
    await waitFor(() => expect(screen.getByRole('button', { name: /לקוח חדש אצל סיוון, 12:00/ })).toHaveClass('is-first'));
    void user;
  });

  it('existing returning customers are not highlighted on later visits', async () => {
    setup(); // seed: דניאל has a visit last week, נועה has a future visit next week
    const daniel = await screen.findAllByRole('button', { name: /דניאל אצל רותם/ });
    await waitFor(() => expect(screen.getByRole('button', { name: /שרון אצל רותם/ })).toHaveClass('is-first'));
    daniel.forEach((d) => expect(d).not.toHaveClass('is-first'));
    expect(screen.getByRole('button', { name: /נועה אצל סיוון/ })).toHaveClass('is-first'); // today is her first
  });
});

describe('4. date navigation buttons', () => {
  it('keeps the order תאריך → יום קודם → היום → יום הבא and the arrows work', async () => {
    const { user } = setup(D, false);
    await screen.findAllByTestId('free');
    const ids = Array.from(screen.getByTestId('date-nav').children).map((c) => (c as HTMLElement).dataset.testid);
    expect(ids.slice(0, 4)).toEqual(['nav-date', 'prev-day', 'today', 'next-day']);
    await user.click(screen.getByRole('button', { name: 'יום קודם' }));
    expect(screen.getByTestId('date-label')).toHaveTextContent('9 בנובמבר');
  });
});

describe('dialogs keep focus during live updates', () => {
  it('a change from another device while typing does not move the cursor out of the name field', async () => {
    const { user, other } = setup(D, false);
    await screen.findAllByTestId('free');
    const cell = screen.getAllByTestId('free').find((e) => e.getAttribute('data-staff-id') === DEMO_STAFF[0].id && e.getAttribute('data-start') === '10:00')!;
    await user.click(within(cell).getByText('פנוי'));
    const field = within(await screen.findByRole('dialog')).getByRole('combobox', { name: 'שם הלקוח' });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, 'אב');
    await act(() => other.createAppointment(DEMO_SHOP, input(DEMO_STAFF[1].id, D, 900, 'ממכשיר אחר')));
    await screen.findByRole('button', { name: /ממכשיר אחר/ });
    await new Promise((r) => setTimeout(r, 200));
    expect(field).toHaveFocus();
    await user.type(field, 'י{Enter}');
    await screen.findByRole('button', { name: /אבי אצל רותם, 10:00/ });
  });
});
