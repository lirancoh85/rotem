-- Default slot length is now 15 minutes.
-- A 30-minute block with no slot_splits row is split (two 15-minute slots).
-- "Join to 30" stores is_split = false; "split to 15" stores is_split = true (or deletes the row).
-- Existing rows keep their meaning: is_split = false blocks stay 30 minutes.

alter table public.slot_splits alter column is_split set default true;

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

  -- no row = the default, which is split
  was_split := case when tg_op = 'INSERT' then true else old.is_split end;
  now_split := case when tg_op = 'DELETE' then true else new.is_split end;

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

revoke all on function public.slot_splits_guard() from public, anon, authenticated;

-- only a block joined to 30 minutes needs re-splitting when a booking uses :15/:45
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
      update public.slot_splits
         set is_split = true
       where staff_member_id = new.staff_member_id
         and date = local_ts::date
         and block_start_time = (local_ts - interval '15 minutes')::time
         and is_split = false;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.appointments_after_write() from public, anon, authenticated;
