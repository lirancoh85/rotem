-- 1) Correct the staff member's name: סיון → סיוון (same row/id, so all
--    appointments, splits and customers stay linked; nothing is duplicated).
update public.staff_members
   set name = 'סיוון'
 where id = '5a10a000-0000-4000-8000-0000000000a2' and name = 'סיון';

-- 2) First-time customers.
--    A customer's first visit is their earliest remaining appointment (by start time;
--    ties broken by creation time, then id). Identity is the customer record, which is
--    de-duplicated by phone number (then name) when appointments are saved.
--    Cancelled appointments are deleted, so they never count. Crossed-out slots have
--    no customer and never count.
create index if not exists appointments_customer_start_idx
  on public.appointments (customer_id, starts_at) where customer_id is not null;

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
    and not exists (
      select 1 from public.appointments b
      where b.customer_id = a.customer_id
        and not b.is_blocked
        and b.id <> a.id
        and (b.starts_at, b.created_at, b.id) < (a.starts_at, a.created_at, a.id)
    );
$$;

revoke all on function public.first_visit_ids(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.first_visit_ids(uuid, timestamptz, timestamptz) to authenticated;
