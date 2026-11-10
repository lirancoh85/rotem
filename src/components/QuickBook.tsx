import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { CustomerField, type CustomerLookup } from './CustomerField';
import type { Customer } from '../domain/types';
import { fmtTime } from '../lib/time';
import { he } from '../i18n/he';

/** The one-step dialog shown when tapping a free slot: type a name, or cross the slot out. */
export function QuickBook(p: {
  staffName: string;
  start: number;
  duration: number;
  error: string | null;
  saving: boolean;
  lookup?: CustomerLookup;
  onSave(c: QuickCustomer): void;
  onBlock(): void;
  onMore(c: QuickCustomer): void;
  onCancel(): void;
}) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Customer | null>(null);
  const current = (): QuickCustomer => ({
    name: name.trim(),
    phone: picked?.phone ?? '',
    customerId: picked?.id ?? null,
  });
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!p.saving) p.onSave(current());
  };
  return (
    <Modal title={he.newAppointment} onClose={p.onCancel} labelledBy={`${id}-t`} size="sm">
      <form className="quick" onSubmit={submit} noValidate>
        <h2 id={`${id}-t`} className="quick-title">
          {p.staffName} · <bdi dir="ltr">{fmtTime(p.start)}–{fmtTime(p.start + p.duration)}</bdi>
        </h2>
        {p.error && <div className="form-error" role="alert">{p.error}</div>}
        <CustomerField
          ref={ref}
          label={he.customerName}
          value={name}
          onValueChange={(v) => {
            setName(v);
            if (picked && v.trim() !== picked.name) setPicked(null);
          }}
          onPick={(c) => {
            setName(c.name);
            setPicked(c);
          }}
          pickedId={picked?.id}
          lookup={p.lookup}
          placeholder={he.customerNamePlaceholder}
          enterKeyHint="done"
          maxLength={80}
        />
        {picked && (
          <p className="picked-note" data-testid="picked-customer">
            ✓ {he.returningCustomer}
            {picked.phone && (
              <>
                {' · '}
                <bdi dir="ltr">{picked.phone}</bdi>
              </>
            )}
          </p>
        )}
        <div className="quick-actions">
          <button type="submit" className={`btn primary ${p.saving ? 'is-saving' : ''}`} disabled={p.saving}>
            {p.saving ? he.saving : he.quickSave}
          </button>
          <button type="button" className="btn block-btn" onClick={p.onBlock} disabled={p.saving}>
            <span className="strike">{he.blockSlot}</span>
          </button>
        </div>
        <div className="quick-foot">
          <button type="button" className="link-btn" onClick={() => p.onMore(current())}>
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

export interface QuickCustomer {
  name: string;
  phone: string;
  customerId: string | null;
}
