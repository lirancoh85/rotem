import { memo, useMemo } from 'react';
import type { Appointment, SlotSplit, Staff } from '../domain/types';
import { QUARTER } from '../domain/types';
import { buildColumn, type Cell, type DayAppointment } from '../domain/schedule';
import { fmtTime, durationLabel } from '../lib/time';
import { he } from '../i18n/he';

export interface CalendarProps {
  staff: Staff[];
  date: string;
  dayStart: number;
  dayEnd: number;
  dayAppts: DayAppointment[];
  splits: SlotSplit[];
  /** minutes since midnight when viewing today, else null */
  nowMinutes: number | null;
  busyKey?: string | null;
  onFreeTap(staffId: string, start: number, split: boolean): void;
  onAppointmentTap(appt: Appointment): void;
  onSplit(staffId: string, blockStart: number): void;
  onMerge(staffId: string, blockStart: number): void;
}

/**
 * Three-column RTL day calendar: שעה | רותם | סיון (right to left).
 * The DOM order is time, staff[0], staff[1]; with dir="rtl" the first grid column is on the right.
 */
export const Calendar = memo(function Calendar(p: CalendarProps) {
  const columns = useMemo(
    () =>
      p.staff.map((s) =>
        buildColumn({
          staffId: s.id,
          date: p.date,
          dayStart: p.dayStart,
          dayEnd: p.dayEnd,
          dayAppts: p.dayAppts,
          splits: p.splits,
        }),
      ),
    [p.staff, p.date, p.dayStart, p.dayEnd, p.dayAppts, p.splits],
  );

  const rangeStart = Math.min(p.dayStart, ...columns.flatMap((c) => c.map((x) => x.start)));
  const rangeEnd = Math.max(p.dayEnd, ...columns.flatMap((c) => c.map((x) => x.end)));
  const rows = (rangeEnd - rangeStart) / QUARTER;
  const rowOf = (m: number) => (m - rangeStart) / QUARTER + 2; // row 1 = header

  // which quarter labels deserve emphasis (split somewhere in that block)
  const splitBlocks = new Set(
    p.splits.filter((s) => s.isSplit && p.staff.some((st) => st.id === s.staffId)).map((s) => s.blockStart),
  );

  const quarters: number[] = [];
  for (let m = rangeStart; m < rangeEnd; m += QUARTER) quarters.push(m);

  return (
    <div
      className="cal"
      dir="rtl"
      role="grid"
      aria-label="יומן תורים"
      data-testid="calendar"
      style={{
        gridTemplateColumns: `var(--time-col) repeat(${p.staff.length}, minmax(0, 1fr))`,
        gridTemplateRows: `var(--head-h) repeat(${rows}, var(--q-h))`,
      }}
    >
      <div className="cal-head cal-head-time" role="columnheader" style={{ gridColumn: 1, gridRow: 1 }} data-col="time">
        {he.timeHeader}
      </div>
      {p.staff.map((s, i) => (
        <div
          key={s.id}
          className={`cal-head cal-head-staff staff-${i}`}
          role="columnheader"
          style={{ gridColumn: i + 2, gridRow: 1 }}
          data-col={`staff-${i}`}
          data-staff-id={s.id}
        >
          {s.name}
        </div>
      ))}

      {quarters.map((m) => {
        const isBlock = m % 30 === 0;
        const showQuarter = !isBlock && splitBlocks.has(m - QUARTER);
        return (
          <div
            key={m}
            className={`cal-time ${isBlock ? 'is-block' : 'is-quarter'} ${showQuarter ? 'is-split' : ''}`}
            style={{ gridColumn: 1, gridRow: rowOf(m) }}
            role="rowheader"
          >
            {isBlock || showQuarter ? fmtTime(m) : ''}
          </div>
        );
      })}

      {columns.map((cells, i) =>
        cells.map((c) => (
          <CellView
            key={`${c.staffId}-${c.kind}-${c.start}`}
            cell={c}
            col={i + 2}
            colIndex={i}
            row={`${rowOf(c.start)} / ${rowOf(c.end)}`}
            staffName={p.staff[i].name}
            busy={p.busyKey === `${c.staffId}:${c.kind === 'free' ? c.blockStart : ''}`}
            {...p}
          />
        )),
      )}

      {p.nowMinutes !== null && p.nowMinutes >= rangeStart && p.nowMinutes < rangeEnd && (
        <div
          className="cal-now"
          aria-hidden="true"
          style={{
            gridColumn: '1 / -1',
            gridRow: rowOf(Math.floor(p.nowMinutes / QUARTER) * QUARTER),
            ['--now-offset' as string]: `${((p.nowMinutes % QUARTER) / QUARTER) * 100}%`,
          }}
        />
      )}
    </div>
  );
});

function CellView(
  props: { cell: Cell; col: number; colIndex: number; row: string; staffName: string; busy: boolean } & CalendarProps,
) {
  const { cell: c, col, colIndex, row, staffName } = props;
  const from = fmtTime(c.start);
  const to = fmtTime(c.end);
  const len = c.end - c.start;

  if (c.kind === 'appointment') {
    const a = c.appt;
    const fullLen = Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000);
    return (
      <button
        type="button"
        className={`cell appt staff-${colIndex} len-${Math.min(len, 60)} ${len <= 15 ? 'is-short' : ''}`}
        style={{ gridColumn: col, gridRow: row }}
        onClick={() => props.onAppointmentTap(a)}
        aria-label={he.apptAria(a.customerName, staffName, from, to)}
        data-testid="appt"
        data-staff-id={c.staffId}
        data-start={from}
        data-duration={fullLen}
      >
        <span className="appt-name">{a.customerName}</span>
        <span className="appt-meta">
          <span className="appt-dur">({durationLabel(fullLen)})</span>
          {len > 15 && (
            <span className="appt-time">
              {from}–{to}
            </span>
          )}
          {a.service && len > 15 && <span className="appt-service">{a.service}</span>}
        </span>
      </button>
    );
  }

  return (
    <div
      className={`cell free ${c.split ? 'is-split' : 'is-block'} ${c.start % 30 === 15 ? 'second-half' : ''} ${
        props.busy ? 'is-busy' : ''
      }`}
      style={{ gridColumn: col, gridRow: row }}
      data-testid="free"
      data-staff-id={c.staffId}
      data-start={from}
      data-len={len}
    >
      <button
        type="button"
        className="free-main"
        onClick={() => props.onFreeTap(c.staffId, c.start, c.split)}
        aria-label={he.freeSlotAria(staffName, from, to)}
      >
        <span className="free-label">{he.free}</span>
        {c.split && <span className="free-len">{he.minutesShort(len)}</span>}
      </button>
      {c.canSplit && (
        <button
          type="button"
          className="chip-action split-btn"
          onClick={() => props.onSplit(c.staffId, c.blockStart)}
          aria-label={he.splitBlockAria(staffName, from)}
          disabled={props.busy}
        >
          <ScissorsIcon /> <span>15</span>
        </button>
      )}
      {c.canMerge && (
        <button
          type="button"
          className="chip-action merge-btn"
          onClick={() => props.onMerge(c.staffId, c.blockStart)}
          aria-label={he.mergeBlockAria(staffName, fmtTime(c.blockStart))}
          disabled={props.busy}
        >
          <MergeIcon /> <span>30</span>
        </button>
      )}
    </div>
  );
}

const ScissorsIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" strokeLinecap="round" />
  </svg>
);
const MergeIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </svg>
);
