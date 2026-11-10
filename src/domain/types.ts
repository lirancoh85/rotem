export interface Staff {
  id: string;
  name: string;
  displayOrder: number;
}

export interface Shop {
  id: string;
  name: string;
  timezone: string;
  /** minutes since midnight */
  dayStart: number;
  dayEnd: number;
}

export interface Appointment {
  id: string;
  shopId: string;
  staffId: string;
  customerName: string;
  customerPhone: string | null;
  service: string | null;
  notes: string | null;
  /** ISO UTC instants */
  startsAt: string;
  endsAt: string;
  /** crossed-out slot (no customer) */
  isBlocked?: boolean;
  customerId?: string | null;
  updatedAt?: string;
}

/** Split state of one 30-minute block of one staff member on one date. */
export interface SlotSplit {
  shopId: string;
  staffId: string;
  /** 'YYYY-MM-DD' salon-local */
  date: string;
  /** minutes since midnight; multiple of 30 */
  blockStart: number;
  isSplit: boolean;
}

export interface AppointmentInput {
  staffId: string;
  date: string;
  /** minutes since midnight */
  start: number;
  duration: number;
  customerName: string;
  customerPhone: string;
  service: string;
  notes: string;
  isBlocked?: boolean;
  /** set when picked from autocomplete */
  customerId?: string | null;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  visits?: number;
  lastVisit?: string | null;
}

export const DURATIONS = [15, 30, 45, 60] as const;
export const QUARTER = 15;
export const BLOCK = 30;
