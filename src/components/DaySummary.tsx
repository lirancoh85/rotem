import type { SlotSplit, Staff } from '../domain/types';
import type { DayAppointment } from '../domain/schedule';
import { he } from '../i18n/he';

/** Display-only overview of the visible day: counts and how full each staff member is. */
export function DaySummary(p: {
  staff: Staff[];
  dayAppts: DayAppointment[];
  splits: SlotSplit[];
  dayStart: number;
  dayEnd: number;
}) {
  const real = p.dayAppts.filter((a) => !a.appt.isBlocked);
  const blocked = p.dayAppts.length - real.length;
  const open = Math.max(1, p.dayEnd - p.dayStart);
  const splitCount = p.splits.filter((s) => s.isSplit).length;
  const perStaff = p.staff.map((s, i) => {
    const mine = p.dayAppts.filter((a) => a.staffId === s.id);
    const minutes = mine.reduce((sum, a) => sum + Math.max(0, Math.min(a.end, p.dayEnd) - Math.max(a.start, p.dayStart)), 0);
    return {
      staff: s,
      index: i,
      count: mine.filter((a) => !a.appt.isBlocked).length,
      pct: Math.min(100, Math.round((minutes / open) * 100)),
    };
  });

  return (
    <section className="day-summary" aria-label={he.summaryTitle} data-testid="day-summary">
      <div className="summary-pills">
        <span className="pill pill-strong">
          <b>{real.length}</b> {he.summaryAppointments}
        </span>
        {perStaff.map((x) => (
          <span key={x.staff.id} className={`pill staff-${x.index}`}>
            <span className="pill-dot" aria-hidden="true" />
            {x.staff.name} <b>{x.count}</b>
          </span>
        ))}
        {blocked > 0 && (
          <span className="pill pill-muted">
            <b>{blocked}</b> {he.summaryBlocked}
          </span>
        )}
        {splitCount > 0 && (
          <span className="pill pill-muted">
            <b>{splitCount}</b> {he.summarySplit}
          </span>
        )}
      </div>
      <div className="summary-bars">
        {perStaff.map((x) => (
          <div key={x.staff.id} className={`bar staff-${x.index}`}>
            <span className="bar-label">
              <span className="pill-dot" aria-hidden="true" />
              <b>{x.pct}%</b> {he.summaryOccupancy(x.staff.name)}
            </span>
            <span className="bar-track" role="presentation">
              <span className="bar-fill" style={{ width: `${x.pct}%` }} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
