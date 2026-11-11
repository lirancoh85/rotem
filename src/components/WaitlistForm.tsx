import { useId, useState, type FormEvent } from 'react';
import type { Customer, Staff, WaitlistInput } from '../domain/types';
import { DURATIONS } from '../domain/types';
import { addDays, durationLabel, fmtTime, formatHebrewDateShort, todayLocal } from '../lib/time';
import { he } from '../i18n/he';
import { CustomerField, type CustomerLookup } from './CustomerField';

const HOURS = Array.from({ length: 49 }, (_, i) => i * 30);

/** Add or edit a waiting-list request. */
export function WaitlistForm(p: {
  staff: Staff[];
  dayStart: number;
  dayEnd: number;
  initial?: Partial<WaitlistInput>;
  lookup?: CustomerLookup;
  saving: boolean;
  error: string | null;
  onSave(input: WaitlistInput): void;
  onCancel(): void;
}) {
  const today = todayLocal();
  const [v, setV] = useState<WaitlistInput>({
    customerName: '',
    customerPhone: '',
    customerId: null,
    service: '',
    duration: 30,
    staffId: null,
    preferredDates: [today],
    timeFrom: p.dayStart,
    timeTo: p.dayEnd,
    notes: '',
    ...p.initial,
  });
  const [newDate, setNewDate] = useState(addDays(today, 1));
  const [localError, setLocalError] = useState<string | null>(null);
  const id = useId();

  const addDate = (d: string) => d && !v.preferredDates.includes(d) && setV({ ...v, preferredDates: [...v.preferredDates, d].sort() });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!v.customerName.trim()) return setLocalError(he.errors.NAME_REQUIRED);
    if (!v.preferredDates.length) return setLocalError(he.waitlistNeedDate);
    setLocalError(null);
    p.onSave(v);
  };

  return (
    <form className="wl-form" onSubmit={submit} noValidate aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`}>{p.initial?.customerName ? he.waitlistEdit : he.waitlistAdd}</h3>
      {(localError || p.error) && <div className="form-error" role="alert">{localError ?? p.error}</div>}
      <div className="field-row name-row">
        <CustomerField
          label={he.customerName}
          value={v.customerName}
          onValueChange={(t) => setV({ ...v, customerName: t, customerId: null })}
          onPick={(c: Customer) => setV({ ...v, customerName: c.name, customerPhone: c.phone ?? v.customerPhone, customerId: c.id })}
          pickedId={v.customerId}
          lookup={p.lookup}
          placeholder={he.customerNamePlaceholder}
          maxLength={80}
        />
        <CustomerField
          label={he.phone}
          type="tel"
          inputMode="tel"
          dir="ltr"
          value={v.customerPhone}
          onValueChange={(t) => setV({ ...v, customerPhone: t })}
          onPick={(c: Customer) => setV({ ...v, customerName: c.name, customerPhone: c.phone ?? '', customerId: c.id })}
          pickedId={v.customerId}
          lookup={p.lookup}
          placeholder="050-0000000"
          maxLength={30}
        />
      </div>

      <label className="field">
        <span>{he.service}</span>
        <input value={v.service} onChange={(e) => setV({ ...v, service: e.target.value })} placeholder={he.servicePlaceholder} maxLength={80} />
      </label>

      <fieldset className="field">
        <legend>{he.duration}</legend>
        <div className="segmented" role="radiogroup" aria-label={he.duration}>
          {DURATIONS.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={v.duration === d} className={`seg ${v.duration === d ? 'on' : ''}`} onClick={() => setV({ ...v, duration: d })}>
              {durationLabel(d)}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>{he.staff}</legend>
        <div className="segmented" role="radiogroup" aria-label={he.staff}>
          {[{ id: null as string | null, name: he.waitlistAnyStaff }, ...p.staff].map((s) => (
            <button key={s.id ?? 'any'} type="button" role="radio" aria-checked={v.staffId === s.id} className={`seg ${v.staffId === s.id ? 'on' : ''}`} onClick={() => setV({ ...v, staffId: s.id })}>
              {s.name}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>{he.waitlistDates}</legend>
        <div className="date-chips">
          {v.preferredDates.map((d) => (
            <span key={d} className="date-chip">
              {formatHebrewDateShort(d)}
              <button type="button" aria-label={he.waitlistRemoveDate(formatHebrewDateShort(d))} onClick={() => setV({ ...v, preferredDates: v.preferredDates.filter((x) => x !== d) })}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="add-date">
          <input type="date" min={today} value={newDate} onChange={(e) => setNewDate(e.target.value)} aria-label={he.waitlistAddDate} />
          <button type="button" className="btn" onClick={() => addDate(newDate)}>
            {he.waitlistAddDate}
          </button>
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>{he.waitlistTimeRange}</legend>
        <div className="field-row">
          <label className="field">
            <span>{he.waitlistFrom}</span>
            <select dir="ltr" value={v.timeFrom} onChange={(e) => setV({ ...v, timeFrom: Number(e.target.value) })}>
              {HOURS.slice(0, -1).map((m) => <option key={m} value={m}>{fmtTime(m)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{he.waitlistTo}</span>
            <select dir="ltr" value={v.timeTo} onChange={(e) => setV({ ...v, timeTo: Number(e.target.value) })}>
              {HOURS.filter((m) => m > v.timeFrom).map((m) => <option key={m} value={m}>{m === 1440 ? '24:00' : fmtTime(m)}</option>)}
            </select>
          </label>
        </div>
      </fieldset>

      <label className="field">
        <span>{he.notes}</span>
        <textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} maxLength={500} />
      </label>

      <div className="form-actions">
        <button type="submit" className={`btn primary ${p.saving ? 'is-saving' : ''}`} disabled={p.saving}>
          {he.quickSave}
        </button>
        <button type="button" className="btn ghost" onClick={p.onCancel}>
          {he.cancel}
        </button>
      </div>
    </form>
  );
}
