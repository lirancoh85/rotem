import { BLOCK, QUARTER, type Appointment, type SlotSplit } from './types';
import { SALON_TZ, utcToLocal } from '../lib/time';

/** An appointment projected onto one salon-local day, in minutes since midnight. */
export interface DayAppointment {
  appt: Appointment;
  staffId: string;
  start: number;
  end: number;
}

export type Cell =
  | {
      kind: 'appointment';
      staffId: string;
      start: number;
      end: number;
      appt: Appointment;
      /** block the appointment starts in is split (render as 15-min style) */
      inSplitBlock: boolean;
    }
  | {
      kind: 'free';
      staffId: string;
      start: number;
      end: number;
      blockStart: number;
      /** true => this is one 15-minute half of a split block */
      split: boolean;
      /** controls shown on this cell */
      canSplit: boolean;
      canMerge: boolean;
    };

export function toDayAppointments(appts: Appointment[], date: string, tz = SALON_TZ): DayAppointment[] {
  const out: DayAppointment[] = [];
  for (const a of appts) {
    const s = utcToLocal(a.startsAt, tz);
    const e = utcToLocal(a.endsAt, tz);
    if (s.date !== date) continue;
    const end = e.date === date ? e.minutes : 24 * 60;
    out.push({ appt: a, staffId: a.staffId, start: s.minutes, end });
  }
  return out.sort((x, y) => x.start - y.start);
}

export const blockOf = (minutes: number) => Math.floor(minutes / BLOCK) * BLOCK;

export function isBlockSplit(splits: SlotSplit[], staffId: string, date: string, blockStart: number) {
  return splits.some((s) => s.staffId === staffId && s.date === date && s.blockStart === blockStart && s.isSplit);
}

/** Can a 30-minute block be split? Not if an appointment runs across its midpoint. */
export function canSplitBlock(dayAppts: DayAppointment[], staffId: string, blockStart: number) {
  const mid = blockStart + QUARTER;
  return !dayAppts.some((a) => a.staffId === staffId && a.start < mid && a.end > mid);
}

/** Can a split block return to 30 minutes? Only when no appointment starts/ends at its midpoint. */
export function canMergeBlock(dayAppts: DayAppointment[], staffId: string, blockStart: number) {
  const mid = blockStart + QUARTER;
  return !dayAppts.some((a) => a.staffId === staffId && (a.start === mid || a.end === mid));
}

/** Blocks that must become split for an appointment [start, end) (boundaries on :15/:45). */
export function blocksRequiringSplit(start: number, end: number): number[] {
  const out: number[] = [];
  for (const b of [start, end]) if (b % BLOCK === QUARTER) out.push(b - QUARTER);
  return [...new Set(out)];
}

export function findOverlap(
  dayAppts: DayAppointment[],
  staffId: string,
  start: number,
  end: number,
  ignoreId?: string,
): DayAppointment | undefined {
  return dayAppts.find((a) => a.staffId === staffId && a.appt.id !== ignoreId && a.start < end && a.end > start);
}

export type ValidationError = 'OVERLAP' | 'OFF_GRID' | 'DAY_BOUNDARY' | 'NAME_REQUIRED' | 'BAD_DURATION';

export function validateAppointment(
  dayAppts: DayAppointment[],
  input: { staffId: string; start: number; duration: number; customerName: string },
  ignoreId?: string,
): ValidationError | null {
  if (!input.customerName.trim()) return 'NAME_REQUIRED';
  if (input.duration <= 0 || input.duration > 240 || input.duration % QUARTER) return 'BAD_DURATION';
  if (input.start % QUARTER) return 'OFF_GRID';
  const end = input.start + input.duration;
  if (end > 24 * 60) return 'DAY_BOUNDARY';
  if (findOverlap(dayAppts, input.staffId, input.start, end, ignoreId)) return 'OVERLAP';
  return null;
}

/**
 * Builds the visible cells of one staff column between dayStart and dayEnd.
 * Unsplit free blocks are one 30-minute cell; split blocks are two 15-minute cells;
 * appointments are one cell spanning their full length (15/30/45/60...).
 */
export function buildColumn(opts: {
  staffId: string;
  date: string;
  dayStart: number;
  dayEnd: number;
  dayAppts: DayAppointment[];
  splits: SlotSplit[];
}): Cell[] {
  const { staffId, date, dayAppts, splits } = opts;
  const mine = dayAppts.filter((a) => a.staffId === staffId).sort((a, b) => a.start - b.start);
  // extend the visible range so appointments outside opening hours are never hidden
  const dayStart = Math.min(opts.dayStart, ...mine.map((a) => blockOf(a.start)));
  const dayEnd = Math.max(opts.dayEnd, ...mine.map((a) => Math.ceil(a.end / BLOCK) * BLOCK));

  const cells: Cell[] = [];
  let m = dayStart;
  let i = 0;
  while (m < dayEnd) {
    while (i < mine.length && mine[i].end <= m) i++;
    const cur = mine[i];
    if (cur && cur.start <= m) {
      const end = Math.min(cur.end, dayEnd);
      cells.push({
        kind: 'appointment',
        staffId,
        start: Math.max(cur.start, dayStart),
        end,
        appt: cur.appt,
        inSplitBlock: isBlockSplit(splits, staffId, date, blockOf(cur.start)),
      });
      m = end;
      i++;
      continue;
    }
    const block = blockOf(m);
    const split = isBlockSplit(splits, staffId, date, block) || m % BLOCK !== 0;
    const nextStart = cur ? cur.start : Infinity;
    if (split) {
      const end = Math.min(m + QUARTER, nextStart, dayEnd);
      const blockFree = !mine.some((a) => a.start < block + BLOCK && a.end > block);
      cells.push({
        kind: 'free',
        staffId,
        start: m,
        end,
        blockStart: block,
        split: true,
        canSplit: false,
        // offer "back to 30" on the first half only, when the whole block is empty
        canMerge: m === block && blockFree && canMergeBlock(dayAppts, staffId, block),
      });
      m = end;
    } else {
      const end = Math.min(block + BLOCK, nextStart, dayEnd);
      cells.push({
        kind: 'free',
        staffId,
        start: m,
        end,
        blockStart: block,
        split: false,
        canSplit: end - m === BLOCK,
        canMerge: false,
      });
      m = end;
    }
  }
  return cells;
}

export function durationOf(a: { startsAt: string; endsAt: string }) {
  return Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000);
}
