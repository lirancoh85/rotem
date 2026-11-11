import type { Appointment, Customer } from './types';
import { addDays, pad, utcToLocal } from '../lib/time';

/** Same normalization as the database: digits only, +972 → 0. */
export function normalizePhone(p: string | null | undefined): string | null {
  const d = (p ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('972') && d.length >= 11) return `0${d.slice(3)}`;
  return d;
}

export function nameKey(p: string | null | undefined): string {
  return (p ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface StoredCustomer extends Customer {
  updatedAt: string;
  notes?: string | null;
  preferences?: string | null;
}

/**
 * Finds or creates the customer for an appointment (mirror of the DB trigger
 * `appointments_link_customer`). Returns the updated list and the linked id.
 */
export function linkCustomer(
  list: StoredCustomer[],
  input: { customerName: string; customerPhone: string; customerId?: string | null },
  newId: () => string,
  now = new Date().toISOString(),
): { customers: StoredCustomer[]; id: string } {
  const digits = normalizePhone(input.customerPhone);
  const key = nameKey(input.customerName);
  const customers = list.map((c) => ({ ...c }));
  const touch = (c: StoredCustomer) => (c.updatedAt = now);

  if (input.customerId) {
    const c = customers.find((x) => x.id === input.customerId);
    const cd = c ? normalizePhone(c.phone) : null;
    if (c && (!digits || !cd || cd === digits)) {
      if (digits && !cd) {
        const other = customers.find((x) => normalizePhone(x.phone) === digits);
        if (other) return { customers, id: other.id };
        c.phone = input.customerPhone.trim();
      }
      touch(c);
      return { customers, id: c.id };
    }
  }

  let found: StoredCustomer | undefined;
  if (digits) {
    found = customers.find((x) => normalizePhone(x.phone) === digits);
    if (!found) {
      found = customers.find((x) => nameKey(x.name) === key && !normalizePhone(x.phone));
      if (found) found.phone = input.customerPhone.trim();
    }
  } else {
    found = customers
      .filter((x) => nameKey(x.name) === key)
      .sort((a, b) => Number(!normalizePhone(b.phone)) - Number(!normalizePhone(a.phone)) || b.updatedAt.localeCompare(a.updatedAt))[0];
  }
  if (found) {
    touch(found);
    return { customers, id: found.id };
  }
  const created: StoredCustomer = {
    id: newId(),
    name: input.customerName.trim(),
    phone: input.customerPhone.trim() || null,
    updatedAt: now,
  };
  return { customers: [...customers, created], id: created.id };
}

/** Autocomplete match: name fragment, or ≥3 phone digits. Prefix matches first, then most recent. */
export function matchCustomers(list: StoredCustomer[], query: string, appts: Appointment[] = [], limit = 8): Customer[] {
  const k = nameKey(query);
  if (!k) return [];
  const d = normalizePhone(query);
  return list
    .filter((c) => nameKey(c.name).includes(k) || (d && d.length >= 3 && (normalizePhone(c.phone) ?? '').includes(d)))
    .sort(
      (a, b) =>
        Number(nameKey(b.name).startsWith(k)) - Number(nameKey(a.name).startsWith(k)) || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, limit)
    .map((c) => {
      const mine = appts.filter((a) => a.customerId === c.id);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        visits: mine.length,
        lastVisit: mine.map((a) => a.startsAt).sort().at(-1) ?? null,
      };
    });
}

/**
 * Recognizes a date typed into search: 10/11, 10.11, 10/11/26, 10/11/2026, 2026-11-10.
 * Day-month without a year means the current year.
 */
export function parseSearchDate(q: string, today: string): string | null {
  const s = q.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/.exec(s);
  if (!m) return null;
  let y = m[3] ? +m[3] : +today.slice(0, 4);
  if (y < 100) y += 2000;
  return valid(y, +m[2], +m[1]);
}

function valid(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(mo)}-${pad(d)}`;
  return addDays(iso, 0) === iso ? iso : null; // rejects 31/02 etc.
}

/** Demo / offline search with the same semantics as `search_appointments`. */
export function filterAppointments(appts: Appointment[], query: string, date: string | null, tz: string): Appointment[] {
  const k = nameKey(query);
  const d = normalizePhone(query);
  return appts
    .filter((a) => !a.isBlocked && a.status !== 'cancelled')
    .filter((a) =>
      date
        ? utcToLocal(a.startsAt, tz).date === date
        : !!k &&
          (nameKey(a.customerName).includes(k) || (!!d && d.length >= 3 && (normalizePhone(a.customerPhone) ?? '').includes(d))),
    )
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, 60);
}

/**
 * Appointments on `date` that are the customer's first visit — the earliest
 * remaining (non-blocked) appointment of that customer. Mirror of `first_visit_ids`.
 * Ties on start time keep the earlier-created one (array order).
 */
export function firstVisitIdsOn(appts: Appointment[], date: string, tz: string): string[] {
  const firstByCustomer = new Map<string, Appointment>();
  appts.forEach((a) => {
    if (a.isBlocked || !a.customerId || (a.status ?? 'booked') !== 'booked') return;
    const cur = firstByCustomer.get(a.customerId);
    if (!cur || a.startsAt < cur.startsAt) firstByCustomer.set(a.customerId, a);
  });
  return [...firstByCustomer.values()].filter((a) => utcToLocal(a.startsAt, tz).date === date).map((a) => a.id);
}
