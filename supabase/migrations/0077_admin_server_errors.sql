-- The admin billing page failed intermittently with only a generic Next error
-- page visible (edge logs show small 200s; wrangler tail is unreliable).
-- House doctrine: failures must persist their cause so diagnosis is a SELECT.
-- Server-side page loaders write their exception here before rethrowing.

create table public.admin_server_errors (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope ~ '^[a-z0-9_]{1,80}$'),
  message text not null,
  stack text,
  created_at timestamptz not null default now()
);

alter table public.admin_server_errors enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads
-- and writes this table.
grant select, insert on public.admin_server_errors to service_role;
