import type {
  Appointment,
  AppointmentInput,
  AppointmentStatus,
  Customer,
  CustomerProfile,
  CustomerSummary,
  CustomerUpdate,
  SeriesChange,
  SeriesRequest,
  Shop,
  SlotSplit,
  Staff,
} from '../domain/types';

export type ChangeEvent =
  | { table: 'appointments'; type: 'upsert'; row: Appointment }
  | { table: 'appointments'; type: 'delete'; id: string }
  | { table: 'slot_splits'; type: 'upsert'; row: SlotSplit }
  | { table: 'slot_splits'; type: 'delete'; key: { staffId: string; date: string; blockStart: number } }
  | { table: 'shops'; type: 'upsert'; row: Shop };

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

export interface DayData {
  appointments: Appointment[];
  splits: SlotSplit[];
}

export interface Backend {
  readonly mode: 'supabase' | 'demo';
  loadShop(): Promise<{ shop: Shop; staff: Staff[] }>;
  loadDay(shopId: string, date: string): Promise<DayData>;
  createAppointment(shop: Shop, input: AppointmentInput): Promise<Appointment>;
  updateAppointment(shop: Shop, id: string, input: AppointmentInput): Promise<Appointment>;
  deleteAppointment(id: string): Promise<void>;
  setSplit(shop: Shop, staffId: string, date: string, blockStart: number, isSplit: boolean): Promise<SlotSplit>;
  updateShopHours(shopId: string, dayStart: number, dayEnd: number): Promise<Shop>;
  /** returning-customer autocomplete (name or phone fragment) */
  searchCustomers(shopId: string, query: string): Promise<Customer[]>;
  /** appointments across all dates; by date when `date` is given, else by name/phone */
  searchAppointments(shopId: string, query: string, date: string | null): Promise<Appointment[]>;
  /** cancel (kept in history), mark a no-show, or restore to booked */
  setAppointmentStatus(id: string, status: AppointmentStatus): Promise<Appointment>;
  /** customers with visit statistics, filtered by name/phone fragment */
  listCustomers(shopId: string, query: string): Promise<CustomerSummary[]>;
  getCustomerProfile(customerId: string): Promise<CustomerProfile | null>;
  updateCustomer(customerId: string, update: CustomerUpdate): Promise<void>;
  /** appointments (not cancelled) and splits for [fromDate, toDate) */
  loadRange(shopId: string, fromDate: string, toDate: string): Promise<DayData>;
  /** creates all occurrences atomically; returns the series id (same id for a repeated request) */
  createSeries(shop: Shop, req: SeriesRequest): Promise<string>;
  /** 'future' = this and following, 'all' = every occurrence not yet started */
  cancelSeries(apptId: string, scope: 'future' | 'all'): Promise<number>;
  /** apply staff/time/length/service/notes to this occurrence and all following */
  updateSeriesFuture(apptId: string, change: SeriesChange): Promise<number>;
  updateClosedWeekdays(shopId: string, days: number[]): Promise<Shop>;
  /** ids of appointments on `date` that are the customer's first visit */
  firstVisitIds(shopId: string, date: string): Promise<string[]>;
  /** Live changes from any device. Returns an unsubscribe function. */
  subscribe(
    shopId: string,
    onChange: (e: ChangeEvent) => void,
    onStatus: (s: ConnectionStatus) => void,
  ): () => void;
  signOut(): Promise<void>;
}

/** Domain error codes shared by DB triggers, client validation and the demo backend. */
export type ErrorCode =
  | 'OVERLAP'
  | 'BLOCK_OCCUPIED'
  | 'BLOCK_HAS_SPLIT_APPOINTMENTS'
  | 'DAY_BOUNDARY'
  | 'OFF_GRID'
  | 'NAME_REQUIRED'
  | 'BAD_DURATION'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'NO_SHOP'
  | 'DUPLICATE_PHONE'
  | 'OFFLINE'
  | 'SERIES_CONFLICT'
  | 'SLOT_TAKEN'
  | 'UNKNOWN';

export class AppError extends Error {
  constructor(public code: ErrorCode, detail?: string) {
    super(detail ?? code);
  }
}

/** Maps Postgres / PostgREST / network errors to domain error codes. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const err = (e ?? {}) as { code?: string; message?: string; details?: string };
  const msg = `${err.message ?? ''} ${err.details ?? ''}`;
  for (const code of ['BLOCK_OCCUPIED', 'BLOCK_HAS_SPLIT_APPOINTMENTS', 'DAY_BOUNDARY'] as const) {
    if (msg.includes(code)) return new AppError(code);
  }
  if (msg.includes('SERIES_CONFLICT')) return new AppError('SERIES_CONFLICT', err.details ?? msg);
  if (msg.includes('SLOT_TAKEN')) return new AppError('SLOT_TAKEN');
  if (msg.includes('NAME_REQUIRED')) return new AppError('NAME_REQUIRED');
  if (err.code === '23P01' || msg.includes('appointments_no_overlap_per_staff')) return new AppError('OVERLAP');
  if (err.code === '23505' && msg.includes('customers_shop_phone_key')) return new AppError('DUPLICATE_PHONE');
  if (err.code === '23514') return new AppError('OFF_GRID', msg);
  if (err.code === '42501' || err.code === 'PGRST301') return new AppError('FORBIDDEN', msg);
  if (err.code === 'PGRST116') return new AppError('NOT_FOUND', msg);
  if (/fetch|network|Failed to fetch|NetworkError|Load failed/i.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return new AppError('NETWORK', msg);
  }
  return new AppError('UNKNOWN', msg);
}
