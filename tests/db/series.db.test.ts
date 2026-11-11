import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { DB_URL, MEMBER, MEMBER2, OUTSIDER, ROTEM, SIVAN, SHOP, createTestDatabase, deviceClient, errorOf, il } from './helpers';

describe.skipIf(!DB_URL)('database: recurring series', () => {
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
    await a.query('delete from public.appointments; delete from public.appointment_series; delete from public.customers;');
    await a.end();
  });
  afterAll(async () => {
    await c?.end();
    await drop?.();
  });

  const weekly = (dates: string[], time = '10:00', staff?: string) =>
    JSON.stringify(dates.map((d, i) => ({ index: i, starts_at: new Date(`${d}T${time}:00+02:00`).toISOString(), ...(staff ? { staff_id: staff } : {}) })));
  const create = (client: pg.Client, key: string, occ: string, interval = 1) =>
    client.query(`select public.create_series($1,$2,$3,'קבוע','050-1231231',null,'תספורת',null,$4,30,null,$5,$6::jsonb) id`,
      [SHOP, key, ROTEM, interval, JSON.parse(occ).length, occ]);
  const list = async () => (await c.query(
    `select to_char(starts_at at time zone 'Asia/Jerusalem','YYYY-MM-DD HH24:MI') t, status, series_index i, staff_member_id s
     from public.appointments order by starts_at`)).rows;

  it('creates every occurrence linked to one series and one customer', async () => {
    const id = (await create(c, randomUUID(), weekly(['2030-01-06', '2030-01-13', '2030-01-20']))).rows[0].id;
    const rows = (await c.query('select series_id, series_index, customer_id from public.appointments order by series_index')).rows;
    expect(rows.map((r) => r.series_index)).toEqual([0, 1, 2]);
    expect(new Set(rows.map((r) => r.series_id))).toEqual(new Set([id]));
    expect(new Set(rows.map((r) => r.customer_id)).size).toBe(1);
    expect((await c.query('select customer_id from public.appointment_series')).rows[0].customer_id).toBe(rows[0].customer_id);
  });

  it('never overwrites: a conflicting date aborts the whole series and names the date', async () => {
    await c.query(`insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at) values ($1,$2,'קיים',$3,$4)`,
      [SHOP, ROTEM, il('2030-01-13', '10:00'), il('2030-01-13', '10:30')]);
    const err = await errorOf(create(c, randomUUID(), weekly(['2030-01-06', '2030-01-13', '2030-01-20'])));
    expect(err?.message).toBe('SERIES_CONFLICT');
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0].t).toBe('2030-01-13 10:00');
    expect((await c.query('select count(*)::int n from public.appointment_series')).rows[0].n).toBe(0);
  });

  it('submitting the same request twice creates nothing new (also when racing)', async () => {
    const key = randomUUID();
    const occ = weekly(['2030-02-03', '2030-02-10']);
    const a = (await create(c, key, occ)).rows[0].id;
    const b = (await create(c, key, occ)).rows[0].id;
    expect(b).toBe(a);
    // two devices at the same moment
    const key2 = randomUUID();
    const occ2 = weekly(['2030-03-03', '2030-03-10']);
    const d2 = await deviceClient(url, MEMBER2);
    try {
      await c.query('begin');
      await d2.query('begin');
      const first = create(c, key2, occ2);
      const second = create(d2, key2, occ2); // waits for the first
      const r1 = (await first).rows[0].id;
      await c.query('commit');
      const r2 = (await second).rows[0].id;
      await d2.query('commit');
      expect(r2).toBe(r1);
    } finally {
      await d2.end();
    }
    expect((await c.query('select count(*)::int n from public.appointments')).rows[0].n).toBe(4);
  });

  it('a rescheduled occurrence can use another staff member and time', async () => {
    const occ = JSON.stringify([
      { index: 0, starts_at: new Date('2030-04-07T10:00:00+03:00').toISOString() },
      { index: 1, starts_at: new Date('2030-04-14T12:30:00+03:00').toISOString(), staff_id: SIVAN },
    ]);
    await create(c, randomUUID(), occ);
    expect((await list()).map((r) => [r.t, r.s])).toEqual([['2030-04-07 10:00', ROTEM], ['2030-04-14 12:30', SIVAN]]);
  });

  it('cancel this-and-following vs all upcoming; single cancel leaves the series', async () => {
    await create(c, randomUUID(), weekly(['2030-05-05', '2030-05-12', '2030-05-19', '2030-05-26'].map((d) => d), '10:00'));
    const ids = (await c.query('select id from public.appointments order by starts_at')).rows.map((r) => r.id);
    await c.query(`update public.appointments set status='cancelled' where id=$1`, [ids[1]]); // single
    expect((await list()).map((r) => r.status)).toEqual(['booked', 'cancelled', 'booked', 'booked']);
    expect((await c.query('select public.cancel_series($1, $2) n', [ids[2], 'future'])).rows[0].n).toBe(2);
    expect((await list()).map((r) => r.status)).toEqual(['booked', 'cancelled', 'cancelled', 'cancelled']);
    expect((await c.query('select public.cancel_series($1, $2) n', [ids[0], 'all'])).rows[0].n).toBe(1);
    expect((await c.query('select status from public.appointment_series')).rows[0].status).toBe('cancelled');
  });

  it('edit this-and-following moves time/staff on the same dates, across DST, atomically', async () => {
    // 2030-03-29 is the DST switch in Israel: same local time before and after
    await create(c, randomUUID(), JSON.stringify([
      { index: 0, starts_at: new Date('2030-03-22T10:00:00+02:00').toISOString() },
      { index: 1, starts_at: new Date('2030-03-29T10:00:00+03:00').toISOString() },
      { index: 2, starts_at: new Date('2030-04-05T10:00:00+03:00').toISOString() },
    ]));
    const ids = (await c.query('select id from public.appointments order by starts_at')).rows.map((r) => r.id);
    expect((await c.query('select public.update_series_future($1,$2,$3,30,$4,null) n', [ids[0], SIVAN, 11 * 60, 'זקן'])).rows[0].n).toBe(3);
    expect((await list()).map((r) => [r.t, r.s])).toEqual([
      ['2030-03-22 11:00', SIVAN], ['2030-03-29 11:00', SIVAN], ['2030-04-05 11:00', SIVAN],
    ]);
    // a conflict on one date rolls everything back
    await c.query(`insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at) values ($1,$2,'חוסם',$3,$4)`,
      [SHOP, ROTEM, il('2030-04-05', '12:00'), il('2030-04-05', '12:30')]);
    const err = await errorOf(c.query('select public.update_series_future($1,$2,$3,30,null,null)', [ids[1], ROTEM, 12 * 60]));
    expect(err?.message).toBe('SERIES_CONFLICT');
    expect((await list()).filter((r) => r.i !== null).map((r) => r.t)).toEqual(['2030-03-22 11:00', '2030-03-29 11:00', '2030-04-05 11:00']);
  });

  it('closed weekdays default to Saturday; outsiders cannot create series', async () => {
    expect((await c.query('select closed_weekdays from public.shops')).rows[0].closed_weekdays).toEqual([6]);
    const o = await deviceClient(url, OUTSIDER);
    try {
      expect((await errorOf(create(o, randomUUID(), weekly(['2030-06-02']))))?.code).toBe('42501');
    } finally {
      await o.end();
    }
  });
});
