import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { DB_URL, MEMBER, MEMBER2, OUTSIDER, ROTEM, SHOP, createTestDatabase, deviceClient, errorOf, il } from './helpers';

describe.skipIf(!DB_URL)('database: waiting list', () => {
  let url: string;
  let drop: () => Promise<void>;
  let c: pg.Client;
  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase());
    c = await deviceClient(url, MEMBER);
  });
  afterEach(async () => {
    const a = new pg.Client({ connectionString: url });
    await a.connect();
    await a.query('delete from public.waitlist_requests; delete from public.appointments; delete from public.customers;');
    await a.end();
  });
  afterAll(async () => {
    await c?.end();
    await drop?.();
  });
  const request = async (name: string, phone: string | null, dates: string[]) =>
    (await c.query(`insert into public.waitlist_requests (shop_id, customer_name, customer_phone, preferred_dates, time_from, time_to)
      values ($1,$2,$3,$4::date[],'09:00','13:00') returning id, customer_id`, [SHOP, name, phone, dates])).rows[0] as { id: string; customer_id: string | null };
  const offer = async (req: string, date: string, start: string, end: string) =>
    (await c.query(`insert into public.waitlist_offers (shop_id, request_id, staff_member_id, starts_at, ends_at) values ($1,$2,$3,$4,$5) returning id`,
      [SHOP, req, ROTEM, il(date, start), il(date, end)])).rows[0].id as string;
  const accept = async (client: pg.Client, id: string) => (await client.query('select public.accept_offer($1) r', [id])).rows[0].r;

  it('links a waiting customer to the existing profile by phone', async () => {
    const appt = (await c.query(`insert into public.appointments (shop_id, staff_member_id, customer_name, customer_phone, starts_at, ends_at)
      values ($1,$2,'מיכל','052-1212121',$3,$4) returning customer_id`, [SHOP, ROTEM, il('2030-01-01', '10:00'), il('2030-01-01', '10:30')])).rows[0];
    const r = await request('מיכל כהן', '+972 52 121 2121', ['2030-01-05']);
    expect(r.customer_id).toBe(appt.customer_id);
  });

  it('accepting books the slot, closes the request and expires other offers', async () => {
    const r = await request('דן', '050-1010101', ['2030-01-06', '2030-01-07']);
    const o1 = await offer(r.id, '2030-01-06', '10:00', '10:30');
    const o2 = await offer(r.id, '2030-01-07', '11:00', '11:30');
    const res = await accept(c, o1);
    expect(res.ok).toBe(true);
    const appt = (await c.query('select customer_name, staff_member_id, status from public.appointments where id=$1', [res.appointment_id])).rows[0];
    expect(appt).toEqual({ customer_name: 'דן', staff_member_id: ROTEM, status: 'booked' });
    expect((await c.query('select status from public.waitlist_requests where id=$1', [r.id])).rows[0].status).toBe('booked');
    expect((await c.query('select status from public.waitlist_offers where id=$1', [o2])).rows[0].status).toBe('expired');
    // clicking accept again does not book twice
    expect((await accept(c, o1)).appointment_id).toBe(res.appointment_id);
    expect((await c.query('select count(*)::int n from public.appointments')).rows[0].n).toBe(1);
  });

  it('if another customer took the slot first, the offer expires and nothing is double-booked', async () => {
    const r = await request('אלה', null, ['2030-01-08']);
    const o = await offer(r.id, '2030-01-08', '10:00', '10:30');
    await c.query(`insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at) values ($1,$2,'מהיר',$3,$4)`,
      [SHOP, ROTEM, il('2030-01-08', '10:00'), il('2030-01-08', '10:30')]);
    const res = await accept(c, o);
    expect(res).toEqual({ ok: false, appointment_id: null, reason: 'SLOT_TAKEN' });
    expect((await c.query('select status from public.waitlist_offers where id=$1', [o])).rows[0].status).toBe('expired');
    expect((await c.query('select status from public.waitlist_requests where id=$1', [r.id])).rows[0].status).toBe('waiting');
  });

  it('two devices accepting offers for the same slot: only one booking', async () => {
    const r1 = await request('ראשון', null, ['2030-01-09']);
    const r2 = await request('שני', null, ['2030-01-09']);
    const o1 = await offer(r1.id, '2030-01-09', '10:00', '10:30');
    const o2 = await offer(r2.id, '2030-01-09', '10:00', '10:30');
    const d2 = await deviceClient(url, MEMBER2);
    try {
      await c.query('begin');
      await d2.query('begin');
      const a = await accept(c, o1);
      const pending = accept(d2, o2); // waits for the first
      await c.query('commit');
      const b = await pending;
      await d2.query('commit');
      expect([a.ok, b.ok]).toEqual([true, false]);
      expect(b.reason).toBe('SLOT_TAKEN');
    } finally {
      await d2.end();
    }
    expect((await c.query(`select count(*)::int n from public.appointments where starts_at=$1`, [il('2030-01-09', '10:00')])).rows[0].n).toBe(1);
  });

  it('declined/expired offers cannot be accepted; requests can be edited and removed', async () => {
    const r = await request('גל', null, ['2030-01-10']);
    const o = await offer(r.id, '2030-01-10', '10:00', '10:30');
    await c.query(`update public.waitlist_offers set status='declined' where id=$1`, [o]);
    expect((await accept(c, o)).reason).toBe('OFFER_CLOSED');
    await c.query(`update public.waitlist_requests set preferred_dates='{2030-01-11,2030-01-12}', status='removed' where id=$1`, [r.id]);
    expect((await c.query('select status, cardinality(preferred_dates) n from public.waitlist_requests where id=$1', [r.id])).rows[0]).toEqual({ status: 'removed', n: 2 });
    expect((await errorOf(c.query(`update public.waitlist_requests set time_to='08:00' where id=$1`, [r.id])))?.code).toBe('23514');
  });

  it('outsiders cannot see or use the waiting list', async () => {
    const r = await request('פרטי', null, ['2030-01-13']);
    const o = await deviceClient(url, OUTSIDER);
    try {
      expect((await o.query('select * from public.waitlist_requests')).rows).toEqual([]);
      expect((await errorOf(o.query(`insert into public.waitlist_requests (shop_id, customer_name, preferred_dates) values ($1,'x','{2030-01-01}')`, [SHOP])))?.code).toBe('42501');
    } finally {
      await o.end();
    }
    void r;
  });
});
