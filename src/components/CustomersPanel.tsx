import { useEffect, useId, useRef, useState } from 'react';
import type { Backend } from '../data/backend';
import type { CustomerSummary } from '../domain/types';
import { formatHebrewDateShort, utcToLocal } from '../lib/time';
import { he } from '../i18n/he';
import { Modal } from './Modal';

/** Customer directory: search by name or phone, open a profile. */
export function CustomersPanel(p: { backend: Backend; shopId: string; tz: string; onOpen(id: string): void; onClose(): void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<CustomerSummary[] | null>(null);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(() => {
      p.backend
        .listCustomers(p.shopId, q.trim())
        .then((r) => n === seq.current && setList(r))
        .catch(() => n === seq.current && setList([]));
    }, q ? 180 : 0);
    return () => clearTimeout(t);
  }, [q, p.backend, p.shopId]);

  const date = (iso: string | null) => (iso ? formatHebrewDateShort(utcToLocal(iso, p.tz).date) : null);

  return (
    <Modal title={he.customersTitle} onClose={p.onClose} labelledBy={`${id}-t`} size="side">
      <div className="customers" data-testid="customers-panel">
        <h2 id={`${id}-t`}>{he.customersTitle}</h2>
        <label className="field search">
          <span className="visually-hidden">{he.customersSearch}</span>
          <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={he.customersSearch} autoComplete="off" />
        </label>
        {list === null && <p className="muted">{he.customersLoading}</p>}
        {list && list.length === 0 && <p className="muted">{he.customersEmpty}</p>}
        {list && list.length > 0 && (
          <ul className="customer-list">
            {list.map((c) => (
              <li key={c.id}>
                <button type="button" className="customer-row" onClick={() => p.onOpen(c.id)} data-testid="customer-row">
                  <span className="customer-avatar" aria-hidden="true">
                    {c.name.trim().charAt(0)}
                  </span>
                  <span className="customer-main">
                    <span className="customer-name">{c.name}</span>
                    <span className="customer-meta">
                      {c.phone && <bdi dir="ltr">{c.phone}</bdi>}
                      <span>
                        {c.completedVisits} {he.completedVisits}
                      </span>
                      {c.nextVisit ? (
                        <span>
                          {he.upcomingAppointments}: {date(c.nextVisit)}
                        </span>
                      ) : c.lastVisit ? (
                        <span>
                          {he.lastAppointment}: {date(c.lastVisit)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className={`status-chip st-${c.status}`}>{he.statusLabel[c.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
