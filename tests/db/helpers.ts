import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export const DB_URL = process.env.TEST_DATABASE_URL;

export const SHOP = '5a10a000-0000-4000-8000-000000000001';
export const ROTEM = '5a10a000-0000-4000-8000-0000000000a1';
export const SIVAN = '5a10a000-0000-4000-8000-0000000000a2';
export const MEMBER = '11111111-1111-4111-8111-111111111111';
export const MEMBER2 = '22222222-2222-4222-8222-222222222222';
export const OUTSIDER = '33333333-3333-4333-8333-333333333333';

const root = join(__dirname, '..', '..');

/** Creates an isolated database, applies the Supabase shim + all migrations. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!DB_URL) throw new Error('TEST_DATABASE_URL not set');
  const name = `rotem_test_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = withDatabase(DB_URL, name);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('set client_min_messages = warning');
  await c.query(readFileSync(join(root, 'tests/db/supabase-shim.sql'), 'utf8'));
  const migDir = join(root, 'supabase/migrations');
  for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
    await c.query(readFileSync(join(migDir, f), 'utf8'));
  }
  await c.query(`insert into auth.users (id, email) values ($1,'rotem@x'),($2,'sivan@x'),($3,'other@x')`, [
    MEMBER, MEMBER2, OUTSIDER,
  ]);
  await c.query(`insert into public.shop_members (shop_id, user_id, role) values ($3,$1,'owner'),($3,$2,'staff')`, [
    MEMBER, MEMBER2, SHOP,
  ]);
  await c.end();

  return {
    url,
    drop: async () => {
      const a = new pg.Client({ connectionString: DB_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

function withDatabase(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** A connection that behaves like a signed-in device (role authenticated + JWT sub). */
export async function deviceClient(url: string, userId: string | null) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  if (userId) {
    await c.query('set role authenticated');
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  } else {
    await c.query(`set role anon`);
  }
  return c;
}

/** Local Israel wall time -> ISO with the correct offset for that date (handled by Postgres). */
export const il = (date: string, time: string) => `${date} ${time}:00 Asia/Jerusalem`;

export async function book(
  c: pg.Client,
  staff: string,
  date: string,
  start: string,
  end: string,
  name = 'לקוח',
) {
  const { rows } = await c.query(
    `insert into public.appointments (shop_id, staff_member_id, customer_name, starts_at, ends_at)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz) returning id`,
    [SHOP, staff, name, il(date, start), il(date, end)],
  );
  return rows[0].id as string;
}

export async function setSplit(c: pg.Client, staff: string, date: string, block: string, isSplit: boolean) {
  await c.query(
    `insert into public.slot_splits (shop_id, staff_member_id, date, block_start_time, is_split)
     values ($1, $2, $3, $4, $5)
     on conflict (staff_member_id, date, block_start_time) do update set is_split = excluded.is_split`,
    [SHOP, staff, date, block, isSplit],
  );
}

export async function splitState(c: pg.Client, staff: string, date: string, block: string) {
  const { rows } = await c.query(
    `select is_split from public.slot_splits where staff_member_id=$1 and date=$2 and block_start_time=$3`,
    [staff, date, block],
  );
  return rows[0]?.is_split ?? false;
}

export async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
}
