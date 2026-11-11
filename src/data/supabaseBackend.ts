import type { SupabaseClient } from '@supabase/supabase-js';
import type { Backend, ChangeEvent, ConnectionStatus, DayData } from './backend';
import { AppError, toAppError } from './backend';
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
import { addDays, fmtTime, localToIso, parseTime } from '../lib/time';

type Row = Record<string, unknown>;

export const rowToAppointment = (r: Row): Appointment => ({
  id: r.id as string,
  shopId: r.shop_id as string,
  staffId: r.staff_member_id as string,
  customerName: r.customer_name as string,
  customerPhone: (r.customer_phone as string | null) ?? null,
  service: (r.service as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
  startsAt: new Date(r.starts_at as string).toISOString(),
  endsAt: new Date(r.ends_at as string).toISOString(),
  isBlocked: Boolean(r.is_blocked),
  customerId: (r.customer_id as string | null | undefined) ?? null,
  status: ((r.status as AppointmentStatus | undefined) ?? 'booked'),
  seriesId: (r.series_id as string | null | undefined) ?? null,
  seriesIndex: (r.series_index as number | null | undefined) ?? null,
  updatedAt: (r.updated_at as string | undefined) ?? undefined,
});

const rowToStats = (r: Row) => ({
  completedVisits: Number(r.completed_visits ?? 0),
  upcomingCount: Number(r.upcoming_count ?? 0),
  cancelledCount: Number(r.cancelled_count ?? 0),
  noShowCount: Number(r.no_show_count ?? 0),
  firstVisit: (r.first_visit as string | null) ?? null,
  lastVisit: (r.last_visit as string | null) ?? null,
  nextVisit: (r.next_visit as string | null) ?? null,
  status: ((r.status as CustomerSummary['status'] | undefined) ?? 'new'),
});

export const rowToOffer = (r: Row): WaitlistOffer => ({
  id: r.id as string,
  requestId: r.request_id as string,
  staffId: r.staff_member_id as string,
  startsAt: new Date(r.starts_at as string).toISOString(),
  endsAt: new Date(r.ends_at as string).toISOString(),
  status: r.status as OfferStatus,
  appointmentId: (r.appointment_id as string | null) ?? null,
  createdAt: r.created_at as string,
});

export const rowToWaitlist = (r: Row): WaitlistRequest => ({
  id: r.id as string,
  customerId: (r.customer_id as string | null) ?? null,
  customerName: r.customer_name as string,
  customerPhone: (r.customer_phone as string | null) ?? null,
  service: (r.service as string | null) ?? null,
  duration: Number(r.duration_minutes ?? 30),
  staffId: (r.staff_member_id as string | null) ?? null,
  preferredDates: ((r.preferred_dates as string[]) ?? []).slice().sort(),
  timeFrom: parseTime(r.time_from as string),
  timeTo: (r.time_to as string).startsWith('23:59') ? 1440 : parseTime(r.time_to as string),
  notes: (r.notes as string | null) ?? null,
  status: r.status as WaitlistStatus,
  createdAt: r.created_at as string,
  offers: ((r.waitlist_offers as Row[] | undefined) ?? []).map(rowToOffer).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
});

export const rowToSplit = (r: Row): SlotSplit => ({
  shopId: r.shop_id as string,
  staffId: r.staff_member_id as string,
  date: r.date as string,
  blockStart: parseTime(r.block_start_time as string),
  isSplit: r.is_split as boolean,
});

export const rowToShop = (r: Row): Shop => ({
  id: r.id as string,
  name: r.name as string,
  timezone: (r.timezone as string) ?? 'Asia/Jerusalem',
  dayStart: parseTime(r.day_start as string),
  dayEnd: parseTime(r.day_end as string),
  closedWeekdays: ((r.closed_weekdays as number[] | undefined) ?? [6]).map(Number),
});

const APPT_COLS =
  'id, shop_id, staff_member_id, customer_name, customer_phone, service, notes, starts_at, ends_at, is_blocked, customer_id, status, series_id, series_index, updated_at';

function inputToRow(shop: Shop, input: AppointmentInput) {
  const nullIfEmpty = (s: string) => (s.trim() ? s.trim() : null);
  return {
    shop_id: shop.id,
    staff_member_id: input.staffId,
    customer_name: input.customerName.trim(),
    customer_phone: nullIfEmpty(input.customerPhone),
    service: nullIfEmpty(input.service),
    notes: nullIfEmpty(input.notes),
    starts_at: localToIso(input.date, input.start, shop.timezone),
    ends_at: localToIso(input.date, input.start + input.duration, shop.timezone),
    is_blocked: Boolean(input.isBlocked),
    customer_id: input.isBlocked ? null : (input.customerId ?? null),
  };
}

/** Maps a Supabase realtime postgres_changes payload to a ChangeEvent. */
export function payloadToChange(table: string, payload: { eventType: string; new: Row; old: Row }): ChangeEvent | null {
  if (table === 'appointments') {
    if (payload.eventType === 'DELETE') return payload.old?.id ? { table, type: 'delete', id: payload.old.id as string } : null;
    return { table, type: 'upsert', row: rowToAppointment(payload.new) };
  }
  if (table === 'slot_splits') {
    if (payload.eventType === 'DELETE') {
      const o = payload.old;
      if (!o?.staff_member_id) return null;
      return {
        table,
        type: 'delete',
        key: { staffId: o.staff_member_id as string, date: o.date as string, blockStart: parseTime(o.block_start_time as string) },
      };
    }
    return { table, type: 'upsert', row: rowToSplit(payload.new) };
  }
  if (table === 'shops' && payload.eventType !== 'DELETE') return { table, type: 'upsert', row: rowToShop(payload.new) };
  return null;
}

export class SupabaseBackend implements Backend {
  readonly mode = 'supabase' as const;
  constructor(private sb: SupabaseClient) {}

  async loadShop() {
    const { data: auth } = await this.sb.auth.getUser();
    if (!auth.user) throw new AppError('FORBIDDEN');
    const { data: member, error } = await this.sb
      .from('shop_members')
      .select('shop_id, shops(*)')
      .eq('user_id', auth.user.id)
      .limit(1)
      .maybeSingle();
    if (error) throw toAppError(error);
    if (!member?.shops) throw new AppError('NO_SHOP');
    const shop = rowToShop(member.shops as unknown as Row);
    const { data: staffRows, error: e2 } = await this.sb
      .from('staff_members')
      .select('id, name, display_order')
      .eq('shop_id', shop.id)
      .eq('active', true)
      .order('display_order');
    if (e2) throw toAppError(e2);
    const staff: Staff[] = (staffRows ?? []).map((r) => ({ id: r.id, name: r.name, displayOrder: r.display_order }));
    return { shop, staff };
  }

  async loadDay(shopId: string, date: string): Promise<DayData> {
    const from = localToIso(date, 0);
    const to = localToIso(addDays(date, 1), 0);
    const [a, s] = await Promise.all([
      this.sb.from('appointments').select(APPT_COLS).eq('shop_id', shopId).neq('status', 'cancelled').gte('starts_at', from).lt('starts_at', to),
      this.sb.from('slot_splits').select('*').eq('shop_id', shopId).eq('date', date),
    ]);
    if (a.error) throw toAppError(a.error);
    if (s.error) throw toAppError(s.error);
    return { appointments: (a.data ?? []).map(rowToAppointment), splits: (s.data ?? []).map(rowToSplit) };
  }

  async createAppointment(shop: Shop, input: AppointmentInput) {
    const { data, error } = await this.sb.from('appointments').insert(inputToRow(shop, input)).select(APPT_COLS).single();
    if (error) throw toAppError(error);
    return rowToAppointment(data);
  }

  async updateAppointment(shop: Shop, id: string, input: AppointmentInput) {
    const { data, error } = await this.sb
      .from('appointments')
      .update(inputToRow(shop, input))
      .eq('id', id)
      .select(APPT_COLS)
      .single();
    if (error) throw toAppError(error);
    return rowToAppointment(data);
  }

  async deleteAppointment(id: string) {
    const { error } = await this.sb.from('appointments').delete().eq('id', id);
    if (error) throw toAppError(error);
  }

  async setSplit(shop: Shop, staffId: string, date: string, blockStart: number, isSplit: boolean) {
    const { data, error } = await this.sb
      .from('slot_splits')
      .upsert(
        { shop_id: shop.id, staff_member_id: staffId, date, block_start_time: fmtTime(blockStart), is_split: isSplit },
        { onConflict: 'staff_member_id,date,block_start_time' },
      )
      .select('*')
      .single();
    if (error) throw toAppError(error);
    return rowToSplit(data);
  }

  async updateShopHours(shopId: string, dayStart: number, dayEnd: number) {
    const { data, error } = await this.sb
      .from('shops')
      .update({ day_start: fmtTime(dayStart), day_end: fmtTime(dayEnd) })
      .eq('id', shopId)
      .select('*')
      .single();
    if (error) throw toAppError(error);
    return rowToShop(data);
  }

  async searchCustomers(shopId: string, query: string): Promise<Customer[]> {
    const { data, error } = await this.sb.rpc('search_customers', { p_shop: shopId, p_query: query, p_limit: 8 });
    if (error) throw toAppError(error);
    return ((data ?? []) as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      phone: (r.phone as string | null) ?? null,
      visits: Number(r.visits ?? 0),
      lastVisit: (r.last_visit as string | null) ?? null,
    }));
  }

  async searchAppointments(shopId: string, query: string, date: string | null): Promise<Appointment[]> {
    const { data, error } = await this.sb.rpc('search_appointments', {
      p_shop: shopId,
      p_query: query,
      p_date: date,
      p_limit: 60,
    });
    if (error) throw toAppError(error);
    return ((data ?? []) as Row[]).map(rowToAppointment);
  }

  async setAppointmentStatus(id: string, status: AppointmentStatus) {
    const { data, error } = await this.sb.from('appointments').update({ status }).eq('id', id).select(APPT_COLS).single();
    if (error) throw toAppError(error);
    return rowToAppointment(data);
  }

  async listCustomers(shopId: string, query: string): Promise<CustomerSummary[]> {
    const { data, error } = await this.sb.rpc('list_customers', { p_shop: shopId, p_query: query, p_limit: 100, p_offset: 0 });
    if (error) throw toAppError(error);
    return ((data ?? []) as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      phone: (r.phone as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      preferences: (r.preferences as string | null) ?? null,
      ...rowToStats(r),
    }));
  }

  async getCustomerProfile(customerId: string): Promise<CustomerProfile | null> {
    const { data, error } = await this.sb.rpc('customer_profile', { p_customer: customerId });
    if (error) throw toAppError(error);
    if (!data) return null;
    const p = data as { customer: CustomerProfile['customer']; stats: Row; appointments: Row[] };
    return { customer: p.customer, stats: rowToStats(p.stats), appointments: p.appointments.map(rowToAppointment) };
  }

  async updateCustomer(customerId: string, u: CustomerUpdate) {
    const { error } = await this.sb.rpc('update_customer', {
      p_customer: customerId,
      p_name: u.name,
      p_phone: u.phone,
      p_notes: u.notes,
      p_preferences: u.preferences,
    });
    if (error) throw toAppError(error);
  }

  async loadRange(shopId: string, fromDate: string, toDate: string): Promise<DayData> {
    const [a, s] = await Promise.all([
      this.sb
        .from('appointments')
        .select(APPT_COLS)
        .eq('shop_id', shopId)
        .neq('status', 'cancelled')
        .gte('starts_at', localToIso(fromDate, 0))
        .lt('starts_at', localToIso(toDate, 0))
        .order('starts_at'),
      this.sb.from('slot_splits').select('*').eq('shop_id', shopId).gte('date', fromDate).lt('date', toDate),
    ]);
    if (a.error) throw toAppError(a.error);
    if (s.error) throw toAppError(s.error);
    return { appointments: (a.data ?? []).map(rowToAppointment), splits: (s.data ?? []).map(rowToSplit) };
  }

  async createSeries(shop: Shop, req: SeriesRequest) {
    const { data, error } = await this.sb.rpc('create_series', {
      p_shop: shop.id,
      p_request_key: req.requestKey,
      p_staff: req.staffId,
      p_customer_name: req.customerName,
      p_customer_phone: req.customerPhone,
      p_customer_id: req.customerId,
      p_service: req.service,
      p_notes: req.notes,
      p_interval_weeks: req.intervalWeeks,
      p_duration: req.duration,
      p_ends_on: req.endsOn,
      p_count: req.count,
      p_occurrences: req.occurrences.map((o) => ({
        index: o.index,
        starts_at: localToIso(o.date, o.start, shop.timezone),
        staff_id: o.staffId,
      })),
    });
    if (error) throw toAppError(error);
    return data as string;
  }

  async cancelSeries(apptId: string, scope: 'future' | 'all') {
    const { data, error } = await this.sb.rpc('cancel_series', { p_appt: apptId, p_scope: scope });
    if (error) throw toAppError(error);
    return Number(data ?? 0);
  }

  async updateSeriesFuture(apptId: string, c: SeriesChange) {
    const { data, error } = await this.sb.rpc('update_series_future', {
      p_appt: apptId,
      p_staff: c.staffId,
      p_start_minutes: c.start,
      p_duration: c.duration,
      p_service: c.service,
      p_notes: c.notes,
    });
    if (error) throw toAppError(error);
    return Number(data ?? 0);
  }

  async updateClosedWeekdays(shopId: string, days: number[]) {
    const { data, error } = await this.sb.from('shops').update({ closed_weekdays: days }).eq('id', shopId).select('*').single();
    if (error) throw toAppError(error);
    return rowToShop(data);
  }

  async listWaitlist(shopId: string): Promise<WaitlistRequest[]> {
    const { data, error } = await this.sb
      .from('waitlist_requests')
      .select('*, waitlist_offers(*)')
      .eq('shop_id', shopId)
      .eq('status', 'waiting')
      .order('created_at');
    if (error) throw toAppError(error);
    return ((data ?? []) as Row[]).map(rowToWaitlist);
  }

  async saveWaitlistRequest(shop: Shop, w: WaitlistInput, id?: string) {
    const row = {
      shop_id: shop.id,
      customer_name: w.customerName.trim(),
      customer_phone: w.customerPhone.trim() || null,
      customer_id: w.customerId,
      service: w.service.trim() || null,
      duration_minutes: w.duration,
      staff_member_id: w.staffId,
      preferred_dates: [...new Set(w.preferredDates)].sort(),
      time_from: fmtTime(w.timeFrom),
      time_to: w.timeTo >= 1440 ? '23:59' : fmtTime(w.timeTo),
      notes: w.notes.trim() || null,
    };
    const { error } = id
      ? await this.sb.from('waitlist_requests').update(row).eq('id', id)
      : await this.sb.from('waitlist_requests').insert(row);
    if (error) throw toAppError(error);
  }

  async setWaitlistStatus(id: string, status: WaitlistStatus) {
    const { error } = await this.sb.from('waitlist_requests').update({ status }).eq('id', id);
    if (error) throw toAppError(error);
  }

  async createOffer(shop: Shop, requestId: string, slot: { date: string; start: number; staffId: string; duration: number }) {
    const { data, error } = await this.sb
      .from('waitlist_offers')
      .insert({
        shop_id: shop.id,
        request_id: requestId,
        staff_member_id: slot.staffId,
        starts_at: localToIso(slot.date, slot.start, shop.timezone),
        ends_at: localToIso(slot.date, slot.start + slot.duration, shop.timezone),
      })
      .select('*')
      .single();
    if (error) throw toAppError(error);
    return rowToOffer(data);
  }

  async setOfferStatus(offerId: string, status: Exclude<OfferStatus, 'accepted'>) {
    const { error } = await this.sb.from('waitlist_offers').update({ status }).eq('id', offerId);
    if (error) throw toAppError(error);
  }

  async acceptOffer(offerId: string) {
    const { data, error } = await this.sb.rpc('accept_offer', { p_offer: offerId });
    if (error) throw toAppError(error);
    const r = data as { ok: boolean; appointment_id: string | null; reason: string | null };
    return { ok: r.ok, appointmentId: r.appointment_id, reason: r.reason };
  }

  async firstVisitIds(shopId: string, date: string): Promise<string[]> {
    const { data, error } = await this.sb.rpc('first_visit_ids', {
      p_shop: shopId,
      p_from: localToIso(date, 0),
      p_to: localToIso(addDays(date, 1), 0),
    });
    if (error) throw toAppError(error);
    return ((data ?? []) as unknown[]).map((r) => (typeof r === 'string' ? r : String(Object.values(r as object)[0])));
  }

  subscribe(shopId: string, onChange: (e: ChangeEvent) => void, onStatus: (s: ConnectionStatus) => void) {
    onStatus('connecting');
    const channel = this.sb.channel(`salon-${shopId}`);
    for (const table of ['appointments', 'slot_splits', 'shops'] as const) {
      const filter = table === 'shops' ? `id=eq.${shopId}` : `shop_id=eq.${shopId}`;
      const handler = (p: { eventType: string; new: Row; old: Row }) => {
        const change = payloadToChange(table, p);
        if (change) onChange(change);
      };
      channel.on('postgres_changes' as never, { event: 'INSERT', schema: 'public', table, filter }, handler);
      channel.on('postgres_changes' as never, { event: 'UPDATE', schema: 'public', table, filter }, handler);
      // Supabase cannot filter DELETE events; RLS still limits them to this shop's rows.
      channel.on('postgres_changes' as never, { event: 'DELETE', schema: 'public', table }, handler);
    }
    for (const table of ['waitlist_requests', 'waitlist_offers'] as const) {
      channel.on('postgres_changes' as never, { event: '*', schema: 'public', table, filter: `shop_id=eq.${shopId}` }, () =>
        onChange({ table: 'waitlist', type: 'changed' }),
      );
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') onStatus('live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') onStatus('offline');
    });
    return () => {
      void this.sb.removeChannel(channel);
    };
  }

  async signOut() {
    await this.sb.auth.signOut();
  }
}
