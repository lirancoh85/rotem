import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalonApp } from './App';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './data/demoBackend';
import { computeStats, customerStatus } from './domain/profile';
import { D, ROTEM, appt } from './test/fixtures';

function setup() {
  const store = memoryStore(seedDemoData(D));
  const channel = `p1-${Math.random()}`;
  const backend = new DemoBackend(store, channel);
  const other = new DemoBackend(store, channel);
  render(<SalonApp backend={backend} onSignOut={vi.fn()} initialDate={D} />);
  return { backend, other, user: userEvent.setup() };
}
const card = (re: RegExp) => screen.findByRole('button', { name: re });

describe('Phase 1 — customer status rules', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  it('new → returning → inactive', () => {
    expect(customerStatus(0, null, '2026-12-01T10:00:00Z', now)).toBe('new');
    expect(customerStatus(1, '2026-11-01T10:00:00Z', null, now)).toBe('new');
    expect(customerStatus(2, '2026-11-01T10:00:00Z', null, now)).toBe('returning');
    expect(customerStatus(5, '2026-06-01T10:00:00Z', null, now)).toBe('inactive');
    expect(customerStatus(5, '2026-06-01T10:00:00Z', '2026-12-01T10:00:00Z', now)).toBe('returning');
  });
  it('counts completed visits, cancellations and no-shows separately', () => {
    const a = (d: string, status?: 'cancelled' | 'no_show') => ({ ...appt(ROTEM, '10:00', 30, 'x', d), status });
    const s = computeStats([a('2026-10-01'), a('2026-10-15', 'no_show'), a('2026-10-20', 'cancelled'), a('2026-11-01'), a('2026-12-01')], now);
    expect(s).toMatchObject({ completedVisits: 2, noShowCount: 1, cancelledCount: 1, upcomingCount: 1, status: 'returning' });
    expect(s.firstVisit?.slice(0, 10)).toBe('2026-10-01');
  });
});

describe('Phase 1 — profiles in the app', () => {
  it('tapping the customer name opens the profile; tapping the card still edits', async () => {
    const { user } = setup();
    const daniel = (await screen.findAllByRole('button', { name: /דניאל אצל רותם, 08:00/ }))[0];
    await user.click(within(daniel).getByText('דניאל'));
    const prof = await screen.findByTestId('customer-profile');
    expect(within(prof).getByRole('heading', { name: 'דניאל' })).toBeInTheDocument();
    expect(within(prof).getByText('050-1234567')).toBeInTheDocument();
    expect(within(prof).getByRole('region', { name: 'התור הנוכחי' })).toHaveTextContent('08:00–08:30');
    // three visits: last week + two earlier today (all in the past relative to now)
    await waitFor(() => expect(within(prof).getByTestId('stat-visits')).toHaveTextContent('3'));
    expect(within(prof).getByTestId('customer-status')).toHaveTextContent('חוזר/ת');
    const rows = within(within(prof).getByTestId('history-previous')).getAllByTestId('history-row');
    expect(rows.map((r) => r.textContent?.match(/\d{2}:\d{2}–/)?.[0])).toEqual(['17:00–', '08:00–', '09:00–']); // chronological
    await user.click(screen.getByRole('button', { name: 'סגירה' }));
    await user.click(await card(/שרון אצל רותם/));
    expect(within(await screen.findByRole('dialog')).getByRole('heading')).toHaveTextContent('עריכת תור');
  });

  it('edits details and preferences; calendar shows the new name; a taken phone is refused', async () => {
    const { user } = setup();
    await user.click(within(await card(/שרון אצל רותם/)).getByText('שרון'));
    let prof = await screen.findByTestId('customer-profile');
    await user.click(within(prof).getByRole('button', { name: 'עריכת פרטים' }));
    const name = within(prof).getByLabelText('שם הלקוח');
    await user.clear(name);
    await user.type(name, 'שרון לוי');
    await user.type(within(prof).getByLabelText('העדפות תספורת'), 'קצר בצדדים');
    await user.click(within(prof).getByRole('button', { name: 'שמור פרטים' }));
    await within(prof).findByRole('heading', { name: 'שרון לוי' });
    expect(within(prof).getByText('קצר בצדדים')).toBeInTheDocument();
    await screen.findByRole('button', { name: /שרון לוי אצל רותם, 10:00/ });
    // phone of another customer
    await user.click(within(prof).getByRole('button', { name: 'עריכת פרטים' }));
    prof = screen.getByTestId('customer-profile');
    await user.type(within(prof).getByLabelText('מספר טלפון'), '054-7654321');
    await user.click(within(prof).getByRole('button', { name: 'שמור פרטים' }));
    expect(await within(prof).findByRole('alert')).toHaveTextContent('כבר שייך');
  });

  it('"Book again" opens a new booking with the customer selected and links to the same profile', async () => {
    const { user, backend } = setup();
    await user.click(within(await card(/נועה אצל סיוון/)).getByText('נועה'));
    const prof = await screen.findByTestId('customer-profile');
    await user.click(await within(prof).findByRole('button', { name: 'קבע תור שוב' }));
    const form = await screen.findByRole('dialog', { name: /תור חדש/ });
    expect(within(form).getByRole('combobox', { name: 'שם הלקוח' })).toHaveValue('נועה');
    expect(within(form).getByRole('combobox', { name: 'מספר טלפון' })).toHaveValue('054-7654321');
    expect(within(form).getByRole('radio', { name: 'סיוון' })).toHaveAttribute('aria-checked', 'true');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'שעה' }), '900');
    await user.click(within(form).getByRole('button', { name: 'שמור תור' }));
    await card(/נועה אצל סיוון, 15:00/);
    const found = await backend.listCustomers(DEMO_SHOP.id, 'נועה');
    expect(found).toHaveLength(1);
    expect(found[0].completedVisits + found[0].upcomingCount).toBe(3);
  });

  it('customers list searches by name and phone and opens a profile', async () => {
    const { user } = setup();
    await screen.findAllByTestId('appt');
    await user.click(screen.getByRole('button', { name: 'לקוחות' }));
    const panel = await screen.findByTestId('customers-panel');
    await waitFor(() => expect(within(panel).getAllByTestId('customer-row').length).toBeGreaterThan(5));
    await user.type(within(panel).getByRole('searchbox'), '7654');
    await waitFor(() => expect(within(panel).getAllByTestId('customer-row')).toHaveLength(1));
    expect(within(panel).getByTestId('customer-row')).toHaveTextContent('נועה');
    await user.click(within(panel).getByTestId('customer-row'));
    expect(await screen.findByRole('heading', { name: 'נועה' })).toBeInTheDocument();
  });

  it('cancel keeps history (and undo restores); no-show is recorded', async () => {
    const { user } = setup();
    await user.click(await card(/רוני אצל סיוון/));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'בטל תור' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'ביטול תור' })).getByRole('button', { name: 'בטל תור' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /רוני אצל/ })).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'ביטול פעולה' }));
    const back = await card(/רוני אצל סיוון/);
    // no-show via the profile
    await user.click(within(back).getByText('רוני'));
    const prof = await screen.findByTestId('customer-profile');
    await user.click(await within(prof).findByRole('button', { name: 'לא הגיע' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /רוני אצל סיוון.*לא הגיע/ })).toHaveClass('is-no-show'));
    await waitFor(() => expect(within(within(prof).getByTestId('history-missed')).getAllByTestId('history-row')).toHaveLength(1));
  });

  it('first-time customers stay green on their first appointment', async () => {
    const { other } = setup();
    await act(() => other.createAppointment(DEMO_SHOP, {
      staffId: DEMO_STAFF[0].id, date: D, start: 900, duration: 30, customerName: 'ראשונה', customerPhone: '058-1111111', service: '', notes: '',
    }));
    await waitFor(async () => expect(await card(/ראשונה אצל רותם/)).toHaveClass('is-first'));
  });
});
