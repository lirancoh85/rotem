import { useEffect, useId, useState } from 'react';
import type { Backend } from '../data/backend';
import { toAppError } from '../data/backend';
import type { Appointment, CustomerProfile, Staff } from '../domain/types';
import { fmtTime, formatHebrewDate, formatHebrewDateShort, utcToLocal } from '../lib/time';
import { telLink, whatsappLink } from '../lib/contact';
import { he } from '../i18n/he';
import { Modal } from './Modal';

/** Customer profile: details, notes/preferences, statistics and full booking history. */
export function CustomerProfileSheet(p: {
  backend: Backend;
  customerId: string;
  staff: Staff[];
  tz: string;
  /** the appointment that was tapped in the calendar, if any */
  contextAppt?: Appointment | null;
  /** changes whenever appointments change, so the profile refreshes */
  refreshKey: number;
  readOnly?: boolean;
  onClose(): void;
  onBookAgain(profile: CustomerProfile): void;
  onEditAppointment(a: Appointment): void;
  onCancelAppointment(a: Appointment): void;
  onSetNoShow(a: Appointment, noShow: boolean): void;
  onJump(a: Appointment): void;
  onSaved(): void;
  onAddToWaitlist?(profile: CustomerProfile): void;
}) {
  const [profile, setProfile] = useState<CustomerProfile | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', phone: '', notes: '', preferences: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now] = useState(() => Date.now());
  const id = useId();

  useEffect(() => {
    let alive = true;
    p.backend
      .getCustomerProfile(p.customerId)
      .then((r) => alive && setProfile(r))
      .catch(() => alive && setProfile(null));
    return () => {
      alive = false;
    };
  }, [p.backend, p.customerId, p.refreshKey]);

  const startEdit = () => {
    if (!profile) return;
    const c = profile.customer;
    setDraft({ name: c.name, phone: c.phone ?? '', notes: c.notes ?? '', preferences: c.preferences ?? '' });
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await p.backend.updateCustomer(p.customerId, draft);
      setProfile(await p.backend.getCustomerProfile(p.customerId));
      setEditing(false);
      p.onSaved();
    } catch (e) {
      setError(he.errors[toAppError(e).code]);
    } finally {
      setSaving(false);
    }
  };

  const staffName = (sid: string) => p.staff.find((s) => s.id === sid)?.name ?? '';
  const staffIdx = (sid: string) => p.staff.findIndex((s) => s.id === sid);
  const when = (a: Appointment) => {
    const s = utcToLocal(a.startsAt, p.tz);
    const e = utcToLocal(a.endsAt, p.tz);
    return { date: s.date, from: fmtTime(s.minutes), to: fmtTime(e.minutes) };
  };
  const dateOf = (iso: string | null) => (iso ? formatHebrewDateShort(utcToLocal(iso, p.tz).date) : '—');

  const appts = profile?.appointments ?? [];
  const upcoming = appts.filter((a) => (a.status ?? 'booked') === 'booked' && Date.parse(a.startsAt) > now);
  const previous = appts.filter((a) => (a.status ?? 'booked') === 'booked' && Date.parse(a.startsAt) <= now);
  const missed = appts.filter((a) => a.status === 'cancelled' || a.status === 'no_show');

  const ctx = p.contextAppt && profile ? appts.find((a) => a.id === p.contextAppt!.id) ?? p.contextAppt : null;
  const ctxStarted = ctx ? Date.parse(ctx.startsAt) <= now : false;

  const row = (a: Appointment) => {
    const w = when(a);
    const st = a.status ?? 'booked';
    const label = st === 'booked' ? (Date.parse(a.endsAt) <= now ? he.apptStatus.done : he.apptStatus.booked) : he.apptStatus[st];
    return (
      <li key={a.id}>
        <button type="button" className="history-row" onClick={() => p.onJump(a)} data-testid="history-row" data-status={st}>
          <span className="history-date">{formatHebrewDateShort(w.date)}</span>
          <bdi dir="ltr" className="history-time">
            {w.from}–{w.to}
          </bdi>
          <span className={`history-staff staff-${staffIdx(a.staffId)}`}>{staffName(a.staffId)}</span>
          {a.service && <span className="history-service">{a.service}</span>}
          {a.seriesId && <span className="recurring-mark" aria-label={he.recurring} title={he.recurring} />}
          <span className={`history-status st-${st === 'booked' && Date.parse(a.endsAt) <= now ? 'done' : st}`}>{label}</span>
        </button>
      </li>
    );
  };

  const section = (title: string, list: Appointment[], testId: string) => (
    <section className="history-section" data-testid={testId}>
      <h3>
        {title} <span className="count">{list.length}</span>
      </h3>
      {list.length ? <ul className="history-list">{list.map(row)}</ul> : <p className="muted empty-small">{he.noAppointments}</p>}
    </section>
  );

  const c = profile?.customer;
  const wa = c ? whatsappLink(c.phone, '') : null;
  const tel = c ? telLink(c.phone) : null;

  return (
    <Modal title={he.customerProfile} onClose={p.onClose} labelledBy={`${id}-t`} size="side">
      <div className="profile" data-testid="customer-profile">
        {profile === undefined && <p className="muted">{he.loading}</p>}
        {profile === null && <p className="muted">{he.errors.NOT_FOUND}</p>}
        {profile && c && (
          <>
            <header className="profile-head">
              <span className="profile-avatar" aria-hidden="true">
                {c.name.trim().charAt(0)}
              </span>
              <div className="profile-title">
                <h2 id={`${id}-t`}>{c.name}</h2>
                <div className="profile-sub">
                  <span className={`status-chip st-${profile.stats.status}`} data-testid="customer-status">
                    {he.statusLabel[profile.stats.status]}
                  </span>
                  {c.phone && (
                    <bdi dir="ltr" className="profile-phone">
                      {c.phone}
                    </bdi>
                  )}
                </div>
              </div>
            </header>

            {(tel || wa) && (
              <div className="contact-row">
                {tel && (
                  <a className="btn contact-btn" href={tel}>
                    {he.call}
                  </a>
                )}
                {wa && (
                  <a className="btn contact-btn wa" href={wa} target="_blank" rel="noopener noreferrer">
                    {he.whatsapp}
                  </a>
                )}
              </div>
            )}

            {ctx && (
              <section className="context-appt" aria-label={he.thisAppointment}>
                <div className="context-info">
                  <span className="context-label">{he.thisAppointment}</span>
                  <strong>
                    {formatHebrewDate(when(ctx).date)} · <bdi dir="ltr">{when(ctx).from}–{when(ctx).to}</bdi> · {staffName(ctx.staffId)}
                  </strong>
                </div>
                {!p.readOnly && (
                  <div className="context-actions">
                    <button type="button" className="btn primary" onClick={() => p.onEditAppointment(ctx)}>
                      {he.editThisAppointment}
                    </button>
                    {ctxStarted && ctx.status !== 'cancelled' && (
                      <button type="button" className="btn" onClick={() => p.onSetNoShow(ctx, ctx.status !== 'no_show')}>
                        {ctx.status === 'no_show' ? he.markArrived : he.markNoShow}
                      </button>
                    )}
                    {ctx.status !== 'cancelled' && (
                      <button type="button" className="btn danger" onClick={() => p.onCancelAppointment(ctx)}>
                        {he.cancelAppointment}
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}

            <dl className="stats-grid">
              <div>
                <dt>{he.completedVisits}</dt>
                <dd data-testid="stat-visits">{profile.stats.completedVisits}</dd>
              </div>
              <div>
                <dt>{he.firstAppointment}</dt>
                <dd>{dateOf(profile.stats.firstVisit)}</dd>
              </div>
              <div>
                <dt>{he.lastAppointment}</dt>
                <dd>{dateOf(profile.stats.lastVisit)}</dd>
              </div>
              <div>
                <dt>{he.upcomingAppointments}</dt>
                <dd>{profile.stats.upcomingCount}</dd>
              </div>
              <div>
                <dt>{he.cancelledCount}</dt>
                <dd>{profile.stats.cancelledCount}</dd>
              </div>
              <div>
                <dt>{he.noShowCount}</dt>
                <dd>{profile.stats.noShowCount}</dd>
              </div>
            </dl>

            {!editing ? (
              <section className="profile-notes">
                <div>
                  <h3>{he.preferences}</h3>
                  <p className={c.preferences ? '' : 'muted'}>{c.preferences || '—'}</p>
                </div>
                <div>
                  <h3>{he.notes}</h3>
                  <p className={c.notes ? '' : 'muted'}>{c.notes || '—'}</p>
                </div>
              </section>
            ) : (
              <form
                className="profile-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                {error && <div className="form-error" role="alert">{error}</div>}
                <div className="field-row">
                  <label className="field">
                    <span>{he.customerName}</span>
                    <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} required />
                  </label>
                  <label className="field">
                    <span>{he.phone}</span>
                    <input type="tel" dir="ltr" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} maxLength={30} />
                  </label>
                </div>
                <label className="field">
                  <span>{he.preferences}</span>
                  <textarea rows={2} value={draft.preferences} placeholder={he.preferencesPlaceholder} onChange={(e) => setDraft({ ...draft, preferences: e.target.value })} maxLength={2000} />
                </label>
                <label className="field">
                  <span>{he.notes}</span>
                  <textarea rows={2} value={draft.notes} placeholder={he.customerNotesPlaceholder} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} maxLength={2000} />
                </label>
                <div className="form-actions">
                  <button type="submit" className={`btn primary ${saving ? 'is-saving' : ''}`} disabled={saving}>
                    {he.saveCustomer}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                    {he.cancel}
                  </button>
                </div>
              </form>
            )}

            {!editing && !p.readOnly && (
              <div className="profile-actions">
                <button type="button" className="btn primary" onClick={() => p.onBookAgain(profile)}>
                  {he.bookAgain}
                </button>
                <button type="button" className="btn" onClick={startEdit}>
                  {he.editCustomer}
                </button>
                {p.onAddToWaitlist && (
                  <button type="button" className="btn" onClick={() => p.onAddToWaitlist!(profile)}>
                    {he.waitlistAdd}
                  </button>
                )}
              </div>
            )}

            {section(he.upcomingAppointments, upcoming, 'history-upcoming')}
            {section(he.previousAppointments, previous, 'history-previous')}
            {section(he.cancelledAndNoShows, missed, 'history-missed')}
          </>
        )}
      </div>
    </Modal>
  );
}
