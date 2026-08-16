-- =============================================================================
-- 0066 - A skipped billing cycle can never become an invoice.
--
-- The skip decision and invoice creation previously checked one another only
-- from the skip side. A later invoice RPC could therefore still insert the
-- client/week. Serialize both operations on the same transaction lock and
-- make the invoice table enforce the invariant for every current or future
-- issuer, including automation.
-- =============================================================================

set local lock_timeout = '10s';
set local statement_timeout = '5min';

create or replace function public.guard_invoice_against_billing_cycle_skip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(
    hashtext(new.client_id::text),
    new.period_start - date '2000-01-01'
  );

  if exists (
    select 1
    from public.billing_cycle_skips skip
    where skip.client_id = new.client_id
      and skip.period_start = new.period_start
  ) then
    raise exception 'This billing cycle was skipped and cannot be invoiced.'
      using errcode = 'P0001';
  end if;

  return new;
end
$$;

drop trigger if exists invoices_reject_skipped_cycle on public.invoices;
create trigger invoices_reject_skipped_cycle
  before insert on public.invoices
  for each row execute function public.guard_invoice_against_billing_cycle_skip();

revoke all on function public.guard_invoice_against_billing_cycle_skip()
  from public, anon, authenticated, service_role;

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

  perform pg_advisory_xact_lock(
    hashtext(p_client_id::text),
    p_period_start - date '2000-01-01'
  );

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

revoke all on function public.skip_billing_cycle(uuid, date, date, text, uuid)
  from public, anon, authenticated;
grant execute on function public.skip_billing_cycle(uuid, date, date, text, uuid)
  to service_role;

comment on function public.guard_invoice_against_billing_cycle_skip() is
  'Serializes invoice insertion against a client/week skip and rejects every skipped billing cycle at the table boundary.';

notify pgrst, 'reload schema';
