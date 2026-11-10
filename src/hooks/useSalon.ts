import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend, ConnectionStatus, DayData, ErrorCode } from '../data/backend';
import { AppError, toAppError } from '../data/backend';
import { applyChange } from '../data/applyChange';
import type { AppointmentInput, Shop, Staff } from '../domain/types';
import { toDayAppointments, validateAppointment } from '../domain/schedule';
import { todayLocal } from '../lib/time';

export interface SalonState {
  shop: Shop | null;
  staff: Staff[];
  date: string;
  day: DayData;
  loading: boolean;
  fatal: ErrorCode | null;
  status: ConnectionStatus;
}

const EMPTY: DayData = { appointments: [], splits: [] };

export function useSalon(backend: Backend, initialDate?: string) {
  const [shop, setShop] = useState<Shop | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [date, setDate] = useState(() => initialDate ?? todayLocal());
  const [day, setDay] = useState<DayData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<ErrorCode | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  const dateRef = useRef(date);
  dateRef.current = date;
  const tz = shop?.timezone ?? 'Asia/Jerusalem';
  const tzRef = useRef(tz);
  tzRef.current = tz;
  const reqId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    backend
      .loadShop()
      .then(({ shop, staff }) => {
        if (cancelled) return;
        setShop(shop);
        setStaff(staff);
      })
      .catch((e) => !cancelled && setFatal(toAppError(e).code));
    return () => {
      cancelled = true;
    };
  }, [backend]);

  const reload = useCallback(async () => {
    if (!shop) return;
    const id = ++reqId.current;
    const target = dateRef.current;
    try {
      const data = await backend.loadDay(shop.id, target);
      if (id === reqId.current) setDay(data);
    } catch (e) {
      if (id === reqId.current && toAppError(e).code === 'FORBIDDEN') setFatal('FORBIDDEN');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [backend, shop]);

  useEffect(() => {
    setLoading(true);
    setDay(EMPTY);
    void reload();
  }, [reload, date]);

  // live updates from every device
  useEffect(() => {
    if (!shop) return;
    let prev: ConnectionStatus = 'connecting';
    const unsub = backend.subscribe(
      shop.id,
      (e) => {
        if (e.table === 'shops') {
          setShop(e.row);
          return;
        }
        setDay((d) => applyChange(d, e, dateRef.current, tzRef.current));
      },
      (s) => {
        // after a reconnect, re-sync anything missed while offline
        if (s === 'live' && prev === 'offline') void reload();
        prev = s;
        setStatus(s);
      },
    );
    return unsub;
  }, [backend, shop?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void reload();
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  const dayAppts = useMemo(() => toDayAppointments(day.appointments, date, tz), [day.appointments, date, tz]);

  /** Runs a write; on conflict re-syncs from the server so the screen shows the truth. */
  const guarded = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        const err = toAppError(e);
        if (err.code !== 'NAME_REQUIRED' && err.code !== 'BAD_DURATION') void reload();
        throw err;
      }
    },
    [reload],
  );

  const saveAppointment = useCallback(
    (input: AppointmentInput, id?: string) =>
      guarded(async () => {
        if (!shop) throw new AppError('UNKNOWN');
        // fast local check against what this device already knows
        if (input.date === dateRef.current) {
          const err = validateAppointment(dayAppts, input, id);
          if (err) throw new AppError(err);
        }
        const appt = id ? await backend.updateAppointment(shop, id, input) : await backend.createAppointment(shop, input);
        if (input.date !== dateRef.current) setDate(input.date);
        else setDay((d) => applyChange(d, { table: 'appointments', type: 'upsert', row: appt }, input.date, tz));
        return appt;
      }),
    [backend, shop, dayAppts, guarded, tz],
  );

  const deleteAppointment = useCallback(
    (id: string) =>
      guarded(async () => {
        await backend.deleteAppointment(id);
        setDay((d) => applyChange(d, { table: 'appointments', type: 'delete', id }, dateRef.current, tz));
      }),
    [backend, guarded, tz],
  );

  const setSplit = useCallback(
    (staffId: string, blockStart: number, isSplit: boolean) =>
      guarded(async () => {
        if (!shop) throw new AppError('UNKNOWN');
        const row = await backend.setSplit(shop, staffId, dateRef.current, blockStart, isSplit);
        setDay((d) => applyChange(d, { table: 'slot_splits', type: 'upsert', row }, dateRef.current, tz));
      }),
    [backend, shop, guarded, tz],
  );

  const updateHours = useCallback(
    async (dayStart: number, dayEnd: number) => {
      if (!shop) return;
      setShop(await backend.updateShopHours(shop.id, dayStart, dayEnd));
    },
    [backend, shop],
  );

  return {
    shop,
    staff,
    date,
    setDate,
    day,
    dayAppts,
    loading,
    fatal,
    status,
    reload,
    saveAppointment,
    deleteAppointment,
    setSplit,
    updateHours,
  };
}

export type Salon = ReturnType<typeof useSalon>;
