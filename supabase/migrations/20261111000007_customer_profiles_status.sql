-- Phase 1: customer profiles & booking history.
--  * appointments.status: booked | cancelled | no_show  (cancel keeps history instead of deleting)
--  * overlap rule ignores cancelled appointments (the slot becomes free again)
--  * customers.notes / preferences
--  * list_customers / customer_profile / update_customer RPCs
-- Existing rows default to 'booked' — all current bookings are preserved unchanged.

alter table public.appointments
  add column if not exists status text not null default 'booked',
  add column if not exists cancelled_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_status_check') then
    alter table public.appointments add constraint appointments_status_check
      check (status in ('booked', 'cancelled', 'no_show'));
  end if;
end $$;

-- per-staff no-overlap, now only between appointments that still hold the slot
alter table public.appointments drop constraint if exists appointments_no_overlap_per_staff;
alter table public.appointments add constraint appointments_no_overlap_per_staff exclude using gist (
  staff_member_id with =,
  tstzrange(starts_at, ends_at, '[)') with &&) where (status <> 'cancelled');

create index if not exists appointments_shop_status_start_idx on public.appointments (shop_id, status, starts_at);

-- cancelled_at bookkeeping (runs after appointments_before_write: name order)
create or replace function public.appointments_status_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') then
    new.cancelled_at := now();
  elsif new.status <> 'cancelled' then
    new.cancelled_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists appointments_status_stamp on public.appointments;
create trigger appointments_status_stamp
  before insert or update of status on public.appointments
  for each row execute function public.appointments_status_stamp();

-- split rules: cancelled appointments no longer occupy a block
create or replace function public.slot_splits_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      public.slot_splits;
  tz     text;
  mid    timestamptz;
  was_split boolean;
  now_split boolean;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  if tg_op = 'UPDATE' and (new.staff_member_id, new.date, new.block_start_time, new.shop_id)
        is distinct from (old.staff_member_id, old.date, old.block_start_time, old.shop_id) then
    raise exception 'SPLIT_KEY_IMMUTABLE' using errcode = 'P0001';
  end if;

  perform public.lock_staff_schedule(r.staff_member_id);

  tz  := public.shop_timezone(r.shop_id);
  mid := ((r.date + r.block_start_time) + interval '15 minutes') at time zone tz;

  was_split := case when tg_op = 'INSERT' then false else old.is_split end;
  now_split := case when tg_op = 'DELETE' then false else new.is_split end;

  if now_split and not was_split then
    if exists (select 1 from public.appointments a
               where a.staff_member_id = r.staff_member_id and a.status <> 'cancelled'
                 and a.starts_at < mid and a.ends_at > mid) then
      raise exception 'BLOCK_OCCUPIED' using errcode = 'P0001';
    end if;
  elsif was_split and not now_split then
    if exists (select 1 from public.appointments a
               where a.staff_member_id = r.staff_member_id and a.status <> 'cancelled'
                 and (a.starts_at = mid or a.ends_at = mid)) then
      raise exception 'BLOCK_HAS_SPLIT_APPOINTMENTS' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- first visits: cancelled appointments and no-shows are not visits
create or replace function public.first_visit_ids(p_shop uuid, p_from timestamptz, p_to timestamptz)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select a.id
  from public.appointments a
  where a.shop_id = p_shop
    and a.starts_at >= p_from and a.starts_at < p_to
    and a.customer_id is not null
    and not a.is_blocked
    and a.status = 'booked'
    and not exists (
      select 1 from public.appointments b
      where b.customer_id = a.customer_id
        and not b.is_blocked
        and b.status = 'booked'
        and b.id <> a.id
        and (b.starts_at, b.created_at, b.id) < (a.starts_at, a.created_at, a.id)
    );
$$;

-- search never returns cancelled appointments
create or replace function public.search_appointments(p_shop uuid, p_query text, p_date date default null, p_limit int default 60)
returns setof public.appointments
language sql
stable
security invoker
set search_path = ''
as $$
  select a.*
  from public.appointments a
  where a.shop_id = p_shop
    and not a.is_blocked
    and a.status <> 'cancelled'
    and (
      (p_date is not null
        and a.starts_at >= (p_date::timestamp at time zone public.shop_timezone(p_shop))
        and a.starts_at <  ((p_date + 1)::timestamp at time zone public.shop_timezone(p_shop)))
      or (p_date is null and public.name_key(p_query) <> '' and (
            public.name_key(a.customer_name) like '%' || public.like_escape(public.name_key(p_query)) || '%'
            or (length(coalesce(public.normalize_phone(p_query), '')) >= 3
                and public.normalize_phone(a.customer_phone) like '%' || public.normalize_phone(p_query) || '%')))
    )
  order by a.starts_at desc
  limit least(greatest(p_limit, 1), 200);
$$;

-- ---------------------------------------------------------------------------
-- Customer profile fields
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists notes text check (notes is null or char_length(notes) <= 2000),
  add column if not exists preferences text check (preferences is null or char_length(preferences) <= 2000);

-- New: no completed visit yet, or just the first one. Returning: 2+ visits.
-- Inactive: has visited, but not in the last 90 days and nothing booked ahead.
create or replace function public.customer_status(p_completed bigint, p_last timestamptz, p_next timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_completed >= 1 and p_next is null and p_last < now() - interval '90 days' then 'inactive'
    when p_completed >= 2 then 'returning'
    else 'new'
  end;
$$;

create or replace view public.customer_stats
with (security_invoker = true) as
select
  c.id as customer_id,
  c.shop_id,
  count(a.id) filter (where a.status = 'booked' and a.ends_at <= now())             as completed_visits,
  count(a.id) filter (where a.status = 'booked' and a.starts_at > now())            as upcoming_count,
  count(a.id) filter (where a.status = 'cancelled')                                  as cancelled_count,
  count(a.id) filter (where a.status = 'no_show')                                    as no_show_count,
  min(a.starts_at) filter (where a.status = 'booked')                                as first_visit,
  max(a.starts_at) filter (where a.status = 'booked' and a.ends_at <= now())         as last_visit,
  min(a.starts_at) filter (where a.status = 'booked' and a.starts_at > now())        as next_visit
from public.customers c
left join public.appointments a on a.customer_id = c.id and not a.is_blocked
group by c.id, c.shop_id;

create or replace function public.list_customers(p_shop uuid, p_query text default '', p_limit int default 50, p_offset int default 0)
returns table (
  id uuid, name text, phone text, notes text, preferences text,
  completed_visits bigint, upcoming_count bigint, cancelled_count bigint, no_show_count bigint,
  first_visit timestamptz, last_visit timestamptz, next_visit timestamptz, status text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (select public.name_key(p_query) as k, public.normalize_phone(p_query) as d)
  select c.id, c.name, c.phone, c.notes, c.preferences,
         s.completed_visits, s.upcoming_count, s.cancelled_count, s.no_show_count,
         s.first_visit, s.last_visit, s.next_visit,
         public.customer_status(s.completed_visits, s.last_visit, s.next_visit)
  from public.customers c
  join public.customer_stats s on s.customer_id = c.id, q
  where c.shop_id = p_shop
    and (q.k = ''
         or c.name_norm like '%' || public.like_escape(q.k) || '%'
         or (q.d is not null and length(q.d) >= 3 and c.phone_digits like '%' || q.d || '%'))
  order by coalesce(s.next_visit, s.last_visit, c.updated_at) desc nulls last, c.name
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
$$;

create or replace function public.customer_profile(p_customer uuid)
returns json
language sql
stable
security invoker
set search_path = ''
as $$
  select json_build_object(
    'customer', json_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'notes', c.notes, 'preferences', c.preferences),
    'stats', json_build_object(
      'completed_visits', s.completed_visits, 'upcoming_count', s.upcoming_count,
      'cancelled_count', s.cancelled_count, 'no_show_count', s.no_show_count,
      'first_visit', s.first_visit, 'last_visit', s.last_visit, 'next_visit', s.next_visit,
      'status', public.customer_status(s.completed_visits, s.last_visit, s.next_visit)),
    'appointments', coalesce((
      select json_agg(json_build_object(
        'id', a.id, 'shop_id', a.shop_id, 'staff_member_id', a.staff_member_id, 'customer_name', a.customer_name,
        'customer_phone', a.customer_phone, 'service', a.service, 'notes', a.notes, 'starts_at', a.starts_at,
        'ends_at', a.ends_at, 'is_blocked', a.is_blocked, 'customer_id', a.customer_id, 'status', a.status,
        'updated_at', a.updated_at) order by a.starts_at)
      from public.appointments a where a.customer_id = c.id and not a.is_blocked), '[]'::json)
  )
  from public.customers c
  join public.customer_stats s on s.customer_id = c.id
  where c.id = p_customer;
$$;

-- edit a customer; their appointments show the new name/phone (same customer id, no duplicates)
create or replace function public.update_customer(p_customer uuid, p_name text, p_phone text, p_notes text, p_preferences text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'NAME_REQUIRED' using errcode = 'P0001';
  end if;
  update public.customers
     set name = btrim(p_name),
         phone = nullif(btrim(coalesce(p_phone, '')), ''),
         notes = nullif(btrim(coalesce(p_notes, '')), ''),
         preferences = nullif(btrim(coalesce(p_preferences, '')), ''),
         updated_at = now()
   where id = p_customer;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  update public.appointments
     set customer_name = btrim(p_name), customer_phone = nullif(btrim(coalesce(p_phone, '')), '')
   where customer_id = p_customer
     and (customer_name is distinct from btrim(p_name)
          or customer_phone is distinct from nullif(btrim(coalesce(p_phone, '')), ''));
end;
$$;

revoke all on function public.list_customers(uuid, text, int, int) from public, anon;
revoke all on function public.customer_profile(uuid) from public, anon;
revoke all on function public.update_customer(uuid, text, text, text, text) from public, anon;
grant execute on function public.list_customers(uuid, text, int, int) to authenticated;
grant execute on function public.customer_profile(uuid) to authenticated;
grant execute on function public.update_customer(uuid, text, text, text, text) to authenticated;
grant execute on function public.customer_status(bigint, timestamptz, timestamptz) to authenticated;
revoke all on public.customer_stats from anon;
grant select on public.customer_stats to authenticated;
