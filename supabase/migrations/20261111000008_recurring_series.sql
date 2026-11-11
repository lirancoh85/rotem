-- Phase 2: recurring appointments.
--  * shops.closed_weekdays (0 = Sunday … 6 = Saturday) — used to flag closed days
--  * appointment_series + appointments.series_id / series_index
--  * create_series: all occurrences in one transaction, never overwrites (per-staff
--    exclusion constraint), idempotent per request_key (double submit → same series)
--  * cancel_series / update_series_future: "this and following" or "all upcoming"

alter table public.shops
  add column if not exists closed_weekdays smallint[] not null default '{6}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shops_closed_weekdays_check') then
    alter table public.shops add constraint shops_closed_weekdays_check
      check (closed_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]);
  end if;
end $$;

create table if not exists public.appointment_series (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  request_key      uuid not null,
  staff_member_id  uuid not null,
  customer_id      uuid references public.customers (id) on delete set null,
  customer_name    text not null,
  interval_weeks   int not null check (interval_weeks between 1 and 52),
  duration_minutes int not null check (duration_minutes between 15 and 240 and duration_minutes % 15 = 0),
  service          text,
  notes            text,
  ends_on          date,
  occurrence_count int check (occurrence_count is null or occurrence_count between 1 and 104),
  status           text not null default 'active' check (status in ('active', 'cancelled')),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  constraint appointment_series_staff_fk foreign key (staff_member_id, shop_id)
    references public.staff_members (id, shop_id),
  constraint appointment_series_request_key unique (shop_id, request_key)
);

alter table public.appointments
  add column if not exists series_id uuid references public.appointment_series (id) on delete set null,
  add column if not exists series_index int;
create unique index if not exists appointments_series_occurrence_key
  on public.appointments (series_id, series_index) where series_id is not null;

alter table public.appointment_series enable row level security;
revoke all on public.appointment_series from anon;
grant select, insert, update on public.appointment_series to authenticated;
drop policy if exists series_select on public.appointment_series;
create policy series_select on public.appointment_series for select to authenticated
  using ((select public.is_shop_member(shop_id)));
drop policy if exists series_insert on public.appointment_series;
create policy series_insert on public.appointment_series for insert to authenticated
  with check ((select public.is_shop_member(shop_id)));
drop policy if exists series_update on public.appointment_series;
create policy series_update on public.appointment_series for update to authenticated
  using ((select public.is_shop_member(shop_id))) with check ((select public.is_shop_member(shop_id)));

-- ---------------------------------------------------------------------------
-- create_series
--   p_occurrences: [{ "index": 0, "starts_at": "<iso>", "staff_id": "<uuid, optional>" }, …]
--   (conflicting dates are resolved in the app first: skipped or moved)
-- ---------------------------------------------------------------------------
create or replace function public.create_series(
  p_shop uuid, p_request_key uuid, p_staff uuid,
  p_customer_name text, p_customer_phone text, p_customer_id uuid,
  p_service text, p_notes text, p_interval_weeks int, p_duration int,
  p_ends_on date, p_count int, p_occurrences jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_series uuid;
  o jsonb;
  v_start timestamptz;
  v_customer uuid := p_customer_id;
begin
  select id into v_series from public.appointment_series where shop_id = p_shop and request_key = p_request_key;
  if found then
    return v_series; -- same request submitted again: nothing new is created
  end if;
  if p_occurrences is null or jsonb_array_length(p_occurrences) = 0 then
    raise exception 'NO_OCCURRENCES' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_occurrences) > 104 then
    raise exception 'TOO_MANY_OCCURRENCES' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointment_series (shop_id, request_key, staff_member_id, customer_id, customer_name,
      interval_weeks, duration_minutes, service, notes, ends_on, occurrence_count)
    values (p_shop, p_request_key, p_staff, p_customer_id, btrim(p_customer_name),
      p_interval_weeks, p_duration, nullif(btrim(coalesce(p_service, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
      p_ends_on, p_count)
    returning id into v_series;
  exception when unique_violation then
    -- the identical request won a race on another connection
    select id into v_series from public.appointment_series where shop_id = p_shop and request_key = p_request_key;
    return v_series;
  end;

  for o in select value from jsonb_array_elements(p_occurrences) order by (value->>'index')::int loop
    v_start := (o->>'starts_at')::timestamptz;
    begin
      insert into public.appointments (shop_id, staff_member_id, customer_name, customer_phone, customer_id,
        service, notes, starts_at, ends_at, series_id, series_index)
      values (p_shop, coalesce((o->>'staff_id')::uuid, p_staff), btrim(p_customer_name),
        nullif(btrim(coalesce(p_customer_phone, '')), ''), v_customer,
        nullif(btrim(coalesce(p_service, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
        v_start, v_start + make_interval(mins => p_duration), v_series, (o->>'index')::int)
      returning customer_id into v_customer;
    exception when exclusion_violation then
      raise exception 'SERIES_CONFLICT' using errcode = 'P0001',
        detail = to_char(v_start at time zone public.shop_timezone(p_shop), 'YYYY-MM-DD HH24:MI');
    end;
  end loop;

  update public.appointment_series set customer_id = v_customer where id = v_series and customer_id is distinct from v_customer;
  return v_series;
end;
$$;

-- cancel 'future' (this one and the following) or 'all' (every occurrence not yet started)
create or replace function public.cancel_series(p_appt uuid, p_scope text)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  a public.appointments;
  n int;
begin
  select * into a from public.appointments where id = p_appt;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if a.series_id is null then raise exception 'NOT_IN_SERIES' using errcode = 'P0001'; end if;
  if p_scope not in ('future', 'all') then raise exception 'BAD_SCOPE' using errcode = 'P0001'; end if;

  update public.appointments
     set status = 'cancelled'
   where series_id = a.series_id and status = 'booked'
     and starts_at >= case when p_scope = 'future' then a.starts_at else least(a.starts_at, now()) end;
  get diagnostics n = row_count;
  if p_scope = 'all' then
    update public.appointment_series set status = 'cancelled' where id = a.series_id;
  end if;
  return n;
end;
$$;

-- change staff / time / length / service / notes for this occurrence and all following ones
create or replace function public.update_series_future(
  p_appt uuid, p_staff uuid, p_start_minutes int, p_duration int, p_service text, p_notes text)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  a public.appointments;
  r record;
  tz text;
  v_start timestamptz;
  n int := 0;
begin
  select * into a from public.appointments where id = p_appt;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if a.series_id is null then raise exception 'NOT_IN_SERIES' using errcode = 'P0001'; end if;
  tz := public.shop_timezone(a.shop_id);

  for r in
    select id, starts_at from public.appointments
     where series_id = a.series_id and status = 'booked' and starts_at >= a.starts_at
     order by starts_at
  loop
    -- same calendar day, new local time (DST-safe: built from the local date)
    v_start := (((r.starts_at at time zone tz)::date)::timestamp + make_interval(mins => p_start_minutes)) at time zone tz;
    begin
      update public.appointments
         set staff_member_id = p_staff, starts_at = v_start, ends_at = v_start + make_interval(mins => p_duration),
             service = nullif(btrim(coalesce(p_service, '')), ''), notes = nullif(btrim(coalesce(p_notes, '')), '')
       where id = r.id;
    exception when exclusion_violation then
      raise exception 'SERIES_CONFLICT' using errcode = 'P0001',
        detail = to_char(v_start at time zone tz, 'YYYY-MM-DD HH24:MI');
    end;
    n := n + 1;
  end loop;

  update public.appointment_series
     set staff_member_id = p_staff, duration_minutes = p_duration,
         service = nullif(btrim(coalesce(p_service, '')), ''), notes = nullif(btrim(coalesce(p_notes, '')), '')
   where id = a.series_id;
  return n;
end;
$$;

revoke all on function public.create_series(uuid, uuid, uuid, text, text, uuid, text, text, int, int, date, int, jsonb) from public, anon;
revoke all on function public.cancel_series(uuid, text) from public, anon;
revoke all on function public.update_series_future(uuid, uuid, int, int, text, text) from public, anon;
grant execute on function public.create_series(uuid, uuid, uuid, text, text, uuid, text, text, int, int, date, int, jsonb) to authenticated;
grant execute on function public.cancel_series(uuid, text) to authenticated;
grant execute on function public.update_series_future(uuid, uuid, int, int, text, text) to authenticated;

-- series changes reach every device (appointments already stream)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'appointment_series') then
    execute 'alter publication supabase_realtime add table public.appointment_series';
  end if;
end $$;
