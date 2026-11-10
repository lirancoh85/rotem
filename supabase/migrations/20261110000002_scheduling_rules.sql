-- Scheduling rules enforced in the database, so every device obeys them
-- regardless of client version, and concurrent writes stay consistent.
--
--  * Appointment boundaries at :15/:45 automatically mark their 30-minute block
--    as split (a booking may split a block; a split never creates a booking).
--  * A block cannot be split while an appointment runs across its midpoint.
--  * A split block can return to 30 minutes only when no appointment starts or
--    ends at its midpoint (i.e. no 15-minute appointment depends on the split).
--  * All writes for one staff member are serialized with an advisory lock.

-- Serialize all schedule writes for one staff member inside the transaction.
create or replace function public.lock_staff_schedule(p_staff uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('staff_schedule:' || p_staff::text, 0));
$$;

create or replace function public.shop_timezone(p_shop uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select timezone from public.shops where id = p_shop), 'Asia/Jerusalem');
$$;

-- ---------------------------------------------------------------------------
-- appointments: BEFORE write — locking, same-day check, timestamps
-- ---------------------------------------------------------------------------
create or replace function public.appointments_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tz text;
begin
  -- lock both old and new staff (stable order avoids deadlocks when moving)
  if tg_op = 'UPDATE' and old.staff_member_id <> new.staff_member_id then
    if old.staff_member_id::text < new.staff_member_id::text then
      perform public.lock_staff_schedule(old.staff_member_id);
      perform public.lock_staff_schedule(new.staff_member_id);
    else
      perform public.lock_staff_schedule(new.staff_member_id);
      perform public.lock_staff_schedule(old.staff_member_id);
    end if;
  else
    perform public.lock_staff_schedule(new.staff_member_id);
  end if;

  if tg_op = 'UPDATE' and new.shop_id <> old.shop_id then
    raise exception 'SHOP_IMMUTABLE' using errcode = 'P0001';
  end if;

  tz := public.shop_timezone(new.shop_id);
  if (new.starts_at at time zone tz)::date
     <> ((new.ends_at - interval '1 microsecond') at time zone tz)::date then
    raise exception 'DAY_BOUNDARY' using errcode = 'P0001';
  end if;

  new.customer_name := btrim(new.customer_name);
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- appointments: AFTER write — auto-split blocks that need a 15-minute boundary
-- ---------------------------------------------------------------------------
create or replace function public.appointments_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tz text;
  b timestamptz;
  local_ts timestamp;
begin
  tz := public.shop_timezone(new.shop_id);
  foreach b in array array[new.starts_at, new.ends_at] loop
    local_ts := b at time zone tz;
    if extract(minute from local_ts) in (15, 45) then
      insert into public.slot_splits (shop_id, staff_member_id, date, block_start_time, is_split)
      values (new.shop_id, new.staff_member_id, local_ts::date,
              (local_ts - interval '15 minutes')::time, true)
      on conflict (staff_member_id, date, block_start_time)
        do update set is_split = true
        where public.slot_splits.is_split = false;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists appointments_before_write on public.appointments;
create trigger appointments_before_write
  before insert or update on public.appointments
  for each row execute function public.appointments_before_write();

drop trigger if exists appointments_after_write on public.appointments;
create trigger appointments_after_write
  after insert or update of starts_at, ends_at, staff_member_id on public.appointments
  for each row execute function public.appointments_after_write();

-- ---------------------------------------------------------------------------
-- slot_splits: guard split / unsplit transitions
-- ---------------------------------------------------------------------------
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
               where a.staff_member_id = r.staff_member_id
                 and a.starts_at < mid and a.ends_at > mid) then
      raise exception 'BLOCK_OCCUPIED' using errcode = 'P0001';
    end if;
  elsif was_split and not now_split then
    if exists (select 1 from public.appointments a
               where a.staff_member_id = r.staff_member_id
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

drop trigger if exists slot_splits_guard on public.slot_splits;
create trigger slot_splits_guard
  before insert or update or delete on public.slot_splits
  for each row execute function public.slot_splits_guard();
