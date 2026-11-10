import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Backend } from './data/backend';
import { toAppError } from './data/backend';
import { DemoBackend } from './data/demoBackend';
import { SupabaseBackend } from './data/supabaseBackend';
import type { Appointment, AppointmentInput } from './domain/types';
import { useSalon } from './hooks/useSalon';
import { Calendar } from './components/Calendar';
import { AppointmentForm, type FormSeed } from './components/AppointmentForm';
import { ConfirmDialog } from './components/ConfirmDialog';
import { QuickBook } from './components/QuickBook';
import { DateBar } from './components/DateBar';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { SettingsDialog } from './components/SettingsDialog';
import { Toast, type ToastMsg } from './components/Toast';
import { fmtTime, nowMinutesLocal, todayLocal, utcToLocal } from './lib/time';
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

type FormState = { seed: FormSeed; editing: Appointment | null; mode: 'quick' | 'full'; initialName?: string };

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
  const [confirmDelete, setConfirmDelete] = useState<Appointment | null>(null);
  const [confirmUnblock, setConfirmUnblock] = useState<Appointment | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [filter, setFilterState] = useState(readFilter);
  const [now, setNow] = useState(() => Date.now());

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

  const doDelete = async (appt: Appointment) => {
    setConfirmDelete(null);
    setForm(null);
    try {
      await salon.deleteAppointment(appt.id);
      const s = utcToLocal(appt.startsAt, tz);
      const e = utcToLocal(appt.endsAt, tz);
      notify(he.deleted, 'ok', {
        label: he.undo,
        run: () =>
          void salon
            .saveAppointment({
              staffId: appt.staffId,
              date: s.date,
              start: s.minutes,
              duration: e.minutes - s.minutes,
              customerName: appt.customerName,
              customerPhone: appt.customerPhone ?? '',
              service: appt.service ?? '',
              notes: appt.notes ?? '',
            })
            .catch((err) => notify(he.errors[toAppError(err).code], 'error')),
      });
    } catch (e) {
      notify(he.errors[toAppError(e).code], 'error');
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
    <div className="app">
      <Header status={salon.status} demo={backend.mode === 'demo'} onSettings={() => setSettingsOpen(true)} />
      <DateBar date={date} onDate={salon.setDate} staff={staff} filter={filter} onFilter={setFilter} />
      <main className="cal-wrap" aria-busy={salon.loading}>
        {empty && <p className="empty-note">{he.emptyDay}</p>}
        {shop && visibleStaff.length > 0 ? (
          <Calendar
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
          onSave={(name) => void onSave({ ...form.seed, customerName: name, customerPhone: '', service: '', notes: '' })}
          onBlock={() =>
            void onSave({ ...form.seed, customerName: he.blocked, customerPhone: '', service: '', notes: '', isBlocked: true })
          }
          onMore={(name) => {
            setFormError(null);
            setForm({ ...form, mode: 'full', initialName: name });
          }}
          onCancel={() => setForm(null)}
        />
      )}

      {form && shop && form.mode === 'full' && (
        <AppointmentForm
          initialName={form.initialName}
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
          onDelete={form.editing ? () => setConfirmDelete(form.editing) : undefined}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={he.deleteTitle}
          message={he.deleteQuestion(confirmDelete.customerName, fmtTime(utcToLocal(confirmDelete.startsAt, tz).minutes))}
          confirmLabel={he.confirmDelete}
          onConfirm={() => void doDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
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
