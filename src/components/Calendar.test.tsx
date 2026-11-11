import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Calendar, type CalendarProps } from './Calendar';
import { toDayAppointments } from '../domain/schedule';
import { D, ROTEM, SIVAN, appt, split } from '../test/fixtures';

function setup(over: Partial<CalendarProps> = {}) {
  const appts = [appt(ROTEM, '09:00', 15, 'דניאל'), appt(ROTEM, '09:15', 15, 'אבי'), appt(SIVAN, '09:00', 30, 'משה')];
  const props: CalendarProps = {
    staff: [ROTEM, SIVAN],
    date: D,
    dayStart: 8 * 60,
    dayEnd: 10 * 60,
    dayAppts: toDayAppointments(appts, D),
    splits: [split(ROTEM, '09:00')],
    nowMinutes: null,
    onFreeTap: vi.fn(),
    onAppointmentTap: vi.fn(),
    onSplit: vi.fn(),
    onMerge: vi.fn(),
    ...over,
  };
  render(<Calendar {...props} />);
  return props;
}
const gridCol = (el: Element) => (el as HTMLElement).style.gridColumn;

describe('RTL calendar layout', () => {
  it('is RTL with columns שעה, רותם, סיוון in grid columns 1, 2, 3 (right to left)', () => {
    setup();
    const cal = screen.getByTestId('calendar');
    expect(cal).toHaveAttribute('dir', 'rtl');
    const heads = screen.getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual(['שעה', 'רותם', 'סיוון']);
    expect(heads.map(gridCol)).toEqual(['1', '2', '3']);
    expect(cal.style.gridTemplateColumns).toBe('var(--time-col) repeat(2, minmax(0, 1fr))');
  });

  it('places every appointment in its own staff column', () => {
    setup();
    for (const el of screen.getAllByTestId('appt')) {
      expect(gridCol(el)).toBe(el.getAttribute('data-staff-id') === ROTEM.id ? '2' : '3');
    }
  });
});

describe('15 / 30-minute rendering', () => {
  it('renders Rotem’s split 09:00 block as two 15-minute cells and Sivan’s as one 30-minute appointment', () => {
    setup();
    const [daniel, avi] = screen.getAllByTestId('appt').filter((e) => e.getAttribute('data-staff-id') === ROTEM.id);
    expect(daniel).toHaveAttribute('data-start', '09:00');
    expect(daniel).toHaveAttribute('data-duration', '15');
    expect(avi).toHaveAttribute('data-start', '09:15');
    // 15-minute appointments span 1 grid row, 30-minute ones span 2
    const span = (el: Element) => {
      const [a, b] = (el as HTMLElement).style.gridRow.split('/').map((x) => Number(x.trim()));
      return b - a;
    };
    expect(span(daniel)).toBe(1);
    const moshe = screen.getByRole('button', { name: /משה/ });
    expect(span(moshe)).toBe(2);
    expect(moshe).toHaveTextContent('(30 דק׳)');
    expect(daniel).toHaveTextContent('(15 דק׳)');
  });

  it('shows free 30-minute blocks with a split button, and empty split halves as 15 minutes', () => {
    setup({ dayAppts: [], splits: [split(SIVAN, '08:30')] });
    const sivanFree = screen.getAllByTestId('free').filter((e) => e.getAttribute('data-staff-id') === SIVAN.id);
    expect(sivanFree.slice(0, 3).map((e) => [e.getAttribute('data-start'), e.getAttribute('data-len')])).toEqual([
      ['08:00', '30'], ['08:30', '15'], ['08:45', '15'],
    ]);
    // Rotem's 08:30 is unaffected by Sivan's split
    const rotem0830 = screen.getAllByTestId('free').find((e) => e.getAttribute('data-staff-id') === ROTEM.id && e.getAttribute('data-start') === '08:30');
    expect(rotem0830).toHaveAttribute('data-len', '30');
    expect(within(sivanFree[1]).getByRole('button', { name: /החזרת 08:30 של סיוון/ })).toBeInTheDocument();
  });
});

describe('interaction', () => {
  it('tapping a slot in a staff column selects that staff member', async () => {
    const p = setup({ dayAppts: [], splits: [] });
    await userEvent.click(screen.getByRole('button', { name: /^סיוון, 08:00–08:30/ }));
    expect(p.onFreeTap).toHaveBeenLastCalledWith(SIVAN.id, 480, false);
    await userEvent.click(screen.getByRole('button', { name: /^רותם, 08:30–09:00/ }));
    expect(p.onFreeTap).toHaveBeenLastCalledWith(ROTEM.id, 510, false);
  });
  it('split / merge buttons target only their staff member and block', async () => {
    const p = setup({ dayAppts: [], splits: [split(ROTEM, '09:30')] });
    await userEvent.click(screen.getByRole('button', { name: 'פיצול 09:00 של סיוון לשני תורים של 15 דקות' }));
    expect(p.onSplit).toHaveBeenCalledWith(SIVAN.id, 540);
    await userEvent.click(screen.getByRole('button', { name: 'החזרת 09:30 של רותם לתור של 30 דקות' }));
    expect(p.onMerge).toHaveBeenCalledWith(ROTEM.id, 570);
  });
  it('a single staff filter renders time + one column', () => {
    setup({ staff: [SIVAN] });
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['שעה', 'סיוון']);
  });
});
