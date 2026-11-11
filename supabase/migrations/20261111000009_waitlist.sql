-- Phase 3: smart waiting list (manual WhatsApp offers — no paid API).
--  * waitlist_requests: who is waiting, for what, which dates and time range
--  * waitlist_offers:   slots offered to a request (sent / accepted / declined / expired)
--  * accept_offer:      books the slot atomically; if it was taken meanwhile the offer
--                       expires instead (the per-staff exclusion constraint decides)

create table if not exists public.waitlist_requests (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  customer_id      uuid references public.customers (id) on delete set null,
  customer_name    text not null check (char_length(btrim(customer_name)) between 1 and 80),
  customer_phone   text check (customer_phone is null or char_length(customer_phone) <= 30),
  service          text check (service is null or char_length(service) <= 80),
  duration_minutes int not null default 30 check (duration_minutes between 15 and 240 and duration_minutes % 15 = 0),
  staff_member_id  uuid,               -- null = any staff member
  preferred_dates  date[] not null check (cardinality(preferred_dates) between 1 and 31),
  time_from        time not null default '08:00',
  time_to          time not null default '20:00',
  notes            text check (notes is null or char_length(notes) <= 500),
  status           text not null default 'waiting' check (status in ('waiting', 'booked', 'removed')),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint waitlist_time_range check (time_to > time_from),
  constraint waitlist_staff_fk foreign key (staff_member_id, shop_id) references public.staff_members (id, shop_id)
);
create index if not exists waitlist_requests_shop_status_idx on public.waitlist_requests (shop_id, status);

create table if not exists public.waitlist_offers (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  request_id       uuid not null references public.waitlist_requests (id) on delete cascade,
  staff_member_id  uuid not null,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'sent' check (status in ('sent', 'accepted', 'declined', 'expired')),
  appointment_id   uuid references public.appointments (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint waitlist_offer_time check (ends_at > starts_at),
  constraint waitlist_offer_staff_fk foreign key (staff_member_id, shop_id) references public.staff_members (id, shop_id)
);
create index if not exists waitlist_offers_request_idx on public.waitlist_offers (request_id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists waitlist_requests_touch on public.waitlist_requests;
create trigger waitlist_requests_touch before update on public.waitlist_requests for each row execute function public.touch_updated_at();
drop trigger if exists waitlist_offers_touch on public.waitlist_offers;
create trigger waitlist_offers_touch before update on public.waitlist_offers for each row execute function public.touch_updated_at();

-- link a waiting customer to their existing profile (phone first, then name)
create or replace function public.waitlist_link_customer()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if new.customer_id is null then
    select id into v from public.customers
     where shop_id = new.shop_id
       and ((public.normalize_phone(new.customer_phone) is not null and phone_digits = public.normalize_phone(new.customer_phone))
            or (public.normalize_phone(new.customer_phone) is null and name_norm = public.name_key(new.customer_name)))
     order by (phone_digits is not null) desc limit 1;
    new.customer_id := v;
  end if;
  return new;
end; $$;
revoke all on function public.waitlist_link_customer() from public, anon, authenticated;
drop trigger if exists waitlist_link_customer on public.waitlist_requests;
create trigger waitlist_link_customer before insert or update of customer_name, customer_phone on public.waitlist_requests
  for each row execute function public.waitlist_link_customer();

alter table public.waitlist_requests enable row level security;
alter table public.waitlist_offers enable row level security;
revoke all on public.waitlist_requests, public.waitlist_offers from anon;
grant select, insert, update, delete on public.waitlist_requests, public.waitlist_offers to authenticated;

drop policy if exists waitlist_requests_all on public.waitlist_requests;
create policy waitlist_requests_all on public.waitlist_requests for all to authenticated
  using ((select public.is_shop_member(shop_id))) with check ((select public.is_shop_member(shop_id)));
drop policy if exists waitlist_offers_all on public.waitlist_offers;
create policy waitlist_offers_all on public.waitlist_offers for all to authenticated
  using ((select public.is_shop_member(shop_id))) with check ((select public.is_shop_member(shop_id)));

-- ---------------------------------------------------------------------------
-- accept_offer: the customer said yes → book it (or expire the offer if the slot is gone)
-- returns { ok, appointment_id, reason }
-- ---------------------------------------------------------------------------
create or replace function public.accept_offer(p_offer uuid)
returns json
language plpgsql
security invoker
set search_path = ''
as $$
declare
  o public.waitlist_offers;
  r public.waitlist_requests;
  v_appt uuid;
begin
  select * into o from public.waitlist_offers where id = p_offer for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if o.status = 'accepted' then
    return json_build_object('ok', true, 'appointment_id', o.appointment_id, 'reason', null); -- repeated click
  end if;
  if o.status <> 'sent' then
    return json_build_object('ok', false, 'appointment_id', null, 'reason', 'OFFER_CLOSED');
  end if;
  select * into r from public.waitlist_requests where id = o.request_id for update;

  begin
    insert into public.appointments (shop_id, staff_member_id, customer_name, customer_phone, customer_id, service, notes, starts_at, ends_at)
    values (o.shop_id, o.staff_member_id, r.customer_name, r.customer_phone, r.customer_id, r.service, r.notes, o.starts_at, o.ends_at)
    returning id into v_appt;
  exception when exclusion_violation then
    update public.waitlist_offers set status = 'expired' where id = o.id;
    return json_build_object('ok', false, 'appointment_id', null, 'reason', 'SLOT_TAKEN');
  end;

  update public.waitlist_offers set status = 'accepted', appointment_id = v_appt where id = o.id;
  update public.waitlist_offers set status = 'expired' where request_id = r.id and id <> o.id and status = 'sent';
  update public.waitlist_requests set status = 'booked' where id = r.id;
  return json_build_object('ok', true, 'appointment_id', v_appt, 'reason', null);
end;
$$;
revoke all on function public.accept_offer(uuid) from public, anon;
grant execute on function public.accept_offer(uuid) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'waitlist_requests') then
      execute 'alter publication supabase_realtime add table public.waitlist_requests';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'waitlist_offers') then
      execute 'alter publication supabase_realtime add table public.waitlist_offers';
    end if;
  end if;
end $$;
