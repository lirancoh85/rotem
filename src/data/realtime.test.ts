import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyChange } from './applyChange';
import type { ChangeEvent, DayData } from './backend';
import { DemoBackend, DEMO_SHOP, DEMO_STAFF, memoryStore, seedDemoData } from './demoBackend';
import { SupabaseBackend, payloadToChange } from './supabaseBackend';
import { D, ROTEM, appt, split } from '../test/fixtures';

const TZ = 'Asia/Jerusalem';
const empty: DayData = { appointments: [], splits: [] };

describe('applyChange (realtime reducer)', () => {
  it('adds, edits, moves to another day and deletes appointments', () => {
    const a = appt(ROTEM, '09:00', 30, 'דניאל');
    let s = applyChange(empty, { table: 'appointments', type: 'upsert', row: a }, D, TZ);
    expect(s.appointments).toHaveLength(1);
    s = applyChange(s, { table: 'appointments', type: 'upsert', row: { ...a, customerName: 'דני' } }, D, TZ);
    expect(s.appointments.map((x) => x.customerName)).toEqual(['דני']);
    const moved = appt(ROTEM, '09:00', 30, 'דני', '2026-11-11');
    s = applyChange(s, { table: 'appointments', type: 'upsert', row: { ...moved, id: a.id } }, D, TZ);
    expect(s.appointments).toHaveLength(0);
    s = applyChange(s, { table: 'appointments', type: 'upsert', row: a }, D, TZ);
    s = applyChange(s, { table: 'appointments', type: 'delete', id: a.id }, D, TZ);
    expect(s.appointments).toHaveLength(0);
  });
  it('is idempotent for echoed events', () => {
    const a = appt(ROTEM, '10:00', 30);
    const e: ChangeEvent = { table: 'appointments', type: 'upsert', row: a };
    const once = applyChange(empty, e, D, TZ);
    expect(applyChange(once, e, D, TZ).appointments).toEqual(once.appointments);
  });
  it('applies split and revert-to-30 events, ignoring other dates', () => {
    let s = applyChange(empty, { table: 'slot_splits', type: 'upsert', row: split(ROTEM, '09:00') }, D, TZ);
    expect(s.splits[0].isSplit).toBe(true);
    s = applyChange(s, { table: 'slot_splits', type: 'upsert', row: split(ROTEM, '09:00', false) }, D, TZ);
    expect(s.splits).toEqual([split(ROTEM, '09:00', false)]);
    s = applyChange(s, { table: 'slot_splits', type: 'upsert', row: split(ROTEM, '10:00', true, '2026-11-12') }, D, TZ);
    expect(s.splits).toHaveLength(1);
    s = applyChange(s, { table: 'slot_splits', type: 'delete', key: { staffId: ROTEM.id, date: D, blockStart: 540 } }, D, TZ);
    expect(s.splits).toHaveLength(0);
  });
});

describe('Supabase realtime mapping', () => {
  it('maps postgres_changes payloads (including RLS-limited deletes) to change events', () => {
    const row = {
      id: 'x', shop_id: 's', staff_member_id: 'r', customer_name: 'אבי', customer_phone: null, service: null, notes: null,
      starts_at: '2026-11-10T07:00:00+00:00', ends_at: '2026-11-10T07:15:00+00:00', updated_at: 't',
    };
    expect(payloadToChange('appointments', { eventType: 'INSERT', new: row, old: {} })).toMatchObject({
      type: 'upsert', row: { id: 'x', staffId: 'r', startsAt: '2026-11-10T07:00:00.000Z' },
    });
    expect(payloadToChange('appointments', { eventType: 'DELETE', new: {}, old: { id: 'x' } })).toEqual({
      table: 'appointments', type: 'delete', id: 'x',
    });
    expect(payloadToChange('slot_splits', {
      eventType: 'UPDATE', old: {},
      new: { shop_id: 's', staff_member_id: 'r', date: D, block_start_time: '09:00:00', is_split: false },
    })).toEqual({ table: 'slot_splits', type: 'upsert', row: { shopId: 's', staffId: 'r', date: D, blockStart: 540, isSplit: false } });
    expect(payloadToChange('slot_splits', {
      eventType: 'DELETE', new: {}, old: { staff_member_id: 'r', date: D, block_start_time: '09:30:00' },
    })).toEqual({ table: 'slot_splits', type: 'delete', key: { staffId: 'r', date: D, blockStart: 570 } });
  });

  it('subscribes to INSERT/UPDATE (filtered by shop) and DELETE for appointments, splits and shop', () => {
    const ons: { event: string; table: string; filter?: string; cb: (p: unknown) => void }[] = [];
    let statusCb: (s: string) => void = () => {};
    const channel = {
      on: vi.fn((_t: string, f: { event: string; table: string; filter?: string }, cb: (p: unknown) => void) => {
        ons.push({ ...f, cb });
        return channel;
      }),
      subscribe: vi.fn((cb: (s: string) => void) => {
        statusCb = cb;
        return channel;
      }),
    };
    const sb = { channel: vi.fn(() => channel), removeChannel: vi.fn() } as unknown as SupabaseClient;
    const changes: ChangeEvent[] = [];
    const statuses: string[] = [];
    const off = new SupabaseBackend(sb).subscribe('shop1', (c) => changes.push(c), (s) => statuses.push(s));

    expect(ons.filter((o) => o.table === 'appointments').map((o) => [o.event, o.filter])).toEqual([
      ['INSERT', 'shop_id=eq.shop1'], ['UPDATE', 'shop_id=eq.shop1'], ['DELETE', undefined],
    ]);
    expect(ons.filter((o) => o.table === 'slot_splits')).toHaveLength(3);

    ons.find((o) => o.table === 'slot_splits' && o.event === 'INSERT')!.cb({
      eventType: 'INSERT', old: {},
      new: { shop_id: 'shop1', staff_member_id: 'r', date: D, block_start_time: '09:00:00', is_split: true },
    });
    expect(changes[0]).toMatchObject({ table: 'slot_splits', row: { isSplit: true, blockStart: 540 } });

    statusCb('SUBSCRIBED');
    statusCb('CHANNEL_ERROR');
    statusCb('SUBSCRIBED');
    expect(statuses).toEqual(['connecting', 'live', 'offline', 'live']);
    off();
    expect(sb.removeChannel).toHaveBeenCalledWith(channel);
  });
});

describe('two devices stay in sync (demo backend, shared store)', () => {
  function twoDevices() {
    const store = memoryStore({ ...seedDemoData(D), appointments: [], splits: [] });
    const channel = `test-${Math.random()}`;
    return { tablet: new DemoBackend(store, channel), phone: new DemoBackend(store, channel) };
  }
  const flush = () => new Promise((r) => setTimeout(r, 20));
  const input = (staffId: string, start: number, duration: number, customerName = 'לקוח') => ({
    staffId, date: D, start, duration, customerName, customerPhone: '', service: '', notes: '',
  });

  it('new, edited, moved and deleted appointments and split/unsplit reach the other device', async () => {
    const { tablet, phone } = twoDevices();
    let phoneView: DayData = await phone.loadDay(DEMO_SHOP.id, D);
    phone.subscribe(DEMO_SHOP.id, (e) => (phoneView = applyChange(phoneView, e, D, TZ)), () => {});
    const [rotem, sivan] = DEMO_STAFF;

    const a = await tablet.createAppointment(DEMO_SHOP, input(rotem.id, 540, 30, 'דניאל'));
    await flush();
    expect(phoneView.appointments.map((x) => x.customerName)).toEqual(['דניאל']);

    await tablet.updateAppointment(DEMO_SHOP, a.id, input(sivan.id, 600, 30, 'דניאל כהן')); // edit + move
    await flush();
    expect(phoneView.appointments).toMatchObject([{ customerName: 'דניאל כהן', staffId: sivan.id }]);

    await tablet.setSplit(DEMO_SHOP, rotem.id, D, 660, true);
    await flush();
    expect(phoneView.splits).toMatchObject([{ staffId: rotem.id, blockStart: 660, isSplit: true }]);

    await tablet.setSplit(DEMO_SHOP, rotem.id, D, 660, false);
    await flush();
    expect(phoneView.splits).toMatchObject([{ blockStart: 660, isSplit: false }]);

    await tablet.deleteAppointment(a.id);
    await flush();
    expect(phoneView.appointments).toHaveLength(0);
  });

  it('a 15-minute booking on one device shows the split block on the other', async () => {
    const { tablet, phone } = twoDevices();
    let phoneView: DayData = empty;
    phone.subscribe(DEMO_SHOP.id, (e) => (phoneView = applyChange(phoneView, e, D, TZ)), () => {});
    await tablet.createAppointment(DEMO_SHOP, input(DEMO_STAFF[0].id, 555, 15, 'אבי'));
    await flush();
    expect(phoneView.splits).toMatchObject([{ blockStart: 540, isSplit: true }]);
  });

  it('the second of two bookings for the same staff and time is rejected', async () => {
    const { tablet, phone } = twoDevices();
    await tablet.createAppointment(DEMO_SHOP, input(DEMO_STAFF[0].id, 540, 30, 'מהטאבלט'));
    await expect(phone.createAppointment(DEMO_SHOP, input(DEMO_STAFF[0].id, 540, 30, 'מהטלפון'))).rejects.toMatchObject({
      code: 'OVERLAP',
    });
    await expect(phone.createAppointment(DEMO_SHOP, input(DEMO_STAFF[1].id, 540, 30))).resolves.toBeTruthy();
  });

  it('enforces split rules like the database', async () => {
    const { tablet } = twoDevices();
    await tablet.createAppointment(DEMO_SHOP, input(DEMO_STAFF[0].id, 540, 30));
    await expect(tablet.setSplit(DEMO_SHOP, DEMO_STAFF[0].id, D, 540, true)).rejects.toMatchObject({ code: 'BLOCK_OCCUPIED' });
    await tablet.createAppointment(DEMO_SHOP, input(DEMO_STAFF[0].id, 600, 15));
    await expect(tablet.setSplit(DEMO_SHOP, DEMO_STAFF[0].id, D, 600, false)).rejects.toMatchObject({
      code: 'BLOCK_HAS_SPLIT_APPOINTMENTS',
    });
  });
});
