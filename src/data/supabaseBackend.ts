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
  Shop,
  SlotSplit,
  Staff,
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
});

const APPT_COLS =
  'id, shop_id, staff_member_id, customer_name, customer_phone, service, notes, starts_at, ends_at, is_blocked, customer_id, status, updated_at';

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
