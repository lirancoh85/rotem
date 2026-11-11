import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Backend } from './data/backend';
import { toAppError } from './data/backend';
import { DemoBackend } from './data/demoBackend';
import { SupabaseBackend } from './data/supabaseBackend';
import type { Appointment, AppointmentInput, CustomerProfile } from './domain/types';
import { useSalon } from './hooks/useSalon';
import { Calendar } from './components/Calendar';
import { AppointmentForm, type FormSeed } from './components/AppointmentForm';
import { ConfirmDialog } from './components/ConfirmDialog';
import { QuickBook } from './components/QuickBook';
import { MoveDialog } from './components/MoveDialog';
import { SearchDialog } from './components/SearchDialog';
import { CustomersPanel } from './components/CustomersPanel';
import { CustomerProfileSheet } from './components/CustomerProfileSheet';
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

export function SalonApp({ backend, onSignOut, initialDate }: { backend: Backend; onSignOut(): void; initialDate?: string }) {
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

  const notify = useCallback((text: string, tone: ToastMsg['tone'] = 'ok', action?: ToastMsg['action']) => {
    setToast({ id: Date.now(), text, tone, action });
  }, []);
  const clearToast = useCallback(() => setToast(null), []);

  const visibleStaff = useMemo(
    () => (filter === 'all' || !staff.some((s) => s.id === filter) ? staff : staff.filter((s) => s.id === filter)),
    [staff, filter],
  );

  const onFreeTap = useCallback(
    (staffId: string, start: number, split: boolean) => {
      setFormError(null);
      setForm({ seed: { staffId, date, start, duration: split ? 15 : 30 }, editing: null, mode: 'quick' });
    },
    [date],
  );
  const onAppointmentTap = useCallback((appt: Appointment) => {
    setFormError(null);
    if (appt.isBlocked) {
      setConfirmUnblock(appt);
      return;
    }
    const s = utcToLocal(appt.startsAt);
    setForm({ seed: { staffId: appt.staffId, date: s.date, start: s.minutes, duration: 30 }, editing: appt, mode: 'full' });
  }, []);

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

  /** cancel keeps the appointment in the customer's history; undo restores it */
  const doCancel = async (appt: Appointment) => {
    setConfirmCancel(null);
    setForm(null);
    try {
      await salon.setAppointmentStatus(appt.id, 'cancelled');
      setRefreshKey((k) => k + 1);
      notify(he.cancelled, 'ok', {
        label: he.undo,
        run: () =>
          void salon.setAppointmentStatus(appt.id, 'booked').catch((err) => notify(he.errors[toAppError(err).code], 'error')),
      });
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
          onDelete={form.editing ? () => setConfirmCancel(form.editing) : undefined}
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
          onCancelAppointment={(a) => setConfirmCancel(a)}
          onSetNoShow={(a, ns) => void setNoShow(a, ns)}
          onJump={(a) => {
            setProfile(null);
            setCustomersOpen(false);
            salon.setDate(utcToLocal(a.startsAt, tz).date);
            if (filter !== 'all' && filter !== a.staffId) setFilter('all');
            setHighlightId(a.id);
          }}
          onSaved={() => notify(he.customerSaved)}
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
