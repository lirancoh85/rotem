import type { Appointment, Shop, SlotSplit, Staff, WaitlistRequest } from './types';
import { freeStarts, toDayAppointments } from './schedule';
import { closedReason } from './recurrence';
import { utcToLocal } from '../lib/time';

export interface SlotMatch {
  requestId: string;
  date: string;
  start: number;
  staffId: string;
  duration: number;
}

/**
 * Free slots that fit a waiting customer: one of their preferred dates (today or later,
 * salon open), their staff preference, their time range and the service length.
 */
export function matchesForRequest(
  req: WaitlistRequest,
  ctx: { appointments: Appointment[]; splits: SlotSplit[]; staff: Staff[]; shop: Shop; today: string; nowMinutes: number },
  perDate = 3,
): SlotMatch[] {
  if (req.status !== 'waiting') return [];
  const out: SlotMatch[] = [];
  const staffIds = req.staffId ? [req.staffId] : ctx.staff.map((s) => s.id);
  for (const date of [...req.preferredDates].sort()) {
    if (date < ctx.today || closedReason(date, ctx.shop.closedWeekdays)) continue;
    const day = toDayAppointments(ctx.appointments, date, ctx.shop.timezone);
    const from = Math.max(req.timeFrom, ctx.shop.dayStart, date === ctx.today ? Math.ceil((ctx.nowMinutes + 1) / 15) * 15 : 0);
    const to = Math.min(req.timeTo, ctx.shop.dayEnd);
    let n = 0;
    for (const staffId of staffIds) {
      const free = freeStarts({ dayAppts: day, splits: ctx.splits, staffId, date, duration: req.duration, dayStart: from, dayEnd: to });
      for (const start of free) {
        if (n >= perDate) break;
        // a slot already offered and still open is not suggested again
        const offered = req.offers.some((o) => {
          if (o.status !== 'sent' || o.staffId !== staffId) return false;
          const l = utcToLocal(o.startsAt, ctx.shop.timezone);
          return l.date === date && l.minutes === start;
        });
        if (!offered) out.push({ requestId: req.id, date, start, staffId, duration: req.duration });
        n++;
      }
    }
  }
  return out;
}


/** Waiting customers that fit one specific slot that just became free. */
export function requestsForSlot(
  requests: WaitlistRequest[],
  slot: { date: string; start: number; end: number; staffId: string },
): WaitlistRequest[] {
  return requests.filter(
    (r) =>
      r.status === 'waiting' &&
      r.preferredDates.includes(slot.date) &&
      (!r.staffId || r.staffId === slot.staffId) &&
      slot.start >= r.timeFrom &&
      slot.start + r.duration <= r.timeTo &&
      r.duration <= slot.end - slot.start,
  );
}

/** The prefilled Hebrew WhatsApp offer. */
export function offerMessage(o: { customerName: string; salonName: string; dateLabel: string; time: string; staffName: string }) {
  const first = o.customerName.trim().split(/\s+/)[0];
  return `היי ${first}, כאן ${o.salonName}. התפנה תור ב${o.dateLabel} בשעה ${o.time} אצל ${o.staffName}. מתאים לך? אפשר להשיב כאן ונשריין לך את התור.`;
}
