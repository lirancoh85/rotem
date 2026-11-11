import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { DB_URL, MEMBER, OUTSIDER, ROTEM, SIVAN, SHOP, createTestDatabase, deviceClient, il } from './helpers';

const D = '2026-11-10';

describe.skipIf(!DB_URL)('database: staff rename and first-time customers', () => {
  let url: string;
  let drop: () => Promise<void>;
  let c: pg.Client;

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase());
    c = await deviceClient(url, MEMBER);
  });
  afterAll(async () => {
    await c?.end();
    await drop?.();
  });

  const book = async (staff: string, date: string, start: string, end: string, name: string, phone: string | null = null) =>
    (await c.query(
      `insert into public.appointments (shop_id, staff_member_id, customer_name, customer_phone, starts_at, ends_at)
       values ($1,$2,$3,$4,$5,$6) returning id`, [SHOP, staff, name, phone, il(date, start), il(date, end)])).rows[0].id as string;
  const firsts = async (date: string) =>
    (await c.query(`select public.first_visit_ids($1, $2::timestamptz, $3::timestamptz) as id`,
      [SHOP, il(date, '00:00'), il(date, '23:59')])).rows.map((r) => r.id as string).sort();

  it('renames the staff member to סיוון without changing the record', async () => {
    const { rows } = await c.query(`select id, name from public.staff_members order by display_order`);
    expect(rows).toEqual([{ id: ROTEM, name: 'רותם' }, { id: SIVAN, name: 'סיוון' }]);
  });

  it('keeps existing appointments and customers linked through the rename (no duplicates)', async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`update public.staff_members set name='סיון' where id=$1`, [SIVAN]);
      await book(SIVAN, '2026-11-01', '10:00', '10:30', 'לפני השינוי', '050-0000001');
      const before = (await admin.query('select count(*)::int n from public.customers')).rows[0].n;
      // re-apply the rename step of the migration
      await admin.query(`update public.staff_members set name='סיוון' where id=$1 and name='סיון'`, [SIVAN]);
      const { rows } = await admin.query(
        `select s.name, count(*)::int n from public.appointments a join public.staff_members s on s.id=a.staff_member_id
         where a.customer_name='לפני השינוי' group by s.name`);
      expect(rows).toEqual([{ name: 'סיוון', n: 1 }]);
      expect((await admin.query('select count(*)::int n from public.customers')).rows[0].n).toBe(before);
    } finally {
      await admin.end();
    }
  });

  it('marks only the earliest visit of each customer, identified by phone number', async () => {
    const first = await book(ROTEM, D, '09:00', '09:30', 'דנה', '052-1112233');
    const second = await book(SIVAN, D, '11:00', '11:30', 'דנה כהן', '+972 52 111 2233'); // same phone
    const other = await book(SIVAN, D, '09:00', '09:30', 'רונית', '054-9998877');
    expect(await firsts(D)).toEqual([first, other].sort());
    expect(await firsts(D)).not.toContain(second);
  });

  it('an earlier visit on another day keeps later visits normal', async () => {
    await book(ROTEM, '2026-10-01', '10:00', '10:30', 'יוסי', '050-7777777');
    const later = await book(ROTEM, D, '12:00', '12:30', 'יוסי', '050-7777777');
    expect(await firsts(D)).not.toContain(later);
  });

  it('a cancelled (deleted) first visit no longer counts; crossed-out slots never count', async () => {
    const a = await book(ROTEM, '2026-11-12', '09:00', '09:30', 'מיכל', '053-1231234');
    const b = await book(ROTEM, '2026-11-12', '10:00', '10:30', 'מיכל', '053-1231234');
    expect(await firsts('2026-11-12')).toEqual([a]);
    await c.query('delete from public.appointments where id=$1', [a]);
    expect(await firsts('2026-11-12')).toEqual([b]);
    await c.query(`insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at, is_blocked)
      values ($1,$2,'חסום',$3,$4,true)`, [SHOP, SIVAN, il('2026-11-12', '13:00'), il('2026-11-12', '13:30')]);
    expect(await firsts('2026-11-12')).toEqual([b]);
  });

  it('outsiders get nothing', async () => {
    const o = await deviceClient(url, OUTSIDER);
    try {
      const { rows } = await o.query(`select public.first_visit_ids($1, $2::timestamptz, $3::timestamptz) as id`,
        [SHOP, il(D, '00:00'), il(D, '23:59')]);
      expect(rows).toEqual([]);
    } finally {
      await o.end();
    }
  });
});
