-- Crossed-out (blocked) slots: stored as an appointment row with is_blocked = true,
-- so they get the same per-staff overlap protection and realtime sync.
alter table public.appointments add column if not exists is_blocked boolean not null default false;
