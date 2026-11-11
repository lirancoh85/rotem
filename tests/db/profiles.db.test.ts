import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { DB_URL, MEMBER, OUTSIDER, ROTEM, SIVAN, SHOP, createTestDatabase, deviceClient, errorOf, il } from './helpers';

describe.skipIf(!DB_URL)('database: customer profiles, cancellation and history', () => {
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
    await a.query('delete from public.appointments; delete from public.customers;');
    await a.end();
  });
  afterAll(async () => {
    await c?.end();
    await drop?.();
  });
  const book = async (staff: string, date: string, start: string, end: string, name: string, phone: string | null = null) =>
    (await c.query(`insert into public.appointments (shop_id, staff_member_id, customer_name, customer_phone, starts_at, ends_at)
      values ($1,$2,$3,$4,$5,$6) returning id, customer_id`, [SHOP, staff, name, phone, il(date, start), il(date, end)])).rows[0] as { id: string; customer_id: string };
  const setStatus = (id: string, s: string) => c.query('update public.appointments set status=$2 where id=$1', [id, s]);

  it('existing bookings default to booked; cancelling frees the slot and keeps the record', async () => {
    const a = await book(ROTEM, '2030-01-07', '10:00', '10:30', 'דנה', '050-1000000');
    expect((await c.query('select status, cancelled_at from public.appointments where id=$1', [a.id])).rows[0]).toEqual({ status: 'booked', cancelled_at: null });
    expect((await errorOf(book(ROTEM, '2030-01-07', '10:00', '10:30', 'אחר')))?.code).toBe('23P01');
    await setStatus(a.id, 'cancelled');
    const row = (await c.query('select status, cancelled_at from public.appointments where id=$1', [a.id])).rows[0];
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();
    expect(await errorOf(book(ROTEM, '2030-01-07', '10:00', '10:30', 'אחר'))).toBeNull(); // slot reusable
    // restoring the cancelled one now conflicts — never overwrites
    expect((await errorOf(setStatus(a.id, 'booked')))?.code).toBe('23P01');
  });

  it('a no-show keeps occupying its time; split rules ignore cancelled appointments', async () => {
    const a = await book(ROTEM, '2030-01-08', '09:00', '09:30', 'נועם');
    await setStatus(a.id, 'no_show');
    expect((await errorOf(book(ROTEM, '2030-01-08', '09:00', '09:30', 'אחר')))?.code).toBe('23P01');
    const b = await book(SIVAN, '2030-01-08', '09:00', '09:30', 'לבטל');
    await setStatus(b.id, 'cancelled');
    expect(await errorOf(c.query(`insert into public.slot_splits (shop_id, staff_member_id, date, block_start_time) values ($1,$2,'2030-01-08','09:00')`, [SHOP, SIVAN]))).toBeNull();
  });

  it('profile: chronological history, counts and status (new → returning → inactive)', async () => {
    const v1 = await book(ROTEM, '2025-01-05', '10:00', '10:30', 'אורי', '052-3333333');
    await book(SIVAN, '2025-02-05', '10:00', '10:30', 'אורי', '0523333333');
    const ns = await book(ROTEM, '2025-03-05', '10:00', '10:30', 'אורי', '0523333333');
    await setStatus(ns.id, 'no_show');
    const cx = await book(ROTEM, '2025-04-05', '10:00', '10:30', 'אורי', '0523333333');
    await setStatus(cx.id, 'cancelled');
    const p = (await c.query('select public.customer_profile($1) p', [v1.customer_id])).rows[0].p;
    expect(p.customer).toMatchObject({ name: 'אורי', phone: '052-3333333' });
    expect(p.stats).toMatchObject({ completed_visits: 2, no_show_count: 1, cancelled_count: 1, upcoming_count: 0, status: 'inactive' });
    expect(p.appointments.map((a: { status: string }) => a.status)).toEqual(['booked', 'booked', 'no_show', 'cancelled']);
    // a future booking makes them active again
    await book(ROTEM, '2031-06-01', '10:00', '10:30', 'אורי', '0523333333');
    const p2 = (await c.query('select public.customer_profile($1) p', [v1.customer_id])).rows[0].p;
    expect(p2.stats).toMatchObject({ status: 'returning', upcoming_count: 1 });
    const fresh = await book(ROTEM, '2031-06-02', '11:00', '11:30', 'חדש לגמרי', '054-1212121');
    const list = (await c.query(`select name, status, completed_visits, upcoming_count from public.list_customers($1, '')`, [SHOP])).rows;
    expect(list).toEqual(expect.arrayContaining([
      { name: 'חדש לגמרי', status: 'new', completed_visits: '0', upcoming_count: '1' },
      { name: 'אורי', status: 'returning', completed_visits: '2', upcoming_count: '1' },
    ]));
    expect((await c.query(`select name from public.list_customers($1, '1212')`, [SHOP])).rows).toEqual([{ name: 'חדש לגמרי' }]);
    void fresh;
  });

  it('editing a customer updates their appointments and never duplicates the profile', async () => {
    const a = await book(ROTEM, '2030-02-01', '10:00', '10:30', 'יוסי', null);
    await c.query(`select public.update_customer($1, 'יוסי כהן', '050-4444444', 'אוהב קצר', 'מספר 2 בצדדים')`, [a.customer_id]);
    expect((await c.query('select customer_name, customer_phone, customer_id from public.appointments where id=$1', [a.id])).rows[0])
      .toEqual({ customer_name: 'יוסי כהן', customer_phone: '050-4444444', customer_id: a.customer_id });
    const b = await book(SIVAN, '2030-02-02', '10:00', '10:30', 'יוסי', '+972504444444');
    expect(b.customer_id).toBe(a.customer_id);
    expect((await c.query('select count(*)::int n from public.customers')).rows[0].n).toBe(1);
    expect((await c.query('select notes, preferences from public.customers')).rows[0]).toEqual({ notes: 'אוהב קצר', preferences: 'מספר 2 בצדדים' });
  });

  it('a phone that belongs to someone else is refused', async () => {
    const a = await book(ROTEM, '2030-03-01', '10:00', '10:30', 'א', '050-5555555');
    const b = await book(ROTEM, '2030-03-01', '11:00', '11:30', 'ב', '050-6666666');
    expect((await errorOf(c.query(`select public.update_customer($1, 'ב', '0505555555', null, null)`, [b.customer_id])))?.code).toBe('23505');
    void a;
  });

  it('first visits ignore cancelled and no-show appointments', async () => {
    const a = await book(ROTEM, '2030-04-01', '10:00', '10:30', 'רון', '053-7777777');
    const b = await book(ROTEM, '2030-04-08', '10:00', '10:30', 'רון', '053-7777777');
    await setStatus(a.id, 'no_show');
    const ids = (await c.query(`select public.first_visit_ids($1, $2::timestamptz, $3::timestamptz) id`, [SHOP, il('2030-04-08', '00:00'), il('2030-04-08', '23:59')])).rows.map((r) => r.id);
    expect(ids).toEqual([b.id]);
  });

  it('outsiders see no customers or profiles', async () => {
    const a = await book(ROTEM, '2030-05-01', '10:00', '10:30', 'פרטי');
    const o = await deviceClient(url, OUTSIDER);
    try {
      expect((await o.query(`select * from public.list_customers($1, '')`, [SHOP])).rows).toEqual([]);
      expect((await o.query('select public.customer_profile($1) p', [a.customer_id])).rows[0].p).toBeNull();
      await o.query(`select public.update_customer($1, 'x', null, null, null)`, [a.customer_id]).catch(() => {});
      expect((await c.query('select name from public.customers where id=$1', [a.customer_id])).rows[0].name).toBe('פרטי');
    } finally {
      await o.end();
    }
  });
});
