import type { ChangeEvent, DayData } from './backend';
import { utcToLocal } from '../lib/time';

/**
 * Applies a realtime change to the currently displayed day.
 * Idempotent: replaying the same event (e.g. our own write echoed back) is harmless.
 */
export function applyChange(state: DayData, e: ChangeEvent, date: string, tz: string): DayData {
  switch (e.table) {
    case 'appointments': {
      const without = state.appointments.filter((a) => a.id !== (e.type === 'upsert' ? e.row.id : e.id));
      if (e.type === 'delete') {
        return without.length === state.appointments.length ? state : { ...state, appointments: without };
      }
      // an edit may move an appointment to another day: then it simply leaves this view
      const onThisDay = utcToLocal(e.row.startsAt, tz).date === date && e.row.status !== 'cancelled';
      const existing = state.appointments.find((a) => a.id === e.row.id);
      if (existing && existing.updatedAt && e.row.updatedAt && existing.updatedAt > e.row.updatedAt) {
        return state; // stale echo, keep the newer version
      }
      return { ...state, appointments: onThisDay ? [...without, e.row] : without };
    }
    case 'slot_splits': {
      const k = e.type === 'upsert' ? e.row : e.key;
      const without = state.splits.filter(
        (s) => !(s.staffId === k.staffId && s.date === k.date && s.blockStart === k.blockStart),
      );
      if (e.type === 'delete') return { ...state, splits: without };
      if (e.row.date !== date) return without.length === state.splits.length ? state : { ...state, splits: without };
      return { ...state, splits: [...without, e.row] };
    }
    default:
      return state;
  }
}
