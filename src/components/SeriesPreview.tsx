import { useEffect, useId, useMemo, useState } from 'react';
import type { Backend, DayData } from '../data/backend';
import { toAppError } from '../data/backend';
import type { AppointmentInput, SeriesOccurrence, Shop, Staff } from '../domain/types';
import { checkOccurrences, occurrenceDates, type Alternative, type RecurrenceRule } from '../domain/recurrence';
import { addDays, durationLabel, fmtTime, formatHebrewDateShort } from '../lib/time';
import { he } from '../i18n/he';
import { Modal } from './Modal';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

/** Preview of a recurring booking: every date, conflicts, skip or pick another slot, then create atomically. */
export function SeriesPreview(p: {
  backend: Backend;
  shop: Shop;
  staff: Staff[];
  input: AppointmentInput;
  rule: RecurrenceRule;
  onCreated(count: number, firstDate: string): void;
  onBack(): void;
}) {
  const id = useId();
  // one key per preview: a double click or retry can never create a second series
  const [requestKey] = useState(newKey);
  const [data, setData] = useState<DayData | null>(null);
  const [reload, setReload] = useState(0);
  const [choice, setChoice] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dates = useMemo(() => occurrenceDates(p.input.date, p.rule), [p.input.date, p.rule]);

  useEffect(() => {
    let alive = true;
    setData(null);
    p.backend
      .loadRange(p.shop.id, addDays(dates[0], -1), addDays(dates[dates.length - 1], 3))
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(he.errors[toAppError(e).code]));
    return () => {
      alive = false;
    };
  }, [dates, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const checks = useMemo(
    () =>
      data
        ? checkOccurrences({
            dates,
            start: p.input.start,
            duration: p.input.duration,
            staffId: p.input.staffId,
            staff: p.staff,
            appointments: data.appointments,
            splits: data.splits,
            dayStart: p.shop.dayStart,
            dayEnd: p.shop.dayEnd,
            closedWeekdays: p.shop.closedWeekdays,
            tz: p.shop.timezone,
          })
        : null,
    [data, dates, p.input, p.staff, p.shop],
  );

  const altKey = (a: Alternative) => `${a.date}|${a.start}|${a.staffId}`;
  const staffName = (sid: string) => p.staff.find((s) => s.id === sid)?.name ?? '';

  const occurrences: SeriesOccurrence[] = [];
  let skipped = 0;
  checks?.forEach((c) => {
    if (!c.problem) {
      occurrences.push({ index: c.index, date: c.date, start: c.start, staffId: c.staffId });
      return;
    }
    const pick = c.alternatives.find((a) => altKey(a) === choice[c.index]);
    if (pick) occurrences.push({ index: c.index, date: pick.date, start: pick.start, staffId: pick.staffId });
    else skipped++;
  });

  const submit = async () => {
    if (!occurrences.length || saving) return;
    setSaving(true);
    setError(null);
    try {
      await p.backend.createSeries(p.shop, {
        requestKey,
        staffId: p.input.staffId,
        customerName: p.input.customerName,
        customerPhone: p.input.customerPhone,
        customerId: p.input.customerId ?? null,
        service: p.input.service,
        notes: p.input.notes,
        intervalWeeks: p.rule.intervalWeeks,
        duration: p.input.duration,
        endsOn: p.rule.end.kind === 'until' ? p.rule.end.date : null,
        count: p.rule.end.kind === 'count' ? p.rule.end.count : null,
        occurrences,
      });
      p.onCreated(occurrences.length, occurrences[0].date);
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'SERIES_CONFLICT') {
        setError(he.seriesConflictAt(err.message));
        setChoice({});
        setReload((n) => n + 1); // someone booked meanwhile — re-check, never overwrite
      } else setError(he.errors[err.code]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={he.seriesTitle} onClose={p.onBack} labelledBy={`${id}-t`}>
      <div className="series" data-testid="series-preview">
        <header className="form-head">
          <h2 id={`${id}-t`}>{he.seriesTitle}</h2>
          <p className="form-summary">
            {p.input.customerName} · {staffName(p.input.staffId)} · <bdi dir="ltr">{fmtTime(p.input.start)}</bdi> ·{' '}
            {durationLabel(p.input.duration)} · {he.repeatEvery(p.rule.intervalWeeks)}
          </p>
        </header>
        {error && <div className="form-error" role="alert">{error}</div>}
        {!checks && !error && <p className="muted">{he.seriesChecking}</p>}
        {checks && (
          <ol className="occ-list">
            {checks.map((c) => (
              <li key={c.index} className={`occ ${c.problem ? 'has-problem' : ''}`} data-testid="occurrence" data-problem={c.problem ?? ''}>
                <div className="occ-main">
                  <span className="occ-date">{formatHebrewDateShort(c.date)}</span>
                  <bdi dir="ltr" className="occ-time">
                    {fmtTime(c.start)}
                  </bdi>
                  <span className={`occ-status ${c.problem ? 'bad' : 'ok'}`}>
                    {c.problem ? he.problem[c.problem] : he.seriesOk}
                    {c.detail ? ` · ${c.detail}` : ''}
                  </span>
                </div>
                {c.problem && (
                  <label className="occ-fix">
                    <span className="visually-hidden">{formatHebrewDateShort(c.date)}</span>
                    {c.alternatives.length ? (
                      <select value={choice[c.index] ?? ''} onChange={(e) => setChoice({ ...choice, [c.index]: e.target.value })} aria-label={`${he.conflictPick} · ${formatHebrewDateShort(c.date)}`}>
                        <option value="">{he.conflictSkip}</option>
                        {c.alternatives.map((a) => (
                          <option key={altKey(a)} value={altKey(a)}>
                            {formatHebrewDateShort(a.date)} · {fmtTime(a.start)} · {staffName(a.staffId)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">{he.conflictNoAlternatives}</span>
                    )}
                  </label>
                )}
              </li>
            ))}
          </ol>
        )}
        {checks && <p className="series-summary" data-testid="series-summary">{he.seriesSummary(occurrences.length, skipped)}</p>}
        <div className="form-actions sticky-actions">
          <button type="button" className={`btn primary ${saving ? 'is-saving' : ''}`} disabled={!checks || !occurrences.length || saving} onClick={() => void submit()}>
            {he.seriesCreate(occurrences.length)}
          </button>
          <button type="button" className="btn ghost" onClick={p.onBack}>
            {he.cancel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
