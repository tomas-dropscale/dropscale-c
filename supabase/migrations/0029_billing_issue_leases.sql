-- =============================================================================
-- 0029 - Fenced per-client billing issuance leases and delivery evidence.
--
-- Stripe copies mutable Customer identity onto an Invoice when it is finalised.
-- Two different weeks for the same client must therefore never update that
-- Customer and finalise concurrently. These service-only leases serialise the
-- complete Stripe mutation sequence and retain every generation so a delayed
-- worker can never revive an old lease token.
-- =============================================================================

-- Existing non-draft Stripe invoices predate explicit delivery evidence. Mark
-- them as already delivered during the migration rather than risking a bulk
-- resend. New finalised invoices remain null until /send succeeds or Stripe's
-- invoice.sent webhook is reconciled.
-- A linked local draft is irreducibly ambiguous without reading Stripe: it may
-- be a true draft, or /send may have succeeded before the local status write.
-- Refuse to install automatic retry semantics over that state. Operators must
-- reconcile those rows explicitly before this standalone migration proceeds.
do $$
begin
  -- Wait for every old invoice writer before inspecting linked drafts, then
  -- keep new writers out until the delivery columns and recovery rules commit.
  -- Without this lock, an uncommitted /finalize attempt could cross the SELECT
  -- snapshot and recreate the exact ambiguous state this preflight rejects.
  lock table public.invoices in share row exclusive mode;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.status = 'draft'
      and invoice.stripe_invoice_id is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0029 preflight: Stripe-linked local drafts require explicit delivery reconciliation before automatic issue recovery can be installed.';
  end if;
end
$$;

alter table public.invoices
  add column stripe_sent_at timestamptz,
  add column stripe_delivery_assumed_at timestamptz;

update public.invoices
set stripe_delivery_assumed_at = clock_timestamp()
where stripe_invoice_id is not null
  and status <> 'draft';

comment on column public.invoices.stripe_sent_at is
  'First durable evidence that Stripe accepted explicit invoice delivery, recorded only from /send success or invoice.sent.';
comment on column public.invoices.stripe_delivery_assumed_at is
  'Migration-time safety marker for historical finalised invoices whose actual delivery event was not previously stored; prevents automatic resend without fabricating sent evidence.';

create table public.billing_issue_leases (
  lease_token uuid primary key,
  client_id uuid not null
    references public.portal_clients (id) on delete cascade,
  fencing_token bigint not null
    constraint billing_issue_leases_fence_positive check (fencing_token > 0),
  period_start date not null
    constraint billing_issue_leases_period_monday
    check (extract(isodow from period_start) = 1),
  issued_by uuid not null
    references public.profiles (id) on delete restrict,
  acquired_at timestamptz not null,
  renewed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  released_at timestamptz,
  constraint billing_issue_leases_client_fence
    unique (client_id, fencing_token),
  constraint billing_issue_leases_renewed_after_acquire
    check (renewed_at >= acquired_at),
  constraint billing_issue_leases_expiry_after_acquire
    check (lease_expires_at >= acquired_at),
  constraint billing_issue_leases_release_after_acquire
    check (released_at is null or released_at >= acquired_at)
);

comment on table public.billing_issue_leases is
  'Service-only history of fenced Stripe invoice-issue leases, serialised per portal client.';
comment on column public.billing_issue_leases.lease_token is
  'Caller-generated idempotency token. A completed or expired token can never be reused.';
comment on column public.billing_issue_leases.fencing_token is
  'Monotonic per-client generation checked by every renewal and release.';

create index billing_issue_leases_latest_client_idx
  on public.billing_issue_leases (client_id, fencing_token desc);

alter table public.billing_issue_leases enable row level security;
revoke all on public.billing_issue_leases
  from public, anon, authenticated, service_role;

create or replace function public.acquire_billing_issue_lease(
  p_client_id uuid,
  p_lease_token uuid,
  p_period_start date,
  p_issued_by uuid
)
returns setof public.billing_issue_leases
language plpgsql
security definer
set search_path = public
as $$
declare
  lease_lifetime constant interval := interval '5 minutes';
  current_lease public.billing_issue_leases%rowtype;
  previous_lease public.billing_issue_leases%rowtype;
  acquired_lease public.billing_issue_leases%rowtype;
  next_fence bigint;
  v_now timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can acquire an issue lease.'
      using errcode = '42501';
  end if;

  if p_client_id is null
     or p_lease_token is null
     or p_period_start is null
     or extract(isodow from p_period_start) <> 1 then
    raise exception 'A client, unique lease token and Monday period are required.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_issued_by
      and profile.role = 'admin'
  ) then
    raise exception 'A verified admin issuer is required for a billing lease.'
      using errcode = '42501';
  end if;

  -- The client row is the durable per-client mutex. Taking this lock before
  -- reading any lease generation serialises acquire, renew and release without
  -- relying on transaction-local advisory locks.
  perform 1
  from public.portal_clients client
  where client.id = p_client_id
  for update;
  if not found then
    raise exception 'The billing client does not exist.'
      using errcode = '22023';
  end if;

  -- Take the database clock only after waiting for the mutex. A timestamp
  -- captured before the wait could incorrectly treat a freshly renewed lease
  -- as expired or shorten its lifetime.
  v_now := clock_timestamp();

  select * into current_lease
  from public.billing_issue_leases lease
  where lease.lease_token = p_lease_token;

  if found then
    if current_lease.client_id <> p_client_id
       or current_lease.period_start <> p_period_start
       or current_lease.issued_by <> p_issued_by then
      raise exception 'A billing lease token cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    select * into previous_lease
    from public.billing_issue_leases lease
    where lease.client_id = p_client_id
    order by lease.fencing_token desc
    limit 1;

    if previous_lease.lease_token <> p_lease_token
       or current_lease.released_at is not null
       or current_lease.lease_expires_at <= v_now then
      raise exception 'A completed or expired billing lease token cannot be reused.'
        using errcode = '22023';
    end if;

    update public.billing_issue_leases lease
    set renewed_at = v_now,
        lease_expires_at = v_now + lease_lifetime
    where lease.lease_token = p_lease_token
    returning * into acquired_lease;

    return next acquired_lease;
    return;
  end if;

  select * into previous_lease
  from public.billing_issue_leases lease
  where lease.client_id = p_client_id
  order by lease.fencing_token desc
  limit 1;

  if found
     and previous_lease.released_at is null
     and previous_lease.lease_expires_at > v_now then
    -- An active different owner is normal contention, not a database error.
    return;
  end if;

  next_fence := coalesce(previous_lease.fencing_token, 0) + 1;
  insert into public.billing_issue_leases (
    lease_token,
    client_id,
    fencing_token,
    period_start,
    issued_by,
    acquired_at,
    renewed_at,
    lease_expires_at
  ) values (
    p_lease_token,
    p_client_id,
    next_fence,
    p_period_start,
    p_issued_by,
    v_now,
    v_now,
    v_now + lease_lifetime
  ) returning * into acquired_lease;

  return next acquired_lease;
end
$$;

create or replace function public.renew_billing_issue_lease(
  p_client_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint
)
returns setof public.billing_issue_leases
language plpgsql
security definer
set search_path = public
as $$
declare
  lease_lifetime constant interval := interval '5 minutes';
  renewed_lease public.billing_issue_leases%rowtype;
  v_now timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can renew an issue lease.'
      using errcode = '42501';
  end if;

  if p_client_id is null
     or p_lease_token is null
     or p_fencing_token is null
     or p_fencing_token <= 0 then
    raise exception 'A complete billing lease generation is required.'
      using errcode = '22023';
  end if;

  perform 1
  from public.portal_clients client
  where client.id = p_client_id
  for update;
  if not found then return; end if;

  v_now := clock_timestamp();
  update public.billing_issue_leases lease
  set renewed_at = v_now,
      lease_expires_at = v_now + lease_lifetime
  where lease.client_id = p_client_id
    and lease.lease_token = p_lease_token
    and lease.fencing_token = p_fencing_token
    and lease.released_at is null
    and lease.lease_expires_at > v_now
    and lease.fencing_token = (
      select max(latest.fencing_token)
      from public.billing_issue_leases latest
      where latest.client_id = p_client_id
    )
  returning * into renewed_lease;

  if found then return next renewed_lease; end if;
end
$$;

create or replace function public.release_billing_issue_lease(
  p_client_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released_lease public.billing_issue_leases%rowtype;
  v_now timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can release an issue lease.'
      using errcode = '42501';
  end if;

  if p_client_id is null
     or p_lease_token is null
     or p_fencing_token is null
     or p_fencing_token <= 0 then
    raise exception 'A complete billing lease generation is required.'
      using errcode = '22023';
  end if;

  perform 1
  from public.portal_clients client
  where client.id = p_client_id
  for update;
  if not found then return false; end if;

  v_now := clock_timestamp();
  update public.billing_issue_leases lease
  set released_at = coalesce(lease.released_at, v_now),
      lease_expires_at = least(lease.lease_expires_at, v_now)
  where lease.client_id = p_client_id
    and lease.lease_token = p_lease_token
    and lease.fencing_token = p_fencing_token
    and lease.fencing_token = (
      select max(latest.fencing_token)
      from public.billing_issue_leases latest
      where latest.client_id = p_client_id
    )
  returning * into released_lease;

  return found;
end
$$;

create or replace function public.record_billing_issue_error(
  p_client_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_invoice_id uuid,
  p_issue_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz;
  updated_invoice_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can record an issue error.'
      using errcode = '42501';
  end if;

  if p_client_id is null
     or p_lease_token is null
     or p_fencing_token is null
     or p_fencing_token <= 0
     or p_invoice_id is null then
    raise exception 'A complete billing lease and invoice are required.'
      using errcode = '22023';
  end if;

  perform 1
  from public.portal_clients client
  where client.id = p_client_id
  for update;
  if not found then return false; end if;

  v_now := clock_timestamp();
  if not exists (
    select 1
    from public.billing_issue_leases lease
    where lease.client_id = p_client_id
      and lease.lease_token = p_lease_token
      and lease.fencing_token = p_fencing_token
      and lease.released_at is null
      and lease.lease_expires_at > v_now
      and lease.fencing_token = (
        select max(latest.fencing_token)
        from public.billing_issue_leases latest
        where latest.client_id = p_client_id
      )
  ) then
    return false;
  end if;

  -- The fence check and error write share the same per-client row lock and
  -- transaction. A delayed worker can therefore never annotate the generation
  -- that took over after it.
  update public.invoices invoice
  set issue_error = left(
        coalesce(nullif(p_issue_error, ''), 'Stripe invoice issue failed.'),
        1000
      ),
      updated_at = v_now
  where invoice.id = p_invoice_id
    and invoice.client_id = p_client_id
    and invoice.status in ('draft', 'open')
    and invoice.stripe_sent_at is null
    and invoice.stripe_delivery_assumed_at is null
  returning invoice.id into updated_invoice_id;

  return found;
end
$$;

revoke all on function public.acquire_billing_issue_lease(
  uuid, uuid, date, uuid
) from public, anon, authenticated;
revoke all on function public.renew_billing_issue_lease(
  uuid, uuid, bigint
) from public, anon, authenticated;
revoke all on function public.release_billing_issue_lease(
  uuid, uuid, bigint
) from public, anon, authenticated;
revoke all on function public.record_billing_issue_error(
  uuid, uuid, bigint, uuid, text
) from public, anon, authenticated;

grant execute on function public.acquire_billing_issue_lease(
  uuid, uuid, date, uuid
) to service_role;
grant execute on function public.renew_billing_issue_lease(
  uuid, uuid, bigint
) to service_role;
grant execute on function public.release_billing_issue_lease(
  uuid, uuid, bigint
) to service_role;
grant execute on function public.record_billing_issue_error(
  uuid, uuid, bigint, uuid, text
) to service_role;
