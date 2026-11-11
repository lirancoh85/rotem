/**
 * Demo backend: same rules as the database, stored in the browser and synced
 * live between tabs/windows. Used for the preview and when Supabase is not configured.
 */
import type { Backend, ChangeEvent, ConnectionStatus, DayData } from './backend';
import { AppError } from './backend';
import type { Appointment, AppointmentInput, Customer, Shop, SlotSplit, Staff } from '../domain/types';
import { filterAppointments, firstVisitIdsOn, linkCustomer, matchCustomers, type StoredCustomer } from '../domain/customers';
import {
  blocksRequiringSplit,
  canMergeBlock,
  canSplitBlock,
  toDayAppointments,
  validateAppointment,
} from '../domain/schedule';
import { addDays, localToIso, todayLocal, utcToLocal } from '../lib/time';

export interface DemoData {
  shop: Shop;
  staff: Staff[];
  appointments: Appointment[];
  splits: SlotSplit[];
  customers?: StoredCustomer[];
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
    return { shop: d.shop, staff: [...d.staff].sort((a, b) => a.displayOrder - b.displayOrder) };
  }

  async loadDay(_shopId: string, date: string): Promise<DayData> {
    await this.delay();
    const d = this.data();
    return {
      appointments: d.appointments.filter((a) => utcToLocal(a.startsAt, d.shop.timezone).date === date),
      splits: d.splits.filter((s) => s.date === date),
    };
  }

  private writeAppointment(shop: Shop, input: AppointmentInput, id?: string): Appointment {
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
