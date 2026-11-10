import type { Appointment, SlotSplit, Staff } from '../domain/types';
import { localToIso } from '../lib/time';

export const D = '2026-11-10';
export const ROTEM: Staff = { id: 'rotem', name: 'רותם', displayOrder: 1 };
export const SIVAN: Staff = { id: 'sivan', name: 'סיון', displayOrder: 2 };
let n = 0;
export function appt(staff: Staff, start: string, duration: number, name = 'לקוח', date = D): Appointment {
  const [h, m] = start.split(':').map(Number);
  const s = h * 60 + m;
  return {
    id: `a${++n}`,
    shopId: 'shop',
    staffId: staff.id,
    customerName: name,
    customerPhone: null,
    service: null,
    notes: null,
    startsAt: localToIso(date, s),
    endsAt: localToIso(date, s + duration),
  };
}
export const split = (staff: Staff, block: string, isSplit = true, date = D): SlotSplit => {
  const [h, m] = block.split(':').map(Number);
  return { shopId: 'shop', staffId: staff.id, date, blockStart: h * 60 + m, isSplit };
};
