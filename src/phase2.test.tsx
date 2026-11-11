import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalonApp } from './App';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './data/demoBackend';
import { checkOccurrences, occurrenceDates } from './domain/recurrence';
import { localToIso, utcToLocal } from './lib/time';

const [ROTEM, SIVAN] = DEMO_STAFF;
const START = '2026-11-15'; // Sunday

function setup(date = START) {
  const seed = seedDemoData('2026-11-10');
  const store = memoryStore({ ...seed, appointments: [], splits: [], customers: [] });
  const channel = `p2-${Math.random()}`;
  const backend = new DemoBackend(store, channel);
  render(<SalonApp backend={backend} onSignOut={vi.fn()} initialDate={date} />);
  return { backend, user: userEvent.setup() };
}
const book = (b: DemoBackend, staffId: string, date: string, start: number, name: string) =>
  b.createAppointment(DEMO_SHOP, { staffId, date, start, duration: 30, customerName: name, customerPhone: '', service: '', notes: '' });

async function openSeriesForm(user: ReturnType<typeof userEvent.setup>, every = 'כל שבוע', count = '4') {
  const cell = (await screen.findAllByTestId('free')).find((e) => e.getAttribute('data-staff-id') === ROTEM.id && e.getAttribute('data-start') === '10:00')!;
  await user.click(within(cell).getByText('פנוי'));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'אפשרויות נוספות' }));
  const form = await screen.findByRole('dialog', { name: /תור חדש/ });
  await user.type(within(form).getByRole('combobox', { name: 'שם הלקוח' }), 'קבוע');
  await user.type(within(form).getByRole('combobox', { name: 'מספר טלפון' }), '050-9090909');
  await user.click(within(form).getByRole('radio', { name: every }));
  const countInput = within(form).getByRole('spinbutton', { name: 'מספר תורים' });
  fireEvent.change(countInput, { target: { value: count } });
  await user.click(within(form).getByRole('button', { name: 'תצוגה מקדימה' }));
  return screen.findByTestId('series-preview');
}

describe('Phase 2 — recurrence rules', () => {
  it('generates dates by interval with count or end date, never shifted by DST', () => {
    expect(occurrenceDates('2026-10-18', { intervalWeeks: 1, end: { kind: 'count', count: 3 } })).toEqual(['2026-10-18', '2026-10-25', '2026-11-01']);
    expect(occurrenceDates('2026-11-01', { intervalWeeks: 3, end: { kind: 'until', date: '2026-12-31' } })).toEqual(['2026-11-01', '2026-11-22', '2026-12-13']);
    // the occurrence after the October DST change keeps 10:00 local
    expect(utcToLocal(localToIso('2026-10-25', 600)).minutes).toBe(600);
  });

  it('flags booked slots, closed days, holidays and hours, and offers alternatives', () => {
    const appt = { id: 'x', shopId: 's', staffId: ROTEM.id, customerName: 'תפוס', customerPhone: null, service: null, notes: null, startsAt: localToIso('2026-09-27', 600), endsAt: localToIso('2026-09-27', 630) };
    const checks = checkOccurrences({
      dates: ['2026-09-19', '2026-09-21', '2026-09-27', '2026-09-28'],
      start: 600, duration: 30, staffId: ROTEM.id, staff: DEMO_STAFF, appointments: [appt], splits: [],
      dayStart: 480, dayEnd: 1200, closedWeekdays: [6], tz: 'Asia/Jerusalem',
    });
    expect(checks.map((c) => c.problem)).toEqual(['closed', 'holiday', 'overlap', null]);
    expect(checks[1].detail).toBe('יום כיפור');
    expect(checks[2].detail).toBe('תפוס');
    expect(checks[2].alternatives[0]).toMatchObject({ date: '2026-09-27', staffId: ROTEM.id });
    const late = checkOccurrences({ dates: ['2026-09-28'], start: 1190, duration: 30, staffId: ROTEM.id, staff: DEMO_STAFF, appointments: [], splits: [], dayStart: 480, dayEnd: 1200, closedWeekdays: [], tz: 'Asia/Jerusalem' });
    expect(late[0].problem).toBe('hours');
  });
});

describe('Phase 2 — recurring bookings in the app', () => {
  it('previews and creates a weekly series linked to one customer, with a recurring icon', async () => {
    const { user, backend } = setup();
    const preview = await openSeriesForm(user);
    await waitFor(() => expect(within(preview).getAllByTestId('occurrence')).toHaveLength(4));
    expect(within(preview).getByTestId('series-summary')).toHaveTextContent('ייקבעו 4 תורים');
    await user.click(within(preview).getByRole('button', { name: 'קבע 4 תורים' }));
    const card = await screen.findByRole('button', { name: /קבוע אצל רותם, 10:00.*תור קבוע/ });
    expect(card).toHaveAttribute('data-series', 'true');
    const range = await backend.loadRange(DEMO_SHOP.id, START, '2026-12-31');
    expect(range.appointments.map((a) => utcToLocal(a.startsAt).date)).toEqual(['2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06']);
    expect(new Set(range.appointments.map((a) => a.customerId)).size).toBe(1);
    expect(new Set(range.appointments.map((a) => a.seriesId)).size).toBe(1);
  });

  it('shows conflicts and lets each be skipped or moved — never overwriting', async () => {
    const { user, backend } = setup();
    await act(async () => void (await book(backend, ROTEM.id, '2026-11-22', 600, 'קיים')));
    const preview = await openSeriesForm(user);
    await waitFor(() => expect(within(preview).getAllByTestId('occurrence')).toHaveLength(4));
    const bad = within(preview).getAllByTestId('occurrence').find((o) => o.dataset.problem === 'overlap')!;
    expect(bad).toHaveTextContent('תפוס · קיים');
    expect(within(preview).getByTestId('series-summary')).toHaveTextContent('ייקבעו 3 תורים · 1 ידולגו');
    const select = within(bad).getByRole('combobox');
    await user.selectOptions(select, within(select).getAllByRole('option')[1]);
    expect(within(preview).getByTestId('series-summary')).toHaveTextContent('ייקבעו 4 תורים');
    await user.click(within(preview).getByRole('button', { name: 'קבע 4 תורים' }));
    await waitFor(() => expect(screen.queryByTestId('series-preview')).toBeNull());
    const all = (await backend.loadRange(DEMO_SHOP.id, START, '2026-12-31')).appointments;
    expect(all.filter((a) => a.customerName === 'קיים')).toHaveLength(1);
    expect(all.filter((a) => a.seriesId)).toHaveLength(4);
  });

  it('the same request twice creates one series', async () => {
    const backend = new DemoBackend(memoryStore({ ...seedDemoData('2026-11-10'), appointments: [], splits: [], customers: [] }), `x-${Math.random()}`);
    const req = {
      requestKey: 'k-1', staffId: ROTEM.id, customerName: 'כפול', customerPhone: '', customerId: null, service: '', notes: '',
      intervalWeeks: 1, duration: 30, endsOn: null, count: 2,
      occurrences: [{ index: 0, date: '2026-11-15', start: 600, staffId: ROTEM.id }, { index: 1, date: '2026-11-22', start: 600, staffId: ROTEM.id }],
    };
    const a = await backend.createSeries(DEMO_SHOP, req);
    const b = await backend.createSeries(DEMO_SHOP, req);
    expect(b).toBe(a);
    expect((await backend.loadRange(DEMO_SHOP.id, '2026-11-01', '2026-12-31')).appointments).toHaveLength(2);
  });

  it('edit "only this" vs "this and following"; cancel following', async () => {
    const { user, backend } = setup();
    const preview = await openSeriesForm(user, 'כל שבוע', '3');
    await user.click(await within(preview).findByRole('button', { name: 'קבע 3 תורים' }));
    // edit only this one: move to 11:00
    await user.click(await screen.findByRole('button', { name: /קבוע אצל רותם, 10:00/ }));
    let form = await screen.findByRole('dialog', { name: /עריכת תור/ });
    await user.selectOptions(within(form).getByRole('combobox', { name: 'שעה' }), '660');
    await user.click(within(form).getByRole('button', { name: 'שמור שינויים' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'עריכת תור קבוע' })).getByRole('button', { name: 'רק התור הזה' }));
    await screen.findByRole('button', { name: /קבוע אצל רותם, 11:00/ });
    let times = (await backend.loadRange(DEMO_SHOP.id, START, '2026-12-31')).appointments.map((a) => utcToLocal(a.startsAt).minutes);
    expect(times).toEqual([660, 600, 600]);
    // this and following: Sivan at 12:00
    await user.click(screen.getByRole('button', { name: /קבוע אצל רותם, 11:00/ }));
    form = await screen.findByRole('dialog', { name: /עריכת תור/ });
    await user.click(within(form).getByRole('radio', { name: 'סיוון' }));
    await user.selectOptions(within(form).getByRole('combobox', { name: 'שעה' }), '720');
    await user.click(within(form).getByRole('button', { name: 'שמור שינויים' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'עריכת תור קבוע' })).getByRole('button', { name: 'התור הזה וכל הבאים' }));
    await screen.findByRole('button', { name: /קבוע אצל סיוון, 12:00/ });
    const after = (await backend.loadRange(DEMO_SHOP.id, START, '2026-12-31')).appointments;
    expect(after.map((a) => [utcToLocal(a.startsAt).minutes, a.staffId])).toEqual([[720, SIVAN.id], [720, SIVAN.id], [720, SIVAN.id]]);
    // cancel this and following from the second one
    const second = after.sort((x, y) => x.startsAt.localeCompare(y.startsAt))[1];
    expect(await backend.cancelSeries(second.id, 'future')).toBe(2);
    expect((await backend.loadRange(DEMO_SHOP.id, START, '2026-12-31')).appointments).toHaveLength(1);
  });

  it('closed weekday (Saturday) is flagged in the preview', async () => {
    const { user } = setup('2026-11-14'); // Saturday
    const preview = await openSeriesForm(user, 'כל שבוע', '2');
    await waitFor(() => expect(within(preview).getAllByTestId('occurrence').every((o) => o.dataset.problem === 'closed')).toBe(true));
  });
});
