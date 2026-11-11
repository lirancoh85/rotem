import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Backend } from './data/backend';
import { toAppError } from './data/backend';
import { DemoBackend } from './data/demoBackend';
import { SupabaseBackend } from './data/supabaseBackend';
import type { Appointment, AppointmentInput, CustomerProfile, WaitlistInput } from './domain/types';
import { useSalon } from './hooks/useSalon';
import { Calendar } from './components/Calendar';
import { AppointmentForm, type FormSeed } from './components/AppointmentForm';
import { ConfirmDialog } from './components/ConfirmDialog';
import { QuickBook } from './components/QuickBook';
import { MoveDialog } from './components/MoveDialog';
import { SearchDialog } from './components/SearchDialog';
import { CustomersPanel } from './components/CustomersPanel';
import { CustomerProfileSheet } from './components/CustomerProfileSheet';
import { SeriesPreview } from './components/SeriesPreview';
import { ScopeDialog, type Scope } from './components/ScopeDialog';
import { WaitlistPanel } from './components/WaitlistPanel';
import { useWaitlist } from './hooks/useWaitlist';
import { useOnline } from './hooks/useOnline';
import { withOfflineGuard } from './lib/offlineGuard';
import { OfflineScreen } from './components/OfflineScreen';
import { requestsForSlot } from './domain/waitlist';
import type { RecurrenceRule } from './domain/recurrence';
import { findOverlap } from './domain/schedule';
import { DateBar } from './components/DateBar';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { SettingsDialog } from './components/SettingsDialog';
import { Toast, type ToastMsg } from './components/Toast';
import { fmtTime, formatHebrewDateShort, nowMinutesLocal, todayLocal, utcToLocal } from './lib/time';
import { he } from './i18n/he';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as
  | string
  | undefined;

function wantsDemo() {
  if (import.meta.env.MODE === 'demo') return true;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo')) return true;
  return !SUPABASE_URL || !SUPABASE_KEY;
}

export default function App() {
  const demo = useMemo(wantsDemo, []);
  if (demo) return <DemoApp />;
  return <SupabaseApp />;
}

function DemoApp() {
  const [{ backend, gen }, setState] = useState(() => ({ backend: new DemoBackend(undefined, undefined, 120), gen: 0 }));
  return (
    <SalonApp
      key={gen}
      backend={backend}
      onSignOut={async () => {
        await backend.signOut();
        setState({ backend: new DemoBackend(undefined, undefined, 120), gen: gen + 1 });
      }}
    />
  );
}

let sbSingleton: SupabaseClient | null = null;
function supabase() {
  sbSingleton ??= createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  return sbSingleton;
}

function SupabaseApp() {
  const sb = supabase();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [sb]);
  const backend = useMemo(() => (session ? new SupabaseBackend(sb) : null), [sb, session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session === undefined) return <div className="splash">{he.loading}</div>;
  if (!session && typeof navigator !== 'undefined' && navigator.onLine === false) return <OfflineScreen />;
  if (!session || !backend) return <LoginScreen sb={sb} />;
  return <SalonApp key={session.user.id} backend={backend} onSignOut={() => backend.signOut()} />;
}

type FormState = {
  seed: FormSeed;
  editing: Appointment | null;
  mode: 'quick' | 'full';
  initialName?: string;
  initialPhone?: string;
  initialCustomerId?: string | null;
};

type PendingMove = { appt: Appointment; staffId: string; date: string; start: number };

/** An existing appointment as form input (used for moves and undo). */
function toInput(appt: Appointment, tz: string): AppointmentInput {
  const s = utcToLocal(appt.startsAt, tz);
  const e = utcToLocal(appt.endsAt, tz);
  return {
    staffId: appt.staffId,
    date: s.date,
    start: s.minutes,
    duration: (e.date === s.date ? e.minutes : 1440) - s.minutes,
    customerName: appt.customerName,
    customerPhone: appt.customerPhone ?? '',
    service: appt.service ?? '',
    notes: appt.notes ?? '',
    isBlocked: appt.isBlocked,
    customerId: appt.customerId ?? null,
  };
}

const VIEW_KEY = 'rotem-full-day';
function readFullDay() {
  try {
    return localStorage.getItem(VIEW_KEY) === '1';
  } catch {
    return false;
  }
}

const FILTER_KEY = 'rotem-staff-filter';
function readFilter() {
  try {
    return localStorage.getItem(FILTER_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

export function SalonApp({ backend: rawBackend, onSignOut, initialDate }: { backend: Backend; onSignOut(): void; initialDate?: string }) {
  const online = useOnline();
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // writes are refused while offline — there is no unsafe offline queue
  const backend = useMemo(
    () => withOfflineGuard(rawBackend, () => onlineRef.current && (typeof navigator === 'undefined' || navigator.onLine !== false)),
    [rawBackend],
  );
  const salon = useSalon(backend, initialDate);
  const { shop, staff, date } = salon;
  const tz = shop?.timezone ?? 'Asia/Jerusalem';

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<Appointment | null>(null);
  const [confirmUnblock, setConfirmUnblock] = useState<Appointment | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [filter, setFilterState] = useState(readFilter);
  const [now, setNow] = useState(() => Date.now());
  const [searchOpen, setSearchOpen] = useState(false);
  const [moveAppt, setMoveAppt] = useState<Appointment | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [fullDay, setFullDayState] = useState(readFullDay);
  const [customersOpen, setCustomersOpen] = useState(false);
  const [profile, setProfile] = useState<{ id: string; ctx: Appointment | null } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [seriesDraft, setSeriesDraft] = useState<{ input: AppointmentInput; rule: RecurrenceRule } | null>(null);
  const [waitlistOpen, setWaitlistOpen] = useState<{ startWith: Partial<WaitlistInput> | null } | null>(null);
  const waitlist = useWaitlist(backend, shop, staff, refreshKey, salon.waitlistTick);
  const [scope, setScope] = useState<{ mode: 'edit' | 'cancel'; appt: Appointment; input?: AppointmentInput } | null>(null);
  // open profiles/panels refresh whenever the diary changes (on any device)
  useEffect(() => setRefreshKey((k) => k + 1), [salon.day.appointments]);

  const toggleFullDay = () =>
    setFullDayState((v) => {
      try {
        localStorage.setItem(VIEW_KEY, v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });

  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), 2600);
    return () => clearTimeout(t);
  }, [highlightId]);

  const lookupCustomers = useCallback(
    (q: string) => (shop ? backend.searchCustomers(shop.id, q) : Promise.resolve([])),
    [backend, shop],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const setFilter = (f: string) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  const notify = useCallback(
    (text: string, tone: ToastMsg['tone'] = 'ok', action?: ToastMsg['action'], action2?: ToastMsg['action2']) => {
      setToast({ id: Date.now(), text, tone, action, action2 });
    },
    [],
  );
  const clearToast = useCallback(() => setToast(null), []);

  const visibleStaff = useMemo(
    () => (filter === 'all' || !staff.some((s) => s.id === filter) ? staff : staff.filter((s) => s.id === filter)),
    [staff, filter],
  );

  const onFreeTap = useCallback(
    (staffId: string, start: number, split: boolean) => {
      if (!onlineRef.current) return notify(he.errors.OFFLINE, 'error');
      setFormError(null);
      setForm({ seed: { staffId, date, start, duration: split ? 15 : 30 }, editing: null, mode: 'quick' });
    },
    [date, notify],
  );
  const onAppointmentTap = useCallback((appt: Appointment) => {
    if (!onlineRef.current) return notify(he.errors.OFFLINE, 'error');
    setFormError(null);
    if (appt.isBlocked) {
      setConfirmUnblock(appt);
      return;
    }
    const s = utcToLocal(appt.startsAt);
    setForm({ seed: { staffId: appt.staffId, date: s.date, start: s.minutes, duration: 30 }, editing: appt, mode: 'full' });
  }, [notify]);

  const onCustomerTap = useCallback((appt: Appointment) => {
    if (appt.customerId) setProfile({ id: appt.customerId, ctx: appt });
  }, []);

  const runSplit = useCallback(
    async (staffId: string, blockStart: number, isSplit: boolean) => {
      setBusyKey(`${staffId}:${blockStart}`);
      try {
        await salon.setSplit(staffId, blockStart, isSplit);
        notify(isSplit ? he.splitDone : he.mergeDone);
      } catch (e) {
        notify(he.errors[toAppError(e).code], 'error');
      } finally {
        setBusyKey(null);
      }
    },
    [salon, notify],
  );
  const onSplit = useCallback((s: string, b: number) => void runSplit(s, b, true), [runSplit]);
  const onMerge = useCallback((s: string, b: number) => void runSplit(s, b, false), [runSplit]);

  const onSave = async (input: AppointmentInput) => {
    if (form?.editing?.seriesId && !input.isBlocked) {
      setScope({ mode: 'edit', appt: form.editing, input });
      return;
    }
    await saveSingle(input);
  };

  const saveSingle = async (input: AppointmentInput) => {
    setSaving(true);
    setFormError(null);
    try {
      await salon.saveAppointment(input, form?.editing?.id);
      notify(input.isBlocked ? he.blockedDone : form?.editing ? he.savedEdit : he.savedNew);
      setForm(null);
    } catch (e) {
      setFormError(he.errors[toAppError(e).code]);
    } finally {
      setSaving(false);
    }
  };

  /** recurring: apply an edit or cancellation to this / following / all occurrences */
  const runScope = async (choice: Scope) => {
    if (!scope) return;
    const { mode, appt, input } = scope;
    setScope(null);
    if (choice === 'this') {
      if (mode === 'edit' && input) await saveSingle(input);
      else setConfirmCancel(appt);
      return;
    }
    try {
      if (mode === 'edit' && input) {
        const n = await backend.updateSeriesFuture(appt.id, {
          staffId: input.staffId,
          start: input.start,
          duration: input.duration,
          service: input.service,
          notes: input.notes,
        });
        notify(he.seriesUpdated(n));
      } else {
        const n = await backend.cancelSeries(appt.id, choice);
        notify(he.seriesCancelled(n));
      }
      setForm(null);
      void salon.reload();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      const err = toAppError(e);
      const msg = err.code === 'SERIES_CONFLICT' ? he.seriesConflictAt(err.message) : he.errors[err.code];
      if (form) setFormError(msg);
      else notify(msg, 'error');
    }
  };

  /** cancel keeps the appointment in the customer's history; undo restores it */
  const doCancel = async (appt: Appointment) => {
    setConfirmCancel(null);
    setForm(null);
    try {
      await salon.setAppointmentStatus(appt.id, 'cancelled');
      setRefreshKey((k) => k + 1);
      const s = utcToLocal(appt.startsAt, tz);
      const e = utcToLocal(appt.endsAt, tz);
      const waiting = requestsForSlot(waitlist.requests ?? [], { date: s.date, start: s.minutes, end: e.minutes, staffId: appt.staffId });
      const undo = {
        label: he.undo,
        run: () =>
          void salon.setAppointmentStatus(appt.id, 'booked').catch((err) => notify(he.errors[toAppError(err).code], 'error')),
      };
      if (waiting.length) {
        // a slot opened up and someone is waiting for it — point to the list, without interrupting
        notify(`${he.cancelled} · ${he.slotFreedMatches(waiting.length)}`, 'ok', { label: he.show, run: () => setWaitlistOpen({ startWith: null }) }, undo);
      } else notify(he.cancelled, 'ok', undo);
    } catch (e) {
      notify(he.errors[toAppError(e).code], 'error');
    }
  };

  const setNoShow = async (appt: Appointment, noShow: boolean) => {
    try {
      await salon.setAppointmentStatus(appt.id, noShow ? 'no_show' : 'booked');
      notify(noShow ? he.noShowDone : he.arrivedDone);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      notify(he.errors[toAppError(e).code], 'error');
    }
  };

  /** "Book again": a new booking with the customer already selected */
  const bookAgain = (p: CustomerProfile) => {
    if (!shop) return;
    const last = [...p.appointments].reverse().find((a) => (a.status ?? 'booked') !== 'cancelled');
    const len = last ? Math.round((Date.parse(last.endsAt) - Date.parse(last.startsAt)) / 60000) : 30;
    const today = todayLocal(tz);
    setProfile(null);
    setCustomersOpen(false);
    setFormError(null);
    setForm({
      seed: { staffId: last?.staffId ?? staff[0]?.id ?? '', date: date < today ? today : date, start: shop.dayStart, duration: len },
      editing: null,
      mode: 'full',
      initialName: p.customer.name,
      initialPhone: p.customer.phone ?? '',
      initialCustomerId: p.customer.id,
    });
  };

  /** drag-and-drop: check availability first, then ask for confirmation */
  const onMoveDrop = useCallback(
    (appt: Appointment, staffId: string, start: number) => {
      const len = toInput(appt, tz).duration;
      if (findOverlap(salon.dayAppts, staffId, start, start + len, appt.id)) {
        notify(he.errors.OVERLAP, 'error');
        return;
      }
      setPendingMove({ appt, staffId, date, start });
    },
    [salon.dayAppts, tz, date, notify],
  );

  const runMove = async (m: PendingMove) => {
    setSaving(true);
    setMoveError(null);
    try {
      await salon.saveAppointment({ ...toInput(m.appt, tz), staffId: m.staffId, date: m.date, start: m.start }, m.appt.id);
      notify(he.moved);
      setPendingMove(null);
      setMoveAppt(null);
      setForm(null);
      setHighlightId(m.appt.id);
    } catch (e) {
      const msg = he.errors[toAppError(e).code];
      if (moveAppt) setMoveError(msg);
      else notify(msg, 'error');
      setPendingMove(null);
    } finally {
      setSaving(false);
    }
  };

  if (salon.fatal === 'NETWORK' || (salon.fatal && !online)) return <OfflineScreen />;
  if (salon.fatal) {
    return (
      <div className="splash">
        <p>{he.errors[salon.fatal]}</p>
        <button type="button" className="btn ghost" onClick={onSignOut}>
          {he.signOut}
        </button>
      </div>
    );
  }

  const isToday = date === todayLocal(tz, now);
  const empty = !salon.loading && salon.day.appointments.length === 0;

  return (
    <div className={`app ${fullDay ? 'full-day' : ''}`}>
      <Header
        status={salon.status}
        demo={backend.mode === 'demo'}
        onSettings={() => setSettingsOpen(true)}
        onSearch={() => setSearchOpen(true)}
        onCustomers={() => setCustomersOpen(true)}
        onWaitlist={() => setWaitlistOpen({ startWith: null })}
        waitlistMatches={waitlist.matchCount}
      />
      <DateBar
        date={date}
        onDate={salon.setDate}
        staff={staff}
        filter={filter}
        onFilter={setFilter}
        fullDay={fullDay}
        onToggleFullDay={toggleFullDay}
      />
      {!online && (
        <div className="offline-banner" role="status" data-testid="offline-banner">
          {he.offlineBanner}
        </div>
      )}
      <main className={`cal-wrap ${fullDay ? 'is-fit' : ''}`} aria-busy={salon.loading}>
        {empty && !fullDay && <p className="empty-note">{he.emptyDay}</p>}
        {shop && visibleStaff.length > 0 ? (
          <Calendar
            key={date}
            staff={visibleStaff}
            date={date}
            dayStart={shop.dayStart}
            dayEnd={shop.dayEnd}
            dayAppts={salon.dayAppts}
            splits={salon.day.splits}
            nowMinutes={isToday ? nowMinutesLocal(tz, now) : null}
            busyKey={busyKey}
            onFreeTap={onFreeTap}
            onAppointmentTap={onAppointmentTap}
            onSplit={onSplit}
            onMerge={onMerge}
            onMoveDrop={onMoveDrop}
            fit={fullDay}
            highlightId={highlightId}
            firstVisitIds={salon.firstVisitIds}
            onCustomerTap={onCustomerTap}
          />
        ) : (
          <p className="empty-note">{he.loading}</p>
        )}
      </main>

      {form && shop && form.mode === 'quick' && (
        <QuickBook
          staffName={staff.find((s) => s.id === form.seed.staffId)?.name ?? ''}
          start={form.seed.start}
          duration={form.seed.duration}
          error={formError}
          saving={saving}
          lookup={lookupCustomers}
          onSave={(c) =>
            void onSave({ ...form.seed, customerName: c.name, customerPhone: c.phone, customerId: c.customerId, service: '', notes: '' })
          }
          onBlock={() =>
            void onSave({ ...form.seed, customerName: he.blocked, customerPhone: '', service: '', notes: '', isBlocked: true })
          }
          onMore={(c) => {
            setFormError(null);
            setForm({ ...form, mode: 'full', initialName: c.name, initialPhone: c.phone, initialCustomerId: c.customerId });
          }}
          onCancel={() => setForm(null)}
        />
      )}

      {form && shop && form.mode === 'full' && (
        <AppointmentForm
          initialName={form.initialName}
          initialPhone={form.initialPhone}
          initialCustomerId={form.initialCustomerId}
          lookup={lookupCustomers}
          onMove={
            form.editing
              ? () => {
                  setMoveError(null);
                  setMoveAppt(form.editing);
                }
              : undefined
          }
          staff={staff}
          dayStart={shop.dayStart}
          dayEnd={shop.dayEnd}
          tz={tz}
          seed={form.seed}
          editing={form.editing}
          error={formError}
          saving={saving}
          onSave={onSave}
          onCancel={() => setForm(null)}
          onDelete={
            form.editing
              ? () => (form.editing!.seriesId ? setScope({ mode: 'cancel', appt: form.editing! }) : setConfirmCancel(form.editing))
              : undefined
          }
          onPreviewSeries={(input, rule) => setSeriesDraft({ input, rule })}
          onOpenProfile={
            form.editing?.customerId
              ? () => {
                  setProfile({ id: form.editing!.customerId!, ctx: form.editing });
                  setForm(null);
                }
              : undefined
          }
        />
      )}

      {moveAppt && shop && (
        <MoveDialog
          appt={moveAppt}
          staff={staff}
          tz={tz}
          dayStart={shop.dayStart}
          dayEnd={shop.dayEnd}
          loadDay={(d) => backend.loadDay(shop.id, d)}
          saving={saving}
          error={moveError}
          onConfirm={(t) => void runMove({ appt: moveAppt, ...t })}
          onCancel={() => setMoveAppt(null)}
        />
      )}

      {pendingMove && (
        <ConfirmDialog
          title={he.moveConfirmTitle}
          message={he.moveQuestion(
            pendingMove.appt.customerName,
            staff.find((s) => s.id === pendingMove.staffId)?.name ?? '',
            formatHebrewDateShort(pendingMove.date),
            fmtTime(pendingMove.start),
            fmtTime(pendingMove.start + toInput(pendingMove.appt, tz).duration),
          )}
          confirmLabel={he.moveConfirm}
          tone="primary"
          onConfirm={() => void runMove(pendingMove)}
          onCancel={() => setPendingMove(null)}
        />
      )}

      {searchOpen && shop && (
        <SearchDialog
          staff={staff}
          tz={tz}
          search={(q, d) => backend.searchAppointments(shop.id, q, d)}
          onPick={(a) => {
            setSearchOpen(false);
            salon.setDate(utcToLocal(a.startsAt, tz).date);
            if (filter !== 'all' && filter !== a.staffId) setFilter('all');
            setHighlightId(a.id);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {confirmCancel && (
        <ConfirmDialog
          title={he.cancelTitle}
          message={he.cancelQuestion(confirmCancel.customerName, fmtTime(utcToLocal(confirmCancel.startsAt, tz).minutes))}
          confirmLabel={he.cancelAppointment}
          onConfirm={() => void doCancel(confirmCancel)}
          onCancel={() => setConfirmCancel(null)}
        />
      )}

      {seriesDraft && shop && (
        <SeriesPreview
          backend={backend}
          shop={shop}
          staff={staff}
          input={seriesDraft.input}
          rule={seriesDraft.rule}
          onBack={() => setSeriesDraft(null)}
          onCreated={(n, first) => {
            setSeriesDraft(null);
            setForm(null);
            notify(he.seriesCreated(n));
            if (first !== date) salon.setDate(first);
            else void salon.reload();
          }}
        />
      )}

      {waitlistOpen && shop && (
        <WaitlistPanel
          backend={backend}
          shop={shop}
          staff={staff}
          requests={waitlist.requests}
          matches={waitlist.matches}
          lookup={lookupCustomers}
          startWith={waitlistOpen.startWith}
          notify={(t, tone) => notify(t, tone)}
          onChanged={waitlist.reload}
          onBooked={(apptId, d) => {
            setWaitlistOpen(null);
            salon.setDate(d);
            if (apptId) setHighlightId(apptId);
            setRefreshKey((k) => k + 1);
          }}
          onClose={() => setWaitlistOpen(null)}
        />
      )}

      {scope && <ScopeDialog mode={scope.mode} onChoose={(c) => void runScope(c)} onCancel={() => setScope(null)} />}

      {customersOpen && shop && (
        <CustomersPanel
          backend={backend}
          shopId={shop.id}
          tz={tz}
          onOpen={(id) => setProfile({ id, ctx: null })}
          onClose={() => setCustomersOpen(false)}
        />
      )}

      {profile && shop && (
        <CustomerProfileSheet
          backend={backend}
          customerId={profile.id}
          contextAppt={profile.ctx}
          staff={staff}
          tz={tz}
          refreshKey={refreshKey}
          onClose={() => setProfile(null)}
          onBookAgain={bookAgain}
          onEditAppointment={(a) => {
            setProfile(null);
            onAppointmentTap(a);
          }}
          onCancelAppointment={(a) => (a.seriesId ? setScope({ mode: 'cancel', appt: a }) : setConfirmCancel(a))}
          onSetNoShow={(a, ns) => void setNoShow(a, ns)}
          onJump={(a) => {
            setProfile(null);
            setCustomersOpen(false);
            salon.setDate(utcToLocal(a.startsAt, tz).date);
            if (filter !== 'all' && filter !== a.staffId) setFilter('all');
            setHighlightId(a.id);
          }}
          onSaved={() => notify(he.customerSaved)}
          onAddToWaitlist={(pr) => {
            setProfile(null);
            setWaitlistOpen({
              startWith: { customerName: pr.customer.name, customerPhone: pr.customer.phone ?? '', customerId: pr.customer.id },
            });
          }}
        />
      )}

      {confirmUnblock && (
        <ConfirmDialog
          title={he.unblockTitle}
          message={he.unblockQuestion(fmtTime(utcToLocal(confirmUnblock.startsAt, tz).minutes))}
          confirmLabel={he.unblockConfirm}
          onConfirm={async () => {
            const a = confirmUnblock;
            setConfirmUnblock(null);
            try {
              await salon.deleteAppointment(a.id);
              notify(he.unblocked);
            } catch (e) {
              notify(he.errors[toAppError(e).code], 'error');
            }
          }}
          onCancel={() => setConfirmUnblock(null)}
        />
      )}

      {settingsOpen && shop && (
        <SettingsDialog
          dayStart={shop.dayStart}
          dayEnd={shop.dayEnd}
          closedWeekdays={shop.closedWeekdays}
          onSaveClosedDays={async (days) => {
            try {
              await salon.updateClosedWeekdays(days);
              notify(he.closedDaysSaved);
            } catch (err) {
              notify(he.errors[toAppError(err).code], 'error');
            }
          }}
          demo={backend.mode === 'demo'}
          onSaveHours={async (s, e) => {
            try {
              await salon.updateHours(s, e);
              notify(he.hoursSaved);
              setSettingsOpen(false);
            } catch (err) {
              notify(he.errors[toAppError(err).code], 'error');
            }
          }}
          onSignOut={() => {
            setSettingsOpen(false);
            onSignOut();
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <Toast toast={toast} onDone={clearToast} />
    </div>
  );
}
