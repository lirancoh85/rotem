import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalonApp } from './App';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './data/demoBackend';
import { applyChange } from './data/applyChange';
import type { DayData } from './data/backend';
import { fitQuarterHeight, FIT_MIN_QUARTER } from './components/Calendar';
import { freeStarts, snapStart, toDayAppointments } from './domain/schedule';
import { linkCustomer, matchCustomers, normalizePhone, parseSearchDate, type StoredCustomer } from './domain/customers';
import { D, ROTEM as R, SIVAN as S, appt, split } from './test/fixtures';

const [ROTEM, SIVAN] = DEMO_STAFF;

function setup(withSeed = true) {
  const seed = seedDemoData(D);
  const store = memoryStore(withSeed ? seed : { ...seed, appointments: [], splits: [], customers: [] });
  const channel = `f-${Math.random()}`;
  const backend = new DemoBackend(store, channel);
  const other = new DemoBackend(store, channel);
  render(<SalonApp backend={backend} onSignOut={vi.fn()} initialDate={D} />);
  return { backend, other, user: userEvent.setup() };
}
const free = (staff: string, start: string) =>
  screen.getAllByTestId('free').find((e) => e.getAttribute('data-staff-id') === staff && e.getAttribute('data-start') === start)!;

describe('1. returning customer autocomplete', () => {
  it('normalizes phones and links returning customers without duplicates', () => {
    expect(normalizePhone('+972-50-123-4567')).toBe('0501234567');
    let list: StoredCustomer[] = [];
    let n = 0;
    const id = () => `c${++n}`;
    const a = linkCustomer(list, { customerName: 'אבי', customerPhone: '' }, id);
    list = a.customers;
    const b = linkCustomer(list, { customerName: ' אבי ', customerPhone: '052 7654321' }, id);
    list = b.customers;
    expect(b.id).toBe(a.id);
    const c = linkCustomer(list, { customerName: 'Avi', customerPhone: '+972527654321' }, id);
    expect(c.id).toBe(a.id);
    expect(c.customers).toHaveLength(1);
    expect(matchCustomers(c.customers, '7654').map((x) => x.name)).toEqual(['אבי']);
  });

  it('suggests existing customers while typing a name; picking fills name and phone', async () => {
    const { user, backend } = setup();
    await screen.findAllByTestId('appt');
    await user.click(within(free(SIVAN.id, '14:00')).getByText('פנוי'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'שם הלקוח' }), 'נו');
    const option = await within(dialog).findByRole('option', { name: /נועה/ });
    expect(option).toHaveTextContent('054-7654321');
    await user.click(option);
    expect(within(dialog).getByRole('combobox', { name: 'שם הלקוח' })).toHaveValue('נועה');
    expect(within(dialog).getByTestId('picked-customer')).toHaveTextContent('054-7654321');
    await user.click(within(dialog).getByRole('button', { name: 'שמור' }));
    await screen.findByRole('button', { name: /נועה אצל סיון, 14:00/ });
    const results = await backend.searchCustomers(DEMO_SHOP.id, 'נועה');
    expect(results).toHaveLength(1); // no duplicate customer
    expect(results[0].visits).toBe(3);
  });

  it('suggests by phone number in the full form and still allows a brand-new customer', async () => {
    const { user, backend } = setup();
    await screen.findAllByTestId('appt');
    await user.click(within(free(ROTEM.id, '15:00')).getByText('פנוי'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'אפשרויות נוספות' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: 'מספר טלפון' }), '0501');
    await user.click(await within(dialog).findByRole('option', { name: /דניאל/ }));
    expect(within(dialog).getByRole('combobox', { name: 'שם הלקוח' })).toHaveValue('דניאל');
    expect(within(dialog).getByRole('combobox', { name: 'מספר טלפון' })).toHaveValue('050-1234567');
    await user.click(within(dialog).getByRole('button', { name: 'שמור תור' }));
    await screen.findByRole('button', { name: /דניאל אצל רותם, 15:00/ });

    // brand-new customer
    await user.click(within(free(ROTEM.id, '16:00')).getByText('פנוי'));
    const d2 = await screen.findByRole('dialog');
    await user.type(within(d2).getByRole('combobox', { name: 'שם הלקוח' }), 'לקוח חדש לגמרי{Enter}');
    await screen.findByRole('button', { name: /לקוח חדש לגמרי אצל רותם/ });
    expect(await backend.searchCustomers(DEMO_SHOP.id, 'דניאל')).toHaveLength(1);
    expect(await backend.searchCustomers(DEMO_SHOP.id, 'חדש')).toHaveLength(1);
  });
});

describe('2. moving appointments', () => {
  it('lists only free start times and snaps drops to the target column grid', () => {
    const day = toDayAppointments([appt(R, '09:00', 30), appt(S, '09:00', 60)], D);
    const times = freeStarts({ dayAppts: day, splits: [split(S, '10:00')], staffId: S.id, date: D, duration: 30, dayStart: 540, dayEnd: 660 });
    expect(times).toEqual([600, 615, 630]); // 10:15 offered because Sivan's 10:00 block is split
    expect(snapStart(560, { splits: [], staffId: R.id, date: D, duration: 30, min: 480, max: 1200 })).toBe(570);
    expect(snapStart(611, { splits: [split(R, '10:00')], staffId: R.id, date: D, duration: 15, min: 480, max: 1200 })).toBe(615);
  });

  it('"העבר תור" moves to Sivan on another free time after confirmation', async () => {
    const { user, other } = setup();
    let otherView: DayData = await other.loadDay(DEMO_SHOP.id, D);
    other.subscribe(DEMO_SHOP.id, (e) => (otherView = applyChange(otherView, e, D, 'Asia/Jerusalem')), () => {});
    await user.click(await screen.findByRole('button', { name: /שרון אצל רותם, 10:00/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'העבר תור' }));
    const dialog = await screen.findByRole('dialog', { name: 'העברת תור' });
    await user.click(within(dialog).getByRole('radio', { name: 'סיון' }));
    // Sivan is busy at 09:00 (משה) and 10:30 (רוני): those are not offered
    const times = await within(dialog).findByRole('radiogroup', { name: 'בחירת שעה פנויה' });
    expect(within(times).queryByRole('radio', { name: '09:00' })).toBeNull();
    expect(within(times).queryByRole('radio', { name: '10:30' })).toBeNull();
    await user.click(within(times).getByRole('radio', { name: '11:00' }));
    expect(within(dialog).getByRole('group', { name: 'אישור העברה' })).toHaveTextContent('להעביר את התור של שרון אל סיון');
    await user.click(within(dialog).getByRole('button', { name: 'העבר' }));
    await screen.findByRole('button', { name: /שרון אצל סיון, 11:00–11:30/ });
    await waitFor(() => expect(otherView.appointments.find((a) => a.customerName === 'שרון')?.staffId).toBe(SIVAN.id));
  });

  it('moves to another date and shows that day', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: /גלעד אצל רותם/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'העבר תור' }));
    const dialog = await screen.findByRole('dialog', { name: 'העברת תור' });
    fireEvent.change(within(dialog).getByLabelText('תאריך'), { target: { value: '2026-11-13' } });
    await user.click(await within(dialog).findByRole('radio', { name: '08:00' }));
    await user.click(within(dialog).getByRole('button', { name: 'העבר' }));
    await waitFor(() => expect(screen.getByTestId('date-label')).toHaveTextContent('13 בנובמבר'));
    expect(await screen.findByRole('button', { name: /גלעד אצל רותם, 08:00–09:00/ })).toBeInTheDocument();
  });

  it('drag-and-drop with a mouse asks for confirmation, then moves between staff', async () => {
    setup();
    const card = await screen.findByRole('button', { name: /שרון אצל רותם, 10:00/ });
    const cal = screen.getByTestId('calendar');
    // jsdom has no layout: give the time rows and staff headers real geometry
    const qh = 40;
    const firstMinute = 480;
    cal.querySelectorAll<HTMLElement>('.cal-time').forEach((el) => {
      const m = Number(el.dataset.minute);
      el.getBoundingClientRect = () => ({ top: 100 + ((m - firstMinute) / 15) * qh, height: qh, left: 600, right: 680, bottom: 0, width: 80, x: 600, y: 0, toJSON() {} }) as DOMRect;
    });
    const heads = cal.querySelectorAll<HTMLElement>('.cal-head-staff');
    heads[0].getBoundingClientRect = () => ({ left: 300, right: 600, top: 60, bottom: 100, width: 300, height: 40, x: 300, y: 60, toJSON() {} }) as DOMRect;
    heads[1].getBoundingClientRect = () => ({ left: 0, right: 300, top: 60, bottom: 100, width: 300, height: 40, x: 0, y: 60, toJSON() {} }) as DOMRect;
    const yAt = (m: number) => 100 + ((m - firstMinute) / 15) * qh + 5;

    fireEvent.pointerDown(card, { button: 0, pointerType: 'mouse', clientX: 450, clientY: yAt(600) });
    fireEvent.pointerMove(window, { pointerType: 'mouse', clientX: 150, clientY: yAt(660) });
    expect(await screen.findByTestId('drop-target')).toHaveTextContent('סיון · 11:00–11:30');
    fireEvent.pointerUp(window, { pointerType: 'mouse', clientX: 150, clientY: yAt(660) });
    const confirm = await screen.findByRole('dialog', { name: 'אישור העברה' });
    expect(confirm).toHaveTextContent('להעביר את התור של שרון אל סיון');
    fireEvent.click(within(confirm).getByRole('button', { name: 'העבר' }));
    await screen.findByRole('button', { name: /שרון אצל סיון, 11:00–11:30/ });
  });

  it('a drop onto an occupied slot is refused before asking', async () => {
    setup();
    const card = await screen.findByRole('button', { name: /שרון אצל רותם, 10:00/ });
    const cal = screen.getByTestId('calendar');
    cal.querySelectorAll<HTMLElement>('.cal-time').forEach((el) => {
      const m = Number(el.dataset.minute);
      el.getBoundingClientRect = () => ({ top: 100 + ((m - 480) / 15) * 40, height: 40 }) as DOMRect;
    });
    const heads = cal.querySelectorAll<HTMLElement>('.cal-head-staff');
    heads[0].getBoundingClientRect = () => ({ left: 300, right: 600 }) as DOMRect;
    heads[1].getBoundingClientRect = () => ({ left: 0, right: 300 }) as DOMRect;
    fireEvent.pointerDown(card, { button: 0, pointerType: 'mouse', clientX: 450, clientY: 100 + 8 * 40 + 5 });
    fireEvent.pointerMove(window, { pointerType: 'mouse', clientX: 150, clientY: 100 + 4 * 40 + 5 }); // Sivan 09:00 (משה)
    expect(await screen.findByTestId('drop-target')).toHaveClass('invalid');
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
    expect(await screen.findByRole('alert')).toHaveTextContent('כבר יש תור');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('3. search', () => {
  it('parses Hebrew-style dates', () => {
    expect(parseSearchDate('12/11', '2026-11-10')).toBe('2026-11-12');
    expect(parseSearchDate('3.1.27', '2026-11-10')).toBe('2027-01-03');
    expect(parseSearchDate('2026-11-17', '2026-11-10')).toBe('2026-11-17');
    expect(parseSearchDate('31/02', '2026-11-10')).toBeNull();
    expect(parseSearchDate('050', '2026-11-10')).toBeNull();
  });

  it('finds past and future appointments by name and navigates to the chosen one', async () => {
    const { user } = setup();
    await screen.findAllByTestId('appt');
    await user.click(screen.getByRole('button', { name: 'חיפוש' }));
    const dialog = await screen.findByRole('dialog', { name: 'חיפוש תורים ולקוחות' });
    await user.type(within(dialog).getByRole('searchbox'), 'דניאל');
    const list = await within(dialog).findByTestId('search-results');
    const items = within(list).getAllByRole('button');
    expect(items.length).toBe(3); // two today + one last week
    expect(items[2]).toHaveTextContent('עבר');
    expect(items[2]).toHaveTextContent('רותם');
    expect(items[2]).toHaveTextContent('17:00–17:30');
    await user.click(items[2]);
    await waitFor(() => expect(screen.getByTestId('date-label')).toHaveTextContent('3 בנובמבר'));
    const target = await screen.findByRole('button', { name: /דניאל אצל רותם, 17:00/ });
    expect(target).toHaveClass('is-highlight');
  });

  it('finds by phone number and by date', async () => {
    const { user } = setup();
    await screen.findAllByTestId('appt');
    await user.click(screen.getByRole('button', { name: 'חיפוש' }));
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('searchbox');
    await user.type(box, '0547654321');
    let list = await within(dialog).findByTestId('search-results');
    await waitFor(() => expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('נועה'), expect.stringContaining('נועה'),
    ]));
    await user.clear(box);
    await user.type(box, '17/11/2026');
    expect(within(dialog).getByText(/תורים בתאריך/)).toBeInTheDocument();
    list = await within(dialog).findByTestId('search-results');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(1));
    expect(within(list).getByRole('button')).toHaveTextContent('סיון');
  });
});

describe('4. full-day view', () => {
  it('computes a row height that fits the whole day, never below the legible minimum', () => {
    expect(fitQuarterHeight(30 + 48 * 14, 48)).toBe(14);
    expect(fitQuarterHeight(30 + 48 * 13 - 1, 48)).toBe(FIT_MIN_QUARTER);
    expect(fitQuarterHeight(800, 48)).toBe(16);
    expect(fitQuarterHeight(300, 48)).toBe(FIT_MIN_QUARTER); // too small → scroll instead of shrinking text
    expect(fitQuarterHeight(5000, 48)).toBe(40);
  });

  it('toggles between "הצג יום מלא" and "תצוגה רגילה", keeping columns and split cells', async () => {
    const { user } = setup();
    await screen.findAllByTestId('appt');
    const toggle = screen.getByTestId('view-toggle');
    expect(toggle).toHaveTextContent('הצג יום מלא');
    await user.click(toggle);
    expect(toggle).toHaveTextContent('תצוגה רגילה');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const cal = screen.getByTestId('calendar');
    expect(cal).toHaveClass('is-fit');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['שעה', 'רותם', 'סיון']);
    expect(screen.getAllByTestId('appt').filter((a) => a.getAttribute('data-duration') === '15')).toHaveLength(2);
    await user.click(toggle);
    expect(toggle).toHaveTextContent('הצג יום מלא');
    expect(screen.getByTestId('calendar')).not.toHaveClass('is-fit');
  });
});

describe('5. date navigation order', () => {
  it('is תאריך → יום קודם → היום → יום הבא from right to left (DOM order in RTL)', async () => {
    const { user } = setup(false);
    await screen.findAllByTestId('free');
    const nav = screen.getByTestId('date-nav');
    expect(Array.from(nav.children).map((c) => (c as HTMLElement).dataset.testid)).toEqual([
      'nav-date', 'prev-day', 'today', 'next-day',
    ]);
    await user.click(screen.getByRole('button', { name: 'יום הבא' }));
    expect(screen.getByTestId('date-label')).toHaveTextContent('11 בנובמבר');
    await user.click(screen.getByRole('button', { name: 'יום קודם' }));
    await user.click(screen.getByRole('button', { name: 'יום קודם' }));
    expect(screen.getByTestId('date-label')).toHaveTextContent('9 בנובמבר');
  });
});

void act;
