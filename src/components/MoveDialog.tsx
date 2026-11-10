import { useEffect, useId, useMemo, useState } from 'react';
import type { Appointment, Staff } from '../domain/types';
import type { DayData } from '../data/backend';
import { freeStarts, toDayAppointments } from '../domain/schedule';
import { durationLabel, fmtTime, formatHebrewDateShort, utcToLocal } from '../lib/time';
import { he } from '../i18n/he';
import { Modal } from './Modal';

/**
 * "העבר תור": choose staff, date and one of the free start times, then confirm.
 * Only times that are free for that staff member (for the appointment's length) are offered.
 */
export function MoveDialog(p: {
  appt: Appointment;
  staff: Staff[];
  tz: string;
  dayStart: number;
  dayEnd: number;
  loadDay(date: string): Promise<DayData>;
  saving: boolean;
  error: string | null;
  onConfirm(target: { staffId: string; date: string; start: number }): void;
  onCancel(): void;
}) {
  const s = utcToLocal(p.appt.startsAt, p.tz);
  const e = utcToLocal(p.appt.endsAt, p.tz);
  const duration = (e.date === s.date ? e.minutes : 1440) - s.minutes;
  const [staffId, setStaffId] = useState(p.appt.staffId);
  const [date, setDate] = useState(s.date);
  const [day, setDay] = useState<DayData | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const id = useId();

  useEffect(() => {
    let alive = true;
    setDay(null);
    p.loadDay(date).then((d) => alive && setDay(d)).catch(() => alive && setDay({ appointments: [], splits: [] }));
    return () => {
      alive = false;
    };
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setChosen(null), [staffId, date]);

  const times = useMemo(() => {
    if (!day) return null;
    return freeStarts({
      dayAppts: toDayAppointments(day.appointments, date, p.tz),
      splits: day.splits,
      staffId,
      date,
      duration,
      dayStart: p.dayStart,
      dayEnd: p.dayEnd,
      ignoreId: p.appt.id,
    });
  }, [day, date, staffId, duration, p.dayStart, p.dayEnd, p.appt.id, p.tz]);

  const isCurrent = (m: number) => staffId === p.appt.staffId && date === s.date && m === s.minutes;
  const staffName = p.staff.find((x) => x.id === staffId)?.name ?? '';

  return (
    <Modal title={he.moveTitle} onClose={p.onCancel} labelledBy={`${id}-t`}>
      <div className="move">
        <header className="form-head">
          <h2 id={`${id}-t`}>{he.moveTitle}</h2>
          <p className="form-summary">
            {p.appt.customerName} · <bdi dir="ltr">{fmtTime(s.minutes)}–{fmtTime(e.minutes)}</bdi> · {durationLabel(duration)}
          </p>
        </header>

        {p.error && <div className="form-error" role="alert">{p.error}</div>}

        <fieldset className="field">
          <legend>{he.staff}</legend>
          <div className="segmented" role="radiogroup" aria-label={he.staff}>
            {p.staff.map((x, i) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={staffId === x.id}
                className={`seg staff-${i} ${staffId === x.id ? 'on' : ''}`}
                onClick={() => setStaffId(x.id)}
              >
                {x.name}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>{he.date}</span>
          <input type="date" value={date} onChange={(ev) => ev.target.value && setDate(ev.target.value)} />
        </label>

        <fieldset className="field">
          <legend>{he.moveChooseTime}</legend>
          {times === null ? (
            <p className="muted">{he.loading}</p>
          ) : times.length === 0 ? (
            <p className="muted">{he.moveNoFreeTimes}</p>
          ) : (
            <div className="time-grid" role="radiogroup" aria-label={he.moveChooseTime}>
              {times.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={chosen === m}
                  disabled={isCurrent(m)}
                  title={isCurrent(m) ? he.moveSameSlot : undefined}
                  className={`time-btn ${chosen === m ? 'on' : ''} ${m % 30 ? 'is-quarter' : ''}`}
                  onClick={() => setChosen(m)}
                >
                  {fmtTime(m)}
                </button>
              ))}
            </div>
          )}
        </fieldset>

        {chosen !== null && (
          <div className="move-confirm" role="group" aria-label={he.moveConfirmTitle}>
            <p>
              {he.moveQuestion(
                p.appt.customerName,
                staffName,
                formatHebrewDateShort(date),
                fmtTime(chosen),
                fmtTime(chosen + duration),
              )}
            </p>
          </div>
        )}

        <div className="form-actions sticky-actions">
          <button
            type="button"
            className="btn primary"
            disabled={chosen === null || p.saving}
            onClick={() => chosen !== null && p.onConfirm({ staffId, date, start: chosen })}
          >
            {p.saving ? he.saving : he.moveConfirm}
          </button>
          <button type="button" className="btn ghost" onClick={p.onCancel}>
            {he.cancel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
