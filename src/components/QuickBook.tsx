import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { fmtTime } from '../lib/time';
import { he } from '../i18n/he';

/** The one-step dialog shown when tapping a free slot: type a name, or cross the slot out. */
export function QuickBook(p: {
  staffName: string;
  start: number;
  duration: number;
  error: string | null;
  saving: boolean;
  onSave(name: string): void;
  onBlock(): void;
  onMore(name: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!p.saving) p.onSave(name.trim());
  };
  return (
    <Modal title={he.newAppointment} onClose={p.onCancel} labelledBy={`${id}-t`} size="sm">
      <form className="quick" onSubmit={submit} noValidate>
        <h2 id={`${id}-t`} className="quick-title">
          {p.staffName} · <bdi dir="ltr">{fmtTime(p.start)}–{fmtTime(p.start + p.duration)}</bdi>
        </h2>
        {p.error && <div className="form-error" role="alert">{p.error}</div>}
        <label className="field">
          <span>{he.customerName}</span>
          <input
            ref={ref}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={he.customerNamePlaceholder}
            autoComplete="off"
            enterKeyHint="done"
            maxLength={80}
          />
        </label>
        <div className="quick-actions">
          <button type="submit" className="btn primary" disabled={p.saving}>
            {p.saving ? he.saving : he.quickSave}
          </button>
          <button type="button" className="btn block-btn" onClick={p.onBlock} disabled={p.saving}>
            <span className="strike">{he.blockSlot}</span>
          </button>
        </div>
        <div className="quick-foot">
          <button type="button" className="link-btn" onClick={() => p.onMore(name)}>
            {he.moreOptions}
          </button>
          <button type="button" className="btn ghost" onClick={p.onCancel}>
            {he.cancel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
