-- רותם עדני — appointment system schema
-- Shops, members, staff, appointments (per-staff, no overlap) and 15-minute block splits.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Shops & membership
-- ---------------------------------------------------------------------------
create table if not exists public.shops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  timezone    text not null default 'Asia/Jerusalem',
  day_start   time not null default '08:00',
  day_end     time not null default '20:00',
  created_at  timestamptz not null default now(),
  constraint shops_hours_valid check (day_end > day_start
    and extract(minute from day_start) in (0, 30)
    and extract(minute from day_end) in (0, 30))
);

create table if not exists public.shop_members (
  shop_id    uuid not null references public.shops (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index if not exists shop_members_user_idx on public.shop_members (user_id);

-- ---------------------------------------------------------------------------
-- Staff members (רותם, סיוון)
-- ---------------------------------------------------------------------------
create table if not exists public.staff_members (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 40),
  display_order int  not null default 0,
  active        boolean not null default true,
  user_id       uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint staff_members_id_shop_key unique (id, shop_id),
  constraint staff_members_shop_name_key unique (shop_id, name)
);

-- ---------------------------------------------------------------------------
-- Appointments — each belongs to exactly one staff member.
-- Overlaps are prohibited per staff member (not across the salon).
-- ---------------------------------------------------------------------------
create table if not exists public.appointments (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null,
  staff_member_id  uuid not null,
  customer_name    text not null check (char_length(btrim(customer_name)) between 1 and 80),
  customer_phone   text check (customer_phone is null or char_length(customer_phone) <= 30),
  service          text check (service is null or char_length(service) <= 80),
  notes            text check (notes is null or char_length(notes) <= 500),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint appointments_staff_fk foreign key (staff_member_id, shop_id)
    references public.staff_members (id, shop_id) on delete restrict,
  constraint appointments_time_order check (ends_at > starts_at),
  constraint appointments_max_length check (ends_at - starts_at <= interval '4 hours'),
  -- every boundary sits on the 15-minute grid
  constraint appointments_quarter_grid check (
    (extract(epoch from starts_at))::bigint % 900 = 0
    and (extract(epoch from ends_at))::bigint % 900 = 0),
  -- THE key rule: no two appointments of the same staff member may overlap.
  -- Enforced atomically by Postgres, so concurrent bookings cannot both succeed.
  constraint appointments_no_overlap_per_staff exclude using gist (
    staff_member_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&)
);
create index if not exists appointments_shop_start_idx on public.appointments (shop_id, starts_at);

-- ---------------------------------------------------------------------------
-- 15-minute splitting of 30-minute blocks, independent per staff member.
-- No row (or is_split = false) => normal 30-minute block.
-- ---------------------------------------------------------------------------
create table if not exists public.slot_splits (
  shop_id          uuid not null,
  staff_member_id  uuid not null,
  date             date not null,
  block_start_time time not null,
  is_split         boolean not null default true,
  updated_at       timestamptz not null default now(),
  primary key (staff_member_id, date, block_start_time),
  constraint slot_splits_staff_fk foreign key (staff_member_id, shop_id)
    references public.staff_members (id, shop_id) on delete cascade,
  constraint slot_splits_block_aligned check (
    extract(minute from block_start_time) in (0, 30)
    and extract(second from block_start_time) = 0)
);
create index if not exists slot_splits_shop_date_idx on public.slot_splits (shop_id, date);
