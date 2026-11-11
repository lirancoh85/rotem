import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Backend, DayData } from '../data/backend';
import type { Shop, Staff, WaitlistRequest } from '../domain/types';
import { matchesForRequest, type SlotMatch } from '../domain/waitlist';
import { addDays, nowMinutesLocal, todayLocal } from '../lib/time';

const HORIZON_DAYS = 60;

/**
 * Active waiting-list requests and the free slots that currently match them.
 * Re-checked whenever appointments change (cancellations free slots) or the list changes.
 */
export function useWaitlist(backend: Backend, shop: Shop | null, staff: Staff[], appointmentsKey: number, waitlistKey: number) {
  const [requests, setRequests] = useState<WaitlistRequest[] | null>(null);
  const [range, setRange] = useState<DayData | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!shop) return;
    let alive = true;
    backend
      .listWaitlist(shop.id)
      .then((r) => alive && setRequests(r))
      .catch(() => alive && setRequests((prev) => prev ?? []));
    return () => {
      alive = false;
    };
  }, [backend, shop, waitlistKey, tick]);

  const today = todayLocal(shop?.timezone);
  const window = useMemo(() => {
    const dates = (requests ?? []).flatMap((r) => r.preferredDates).filter((d) => d >= today && d <= addDays(today, HORIZON_DAYS));
    if (!dates.length) return null;
    dates.sort();
    return { from: dates[0], to: addDays(dates[dates.length - 1], 1) };
  }, [requests, today]);

  useEffect(() => {
    if (!shop || !window) {
      setRange(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      backend
        .loadRange(shop.id, window.from, window.to)
        .then((d) => alive && setRange(d))
        .catch(() => {});
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [backend, shop, window?.from, window?.to, appointmentsKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => {
    const m = new Map<string, SlotMatch[]>();
    if (!shop || !requests) return m;
    const ctx = {
      appointments: range?.appointments ?? [],
      splits: range?.splits ?? [],
      staff,
      shop,
      today,
      nowMinutes: nowMinutesLocal(shop.timezone),
    };
    for (const r of requests) m.set(r.id, range ? matchesForRequest(r, ctx) : []);
    return m;
  }, [requests, range, shop, staff, today]);

  const matchCount = useMemo(() => [...matches.values()].filter((x) => x.length > 0).length, [matches]);
  return { requests, matches, matchCount, reload };
}
