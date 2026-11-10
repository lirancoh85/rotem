-- Returning customers + search.
--  * customers: one record per person per salon, de-duplicated by phone (normalized)
--    and, when there is no phone, by name.
--  * appointments.customer_id is linked automatically by a trigger, so every device
--    and every code path creates/reuses customers the same way (no duplicates).
--  * search_customers / search_appointments power autocomplete and the search screen.

create or replace function public.normalize_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d is null or d = '' then null
    when d like '972%' and length(d) >= 11 then '0' || substr(d, 4)
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s;
$$;

create or replace function public.name_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'));
$$;

create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  phone         text check (phone is null or char_length(phone) <= 30),
  phone_digits  text generated always as (public.normalize_phone(phone)) stored,
  name_norm     text generated always as (public.name_key(name)) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- one customer per phone number; one phone-less customer per name
create unique index if not exists customers_shop_phone_key
  on public.customers (shop_id, phone_digits) where phone_digits is not null;
create unique index if not exists customers_shop_name_nophone_key
  on public.customers (shop_id, name_norm) where phone_digits is null;
create index if not exists customers_shop_name_idx on public.customers (shop_id, name_norm);

alter table public.appointments
  add column if not exists customer_id uuid references public.customers (id) on delete set null;
create index if not exists appointments_customer_idx on public.appointments (customer_id);

-- ---------------------------------------------------------------------------
-- Link (or create) the customer for every appointment write.
-- ---------------------------------------------------------------------------
create or replace function public.appointments_link_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  digits text := public.normalize_phone(new.customer_phone);
  key    text := public.name_key(new.customer_name);
  c      public.customers;
  found_id uuid;
begin
  if new.is_blocked then
    new.customer_id := null;
    return new;
  end if;

  -- 1) an explicitly chosen customer (autocomplete) wins, if it is compatible
  if new.customer_id is not null then
    select * into c from public.customers where id = new.customer_id and shop_id = new.shop_id;
    if found and (digits is null or c.phone_digits is null or c.phone_digits = digits) then
      if digits is not null and c.phone_digits is null then
        select id into found_id from public.customers
          where shop_id = new.shop_id and phone_digits = digits;
        if found_id is null then
          update public.customers set phone = new.customer_phone, updated_at = now() where id = c.id;
        else
          new.customer_id := found_id;   -- that phone already belongs to a customer
        end if;
      else
        update public.customers set updated_at = now() where id = c.id;
      end if;
      return new;
    end if;
    new.customer_id := null;
  end if;

  -- 2) match by phone
  if digits is not null then
    select id into found_id from public.customers where shop_id = new.shop_id and phone_digits = digits;
    if found_id is null then
      -- upgrade a phone-less customer with the same name instead of duplicating
      select id into found_id from public.customers
        where shop_id = new.shop_id and name_norm = key and phone_digits is null;
      if found_id is not null then
        update public.customers set phone = new.customer_phone, updated_at = now() where id = found_id;
      end if;
    end if;
  else
    -- 3) no phone: reuse the single customer with this name, else the phone-less one
    select id into found_id from public.customers
      where shop_id = new.shop_id and name_norm = key
      order by (phone_digits is null) desc, updated_at desc
      limit 1;
  end if;

  if found_id is null then
    insert into public.customers (shop_id, name, phone)
    values (new.shop_id, btrim(new.customer_name), nullif(btrim(coalesce(new.customer_phone, '')), ''))
    on conflict do nothing
    returning id into found_id;
    if found_id is null then -- created concurrently by another device
      select id into found_id from public.customers
        where shop_id = new.shop_id
          and ((digits is not null and phone_digits = digits) or (digits is null and name_norm = key and phone_digits is null));
    end if;
  else
    update public.customers set updated_at = now() where id = found_id;
  end if;

  new.customer_id := found_id;
  return new;
end;
$$;

revoke all on function public.appointments_link_customer() from public, anon, authenticated;

drop trigger if exists appointments_link_customer on public.appointments;
create trigger appointments_link_customer
  before insert or update of customer_name, customer_phone, customer_id, is_blocked on public.appointments
  for each row execute function public.appointments_link_customer();

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.customers enable row level security;
revoke all on public.customers from anon;
grant select, insert, update on public.customers to authenticated;

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using ((select public.is_shop_member(shop_id)));
drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers for insert to authenticated
  with check ((select public.is_shop_member(shop_id)));
drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers for update to authenticated
  using ((select public.is_shop_member(shop_id))) with check ((select public.is_shop_member(shop_id)));

-- ---------------------------------------------------------------------------
-- Search (security invoker: RLS applies to the caller)
-- ---------------------------------------------------------------------------
create or replace function public.like_escape(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(coalesce(p, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$;

create or replace function public.search_customers(p_shop uuid, p_query text, p_limit int default 8)
returns table (id uuid, name text, phone text, visits bigint, last_visit timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select public.name_key(p_query) as k, public.normalize_phone(p_query) as d
  )
  select c.id, c.name, c.phone,
         (select count(*) from public.appointments a where a.customer_id = c.id) as visits,
         (select max(a.starts_at) from public.appointments a where a.customer_id = c.id) as last_visit
  from public.customers c, q
  where c.shop_id = p_shop
    and q.k <> ''
    and (
      c.name_norm like '%' || public.like_escape(q.k) || '%'
      or (q.d is not null and length(q.d) >= 3 and c.phone_digits like '%' || q.d || '%')
    )
  order by (c.name_norm like public.like_escape(q.k) || '%') desc, c.updated_at desc
  limit least(greatest(p_limit, 1), 20);
$$;

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

revoke all on function public.search_customers(uuid, text, int) from public, anon;
revoke all on function public.search_appointments(uuid, text, date, int) from public, anon;
grant execute on function public.search_customers(uuid, text, int) to authenticated;
grant execute on function public.search_appointments(uuid, text, date, int) to authenticated;
grant execute on function public.shop_timezone(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: link every existing appointment to a customer (data is preserved).
-- ---------------------------------------------------------------------------
update public.appointments set customer_id = null where customer_id is null and not is_blocked;
