/**
 * Demo backend: same rules as the database, stored in the browser and synced
 * live between tabs/windows. Used for the preview and when Supabase is not configured.
 */
import type { Backend, ChangeEvent, ConnectionStatus, DayData } from './backend';
import { AppError } from './backend';
import type {
  Appointment,
  AppointmentInput,
  AppointmentStatus,
  Customer,
  CustomerProfile,
  CustomerSummary,
  CustomerUpdate,
  OfferStatus,
  SeriesChange,
  SeriesRequest,
  Shop,
  SlotSplit,
  Staff,
  WaitlistInput,
  WaitlistOffer,
  WaitlistRequest,
  WaitlistStatus,
} from '../domain/types';
import { computeStats } from '../domain/profile';
import {
  filterAppointments,
  firstVisitIdsOn,
  linkCustomer,
  matchCustomers,
  nameKey,
  normalizePhone,
  type StoredCustomer,
} from '../domain/customers';
import {
  blocksRequiringSplit,
  canMergeBlock,
  findOverlap,
  canSplitBlock,
  toDayAppointments,
  validateAppointment,
} from '../domain/schedule';
import { addDays, fmtTime, localToIso, todayLocal, utcToLocal } from '../lib/time';

export interface DemoData {
  shop: Shop;
  staff: Staff[];
  appointments: Appointment[];
  splits: SlotSplit[];
  customers?: StoredCustomer[];
  series?: { id: string; requestKey: string; status: 'active' | 'cancelled' }[];
  waitlist?: WaitlistRequest[];
}

export interface DemoStore {
  read(): DemoData | null;
  write(d: DemoData): void;
}

export const DEMO_SHOP: Shop = {
  id: '5a10a000-0000-4000-8000-000000000001',
  name: 'רותם עדני',
  timezone: 'Asia/Jerusalem',
  dayStart: 8 * 60,
  dayEnd: 20 * 60,
  closedWeekdays: [6],
};
export const DEMO_STAFF: Staff[] = [
  { id: '5a10a000-0000-4000-8000-0000000000a1', name: 'רותם', displayOrder: 1 },
  { id: '5a10a000-0000-4000-8000-0000000000a2', name: 'סיוון', displayOrder: 2 },
];

export function memoryStore(initial: DemoData | null = null): DemoStore {
  let d = initial ? structuredClone(initial) : null;
  return { read: () => (d ? structuredClone(d) : null), write: (n) => void (d = structuredClone(n)) };
}

export function localStorageStore(key = 'rotem-demo-v1'): DemoStore {
  const fallback = memoryStore();
  return {
    read() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as DemoData) : fallback.read();
      } catch {
        return fallback.read();
      }
    },
    write(d) {
      fallback.write(d);
      try {
        localStorage.setItem(key, JSON.stringify(d));
      } catch {
        /* storage unavailable (private mode / preview) — keep in memory */
      }
    },
  };
}

let idCounter = 0;
const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `demo-${Date.now()}-${++idCounter}`;

export function seedDemoData(date = todayLocal()): DemoData {
  const [rotem, sivan] = DEMO_STAFF;
  const mk = (staff: Staff, hhmm: string, dur: number, name: string, service: string | null = null, day = date): Appointment => {
    const [h, m] = hhmm.split(':').map(Number);
    const start = h * 60 + m;
    return {
      id: newId(),
      shopId: DEMO_SHOP.id,
      staffId: staff.id,
      customerName: name,
      customerPhone: null,
      service,
      notes: null,
      startsAt: localToIso(day, start),
      endsAt: localToIso(day, start + dur),
      updatedAt: new Date(0).toISOString(),
    };
  };
  const appointments = [
    mk(rotem, '08:00', 30, 'דניאל', 'תספורת'),
    mk(sivan, '08:30', 30, 'יוסי', 'תספורת'),
    mk(rotem, '09:00', 15, 'דניאל', 'זקן'),
    mk(rotem, '09:15', 15, 'אבי', 'זקן'),
    mk(sivan, '09:00', 30, 'משה', 'תספורת'),
    mk(rotem, '10:00', 30, 'שרון', 'פן'),
    mk(sivan, '10:30', 30, 'רוני', 'תספורת'),
    mk(rotem, '11:00', 60, 'גלעד', 'צבע'),
    mk(sivan, '12:00', 45, 'נועה', 'תספורת + פן'),
    mk(rotem, '17:00', 30, 'דניאל', 'תספורת', addDays(date, -7)),
    mk(sivan, '10:00', 30, 'נועה', 'צבע', addDays(date, 7)),
  ];
  const phones: Record<string, string> = { דניאל: '050-1234567', נועה: '054-7654321', משה: '052-5550000' };
  let customers: StoredCustomer[] = [];
  for (const a of appointments) {
    a.customerPhone = phones[a.customerName] ?? null;
    const linked = linkCustomer(customers, { customerName: a.customerName, customerPhone: a.customerPhone ?? '' }, newId);
    customers = linked.customers;
    a.customerId = linked.id;
  }
  return {
    shop: DEMO_SHOP,
    staff: DEMO_STAFF,
    customers,
    appointments,
    splits: [
      { shopId: DEMO_SHOP.id, staffId: rotem.id, date, blockStart: 9 * 60, isSplit: true },
      { shopId: DEMO_SHOP.id, staffId: sivan.id, date, blockStart: 13 * 60, isSplit: true },
    ],
  };
}

type Bus = { post(e: ChangeEvent): void; listen(fn: (e: ChangeEvent) => void): () => void };

const localBuses = new Map<string, Set<(e: ChangeEvent) => void>>();

/** Cross-tab bus (BroadcastChannel) with an in-process fallback. */
function createBus(name: string): Bus {
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(name);
    const listeners = new Set<(e: ChangeEvent) => void>();
    ch.onmessage = (m) => listeners.forEach((l) => l(m.data as ChangeEvent));
    return {
      post: (e) => ch.postMessage(e),
      listen(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }
  const set = localBuses.get(name) ?? new Set();
  localBuses.set(name, set);
  let self: ((e: ChangeEvent) => void) | null = null;
  return {
    post: (e) => set.forEach((l) => l !== self && l(e)),
    listen(fn) {
      self = fn;
      set.add(fn);
      return () => set.delete(fn);
    },
  };
}

export class DemoBackend implements Backend {
  readonly mode = 'demo' as const;
  private bus: Bus;
  private local = new Set<(e: ChangeEvent) => void>();
  /** artificial latency so the UI behaves like a networked app */
  constructor(
    private store: DemoStore = localStorageStore(),
    channelName = 'rotem-demo-sync',
    private latencyMs = 0,
  ) {
    this.bus = createBus(channelName);
    if (!this.store.read()) this.store.write(seedDemoData());
  }

  private data(): DemoData {
    return this.store.read() ?? seedDemoData();
  }
  private delay() {
    return this.latencyMs ? new Promise((r) => setTimeout(r, this.latencyMs)) : Promise.resolve();
  }
  private emit(e: ChangeEvent) {
    this.local.forEach((l) => l(e));
    this.bus.post(e);
  }

  async loadShop() {
    await this.delay();
    const d = this.data();
    return {
      shop: { ...d.shop, closedWeekdays: d.shop.closedWeekdays ?? [6] },
      staff: [...d.staff].sort((a, b) => a.displayOrder - b.displayOrder),
    };
  }

  async loadDay(_shopId: string, date: string): Promise<DayData> {
    await this.delay();
    const d = this.data();
    return {
      appointments: d.appointments.filter((a) => a.status !== 'cancelled' && utcToLocal(a.startsAt, d.shop.timezone).date === date),
      splits: d.splits.filter((s) => s.date === date),
    };
  }

  private writeAppointment(shop: Shop, input: AppointmentInput, id?: string, extra: Partial<Appointment> = {}): Appointment {
    const d = this.data();
    const dayAppts = toDayAppointments(d.appointments, input.date, shop.timezone);
    const err = validateAppointment(dayAppts, input, id);
    if (err) throw new AppError(err);
    const existing = id ? d.appointments.find((a) => a.id === id) : undefined;
    if (id && !existing) throw new AppError('NOT_FOUND');
    let customerId: string | null = null;
    if (!input.isBlocked) {
      const linked = linkCustomer(d.customers ?? [], input, newId);
      d.customers = linked.customers;
      customerId = linked.id;
    }
    const appt: Appointment = {
      id: id ?? newId(),
      shopId: shop.id,
      staffId: input.staffId,
      customerName: input.customerName.trim(),
      customerPhone: input.customerPhone.trim() || null,
      service: input.service.trim() || null,
      notes: input.notes.trim() || null,
      startsAt: localToIso(input.date, input.start, shop.timezone),
      endsAt: localToIso(input.date, input.start + input.duration, shop.timezone),
      isBlocked: Boolean(input.isBlocked),
      customerId,
      status: existing?.status ?? 'booked',
      seriesId: existing?.seriesId ?? null,
      seriesIndex: existing?.seriesIndex ?? null,
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    d.appointments = [...d.appointments.filter((a) => a.id !== appt.id), appt];
    // same as the DB trigger: boundaries at :15/:45 mark their block as split
    const changedSplits: SlotSplit[] = [];
    for (const blockStart of blocksRequiringSplit(input.start, input.start + input.duration)) {
      const cur = d.splits.find((s) => s.staffId === input.staffId && s.date === input.date && s.blockStart === blockStart);
      if (!cur?.isSplit) {
        const s: SlotSplit = { shopId: shop.id, staffId: input.staffId, date: input.date, blockStart, isSplit: true };
        d.splits = [...d.splits.filter((x) => x !== cur), s];
        changedSplits.push(s);
      }
    }
    this.store.write(d);
    changedSplits.forEach((row) => this.emit({ table: 'slot_splits', type: 'upsert', row }));
    this.emit({ table: 'appointments', type: 'upsert', row: appt });
    return appt;
  }

  async createAppointment(shop: Shop, input: AppointmentInput) {
    await this.delay();
    return this.writeAppointment(shop, input);
  }

  async updateAppointment(shop: Shop, id: string, input: AppointmentInput) {
    await this.delay();
    return this.writeAppointment(shop, input, id);
  }

  async deleteAppointment(id: string) {
    await this.delay();
    const d = this.data();
    d.appointments = d.appointments.filter((a) => a.id !== id);
    this.store.write(d);
    this.emit({ table: 'appointments', type: 'delete', id });
  }

  async setSplit(shop: Shop, staffId: string, date: string, blockStart: number, isSplit: boolean) {
    await this.delay();
    const d = this.data();
    const dayAppts = toDayAppointments(d.appointments, date, shop.timezone);
    const cur = d.splits.find((s) => s.staffId === staffId && s.date === date && s.blockStart === blockStart);
    const was = cur?.isSplit ?? false;
    if (isSplit && !was && !canSplitBlock(dayAppts, staffId, blockStart)) throw new AppError('BLOCK_OCCUPIED');
    if (!isSplit && was && !canMergeBlock(dayAppts, staffId, blockStart)) {
      throw new AppError('BLOCK_HAS_SPLIT_APPOINTMENTS');
    }
    const row: SlotSplit = { shopId: shop.id, staffId, date, blockStart, isSplit };
    d.splits = [...d.splits.filter((s) => s !== cur), row];
    this.store.write(d);
    this.emit({ table: 'slot_splits', type: 'upsert', row });
    return row;
  }

  async loadRange(_shopId: string, fromDate: string, toDate: string): Promise<DayData> {
    await this.delay();
    const d = this.data();
    return {
      appointments: d.appointments.filter((a) => {
        if (a.status === 'cancelled') return false;
        const day = utcToLocal(a.startsAt, d.shop.timezone).date;
        return day >= fromDate && day < toDate;
      }).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      splits: d.splits.filter((s) => s.date >= fromDate && s.date < toDate),
    };
  }

  async createSeries(shop: Shop, req: SeriesRequest) {
    await this.delay();
    const d = this.data();
    const existing = (d.series ?? []).find((s) => s.requestKey === req.requestKey);
    if (existing) return existing.id; // same request again: nothing new
    if (!req.occurrences.length) throw new AppError('UNKNOWN', 'NO_OCCURRENCES');
    // validate every occurrence first — all or nothing, never overwrite
    const planned: Appointment[] = [];
    for (const o of req.occurrences) {
      const day = toDayAppointments([...d.appointments, ...planned], o.date, shop.timezone);
      if (findOverlap(day, o.staffId, o.start, o.start + req.duration)) throw new AppError('SERIES_CONFLICT', `${o.date} ${fmtTime(o.start)}`);
      planned.push({
        id: `plan-${o.index}`,
        shopId: shop.id,
        staffId: o.staffId,
        customerName: req.customerName,
        customerPhone: null,
        service: null,
        notes: null,
        startsAt: localToIso(o.date, o.start, shop.timezone),
        endsAt: localToIso(o.date, o.start + req.duration, shop.timezone),
      });
    }
    const id = newId();
    d.series = [...(d.series ?? []), { id, requestKey: req.requestKey, status: 'active' }];
    this.store.write(d);
    let customerId = req.customerId;
    for (const o of req.occurrences) {
      const a = this.writeAppointment(
        shop,
        {
          staffId: o.staffId,
          date: o.date,
          start: o.start,
          duration: req.duration,
          customerName: req.customerName,
          customerPhone: req.customerPhone,
          customerId,
          service: req.service,
          notes: req.notes,
        },
        undefined,
        { seriesId: id, seriesIndex: o.index },
      );
      customerId = a.customerId ?? customerId;
    }
    return id;
  }

  async cancelSeries(apptId: string, scope: 'future' | 'all') {
    await this.delay();
    const d = this.data();
    const a = d.appointments.find((x) => x.id === apptId);
    if (!a?.seriesId) throw new AppError('NOT_FOUND');
    const from = scope === 'future' ? a.startsAt : [a.startsAt, new Date().toISOString()].sort()[0];
    const changed: Appointment[] = [];
    d.appointments = d.appointments.map((x) => {
      if (x.seriesId !== a.seriesId || (x.status ?? 'booked') !== 'booked' || x.startsAt < from) return x;
      const row = { ...x, status: 'cancelled' as const, updatedAt: new Date().toISOString() };
      changed.push(row);
      return row;
    });
    if (scope === 'all') d.series = (d.series ?? []).map((s) => (s.id === a.seriesId ? { ...s, status: 'cancelled' as const } : s));
    this.store.write(d);
    changed.forEach((row) => this.emit({ table: 'appointments', type: 'upsert', row }));
    return changed.length;
  }

  async updateSeriesFuture(apptId: string, c: SeriesChange) {
    await this.delay();
    const d = this.data();
    const a = d.appointments.find((x) => x.id === apptId);
    if (!a?.seriesId) throw new AppError('NOT_FOUND');
    const tz = d.shop.timezone;
    const targets = d.appointments
      .filter((x) => x.seriesId === a.seriesId && (x.status ?? 'booked') === 'booked' && x.startsAt >= a.startsAt)
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    const ids = new Set(targets.map((x) => x.id));
    const others = d.appointments.filter((x) => !ids.has(x.id));
    const moved = targets.map((x) => {
      const day = utcToLocal(x.startsAt, tz).date;
      return { ...x, staffId: c.staffId, startsAt: localToIso(day, c.start, tz), endsAt: localToIso(day, c.start + c.duration, tz), _day: day };
    });
    for (const m of moved) {
      const dayAppts = toDayAppointments([...others, ...moved.filter((x) => x.id !== m.id)], m._day, tz);
      if (findOverlap(dayAppts, c.staffId, c.start, c.start + c.duration, m.id)) throw new AppError('SERIES_CONFLICT', `${m._day} ${fmtTime(c.start)}`);
    }
    for (const m of moved) {
      this.writeAppointment(
        d.shop,
        { staffId: c.staffId, date: m._day, start: c.start, duration: c.duration, customerName: m.customerName, customerPhone: m.customerPhone ?? '', customerId: m.customerId, service: c.service, notes: c.notes },
        m.id,
      );
    }
    return moved.length;
  }

  async updateClosedWeekdays(_shopId: string, days: number[]) {
    await this.delay();
    const d = this.data();
    d.shop = { ...d.shop, closedWeekdays: [...days].sort() };
    this.store.write(d);
    this.emit({ table: 'shops', type: 'upsert', row: d.shop });
    return d.shop;
  }

  async updateShopHours(_shopId: string, dayStart: number, dayEnd: number) {
    await this.delay();
    const d = this.data();
    d.shop = { ...d.shop, dayStart, dayEnd };
    this.store.write(d);
    this.emit({ table: 'shops', type: 'upsert', row: d.shop });
    return d.shop;
  }

  async searchCustomers(_shopId: string, query: string): Promise<Customer[]> {
    await this.delay();
    const d = this.data();
    return matchCustomers(d.customers ?? [], query, d.appointments);
  }

  async searchAppointments(_shopId: string, query: string, date: string | null): Promise<Appointment[]> {
    await this.delay();
    const d = this.data();
    return filterAppointments(d.appointments, query, date, d.shop.timezone);
  }

  async setAppointmentStatus(id: string, status: AppointmentStatus) {
    await this.delay();
    const d = this.data();
    const a = d.appointments.find((x) => x.id === id);
    if (!a) throw new AppError('NOT_FOUND');
    if (status !== 'cancelled' && a.status === 'cancelled') {
      // restoring must not overwrite whatever took the slot meanwhile
      const s = utcToLocal(a.startsAt, d.shop.timezone);
      const e = utcToLocal(a.endsAt, d.shop.timezone);
      const day = toDayAppointments(d.appointments, s.date, d.shop.timezone);
      if (findOverlap(day, a.staffId, s.minutes, e.minutes, a.id)) throw new AppError('OVERLAP');
    }
    const row: Appointment = { ...a, status, updatedAt: new Date().toISOString() };
    d.appointments = d.appointments.map((x) => (x.id === id ? row : x));
    this.store.write(d);
    this.emit({ table: 'appointments', type: 'upsert', row });
    return row;
  }

  async listCustomers(_shopId: string, query: string): Promise<CustomerSummary[]> {
    await this.delay();
    const d = this.data();
    const k = nameKey(query);
    const digits = normalizePhone(query);
    return (d.customers ?? [])
      .filter((c) => !k || nameKey(c.name).includes(k) || (!!digits && digits.length >= 3 && (normalizePhone(c.phone) ?? '').includes(digits)))
      .map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        notes: c.notes ?? null,
        preferences: c.preferences ?? null,
        ...computeStats(d.appointments.filter((a) => a.customerId === c.id)),
      }))
      .sort((a, b) => (b.nextVisit ?? b.lastVisit ?? '').localeCompare(a.nextVisit ?? a.lastVisit ?? '') || a.name.localeCompare(b.name));
  }

  async getCustomerProfile(customerId: string): Promise<CustomerProfile | null> {
    await this.delay();
    const d = this.data();
    const c = (d.customers ?? []).find((x) => x.id === customerId);
    if (!c) return null;
    const appts = d.appointments.filter((a) => a.customerId === c.id && !a.isBlocked).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return {
      customer: { id: c.id, name: c.name, phone: c.phone, notes: c.notes ?? null, preferences: c.preferences ?? null },
      stats: computeStats(appts),
      appointments: appts,
    };
  }

  async updateCustomer(customerId: string, u: CustomerUpdate) {
    await this.delay();
    const d = this.data();
    const name = u.name.trim();
    if (!name) throw new AppError('NAME_REQUIRED');
    const phone = u.phone.trim() || null;
    const digits = normalizePhone(phone);
    const customers = d.customers ?? [];
    if (digits && customers.some((c) => c.id !== customerId && normalizePhone(c.phone) === digits)) throw new AppError('DUPLICATE_PHONE');
    const c = customers.find((x) => x.id === customerId);
    if (!c) throw new AppError('NOT_FOUND');
    Object.assign(c, { name, phone, notes: u.notes.trim() || null, preferences: u.preferences.trim() || null, updatedAt: new Date().toISOString() });
    const changed: Appointment[] = [];
    d.appointments = d.appointments.map((a) => {
      if (a.customerId !== customerId || (a.customerName === name && a.customerPhone === phone)) return a;
      const row = { ...a, customerName: name, customerPhone: phone, updatedAt: new Date().toISOString() };
      changed.push(row);
      return row;
    });
    this.store.write(d);
    changed.forEach((row) => this.emit({ table: 'appointments', type: 'upsert', row }));
  }

  private saveWaitlist(d: DemoData) {
    this.store.write(d);
    this.emit({ table: 'waitlist', type: 'changed' });
  }

  async listWaitlist(): Promise<WaitlistRequest[]> {
    await this.delay();
    return (this.data().waitlist ?? []).filter((w) => w.status === 'waiting');
  }

  async saveWaitlistRequest(_shop: Shop, w: WaitlistInput, id?: string) {
    await this.delay();
    if (!w.customerName.trim()) throw new AppError('NAME_REQUIRED');
    const d = this.data();
    const list = d.waitlist ?? [];
    const digits = normalizePhone(w.customerPhone);
    const linked =
      w.customerId ??
      (d.customers ?? []).find((c) => (digits ? normalizePhone(c.phone) === digits : nameKey(c.name) === nameKey(w.customerName)))?.id ??
      null;
    const base = {
      customerId: linked,
      customerName: w.customerName.trim(),
      customerPhone: w.customerPhone.trim() || null,
      service: w.service.trim() || null,
      duration: w.duration,
      staffId: w.staffId,
      preferredDates: [...new Set(w.preferredDates)].sort(),
      timeFrom: w.timeFrom,
      timeTo: w.timeTo,
      notes: w.notes.trim() || null,
    };
    d.waitlist = id
      ? list.map((r) => (r.id === id ? { ...r, ...base } : r))
      : [...list, { id: newId(), ...base, status: 'waiting', createdAt: new Date().toISOString(), offers: [] }];
    this.saveWaitlist(d);
  }

  async setWaitlistStatus(id: string, status: WaitlistStatus) {
    await this.delay();
    const d = this.data();
    d.waitlist = (d.waitlist ?? []).map((r) => (r.id === id ? { ...r, status } : r));
    this.saveWaitlist(d);
  }

  async createOffer(shop: Shop, requestId: string, slot: { date: string; start: number; staffId: string; duration: number }) {
    await this.delay();
    const d = this.data();
    const offer: WaitlistOffer = {
      id: newId(),
      requestId,
      staffId: slot.staffId,
      startsAt: localToIso(slot.date, slot.start, shop.timezone),
      endsAt: localToIso(slot.date, slot.start + slot.duration, shop.timezone),
      status: 'sent',
      appointmentId: null,
      createdAt: new Date().toISOString(),
    };
    d.waitlist = (d.waitlist ?? []).map((r) => (r.id === requestId ? { ...r, offers: [...r.offers, offer] } : r));
    this.saveWaitlist(d);
    return offer;
  }

  async setOfferStatus(offerId: string, status: Exclude<OfferStatus, 'accepted'>) {
    await this.delay();
    const d = this.data();
    d.waitlist = (d.waitlist ?? []).map((r) => ({ ...r, offers: r.offers.map((o) => (o.id === offerId ? { ...o, status } : o)) }));
    this.saveWaitlist(d);
  }

  async acceptOffer(offerId: string) {
    await this.delay();
    const d = this.data();
    const req = (d.waitlist ?? []).find((r) => r.offers.some((o) => o.id === offerId));
    const offer = req?.offers.find((o) => o.id === offerId);
    if (!req || !offer) throw new AppError('NOT_FOUND');
    if (offer.status === 'accepted') return { ok: true, appointmentId: offer.appointmentId, reason: null };
    if (offer.status !== 'sent') return { ok: false, appointmentId: null, reason: 'OFFER_CLOSED' };
    const tz = d.shop.timezone;
    const s = utcToLocal(offer.startsAt, tz);
    const e = utcToLocal(offer.endsAt, tz);
    const setOffers = (fn: (o: WaitlistOffer) => WaitlistOffer, reqStatus?: WaitlistStatus) => {
      const fresh = this.data();
      fresh.waitlist = (fresh.waitlist ?? []).map((r) => (r.id === req.id ? { ...r, status: reqStatus ?? r.status, offers: r.offers.map(fn) } : r));
      this.saveWaitlist(fresh);
    };
    if (findOverlap(toDayAppointments(d.appointments, s.date, tz), offer.staffId, s.minutes, e.minutes)) {
      setOffers((o) => (o.id === offerId ? { ...o, status: 'expired' } : o));
      return { ok: false, appointmentId: null, reason: 'SLOT_TAKEN' };
    }
    const appt = this.writeAppointment(d.shop, {
      staffId: offer.staffId,
      date: s.date,
      start: s.minutes,
      duration: e.minutes - s.minutes,
      customerName: req.customerName,
      customerPhone: req.customerPhone ?? '',
      customerId: req.customerId,
      service: req.service ?? '',
      notes: req.notes ?? '',
    });
    setOffers((o) => (o.id === offerId ? { ...o, status: 'accepted', appointmentId: appt.id } : o.status === 'sent' ? { ...o, status: 'expired' } : o), 'booked');
    return { ok: true, appointmentId: appt.id, reason: null };
  }

  async firstVisitIds(_shopId: string, date: string): Promise<string[]> {
    await this.delay();
    const d = this.data();
    return firstVisitIdsOn(d.appointments, date, d.shop.timezone);
  }

  subscribe(_shopId: string, onChange: (e: ChangeEvent) => void, onStatus: (s: ConnectionStatus) => void) {
    this.local.add(onChange);
    const off = this.bus.listen(onChange);
    queueMicrotask(() => onStatus('live'));
    return () => {
      this.local.delete(onChange);
      off();
    };
  }

  async signOut() {
    this.store.write(seedDemoData());
  }
}
