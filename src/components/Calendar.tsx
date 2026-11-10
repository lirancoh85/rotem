import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Appointment, SlotSplit, Staff } from '../domain/types';
import { QUARTER } from '../domain/types';
import { buildColumn, findOverlap, snapStart, type Cell, type DayAppointment } from '../domain/schedule';
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
  /** full-day view: fit every slot into the visible height */
  fit?: boolean;
  /** appointment to scroll to and flash (from search) */
  highlightId?: string | null;
  onFreeTap(staffId: string, start: number, split: boolean): void;
  onAppointmentTap(appt: Appointment): void;
  onSplit(staffId: string, blockStart: number): void;
  onMerge(staffId: string, blockStart: number): void;
  /** drag-and-drop finished on a new staff/time (the caller confirms and saves) */
  onMoveDrop?(appt: Appointment, staffId: string, start: number): void;
}

/** Smallest row height (px per 15 minutes) at which names stay legible in the full-day view. */
export const FIT_MIN_QUARTER = 13;
const FIT_MAX_QUARTER = 40;
const FIT_HEAD = 30;
const LONG_PRESS_MS = 380;

/** Row height that fits `rows` quarter-hours into `available` px, or the legible minimum (then it scrolls). */
export function fitQuarterHeight(available: number, rows: number, head = FIT_HEAD) {
  if (rows <= 0) return FIT_MAX_QUARTER;
  return Math.max(FIT_MIN_QUARTER, Math.min(FIT_MAX_QUARTER, Math.floor((available - head) / rows)));
}

interface DragState {
  appt: Appointment;
  duration: number;
  /** minutes between the appointment start and the grab point */
  grab: number;
  staffId: string;
  start: number;
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

  const gridRef = useRef<HTMLDivElement>(null);

  // ---------- full-day fit ----------
  const [fitQ, setFitQ] = useState<number | null>(null);
  useLayoutEffect(() => {
    const wrap = gridRef.current?.parentElement;
    if (!p.fit || !wrap) {
      setFitQ(null);
      return;
    }
    const measure = () => {
      const cs = getComputedStyle(wrap);
      const avail = wrap.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
      setFitQ(fitQuarterHeight(avail, rows));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(wrap);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [p.fit, rows]);
  const density = fitQ === null ? 'normal' : fitQ < 20 ? 'xs' : fitQ < 30 ? 'sm' : 'md';

  // ---------- search highlight ----------
  useEffect(() => {
    if (!p.highlightId) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-appt-id="${p.highlightId}"]`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [p.highlightId, p.dayAppts]);

  // ---------- drag and drop ----------
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const suppressClick = useRef(false);
  const geometry = useRef({ rangeStart, rangeEnd, staff: p.staff, splits: p.splits, date: p.date });
  geometry.current = { rangeStart, rangeEnd, staff: p.staff, splits: p.splits, date: p.date };

  /** minutes since midnight under a viewport y coordinate (unsnapped) */
  const minuteAtY = useCallback((y: number) => {
    const grid = gridRef.current;
    const first = grid?.querySelector<HTMLElement>('.cal-time');
    if (!grid || !first) return null;
    const r = first.getBoundingClientRect();
    const qh = r.height || 1;
    return geometry.current.rangeStart + ((y - r.top) / qh) * QUARTER;
  }, []);

  const staffAtX = useCallback((x: number) => {
    const heads = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('.cal-head-staff') ?? []);
    let best: { id: string; d: number } | null = null;
    for (const h of heads) {
      const r = h.getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (!best || d < best.d) best = { id: h.dataset.staffId!, d };
    }
    return best?.id ?? null;
  }, []);

  const updateTarget = useCallback(
    (x: number, y: number) => {
      const d = dragRef.current;
      if (!d) return;
      const staffId = staffAtX(x);
      const raw = minuteAtY(y);
      if (!staffId || raw === null) return;
      const g = geometry.current;
      const start = snapStart(raw - d.grab, {
        splits: g.splits,
        staffId,
        date: g.date,
        duration: d.duration,
        min: g.rangeStart,
        max: g.rangeEnd,
      });
      if (start !== d.start || staffId !== d.staffId) {
        const next = { ...d, start, staffId };
        dragRef.current = next;
        setDrag(next);
      }
      // auto-scroll the calendar while dragging near its edges
      const wrap = gridRef.current?.parentElement;
      if (wrap) {
        const r = wrap.getBoundingClientRect();
        if (y < r.top + 48) wrap.scrollBy?.({ top: -24 });
        else if (y > r.bottom - 48) wrap.scrollBy?.({ top: 24 });
      }
    },
    [minuteAtY, staffAtX],
  );

  const onApptPointerDown = useCallback(
    (e: RPointerEvent<HTMLButtonElement>, appt: Appointment, start: number, end: number) => {
      if (!p.onMoveDrop || e.button !== 0) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const touch = e.pointerType === 'touch';
      let started = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const begin = () => {
        const raw = minuteAtY(y0);
        started = true;
        const initial: DragState = {
          appt,
          duration: end - start,
          grab: raw === null ? 0 : Math.max(0, Math.min(end - start - 1, raw - start)),
          staffId: appt.staffId,
          start,
        };
        dragRef.current = initial; // readable immediately by the first move
        setDrag(initial);
        if (touch) {
          try {
            navigator.vibrate?.(15);
          } catch {
            /* not allowed */
          }
        }
      };
      const blockScroll = (ev: TouchEvent) => {
        if (dragRef.current) ev.preventDefault();
      };
      const move = (ev: PointerEvent) => {
        const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
        if (!started) {
          if (touch) {
            if (dist > 10) cleanup(); // the finger is scrolling, not dragging
            return;
          }
          if (dist < 6) return;
          begin();
        }
        updateTarget(ev.clientX, ev.clientY);
      };
      const up = () => {
        const d = dragRef.current;
        if (started && d) {
          suppressClick.current = true;
          setTimeout(() => (suppressClick.current = false), 400);
          const moved = d.staffId !== appt.staffId || d.start !== start;
          if (moved) p.onMoveDrop?.(appt, d.staffId, d.start);
        }
        cleanup();
      };
      const cleanup = () => {
        clearTimeout(timer);
        dragRef.current = null;
        setDrag(null);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cleanup);
        window.removeEventListener('touchmove', blockScroll);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cleanup);
      window.addEventListener('touchmove', blockScroll, { passive: false });
      if (touch) timer = setTimeout(begin, LONG_PRESS_MS);
    },
    [p.onMoveDrop, minuteAtY, updateTarget], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onAppointmentTap = useCallback(
    (a: Appointment) => {
      if (suppressClick.current) return;
      p.onAppointmentTap(a);
    },
    [p.onAppointmentTap], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // which quarter labels deserve emphasis (split somewhere in that block)
  const splitBlocks = new Set(
    p.splits.filter((s) => s.isSplit && p.staff.some((st) => st.id === s.staffId)).map((s) => s.blockStart),
  );

  const quarters: number[] = [];
  for (let m = rangeStart; m < rangeEnd; m += QUARTER) quarters.push(m);

  const dropCol = drag ? p.staff.findIndex((s) => s.id === drag.staffId) : -1;
  const dropInvalid =
    !!drag && !!findOverlap(p.dayAppts, drag.staffId, drag.start, drag.start + drag.duration, drag.appt.id);

  return (
    <div
      ref={gridRef}
      className={`cal ${fitQ !== null ? 'is-fit' : ''} density-${density} ${drag ? 'is-dragging' : ''}`}
      dir="rtl"
      role="grid"
      aria-label="יומן תורים"
      data-testid="calendar"
      data-density={density}
      style={{
        gridTemplateColumns: `var(--time-col) repeat(${p.staff.length}, minmax(0, 1fr))`,
        gridTemplateRows: `var(--head-h) repeat(${rows}, var(--q-h))`,
        ...(fitQ !== null ? { ['--q-h' as string]: `${fitQ}px`, ['--head-h' as string]: `${FIT_HEAD}px` } : {}),
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
          data-initial={s.name.trim().charAt(0)}
          data-count={he.apptCount(p.dayAppts.filter((a) => a.staffId === s.id && !a.appt.isBlocked).length)}
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
            className={`cal-time ${isBlock ? 'is-block' : 'is-quarter'} ${m % 60 === 0 ? 'is-hour' : ''} ${showQuarter ? 'is-split' : ''}`}
            style={{ gridColumn: 1, gridRow: rowOf(m) }}
            role="rowheader"
            data-minute={m}
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
            dragging={drag?.appt.id === (c.kind === 'appointment' ? c.appt.id : null)}
            highlighted={c.kind === 'appointment' && c.appt.id === p.highlightId}
            draggable={!!p.onMoveDrop}
            onApptPointerDown={onApptPointerDown}
            {...p}
            onAppointmentTap={onAppointmentTap}
          />
        )),
      )}

      {drag && dropCol >= 0 && (
        <div
          className={`drop-target ${dropInvalid ? 'invalid' : ''}`}
          style={{ gridColumn: dropCol + 2, gridRow: `${rowOf(drag.start)} / ${rowOf(drag.start + drag.duration)}` }}
          data-testid="drop-target"
          aria-hidden="true"
        >
          <span>
            {p.staff[dropCol].name} · <bdi dir="ltr">{fmtTime(drag.start)}–{fmtTime(drag.start + drag.duration)}</bdi>
          </span>
        </div>
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
        >
          <span className="cal-now-label">{fmtTime(p.nowMinutes)}</span>
        </div>
      )}
    </div>
  );
});

function CellView(
  props: {
    cell: Cell;
    col: number;
    colIndex: number;
    row: string;
    staffName: string;
    busy: boolean;
    dragging: boolean;
    highlighted: boolean;
    draggable: boolean;
    onApptPointerDown(e: RPointerEvent<HTMLButtonElement>, appt: Appointment, start: number, end: number): void;
  } & CalendarProps,
) {
  const { cell: c, col, colIndex, row, staffName } = props;
  const from = fmtTime(c.start);
  const to = fmtTime(c.end);
  const len = c.end - c.start;

  if (c.kind === 'appointment' && c.appt.isBlocked) {
    return (
      <button
        type="button"
        className={`cell appt blocked ${len <= 15 ? 'is-short' : ''} ${props.dragging ? 'is-drag-source' : ''}`}
        style={{ gridColumn: col, gridRow: row }}
        onClick={() => props.onAppointmentTap(c.appt)}
        onPointerDown={props.draggable ? (e) => props.onApptPointerDown(e, c.appt, c.start, c.end) : undefined}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={he.blockedAria(staffName, from, to)}
        data-testid="blocked"
        data-appt-id={c.appt.id}
        data-staff-id={c.staffId}
        data-start={from}
      >
        <span className="blocked-label">{he.blocked}</span>
      </button>
    );
  }

  if (c.kind === 'appointment') {
    const a = c.appt;
    const fullLen = Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000);
    return (
      <button
        type="button"
        className={`cell appt staff-${colIndex} len-${Math.min(len, 60)} ${len <= 15 ? 'is-short' : ''} ${
          props.dragging ? 'is-drag-source' : ''
        } ${props.highlighted ? 'is-highlight' : ''}`}
        style={{ gridColumn: col, gridRow: row }}
        onClick={() => props.onAppointmentTap(a)}
        onPointerDown={props.draggable ? (e) => props.onApptPointerDown(e, a, c.start, c.end) : undefined}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={he.apptAria(a.customerName, staffName, from, to)}
        data-testid="appt"
        data-appt-id={a.id}
        data-staff-id={c.staffId}
        data-start={from}
        data-duration={fullLen}
        data-initial={a.customerName.trim().charAt(0)}
        data-dur={durationLabel(fullLen)}
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
