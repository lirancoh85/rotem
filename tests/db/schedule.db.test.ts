import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  DB_URL, MEMBER, MEMBER2, OUTSIDER, ROTEM, SIVAN, SHOP,
  book, createTestDatabase, deviceClient, errorOf, il, setSplit, splitState,
} from './helpers';

const D = '2026-11-10';

describe.skipIf(!DB_URL)('database: scheduling rules (real Postgres)', () => {
  let url: string;
  let drop: () => Promise<void>;
  let tablet: pg.Client; // device 1 (Rotem, owner)
  let phone: pg.Client; // device 2 (Sivan, staff)

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase());
  });
  afterAll(async () => {
    await drop?.();
  });
  beforeEach(async () => {
    tablet = await deviceClient(url, MEMBER);
    phone = await deviceClient(url, MEMBER2);
  });
  afterEach(async () => {
    await tablet.query('delete from public.appointments');
    await tablet.query('update public.slot_splits set is_split = false');
    await tablet.query('delete from public.slot_splits');
    await tablet.end();
    await phone.end();
  });

  describe('independent staff schedules', () => {
    it('lets Rotem and Sivan have appointments at the same time', async () => {
      await book(tablet, ROTEM, D, '09:00', '09:30', 'דניאל');
      await book(tablet, SIVAN, D, '09:00', '09:30', 'משה');
      const { rows } = await phone.query(
        'select staff_member_id from public.appointments order by staff_member_id');
      expect(rows.map((r) => r.staff_member_id)).toEqual([ROTEM, SIVAN]);
    });

    it('rejects an appointment that references a staff member of another shop', async () => {
      const err = await errorOf(tablet.query(
        `insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at)
         values ('00000000-0000-4000-8000-000000000000', $1, 'x', $2, $3)`,
        [ROTEM, il(D, '09:00'), il(D, '09:30')]));
      expect(err).not.toBeNull();
    });
  });

  describe('appointment overlaps (per staff member)', () => {
    it('prohibits overlapping appointments for the same staff member', async () => {
      await book(tablet, ROTEM, D, '09:00', '09:30');
      const err = await errorOf(book(phone, ROTEM, D, '09:00', '09:30'));
      expect(err?.code).toBe('23P01');
      const partial = await errorOf(book(phone, ROTEM, D, '08:30', '09:15'));
      expect(partial?.code).toBe('23P01');
    });

    it('allows back-to-back appointments', async () => {
      await book(tablet, ROTEM, D, '09:00', '09:30');
      expect(await errorOf(book(tablet, ROTEM, D, '09:30', '10:00'))).toBeNull();
    });

    it('allows 45 and 60 minute appointments and blocks overlaps with them', async () => {
      await book(tablet, ROTEM, D, '10:00', '11:00', 'ארוך');
      await book(tablet, SIVAN, D, '10:00', '10:45', 'ארבעים וחמש');
      expect((await errorOf(book(tablet, ROTEM, D, '10:30', '11:00')))?.code).toBe('23P01');
      expect(await errorOf(book(tablet, SIVAN, D, '10:45', '11:00'))).toBeNull();
    });

    it('moving an appointment onto an occupied slot of another staff member fails', async () => {
      await book(tablet, SIVAN, D, '12:00', '12:30');
      const id = await book(tablet, ROTEM, D, '12:00', '12:30');
      const err = await errorOf(tablet.query(
        'update public.appointments set staff_member_id = $1 where id = $2', [SIVAN, id]));
      expect(err?.code).toBe('23P01');
      expect(await errorOf(tablet.query(
        `update public.appointments set staff_member_id = $1, starts_at = $2, ends_at = $3 where id = $4`,
        [SIVAN, il(D, '12:30'), il(D, '13:00'), id]))).toBeNull();
    });

    it('enforces the 15-minute grid and same-day appointments', async () => {
      expect((await errorOf(book(tablet, ROTEM, D, '09:05', '09:35')))?.code).toBe('23514');
      const err = await errorOf(tablet.query(
        `insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at)
         values ($1,$2,'x',$3,$4)`, [SHOP, ROTEM, il(D, '23:45'), il('2026-11-11', '00:15')]));
      expect(err?.message).toBe('DAY_BOUNDARY');
    });
  });

  describe('crossed-out slots', () => {
    it('a blocked slot is stored per staff member and prevents bookings over it', async () => {
      await tablet.query(
        `insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at, is_blocked)
         values ($1,$2,'חסום',$3,$4,true)`, [SHOP, ROTEM, il(D, '13:00'), il(D, '13:30')]);
      expect((await errorOf(book(phone, ROTEM, D, '13:00', '13:30')))?.code).toBe('23P01');
      expect(await errorOf(book(phone, SIVAN, D, '13:00', '13:30'))).toBeNull();
      const { rows } = await phone.query('select is_blocked from public.appointments where staff_member_id=$1', [ROTEM]);
      expect(rows).toEqual([{ is_blocked: true }]);
    });
  });

  describe('15-minute block splitting', () => {
    it('persists the split state and reads it back from another device', async () => {
      await setSplit(tablet, ROTEM, D, '09:00', true);
      expect(await splitState(phone, ROTEM, D, '09:00')).toBe(true);
    });

    it('splitting Rotem’s block does not split Sivan’s block', async () => {
      await setSplit(tablet, ROTEM, D, '09:00', true);
      expect(await splitState(phone, SIVAN, D, '09:00')).toBe(false);
    });

    it('splitting never creates an appointment', async () => {
      await setSplit(tablet, ROTEM, D, '09:00', true);
      const { rows } = await phone.query('select count(*)::int as n from public.appointments');
      expect(rows[0].n).toBe(0);
    });

    it('two different customers can book the two 15-minute halves', async () => {
      await setSplit(tablet, ROTEM, D, '09:00', true);
      await book(tablet, ROTEM, D, '09:00', '09:15', 'דניאל');
      await book(phone, ROTEM, D, '09:15', '09:30', 'אבי');
      const { rows } = await tablet.query(
        `select customer_name from public.appointments where staff_member_id=$1 order by starts_at`, [ROTEM]);
      expect(rows.map((r) => r.customer_name)).toEqual(['דניאל', 'אבי']);
    });

    it('booking a 15-minute appointment automatically marks the block split', async () => {
      await book(tablet, SIVAN, D, '09:15', '09:30');
      expect(await splitState(phone, SIVAN, D, '09:00')).toBe(true);
      expect(await splitState(phone, ROTEM, D, '09:00')).toBe(false);
    });

    it('a 30-minute appointment may span two 15-minute intervals across blocks', async () => {
      await book(tablet, ROTEM, D, '09:15', '09:45');
      expect(await splitState(tablet, ROTEM, D, '09:00')).toBe(true);
      expect(await splitState(tablet, ROTEM, D, '09:30')).toBe(true);
    });

    it('cannot split a block that is occupied by a 30-minute appointment', async () => {
      await book(tablet, ROTEM, D, '09:00', '09:30');
      const err = await errorOf(setSplit(phone, ROTEM, D, '09:00', true));
      expect(err?.message).toBe('BLOCK_OCCUPIED');
      // Sivan's block at the same time is unaffected
      expect(await errorOf(setSplit(phone, SIVAN, D, '09:00', true))).toBeNull();
    });

    it('cannot split under a longer appointment that crosses the midpoint', async () => {
      await book(tablet, ROTEM, D, '10:00', '11:00');
      expect((await errorOf(setSplit(tablet, ROTEM, D, '10:30', true)))?.message).toBe('BLOCK_OCCUPIED');
    });

    it('an empty split block returns to 30 minutes', async () => {
      await setSplit(tablet, ROTEM, D, '09:00', true);
      expect(await errorOf(setSplit(phone, ROTEM, D, '09:00', false))).toBeNull();
      expect(await splitState(tablet, ROTEM, D, '09:00')).toBe(false);
    });

    it('cannot revert a split block while a 15-minute appointment depends on it', async () => {
      const id = await book(tablet, ROTEM, D, '09:00', '09:15');
      expect((await errorOf(setSplit(tablet, ROTEM, D, '09:00', false)))?.message)
        .toBe('BLOCK_HAS_SPLIT_APPOINTMENTS');
      expect((await errorOf(tablet.query(
        'delete from public.slot_splits where staff_member_id=$1', [ROTEM])))?.message)
        .toBe('BLOCK_HAS_SPLIT_APPOINTMENTS');
      await tablet.query('delete from public.appointments where id=$1', [id]);
      expect(await errorOf(setSplit(tablet, ROTEM, D, '09:00', false))).toBeNull();
    });

    it('uses local Israel time across daylight-saving changes', async () => {
      // July = UTC+3. A 15-min appointment at local 09:00 splits the local 09:00 block.
      await book(tablet, ROTEM, '2026-07-01', '09:00', '09:15');
      const { rows } = await tablet.query(
        `select to_char(block_start_time,'HH24:MI') as t from public.slot_splits where date='2026-07-01'`);
      expect(rows).toEqual([{ t: '09:00' }]);
    });
  });

  describe('concurrent bookings from two devices', () => {
    it('only one of two simultaneous bookings for the same staff and time succeeds', async () => {
      await tablet.query('begin');
      await phone.query('begin');
      await book(tablet, ROTEM, D, '14:00', '14:30', 'מהטאבלט');
      const second = errorOf(book(phone, ROTEM, D, '14:00', '14:30', 'מהטלפון')); // waits on lock
      await tablet.query('commit');
      const err = await second;
      await phone.query('rollback');
      expect(err?.code).toBe('23P01');
      const { rows } = await tablet.query(`select customer_name from public.appointments`);
      expect(rows).toEqual([{ customer_name: 'מהטאבלט' }]);
    });

    it('simultaneous bookings for different staff at the same time both succeed', async () => {
      await tablet.query('begin');
      await phone.query('begin');
      await book(tablet, ROTEM, D, '15:00', '15:30');
      await book(phone, SIVAN, D, '15:00', '15:30'); // does not wait for the other device
      await tablet.query('commit');
      await phone.query('commit');
      const { rows } = await tablet.query('select count(*)::int as n from public.appointments');
      expect(rows[0].n).toBe(2);
    });

    it('a split racing an uncommitted 30-minute booking is rejected after it commits', async () => {
      await tablet.query('begin');
      await book(tablet, ROTEM, D, '16:00', '16:30');
      const split = errorOf(setSplit(phone, ROTEM, D, '16:00', true)); // blocks on staff lock
      await tablet.query('commit');
      expect((await split)?.message).toBe('BLOCK_OCCUPIED');
    });

    it('an unsplit racing a 15-minute booking is rejected after it commits', async () => {
      await setSplit(tablet, ROTEM, D, '17:00', true);
      await tablet.query('begin');
      await book(tablet, ROTEM, D, '17:15', '17:30');
      const unsplit = errorOf(setSplit(phone, ROTEM, D, '17:00', false));
      await tablet.query('commit');
      expect((await unsplit)?.message).toBe('BLOCK_HAS_SPLIT_APPOINTMENTS');
    });
  });

  describe('row level security', () => {
    it('a signed-in user from outside the salon sees and changes nothing', async () => {
      await book(tablet, ROTEM, D, '09:00', '09:30');
      const outsider = await deviceClient(url, OUTSIDER);
      try {
        const { rows } = await outsider.query('select * from public.appointments');
        expect(rows).toHaveLength(0);
        expect((await outsider.query('select * from public.staff_members')).rows).toHaveLength(0);
        expect((await errorOf(book(outsider, SIVAN, D, '10:00', '10:30')))?.code).toBe('42501');
        expect((await errorOf(setSplit(outsider, SIVAN, D, '10:00', true)))?.code).toBe('42501');
      } finally {
        await outsider.end();
      }
    });

    it('anonymous visitors have no access', async () => {
      const anon = await deviceClient(url, null);
      try {
        expect((await errorOf(anon.query('select * from public.appointments')))?.code).toBe('42501');
      } finally {
        await anon.end();
      }
    });

    it('staff (non-owner) cannot add staff members', async () => {
      const err = await errorOf(phone.query(
        `insert into public.staff_members (shop_id, name) values ($1, 'חדש')`, [SHOP]));
      expect(err?.code).toBe('42501');
    });
  });

  describe('realtime configuration', () => {
    it('streams appointments and splits with full row identity', async () => {
      const pub = await tablet.query(
        `select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1`);
      expect(pub.rows.map((r) => r.tablename)).toEqual(
        expect.arrayContaining(['appointments', 'slot_splits']));
      const ri = await tablet.query(
        `select relname, relreplident from pg_class where relname in ('appointments','slot_splits') order by 1`);
      expect(ri.rows).toEqual([
        { relname: 'appointments', relreplident: 'f' },
        { relname: 'slot_splits', relreplident: 'f' },
      ]);
    });
  });
});
