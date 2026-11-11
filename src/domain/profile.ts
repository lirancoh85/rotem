import type { Appointment, CustomerStats, CustomerStatus } from './types';

export const INACTIVE_AFTER_DAYS = 90;

/** Same rules as SQL `customer_status`. */
export function customerStatus(completed: number, lastVisit: string | null, nextVisit: string | null, now = Date.now()): CustomerStatus {
  if (completed >= 1 && !nextVisit && lastVisit && Date.parse(lastVisit) < now - INACTIVE_AFTER_DAYS * 86400000) return 'inactive';
  if (completed >= 2) return 'returning';
  return 'new';
}

/** Statistics for one customer's appointments (same rules as SQL `customer_stats`). */
export function computeStats(appts: Appointment[], now = Date.now()): CustomerStats {
  const mine = appts.filter((a) => !a.isBlocked);
  const booked = mine.filter((a) => (a.status ?? 'booked') === 'booked');
  const done = booked.filter((a) => Date.parse(a.endsAt) <= now);
  const ahead = booked.filter((a) => Date.parse(a.startsAt) > now);
  const iso = (xs: Appointment[], pick: 'min' | 'max') => {
    if (!xs.length) return null;
    const sorted = xs.map((a) => a.startsAt).sort();
    return pick === 'min' ? sorted[0] : sorted[sorted.length - 1];
  };
  const stats = {
    completedVisits: done.length,
    upcomingCount: ahead.length,
    cancelledCount: mine.filter((a) => a.status === 'cancelled').length,
    noShowCount: mine.filter((a) => a.status === 'no_show').length,
    firstVisit: iso(booked, 'min'),
    lastVisit: iso(done, 'max'),
    nextVisit: iso(ahead, 'min'),
  };
  return { ...stats, status: customerStatus(stats.completedVisits, stats.lastVisit, stats.nextVisit, now) };
}
