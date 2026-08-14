-- =============================================================================
-- 0038 - Skipping a client's billing cycle.
--
-- Sometimes the agency decides a client owes nothing for a week: a goodwill
-- gesture after a bad experience, a service interruption, a commercial
-- agreement. Until now the only way to express that was not to issue the
-- invoice and hope nobody re-ran the automation.
--
-- This records the decision instead. A skip is a small, append-only,
-- admin-attributed fact about ONE client and ONE closed-week period. No
-- invoice is created: the engine simply treats that client/week as nothing to
-- pay. The certified Google evidence, the ledger rows and the boundaries are
-- untouched and remain auditable — a skip forgives the fee, it does not
-- rewrite what Google reported.
--
-- A week that already carries a real invoice cannot be skipped: that money has
-- left the building (it may be sent, paid, or awaiting payment in Stripe), and
-- cancelling it is a credit-note problem, not a skip.
-- =============================================================================

create table if not exists public.billing_cycle_skips (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  reason text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (client_id, period_start),
  constraint billing_cycle_skips_period_shape check (
    extract(isodow from period_start) = 1
    and period_end = period_start + 6
  ),
  constraint billing_cycle_skips_reason_length check (
    reason is null or length(reason) <= 500
  )
);

comment on table public.billing_cycle_skips is
  'Weeks an admin decided a client owes nothing for. Consulted by the billing engine, which then issues no invoice for that client/week. Never alters Google evidence.';

create index if not exists billing_cycle_skips_period_idx
  on public.billing_cycle_skips (period_start);

alter table public.billing_cycle_skips enable row level security;

-- Readable by the team and by the client it belongs to (the portal can then
-- show "no charge this week" instead of an unexplained gap). Writes go through
-- the RPCs below only.
drop policy if exists billing_cycle_skips_read on public.billing_cycle_skips;
create policy billing_cycle_skips_read on public.billing_cycle_skips
  for select
  using (public.is_admin() or public.is_client_member(client_id));

revoke insert, update, delete on table public.billing_cycle_skips
  from public, anon, authenticated, service_role;

/**
 * Record that a client owes nothing for one closed-week period.
 *
 * Refuses when the week already has an invoice of its own: an issued
 * settlement is Stripe's problem from that point on.
 */
create or replace function public.skip_billing_cycle(
  p_client_id uuid,
  p_period_start date,
  p_period_end date,
  p_reason text,
  p_created_by uuid
)
returns setof public.billing_cycle_skips
language plpgsql
security definer
set search_path = public
as $$
declare
  created public.billing_cycle_skips;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can skip a billing cycle.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_created_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required to skip a billing cycle.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.portal_clients client where client.id = p_client_id
  ) then
    raise exception 'That client does not exist.'
      using errcode = '22023';
  end if;

  if extract(isodow from p_period_start) <> 1
     or p_period_end <> p_period_start + 6 then
    raise exception 'A billing cycle runs Monday to Sunday.'
      using errcode = '22023';
  end if;

  -- An invoice already exists for this week: void/waived rows are settled
  -- history and do not block the decision, but anything payable does.
  if exists (
    select 1 from public.invoices invoice
    where invoice.client_id = p_client_id
      and invoice.period_start = p_period_start
      and invoice.status not in ('void', 'waived')
  ) then
    raise exception 'This week is already invoiced; skipping it would not undo the charge.'
      using errcode = '22023';
  end if;

  insert into public.billing_cycle_skips (
    client_id, period_start, period_end, reason, created_by
  ) values (
    p_client_id,
    p_period_start,
    p_period_end,
    nullif(btrim(coalesce(p_reason, '')), ''),
    p_created_by
  )
  on conflict (client_id, period_start) do nothing
  returning * into created;

  if created.id is null then
    select * into created
    from public.billing_cycle_skips
    where client_id = p_client_id and period_start = p_period_start;
  end if;

  return next created;
end
$$;

/**
 * Undo a skip that has not yet been acted on. A mis-selected client is a
 * money decision made by hand, so it must be reversible from the dashboard.
 */
create or replace function public.remove_billing_cycle_skip(
  p_client_id uuid,
  p_period_start date,
  p_removed_by uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  removed_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can remove a billing cycle skip.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_removed_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required to remove a billing cycle skip.'
      using errcode = '42501';
  end if;

  delete from public.billing_cycle_skips
  where client_id = p_client_id and period_start = p_period_start
  returning id into removed_id;

  return removed_id is not null;
end
$$;

revoke all on function public.skip_billing_cycle(uuid, date, date, text, uuid)
  from public, anon, authenticated;
revoke all on function public.remove_billing_cycle_skip(uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function public.skip_billing_cycle(uuid, date, date, text, uuid)
  to service_role;
grant execute on function public.remove_billing_cycle_skip(uuid, date, uuid)
  to service_role;
