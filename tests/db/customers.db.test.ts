import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_URL, MEMBER, MEMBER2, OUTSIDER, ROTEM, SIVAN, SHOP, createTestDatabase, deviceClient, errorOf, il } from './helpers';

const D = '2026-11-10';

async function bookWith(c: pg.Client, staff: string, start: string, end: string, name: string, phone: string | null = null, customerId: string | null = null, date = D) {
  const { rows } = await c.query(
    `insert into public.appointments (shop_id, staff_member_id, customer_name, customer_phone, customer_id, starts_at, ends_at)
     values ($1,$2,$3,$4,$5,$6,$7) returning id, customer_id`,
    [SHOP, staff, name, phone, customerId, il(date, start), il(date, end)]);
  return rows[0] as { id: string; customer_id: string };
}
const customers = async (c: pg.Client) =>
  (await c.query('select name, phone, phone_digits from public.customers order by name')).rows;

describe.skipIf(!DB_URL)('database: customers, autocomplete and search', () => {
  let url: string;
  let drop: () => Promise<void>;
  let tablet: pg.Client;
  let phone: pg.Client;

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    tablet = await deviceClient(url, MEMBER);
    phone = await deviceClient(url, MEMBER2);
  });
  afterEach(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query('delete from public.appointments; delete from public.customers;');
    await admin.end();
    await tablet.end();
    await phone.end();
  });

  it('creates one customer per person and reuses it for returning visits (by phone, any format)', async () => {
    const a = await bookWith(tablet, ROTEM, '09:00', '09:30', 'דניאל כהן', '050-123-4567');
    const b = await bookWith(phone, SIVAN, '10:00', '10:30', 'דני', '+972 50 1234567', null, '2026-11-12');
    expect(b.customer_id).toBe(a.customer_id);
    expect(await customers(tablet)).toEqual([{ name: 'דניאל כהן', phone: '050-123-4567', phone_digits: '0501234567' }]);
  });

  it('reuses a phone-less customer by name and upgrades it when a phone is added', async () => {
    const a = await bookWith(tablet, ROTEM, '09:00', '09:30', 'אבי');
    const b = await bookWith(tablet, ROTEM, '10:00', '10:30', '  אבי ');
    expect(b.customer_id).toBe(a.customer_id);
    const c = await bookWith(tablet, ROTEM, '11:00', '11:30', 'אבי', '052-7654321');
    expect(c.customer_id).toBe(a.customer_id);
    expect(await customers(tablet)).toEqual([{ name: 'אבי', phone: '052-7654321', phone_digits: '0527654321' }]);
  });

  it('keeps different people with the same name apart when phones differ', async () => {
    const a = await bookWith(tablet, ROTEM, '09:00', '09:30', 'משה', '050-1111111');
    const b = await bookWith(tablet, ROTEM, '10:00', '10:30', 'משה', '050-2222222');
    expect(b.customer_id).not.toBe(a.customer_id);
  });

  it('a customer chosen from autocomplete is linked as-is', async () => {
    const a = await bookWith(tablet, ROTEM, '09:00', '09:30', 'נועה לוי', '054-5555555');
    const b = await bookWith(phone, SIVAN, '12:00', '12:30', 'נועה לוי', '054-5555555', a.customer_id);
    expect(b.customer_id).toBe(a.customer_id);
    expect((await customers(tablet)).length).toBe(1);
  });

  it('the same new customer booked from two devices at once ends up as one customer', async () => {
    await tablet.query('begin');
    await phone.query('begin');
    const first = await bookWith(tablet, ROTEM, '14:00', '14:30', 'לקוחה חדשה', '058-0000000');
    const second = bookWith(phone, SIVAN, '15:00', '15:30', 'לקוחה חדשה', '058-0000000'); // waits briefly
    await tablet.query('commit');
    const b = await second;
    await phone.query('commit');
    expect(b.customer_id).toBe(first.customer_id);
    expect((await customers(tablet)).length).toBe(1);
  });

  it('blocked slots never create customers', async () => {
    await tablet.query(
      `insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at, is_blocked)
       values ($1,$2,'חסום',$3,$4,true)`, [SHOP, ROTEM, il(D, '13:00'), il(D, '13:30')]);
    expect(await customers(tablet)).toEqual([]);
  });

  it('autocomplete finds customers by part of the name or phone, with visit counts', async () => {
    await bookWith(tablet, ROTEM, '09:00', '09:30', 'דניאל כהן', '050-1234567');
    await bookWith(tablet, ROTEM, '10:00', '10:30', 'דניאל כהן', '050-1234567', null, '2026-11-11');
    await bookWith(tablet, SIVAN, '09:00', '09:30', 'רונית');
    const byName = await tablet.query(`select name, phone, visits from public.search_customers($1, 'דני')`, [SHOP]);
    expect(byName.rows).toEqual([{ name: 'דניאל כהן', phone: '050-1234567', visits: '2' }]);
    const byPhone = await tablet.query(`select name from public.search_customers($1, '1234567')`, [SHOP]);
    expect(byPhone.rows).toEqual([{ name: 'דניאל כהן' }]);
    const wildcard = await tablet.query(`select name from public.search_customers($1, '%')`, [SHOP]);
    expect(wildcard.rows).toEqual([]);
  });

  it('searches appointments by name, phone and date across past and future', async () => {
    await bookWith(tablet, ROTEM, '09:00', '09:30', 'שרון', '053-9999999', null, '2025-01-05');
    await bookWith(tablet, SIVAN, '10:00', '10:30', 'שרון', '053-9999999', null, '2027-03-01');
    await bookWith(tablet, ROTEM, '11:00', '11:30', 'גלעד', null, null, '2027-03-01');
    const s = async (q: string, date: string | null = null) =>
      (await tablet.query(`select customer_name, to_char(starts_at at time zone 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') t
        from public.search_appointments($1, $2, $3::date)`, [SHOP, q, date])).rows;
    expect(await s('שרון')).toEqual([
      { customer_name: 'שרון', t: '2027-03-01 10:00' },
      { customer_name: 'שרון', t: '2025-01-05 09:00' },
    ]);
    expect((await s('0539999999')).length).toBe(2);
    expect(await s('', '2027-03-01')).toEqual([
      { customer_name: 'גלעד', t: '2027-03-01 11:00' },
      { customer_name: 'שרון', t: '2027-03-01 10:00' },
    ]);
  });

  it('outsiders cannot read customers or search', async () => {
    await bookWith(tablet, ROTEM, '09:00', '09:30', 'דניאל', '050-1234567');
    const outsider = await deviceClient(url, OUTSIDER);
    try {
      expect((await outsider.query('select * from public.customers')).rows).toHaveLength(0);
      expect((await outsider.query(`select * from public.search_customers($1,'דני')`, [SHOP])).rows).toHaveLength(0);
      expect((await outsider.query(`select * from public.search_appointments($1,'דני')`, [SHOP])).rows).toHaveLength(0);
    } finally {
      await outsider.end();
    }
    const anon = await deviceClient(url, null);
    try {
      expect((await errorOf(anon.query(`select * from public.search_customers($1,'דני')`, [SHOP])))?.code).toBe('42501');
    } finally {
      await anon.end();
    }
  });

  it('the migration backfills customers for appointments that existed before it', async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query('alter table public.appointments disable trigger appointments_link_customer');
      await admin.query(`insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at)
        values ($1,$2,'ותיק',$3,$4), ($1,$5,'ותיק',$6,$7)`,
        [SHOP, ROTEM, il(D, '09:00'), il(D, '09:30'), SIVAN, il(D, '12:00'), il(D, '12:30')]);
      await admin.query('alter table public.appointments enable trigger appointments_link_customer');
      const mig = readFileSync(join(__dirname, '../../supabase/migrations/20261111000005_customers_search.sql'), 'utf8');
      await admin.query(mig); // re-running the migration is safe and links old rows
      const { rows } = await admin.query('select count(distinct customer_id)::int n, count(*)::int total from public.appointments');
      expect(rows[0]).toEqual({ n: 1, total: 2 });
    } finally {
      await admin.end();
    }
  });
});
