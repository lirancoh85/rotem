import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SalonApp } from './App';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './data/demoBackend';
import { D } from './test/fixtures';

function setup() {
  const store = memoryStore({ ...seedDemoData(D), appointments: [], splits: [] });
  const channel = `app-${Math.random()}`;
  const backend = new DemoBackend(store, channel);
  const other = new DemoBackend(store, channel); // a second device
  render(<SalonApp backend={backend} onSignOut={vi.fn()} initialDate={D} />);
  return { backend, other, user: userEvent.setup() };
}
const free = (staff: string, start: string) =>
  screen.getAllByTestId('free').find((e) => e.getAttribute('data-staff-id') === staff && e.getAttribute('data-start') === start)!;
const [ROTEM, SIVAN] = DEMO_STAFF;

describe('appointment management (full app, Hebrew UI)', () => {
  it('tapping a slot asks only for a name: type it, press Enter, booked for 30 minutes with Rotem', async () => {
    const { user } = setup();
    await screen.findByText('רותם', { selector: '[role=columnheader]' });
    await user.click(within(free(ROTEM.id, '10:00')).getByText('פנוי'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('רותם · 10:00–10:30');
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(1);
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'חסום משבצת' })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('שם הלקוח'), 'שרון{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const card = screen.getByRole('button', { name: /שרון אצל רותם, 10:00–10:30/ });
    expect(card).toHaveTextContent('(30 דק׳)');
    expect(await screen.findByText('התור נשמר')).toBeInTheDocument();
  });

  it('uses "פצל ל־15 דקות" in the form to book the second quarter, leaving the first free', async () => {
    const { user } = setup();
    await screen.findAllByTestId('free');
    await user.click(within(free(SIVAN.id, '09:00')).getByText('פנוי'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'אפשרויות נוספות' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'סיוון' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(dialog).getByRole('checkbox', { name: /פצל ל־15 דקות/ }));
    await user.click(within(dialog).getByRole('radio', { name: /רבע שני/ }));
    await user.type(within(dialog).getByLabelText('שם הלקוח'), 'יוסי');
    await user.click(within(dialog).getByRole('button', { name: 'שמור תור' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /יוסי אצל סיוון, 09:15–09:30/ })).toBeInTheDocument();
    expect(free(SIVAN.id, '09:00')).toHaveAttribute('data-len', '15');
    expect(free(ROTEM.id, '09:00')).toHaveAttribute('data-len', '30'); // Rotem not split
  });

  it('splits a block with the cell button (no appointment created) and reverts it', async () => {
    const { user, backend } = setup();
    await screen.findAllByTestId('free');
    await user.click(screen.getByRole('button', { name: 'פיצול 11:00 של רותם לשני תורים של 15 דקות' }));
    await waitFor(() => expect(free(ROTEM.id, '11:15')).toHaveAttribute('data-len', '15'));
    expect((await backend.loadDay(DEMO_SHOP.id, D)).appointments).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'החזרת 11:00 של רותם לתור של 30 דקות' }));
    await waitFor(() => expect(free(ROTEM.id, '11:00')).toHaveAttribute('data-len', '30'));
  });

  it('shows a Hebrew error when another device took the slot first', async () => {
    const { user, other } = setup();
    await screen.findAllByTestId('free');
    await user.click(within(free(ROTEM.id, '12:00')).getByText('פנוי'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('שם הלקוח'), 'אבי');
    // the phone books the same slot while the tablet form is open
    await act(() => other.createAppointment(DEMO_SHOP, {
      staffId: ROTEM.id, date: D, start: 720, duration: 30, customerName: 'מהטלפון', customerPhone: '', service: '', notes: '',
    }));
    await user.click(within(dialog).getByRole('button', { name: 'שמור' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('כבר יש תור');
    expect(screen.getByRole('button', { name: /מהטלפון אצל רותם/ })).toBeInTheDocument();
  });

  it('edits, moves to Sivan and deletes with a confirmation dialog', async () => {
    const { user, other } = setup();
    await act(() => other.createAppointment(DEMO_SHOP, {
      staffId: ROTEM.id, date: D, start: 600, duration: 30, customerName: 'רוני', customerPhone: '', service: '', notes: '',
    }));
    await user.click(await screen.findByRole('button', { name: /רוני אצל רותם/ }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('עריכת תור');
    await user.click(within(dialog).getByRole('radio', { name: 'סיוון' }));
    await user.click(within(dialog).getByRole('radio', { name: 'שעה' }));
    await user.click(within(dialog).getByRole('button', { name: 'שמור שינויים' }));
    const moved = await screen.findByRole('button', { name: /רוני אצל סיוון, 10:00–11:00/ });
    await user.click(moved);
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'מחק תור' }));
    const confirm = await screen.findByRole('dialog', { name: 'מחיקת תור' });
    expect(confirm).toHaveTextContent('למחוק את התור של רוני בשעה 10:00?');
    await user.click(within(confirm).getByRole('button', { name: 'מחק' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /רוני/ })).not.toBeInTheDocument());
  });

  it('crosses out a slot and un-blocks it again', async () => {
    const { user, other } = setup();
    await screen.findAllByTestId('free');
    await user.click(within(free(SIVAN.id, '13:00')).getByText('פנוי'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'חסום משבצת' }));
    const blocked = await screen.findByRole('button', { name: /סיוון, 13:00–13:30, משבצת חסומה/ });
    expect(blocked).toHaveTextContent('חסום');
    // another device cannot book over a crossed-out slot
    await expect(other.createAppointment(DEMO_SHOP, {
      staffId: SIVAN.id, date: D, start: 780, duration: 30, customerName: 'x', customerPhone: '', service: '', notes: '',
    })).rejects.toMatchObject({ code: 'OVERLAP' });
    await user.click(blocked);
    const confirm = await screen.findByRole('dialog', { name: 'ביטול חסימה' });
    await user.click(within(confirm).getByRole('button', { name: 'בטל חסימה' }));
    await waitFor(() => expect(free(SIVAN.id, '13:00')).toHaveAttribute('data-len', '30'));
  });

  it('requires a name before saving from the quick dialog', async () => {
    const { user } = setup();
    await screen.findAllByTestId('free');
    await user.click(within(free(ROTEM.id, '16:00')).getByText('פנוי'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'שמור' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('יש להזין את שם הלקוח');
  });

  it('reflects changes made on another device in real time', async () => {
    const { other } = setup();
    await screen.findAllByTestId('free');
    await act(async () => {
      await other.setSplit(DEMO_SHOP, SIVAN.id, D, 14 * 60, true);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(free(SIVAN.id, '14:15')).toHaveAttribute('data-len', '15');
  });
});
