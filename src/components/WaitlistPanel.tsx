import { useId, useState } from 'react';
import type { Backend } from '../data/backend';
import { toAppError } from '../data/backend';
import type { Shop, Staff, WaitlistInput, WaitlistOffer, WaitlistRequest } from '../domain/types';
import type { SlotMatch } from '../domain/waitlist';
import { offerMessage } from '../domain/waitlist';
import { whatsappLink } from '../lib/contact';
import { durationLabel, fmtTime, formatHebrewDate, formatHebrewDateShort, utcToLocal } from '../lib/time';
import { he } from '../i18n/he';
import { Modal } from './Modal';
import { WaitlistForm } from './WaitlistForm';
import type { CustomerLookup } from './CustomerField';

/** Waiting list: requests, live matching free slots, WhatsApp offers and their outcome. */
export function WaitlistPanel(p: {
  backend: Backend;
  shop: Shop;
  staff: Staff[];
  requests: WaitlistRequest[] | null;
  matches: Map<string, SlotMatch[]>;
  lookup: CustomerLookup;
  /** open the add form immediately, optionally prefilled (e.g. from a customer profile) */
  startWith?: Partial<WaitlistInput> | null;
  readOnly?: boolean;
  onChanged(): void;
  onBooked(appointmentId: string | null, date: string): void;
  notify(text: string, tone?: 'ok' | 'error'): void;
  onClose(): void;
}) {
  const id = useId();
  const [editing, setEditing] = useState<{ id?: string; initial?: Partial<WaitlistInput> } | null>(p.startWith ? { initial: p.startWith } : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const tz = p.shop.timezone;
  const staffName = (sid: string | null) => (sid ? p.staff.find((s) => s.id === sid)?.name ?? '' : he.waitlistAnyStaff);

  const save = async (input: WaitlistInput) => {
    setSaving(true);
    setError(null);
    try {
      await p.backend.saveWaitlistRequest(p.shop, input, editing?.id);
      p.notify(he.waitlistSaved);
      setEditing(null);
      p.onChanged();
    } catch (e) {
      setError(he.errors[toAppError(e).code]);
    } finally {
      setSaving(false);
    }
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      p.onChanged();
    } catch (e) {
      p.notify(he.errors[toAppError(e).code], 'error');
    } finally {
      setBusy(null);
    }
  };

  const offer = (r: WaitlistRequest, m: SlotMatch) =>
    act(`offer-${r.id}-${m.date}-${m.start}-${m.staffId}`, async () => {
      await p.backend.createOffer(p.shop, r.id, m);
      p.notify(he.offerSent);
    });

  const accept = (o: WaitlistOffer) =>
    act(`accept-${o.id}`, async () => {
      const res = await p.backend.acceptOffer(o.id);
      if (res.ok) {
        p.notify(he.offerBooked);
        p.onBooked(res.appointmentId, utcToLocal(o.startsAt, tz).date);
      } else p.notify(res.reason === 'SLOT_TAKEN' ? he.offerTaken : he.errors.UNKNOWN, 'error');
    });

  const slotLabel = (date: string, start: number, staffId: string) => `${formatHebrewDateShort(date)} · ${fmtTime(start)} · ${staffName(staffId)}`;

  return (
    <Modal title={he.waitlistTitle} onClose={p.onClose} labelledBy={`${id}-t`} size="side">
      <div className="waitlist" data-testid="waitlist-panel">
        <div className="wl-head">
          <h2 id={`${id}-t`}>{he.waitlistTitle}</h2>
          {!editing && !p.readOnly && (
            <button type="button" className="btn primary" onClick={() => setEditing({})}>
              {he.waitlistAdd}
            </button>
          )}
        </div>

        {editing && (
          <WaitlistForm
            staff={p.staff}
            dayStart={p.shop.dayStart}
            dayEnd={p.shop.dayEnd}
            initial={editing.initial}
            lookup={p.lookup}
            saving={saving}
            error={error}
            onSave={(i) => void save(i)}
            onCancel={() => {
              setEditing(null);
              setError(null);
            }}
          />
        )}

        {p.requests === null && <p className="muted">{he.loading}</p>}
        {p.requests && p.requests.length === 0 && !editing && <p className="muted">{he.waitlistEmpty}</p>}

        <ul className="wl-list">
          {(p.requests ?? []).map((r) => {
            const matches = p.matches.get(r.id) ?? [];
            const offers = r.offers.filter((o) => o.status !== 'accepted');
            return (
              <li key={r.id} className={`wl-card ${matches.length ? 'has-match' : ''}`} data-testid="wl-request">
                <div className="wl-top">
                  <div className="wl-who">
                    <strong>{r.customerName}</strong>
                    {r.customerPhone && <bdi dir="ltr" className="muted">{r.customerPhone}</bdi>}
                  </div>
                  {!p.readOnly && (
                    <div className="wl-actions">
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() =>
                          setEditing({
                            id: r.id,
                            initial: {
                              customerName: r.customerName,
                              customerPhone: r.customerPhone ?? '',
                              customerId: r.customerId,
                              service: r.service ?? '',
                              duration: r.duration,
                              staffId: r.staffId,
                              preferredDates: r.preferredDates,
                              timeFrom: r.timeFrom,
                              timeTo: r.timeTo,
                              notes: r.notes ?? '',
                            },
                          })
                        }
                      >
                        {he.edit}
                      </button>
                      <button type="button" className="btn danger" onClick={() => void act(`rm-${r.id}`, () => p.backend.setWaitlistStatus(r.id, 'removed'))}>
                        {he.waitlistRemove}
                      </button>
                    </div>
                  )}
                </div>
                <div className="wl-meta">
                  {r.service && <span>{r.service}</span>}
                  <span>{durationLabel(r.duration)}</span>
                  <span>{staffName(r.staffId)}</span>
                  <bdi dir="ltr">
                    {fmtTime(r.timeFrom)}–{r.timeTo >= 1440 ? '24:00' : fmtTime(r.timeTo)}
                  </bdi>
                </div>
                <div className="date-chips">
                  {r.preferredDates.map((d) => (
                    <span key={d} className="date-chip">
                      {formatHebrewDateShort(d)}
                    </span>
                  ))}
                </div>

                <div className="wl-matches">
                  <span className="wl-label">{he.waitlistMatches}</span>
                  {matches.length === 0 ? (
                    <span className="muted small">{he.waitlistNoMatches}</span>
                  ) : (
                    <ul>
                      {matches.map((m) => {
                        const key = `offer-${r.id}-${m.date}-${m.start}-${m.staffId}`;
                        const msg = offerMessage({
                          customerName: r.customerName,
                          salonName: p.shop.name,
                          dateLabel: formatHebrewDate(m.date),
                          time: fmtTime(m.start),
                          staffName: staffName(m.staffId),
                        });
                        const wa = whatsappLink(r.customerPhone, msg);
                        return (
                          <li key={key} className="wl-slot" data-testid="wl-match">
                            <span>{slotLabel(m.date, m.start, m.staffId)}</span>
                            {!p.readOnly &&
                              (wa ? (
                                <a
                                  className="btn wa-btn"
                                  href={wa}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={() => void offer(r, m)}
                                  aria-disabled={busy === key}
                                >
                                  {he.waitlistOffer}
                                </a>
                              ) : (
                                <button type="button" className="btn" disabled={busy === key} onClick={() => void offer(r, m)}>
                                  {he.waitlistOfferNoPhone}
                                </button>
                              ))}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {offers.length > 0 && (
                  <div className="wl-offers">
                    <span className="wl-label">{he.waitlistOffers}</span>
                    <ul>
                      {offers.map((o) => {
                        const s = utcToLocal(o.startsAt, tz);
                        return (
                          <li key={o.id} className="wl-offer" data-testid="wl-offer" data-status={o.status}>
                            <span>{slotLabel(s.date, s.minutes, o.staffId)}</span>
                            <span className={`offer-chip st-${o.status}`}>{he.offerStatus[o.status]}</span>
                            {o.status === 'sent' && !p.readOnly && (
                              <span className="wl-offer-actions">
                                <button type="button" className="btn primary" disabled={busy === `accept-${o.id}`} onClick={() => void accept(o)}>
                                  {he.offerAccepted}
                                </button>
                                <button type="button" className="btn" onClick={() => void act(`d-${o.id}`, () => p.backend.setOfferStatus(o.id, 'declined'))}>
                                  {he.offerDeclined}
                                </button>
                                <button type="button" className="btn ghost" onClick={() => void act(`e-${o.id}`, () => p.backend.setOfferStatus(o.id, 'expired'))}>
                                  {he.offerExpired}
                                </button>
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
