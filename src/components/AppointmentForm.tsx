import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Appointment, AppointmentInput, Staff } from '../domain/types';
import { DURATIONS, QUARTER } from '../domain/types';
import { blockOf } from '../domain/schedule';
import { fmtTime, durationLabel, utcToLocal } from '../lib/time';
import { he } from '../i18n/he';
import { Modal } from './Modal';
import { CustomerField, type CustomerLookup } from './CustomerField';
import { RecurrenceFields } from './RecurrenceFields';
import type { RecurrenceRule } from '../domain/recurrence';

export interface FormSeed {
  staffId: string;
  date: string;
  start: number;
  duration: number;
}

interface Props {
  staff: Staff[];
  dayStart: number;
  dayEnd: number;
  tz: string;
  seed: FormSeed;
  initialName?: string;
  initialPhone?: string;
  initialCustomerId?: string | null;
  lookup?: CustomerLookup;
  onMove?(): void;
  onOpenProfile?(): void;
  /** when set, a new appointment can repeat; saving opens the series preview */
  onPreviewSeries?(input: AppointmentInput, rule: RecurrenceRule): void;
  /** extra content (recurrence options) rendered before the actions */
  extra?: ReactNode;
  /** custom save label (e.g. "preview series") */
  saveLabel?: string;
  editing?: Appointment | null;
  error: string | null;
  saving: boolean;
  onSave(input: AppointmentInput): void;
  onDelete?(): void;
  onCancel(): void;
}

export function AppointmentForm(p: Props) {
  const editing = p.editing ?? null;
  const initial = useMemo<AppointmentInput>(() => {
    if (editing) {
      const s = utcToLocal(editing.startsAt, p.tz);
      const e = utcToLocal(editing.endsAt, p.tz);
      return {
        staffId: editing.staffId,
        date: s.date,
        start: s.minutes,
        duration: (e.date === s.date ? e.minutes : 1440) - s.minutes,
        customerName: editing.customerName,
        customerPhone: editing.customerPhone ?? '',
        service: editing.service ?? '',
        notes: editing.notes ?? '',
        customerId: editing.customerId ?? null,
      };
    }
    return {
      ...p.seed,
      customerName: p.initialName ?? '',
      customerPhone: p.initialPhone ?? '',
      customerId: p.initialCustomerId ?? null,
      service: '',
      notes: '',
    };
  }, [editing, p.seed, p.tz, p.initialName, p.initialPhone, p.initialCustomerId]);

  const [v, setV] = useState<AppointmentInput>(initial);
  const set = <K extends keyof AppointmentInput>(k: K, val: AppointmentInput[K]) => setV((x) => ({ ...x, [k]: val }));
  const nameRef = useRef<HTMLInputElement>(null);
  const [rule, setRule] = useState<RecurrenceRule | null>(null);
  const id = useId();

  useEffect(() => {
    // focus the name immediately so the barber can just type and press Enter
    const t = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const split15 = v.duration === QUARTER;
  const block = blockOf(v.start);

  const toggleSplit = () => {
    if (split15) setV((x) => ({ ...x, duration: 30, start: blockOf(x.start) }));
    else setV((x) => ({ ...x, duration: QUARTER }));
  };

  const timeOptions = useMemo(() => {
    const opts: number[] = [];
    for (let m = Math.min(p.dayStart, v.start); m < Math.max(p.dayEnd, v.start + QUARTER); m += QUARTER) opts.push(m);
    return opts;
  }, [p.dayStart, p.dayEnd, v.start]);

  const durations = useMemo(
    () => (DURATIONS as readonly number[]).includes(v.duration) ? [...DURATIONS] : [...DURATIONS, v.duration].sort((a, b) => a - b),
    [v.duration],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (p.saving) return;
    const input = { ...v, customerName: v.customerName.trim() };
    if (rule && p.onPreviewSeries) p.onPreviewSeries(input, rule);
    else p.onSave(input);
  };

  const title = editing ? he.editAppointment : he.newAppointment;
  const staffName = p.staff.find((s) => s.id === v.staffId)?.name ?? '';

  return (
    <Modal title={title} onClose={p.onCancel} labelledBy={`${id}-title`}>
      <form className="appt-form" onSubmit={submit} noValidate>
        <header className="form-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="form-summary" data-testid="form-summary">
            {staffName} · <bdi dir="ltr">{fmtTime(v.start)}–{fmtTime(v.start + v.duration)}</bdi> · {durationLabel(v.duration)}
          </p>
        </header>

        {p.error && (
          <div className="form-error" role="alert">
            {p.error}
          </div>
        )}

        <div className="field-row name-row">
          <CustomerField
            ref={nameRef}
            label={he.customerName}
            value={v.customerName}
            onValueChange={(t) => setV((x) => ({ ...x, customerName: t, customerId: null }))}
            onPick={(c) => setV((x) => ({ ...x, customerName: c.name, customerPhone: c.phone ?? x.customerPhone, customerId: c.id }))}
            pickedId={v.customerId}
            lookup={p.lookup}
            placeholder={he.customerNamePlaceholder}
            enterKeyHint="done"
            maxLength={80}
            required
          />
          <CustomerField
            label={he.phone}
            type="tel"
            inputMode="tel"
            dir="ltr"
            value={v.customerPhone}
            onValueChange={(t) => set('customerPhone', t)}
            onPick={(c) => setV((x) => ({ ...x, customerName: c.name, customerPhone: c.phone ?? t0(x), customerId: c.id }))}
            pickedId={v.customerId}
            lookup={p.lookup}
            placeholder="050-0000000"
            maxLength={30}
          />
        </div>

        <fieldset className="field">
          <legend>{he.staff}</legend>
          <div className="segmented" role="radiogroup" aria-label={he.staff}>
            {p.staff.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={v.staffId === s.id}
                className={`seg staff-${i} ${v.staffId === s.id ? 'on' : ''}`}
                onClick={() => set('staffId', s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="field-row">
          <label className="field">
            <span>{he.date}</span>
            <input type="date" value={v.date} onChange={(e) => e.target.value && set('date', e.target.value)} required />
          </label>
          <label className="field">
            <span>{he.time}</span>
            <select value={v.start} onChange={(e) => set('start', Number(e.target.value))} dir="ltr">
              {timeOptions.map((m) => (
                <option key={m} value={m}>
                  {fmtTime(m)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="field">
          <legend>{he.duration}</legend>
          <div className="segmented" role="radiogroup" aria-label={he.duration}>
            {durations.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={v.duration === d}
                className={`seg ${v.duration === d ? 'on' : ''}`}
                onClick={() => set('duration', d)}
              >
                {durationLabel(d)}
              </button>
            ))}
          </div>
        </fieldset>

        <div className={`split-box ${split15 ? 'on' : ''}`}>
          <label className="switch">
            <input type="checkbox" checked={split15} onChange={toggleSplit} />
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-text">
              <strong>{he.splitTo15}</strong>
              <small>{he.splitHint}</small>
            </span>
          </label>
          {split15 && (
            <div className="segmented halves" role="radiogroup" aria-label={he.splitTo15}>
              {[block, block + QUARTER].map((m, i) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={v.start === m}
                  className={`seg ${v.start === m ? 'on' : ''}`}
                  onClick={() => set('start', m)}
                >
                  <span>{i === 0 ? he.firstQuarter : he.secondQuarter}</span>
                  <small dir="ltr">
                    {fmtTime(m)}–{fmtTime(m + QUARTER)}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="field">
          <span>{he.service}</span>
          <input
            value={v.service}
            onChange={(e) => set('service', e.target.value)}
            placeholder={he.servicePlaceholder}
            maxLength={80}
            autoComplete="off"
          />
          <div className="chips">
            {he.services.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip ${v.service === s ? 'on' : ''}`}
                onClick={() => set('service', v.service === s ? '' : s)}
              >
                {s}
              </button>
            ))}
          </div>
        </label>

        <label className="field">
          <span>{he.notes}</span>
          <textarea value={v.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={500} />
        </label>

        {!editing && p.onPreviewSeries && <RecurrenceFields date={v.date} rule={rule} onChange={setRule} />}
        {p.extra}

        <div className="form-actions sticky-actions">
          <button type="submit" className={`btn primary ${p.saving ? 'is-saving' : ''}`} disabled={p.saving}>
            {p.saving ? he.saving : rule ? he.previewSeries : p.saveLabel ?? (editing ? he.saveChanges : he.save)}
          </button>
          <button type="button" className="btn ghost" onClick={p.onCancel}>
            {he.cancel}
          </button>
          {editing && p.onOpenProfile && (
            <button type="button" className="btn ghost" onClick={p.onOpenProfile}>
              {he.customerProfile}
            </button>
          )}
          {editing && p.onMove && (
            <button type="button" className="btn move-btn" onClick={p.onMove}>
              {he.moveAppointment}
            </button>
          )}
          {editing && p.onDelete && (
            <button type="button" className="btn danger" onClick={p.onDelete}>
              {he.delete}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

const t0 = (x: AppointmentInput) => x.customerPhone;
