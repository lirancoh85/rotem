-- Row Level Security, realtime and initial salon data.

-- ---------------------------------------------------------------------------
-- Membership helper (security definer avoids recursive RLS on shop_members)
-- ---------------------------------------------------------------------------
create or replace function public.is_shop_member(p_shop uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_shop_owner(p_shop uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

revoke all on function public.is_shop_member(uuid) from public, anon;
revoke all on function public.is_shop_owner(uuid) from public, anon;
grant execute on function public.is_shop_member(uuid) to authenticated;
grant execute on function public.is_shop_owner(uuid) to authenticated;
revoke all on function public.lock_staff_schedule(uuid) from public, anon;
revoke all on function public.shop_timezone(uuid) from public, anon;
revoke all on function public.appointments_before_write() from public, anon, authenticated;
revoke all on function public.appointments_after_write() from public, anon, authenticated;
revoke all on function public.slot_splits_guard() from public, anon, authenticated;

alter table public.shops         enable row level security;
alter table public.shop_members  enable row level security;
alter table public.staff_members enable row level security;
alter table public.appointments  enable row level security;
alter table public.slot_splits   enable row level security;

-- No access at all for anonymous visitors.
revoke all on public.shops, public.shop_members, public.staff_members,
              public.appointments, public.slot_splits from anon;
grant select, update on public.shops to authenticated;
grant select on public.shop_members to authenticated;
grant select, insert, update on public.staff_members to authenticated;
grant select, insert, update, delete on public.appointments to authenticated;
grant select, insert, update, delete on public.slot_splits to authenticated;

-- shops
drop policy if exists shops_select on public.shops;
create policy shops_select on public.shops for select to authenticated
  using ((select public.is_shop_member(id)));
drop policy if exists shops_update on public.shops;
create policy shops_update on public.shops for update to authenticated
  using ((select public.is_shop_member(id))) with check ((select public.is_shop_member(id)));

-- shop_members: a user sees their own memberships
drop policy if exists shop_members_select on public.shop_members;
create policy shop_members_select on public.shop_members for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_shop_member(shop_id)));

-- staff_members: members read; owners manage
drop policy if exists staff_select on public.staff_members;
create policy staff_select on public.staff_members for select to authenticated
  using ((select public.is_shop_member(shop_id)));
drop policy if exists staff_insert on public.staff_members;
create policy staff_insert on public.staff_members for insert to authenticated
  with check ((select public.is_shop_owner(shop_id)));
drop policy if exists staff_update on public.staff_members;
create policy staff_update on public.staff_members for update to authenticated
  using ((select public.is_shop_owner(shop_id))) with check ((select public.is_shop_owner(shop_id)));

-- appointments: any member of the shop manages the shop's diary
drop policy if exists appointments_select on public.appointments;
create policy appointments_select on public.appointments for select to authenticated
  using ((select public.is_shop_member(shop_id)));
drop policy if exists appointments_insert on public.appointments;
create policy appointments_insert on public.appointments for insert to authenticated
  with check ((select public.is_shop_member(shop_id)));
drop policy if exists appointments_update on public.appointments;
create policy appointments_update on public.appointments for update to authenticated
  using ((select public.is_shop_member(shop_id))) with check ((select public.is_shop_member(shop_id)));
drop policy if exists appointments_delete on public.appointments;
create policy appointments_delete on public.appointments for delete to authenticated
  using ((select public.is_shop_member(shop_id)));

-- slot_splits
drop policy if exists slot_splits_select on public.slot_splits;
create policy slot_splits_select on public.slot_splits for select to authenticated
  using ((select public.is_shop_member(shop_id)));
drop policy if exists slot_splits_insert on public.slot_splits;
create policy slot_splits_insert on public.slot_splits for insert to authenticated
  with check ((select public.is_shop_member(shop_id)));
drop policy if exists slot_splits_update on public.slot_splits;
create policy slot_splits_update on public.slot_splits for update to authenticated
  using ((select public.is_shop_member(shop_id))) with check ((select public.is_shop_member(shop_id)));
drop policy if exists slot_splits_delete on public.slot_splits;
create policy slot_splits_delete on public.slot_splits for delete to authenticated
  using ((select public.is_shop_member(shop_id)));

-- ---------------------------------------------------------------------------
-- Realtime: appointments + splits stream to every signed-in device
-- ---------------------------------------------------------------------------
alter table public.appointments replica identity full;
alter table public.slot_splits  replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments') then
      execute 'alter publication supabase_realtime add table public.appointments';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'slot_splits') then
      execute 'alter publication supabase_realtime add table public.slot_splits';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shops') then
      execute 'alter publication supabase_realtime add table public.shops';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Seed: the salon and its two staff members (fixed ids, idempotent)
-- ---------------------------------------------------------------------------
insert into public.shops (id, name, timezone, day_start, day_end)
values ('5a10a000-0000-4000-8000-000000000001', 'רותם עדני', 'Asia/Jerusalem', '08:00', '20:00')
on conflict (id) do nothing;

insert into public.staff_members (id, shop_id, name, display_order)
values
  ('5a10a000-0000-4000-8000-0000000000a1', '5a10a000-0000-4000-8000-000000000001', 'רותם', 1),
  ('5a10a000-0000-4000-8000-0000000000a2', '5a10a000-0000-4000-8000-000000000001', 'סיון', 2)
on conflict (id) do nothing;
