import type { Appointment, SlotSplit, Staff } from './types';
import { findOverlap, freeStarts, toDayAppointments } from './schedule';
import { addDays } from '../lib/time';
import { israelDayInfo } from '../lib/holidays';

export interface RecurrenceRule {
  /** 1 = every week, 2 = every two weeks … */
  intervalWeeks: number;
  end: { kind: 'count'; count: number } | { kind: 'until'; date: string };
}

export const MAX_OCCURRENCES = 52;

/** Occurrence dates ('YYYY-MM-DD'), starting with `firstDate`. Calendar arithmetic, so DST never shifts dates. */
export function occurrenceDates(firstDate: string, rule: RecurrenceRule): string[] {
  const step = Math.max(1, Math.min(52, Math.round(rule.intervalWeeks))) * 7;
  const out: string[] = [];
  for (let d = firstDate; out.length < MAX_OCCURRENCES; d = addDays(d, step)) {
    if (rule.end.kind === 'count' && out.length >= Math.max(1, rule.end.count)) break;
    if (rule.end.kind === 'until' && d > rule.end.date) break;
    out.push(d);
  }
  return out;
}

export type Problem = 'overlap' | 'closed' | 'holiday' | 'hours';

export interface Alternative {
  date: string;
  start: number;
  staffId: string;
}

export interface OccurrenceCheck {
  index: number;
  date: string;
  start: number;
  staffId: string;
  problem: Problem | null;
  /** holiday name, or the name of the customer already booked */
  detail?: string;
  /** free slots on the same/adjacent days for manual rescheduling */
  alternatives: Alternative[];
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Is the salon open on this date (closed weekday / statutory holiday)? */
export function closedReason(date: string, closedWeekdays: number[]): { problem: 'closed' | 'holiday'; detail?: string } | null {
  if (closedWeekdays.includes(weekdayOf(date))) return { problem: 'closed' };
  const h = israelDayInfo(date);
  if (h?.dayOff) return { problem: 'holiday', detail: h.names.join(' · ') };
  return null;
}

/**
 * Checks every occurrence against existing bookings (incl. crossed-out slots),
 * opening hours, closed weekdays and Israeli non-working days.
 */
export function checkOccurrences(opts: {
  dates: string[];
  start: number;
  duration: number;
  staffId: string;
  staff: Staff[];
  appointments: Appointment[];
  splits: SlotSplit[];
  dayStart: number;
  dayEnd: number;
  closedWeekdays: number[];
  tz: string;
}): OccurrenceCheck[] {
  const dayCache = new Map<string, ReturnType<typeof toDayAppointments>>();
  const dayAppts = (date: string) => {
    if (!dayCache.has(date)) dayCache.set(date, toDayAppointments(opts.appointments, date, opts.tz));
    return dayCache.get(date)!;
  };
  // occurrences already chosen in this series also occupy their slot
  const taken: { date: string; staffId: string; start: number; end: number }[] = [];
  const clashesTaken = (date: string, staffId: string, start: number) =>
    taken.some((t) => t.date === date && t.staffId === staffId && t.start < start + opts.duration && t.end > start);

  const alternativesFor = (date: string): Alternative[] => {
    const out: Alternative[] = [];
    for (const d of [date, addDays(date, 1), addDays(date, -1), addDays(date, 2)]) {
      if (closedReason(d, opts.closedWeekdays)) continue;
      const staffOrder = [opts.staffId, ...opts.staff.map((s) => s.id).filter((id) => id !== opts.staffId)];
      for (const sid of staffOrder) {
        const free = freeStarts({
          dayAppts: dayAppts(d),
          splits: opts.splits,
          staffId: sid,
          date: d,
          duration: opts.duration,
          dayStart: opts.dayStart,
          dayEnd: opts.dayEnd,
        }).filter((m) => !clashesTaken(d, sid, m));
        // nearest times to the requested one first
        free.sort((a, b) => Math.abs(a - opts.start) - Math.abs(b - opts.start));
        free.slice(0, 3).forEach((m) => out.push({ date: d, start: m, staffId: sid }));
      }
      if (out.length >= 6) break;
    }
    return out.slice(0, 6);
  };

  return opts.dates.map((date, index) => {
    const base = { index, date, start: opts.start, staffId: opts.staffId };
    const closed = closedReason(date, opts.closedWeekdays);
    let problem: Problem | null = null;
    let detail: string | undefined;
    if (closed) {
      problem = closed.problem;
      detail = closed.detail;
    } else if (opts.start < opts.dayStart || opts.start + opts.duration > opts.dayEnd) {
      problem = 'hours';
    } else {
      const hit = findOverlap(dayAppts(date), opts.staffId, opts.start, opts.start + opts.duration);
      if (hit || clashesTaken(date, opts.staffId, opts.start)) {
        problem = 'overlap';
        detail = hit?.appt.isBlocked ? undefined : hit?.appt.customerName;
      }
    }
    if (!problem) taken.push({ date, staffId: opts.staffId, start: opts.start, end: opts.start + opts.duration });
    return { ...base, problem, detail, alternatives: problem ? alternativesFor(date) : [] };
  });
}
