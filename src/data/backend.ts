import type { Appointment, AppointmentInput, Shop, SlotSplit, Staff } from '../domain/types';

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
  if (err.code === '23P01' || msg.includes('appointments_no_overlap_per_staff')) return new AppError('OVERLAP');
  if (err.code === '23514') return new AppError('OFF_GRID', msg);
  if (err.code === '42501' || err.code === 'PGRST301') return new AppError('FORBIDDEN', msg);
  if (err.code === 'PGRST116') return new AppError('NOT_FOUND', msg);
  if (/fetch|network|Failed to fetch|NetworkError|Load failed/i.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return new AppError('NETWORK', msg);
  }
  return new AppError('UNKNOWN', msg);
}
