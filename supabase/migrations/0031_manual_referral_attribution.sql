-- =============================================================================
-- 0031 - Admin-owned referral attribution.
--
-- A referral code entered during signup is evidence for an admin to review,
-- never authority to create the permanent relationship. This migration keeps
-- that signal in an append-only pending-request journal and makes the verified
-- admin/service RPC the only path that may fill referred_by. Attribution and
-- pricing remain separate decisions: the attribution RPC never grants the
-- 0.5 pp fee discount or changes a Monday-effective commercial term.
-- =============================================================================

-- 0030 and 0031 are separate transactions, so the old automatic claim writer
-- can still fill referred_by between them. Do not silently bless that edge as
-- admin-reviewed or erase it: stop and require an explicit operator repair.
do $$
begin
  -- Drain old claim/profile/membership writers before validating. Otherwise a
  -- transaction that began under 0025 could commit an invalid edge after this
  -- snapshot but before the stricter functions and trigger become visible.
  lock table
    public.portal_clients,
    public.client_members,
    public.profiles
  in share row exclusive mode;

  if exists (
    select 1
    from public.portal_clients client
    where client.referred_by is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0031 preflight: an unreviewed permanent referral attribution was created after 0030 and requires explicit repair before admin-only attribution can be installed.';
  end if;
end
$$;

create table public.referral_claim_requests (
  id uuid primary key default gen_random_uuid(),
  referred_client_id uuid not null unique
    references public.portal_clients (id) on delete restrict,
  referrer_client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  referral_code text not null
    constraint referral_claim_requests_code_present
    check (btrim(referral_code) <> '' and length(referral_code) <= 128),
  claim_source text not null
    constraint referral_claim_requests_source
    check (claim_source in ('signup', 'client')),
  created_at timestamptz not null default now(),
  constraint referral_claim_requests_not_self
    check (referred_client_id <> referrer_client_id)
);

comment on table public.referral_claim_requests is
  'Append-only referral-code signals awaiting independent admin attribution review; a row never changes referred_by or commercial pricing.';
comment on column public.referral_claim_requests.referred_client_id is
  'One immutable first claim per client. Pending status is derived from portal_clients.referred_by remaining null.';
comment on column public.referral_claim_requests.referral_code is
  'Uppercase, trimmed code supplied by the claimant; retained as review evidence.';

create index referral_claim_requests_referrer_idx
  on public.referral_claim_requests (referrer_client_id, created_at desc);

alter table public.referral_claim_requests enable row level security;
revoke insert, update, delete on public.referral_claim_requests
  from public, authenticated, anon, service_role;
grant select on public.referral_claim_requests
  to authenticated, service_role;

create policy referral_claim_requests_admin_read
  on public.referral_claim_requests for select
  using (public.is_admin());

create or replace function public.guard_referral_claim_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and coalesce(
       current_setting('dropscale.referral_claim_request_write', true),
       ''
     ) = 'on' then
    return new;
  end if;

  raise exception 'A referral claim request is append-only.'
    using errcode = '22023';
end
$$;

create trigger referral_claim_requests_guard_append_only
  before insert or update or delete on public.referral_claim_requests
  for each row execute function public.guard_referral_claim_request();

create table public.referral_attribution_events (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique,
  referred_client_id uuid not null unique
    references public.portal_clients (id) on delete restrict,
  referrer_client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  reason text not null
    constraint referral_attribution_events_reason_present
    check (btrim(reason) <> '' and length(reason) <= 1000),
  reviewed_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  sealed_at timestamptz not null default now(),
  constraint referral_attribution_events_not_self
    check (referred_client_id <> referrer_client_id),
  constraint referral_attribution_events_seal_order
    check (sealed_at >= created_at)
);

comment on table public.referral_attribution_events is
  'Append-only receipts for one-time referral attributions applied manually by a verified admin.';
comment on column public.referral_attribution_events.decision_id is
  'Caller-generated idempotency key for one reviewed attribution.';

create index referral_attribution_events_referrer_idx
  on public.referral_attribution_events (referrer_client_id, created_at desc);

alter table public.referral_attribution_events enable row level security;
revoke insert, update, delete on public.referral_attribution_events
  from public, authenticated, anon;
grant select on public.referral_attribution_events
  to authenticated, service_role;

create policy referral_attribution_events_admin_read
  on public.referral_attribution_events for select
  using (public.is_admin());

create or replace function public.guard_referral_attribution_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and coalesce(
       current_setting('dropscale.manual_referral_attribution_rpc', true),
       ''
     ) = 'on' then
    return new;
  end if;

  raise exception 'A manual referral attribution receipt is append-only.'
    using errcode = '22023';
end
$$;

create trigger referral_attribution_events_guard_append_only
  before insert or update or delete on public.referral_attribution_events
  for each row execute function public.guard_referral_attribution_event();

-- Resolve and append one referral-code signal without changing attribution.
-- A first valid signal is immutable. Retrying the same code is idempotent;
-- submitting a different code returns claim_pending and cannot replace it.
create or replace function public.record_referral_claim_request(
  p_referred_client_id uuid,
  p_code text,
  p_claim_source text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  referral_code_text text := upper(trim(coalesce(p_code, '')));
  referrer_id uuid;
  referred_client public.portal_clients%rowtype;
  existing_request public.referral_claim_requests%rowtype;
begin
  if p_referred_client_id is null then
    return 'not_signed_in';
  end if;
  if referral_code_text = '' then
    return 'empty';
  end if;
  if p_claim_source is null
     or p_claim_source not in ('signup', 'client') then
    raise exception 'Invalid referral claim source.'
      using errcode = '22023';
  end if;

  -- The admin attribution RPC takes the same lock before inspecting or filling
  -- referred_by. A claim that wins the race is visible to that review; an
  -- attribution that wins makes the later claim return already_referred.
  lock table public.referral_claim_requests in share row exclusive mode;

  select * into referred_client
  from public.portal_clients client
  where client.id = p_referred_client_id
  for update;

  if not found then
    return 'not_a_client';
  end if;
  if referred_client.referred_by is not null then
    return 'already_referred';
  end if;
  if exists (
    select 1
    from public.profiles profile
    where profile.id = p_referred_client_id
      and profile.role = 'admin'
  ) then
    return 'staff_account';
  end if;

  select * into existing_request
  from public.referral_claim_requests request
  where request.referred_client_id = p_referred_client_id;

  if found then
    if existing_request.referral_code = referral_code_text then
      return 'ok';
    end if;
    return 'claim_pending';
  end if;

  select client.id into referrer_id
  from public.portal_clients client
  where upper(client.referral_code) = referral_code_text
    and client.approval_status = 'approved'
    and not exists (
      select 1
      from public.profiles profile
      where profile.id = client.id
        and profile.role = 'admin'
    )
  for update;

  if referrer_id is null then
    return 'unknown_code';
  end if;
  if referrer_id = p_referred_client_id then
    return 'own_code';
  end if;

  if public.clients_share_workspace(p_referred_client_id, referrer_id) then
    return 'shared_workspace';
  end if;

  if exists (
    with recursive referrer_ancestry(id) as (
      select referrer_id
      union
      select client.referred_by
      from public.portal_clients client
      join referrer_ancestry ancestry on ancestry.id = client.id
      where client.referred_by is not null
    )
    select 1
    from referrer_ancestry
    where id = p_referred_client_id
  ) then
    return 'cycle';
  end if;

  perform set_config('dropscale.referral_claim_request_write', 'on', true);
  insert into public.referral_claim_requests (
    referred_client_id,
    referrer_client_id,
    referral_code,
    claim_source
  ) values (
    p_referred_client_id,
    referrer_id,
    referral_code_text,
    p_claim_source
  );

  return 'ok';
end
$$;

revoke all on function public.record_referral_claim_request(uuid, text, text)
  from public, authenticated, anon, service_role;

create or replace function public.claim_referral_code(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.record_referral_claim_request(auth.uid(), p_code, 'client');
end
$$;

revoke all on function public.claim_referral_code(text) from public, anon;
grant execute on function public.claim_referral_code(text) to authenticated;

-- Only the service-only admin attribution RPC may write referred_by. Seal
-- INSERT as well as UPDATE: signup and client code claims now write only the
-- separate pending-request journal.
create or replace function public.guard_referral_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.referred_by is null then
      return new;
    end if;

    raise exception 'A referral attribution cannot be inserted directly.'
      using errcode = '22023';
  end if;

  if new.referral_code is distinct from old.referral_code then
    raise exception 'A referral code cannot be changed.'
      using errcode = '22023';
  end if;

  if new.referred_by is distinct from old.referred_by then
    if coalesce(
         current_setting('dropscale.manual_referral_attribution_rpc', true),
         ''
       ) = 'on'
       and auth.role() = 'service_role'
       and old.referred_by is null
       and new.referred_by is not null then
      return new;
    end if;

    raise exception 'A referral attribution cannot be rewritten.'
      using errcode = '22023';
  end if;

  return new;
end
$$;

drop trigger if exists portal_clients_guard_referral on public.portal_clients;
create trigger portal_clients_guard_referral
  before insert or update on public.portal_clients
  for each row execute function public.guard_referral_fields();

-- Keep the confirmed email/password signup semantics, but insert every client
-- without attribution. A valid code becomes pending append-only evidence only;
-- unknown, self, staff, shared-workspace and cyclic suggestions remain
-- non-fatal. OAuth clients may record the same evidence in the callback RPC.
create or replace function public.handle_new_portal_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  referral_code_text text;
begin
  if coalesce(new.raw_user_meta_data ->> 'portal_signup', '') <> 'true' then
    return new;
  end if;

  if new.email_confirmed_at is null then
    return new;
  end if;

  referral_code_text := upper(trim(coalesce(
    new.raw_user_meta_data ->> 'referral_code',
    ''
  )));

  insert into public.portal_clients (
    id,
    full_name,
    email,
    approval_status
  ) values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    'pending'
  )
  on conflict (id) do nothing;

  if referral_code_text <> '' then
    perform public.record_referral_claim_request(
      new.id,
      referral_code_text,
      'signup'
    );
  end if;

  return new;
end
$$;

create or replace function public.assign_manual_referral_attribution(
  p_referred_client_id uuid,
  p_referrer_client_id uuid,
  p_decision_id uuid,
  p_reason text,
  p_reviewed_by uuid
)
returns setof public.referral_attribution_events
language plpgsql
security definer
set search_path = public
as $$
declare
  referred_client public.portal_clients%rowtype;
  referrer_client public.portal_clients%rowtype;
  replay_event public.referral_attribution_events%rowtype;
  created_event public.referral_attribution_events%rowtype;
  referred_found boolean;
  referrer_found boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the referral service can assign a manual attribution.'
      using errcode = '42501';
  end if;

  if p_referred_client_id is null
     or p_referrer_client_id is null
     or p_referred_client_id = p_referrer_client_id
     or p_decision_id is null
     or nullif(btrim(coalesce(p_reason, '')), '') is null
     or length(btrim(p_reason)) > 1000 then
    raise exception 'Invalid manual referral attribution.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_reviewed_by
      and profile.role = 'admin'
  ) then
    raise exception 'A verified admin reviewer is required for a referral attribution.'
      using errcode = '42501';
  end if;

  -- Share the first lock with signup/client claim creation. The admin may
  -- accept or override a pending suggestion, but the evidence visible when the
  -- decision serialises is deterministic and no later claim can race it.
  lock table public.referral_claim_requests in share row exclusive mode;

  -- Attribution volume is tiny. Serialising this append-only journal makes an
  -- exact decision-id retry deterministic even if the first HTTP response is
  -- lost, and avoids a unique-key race returning an ambiguous error.
  lock table public.referral_attribution_events in share row exclusive mode;

  select * into replay_event
  from public.referral_attribution_events event
  where event.decision_id = p_decision_id;

  if found then
    if replay_event.referred_client_id <> p_referred_client_id
       or replay_event.referrer_client_id <> p_referrer_client_id
       or replay_event.reason <> btrim(p_reason)
       or replay_event.reviewed_by <> p_reviewed_by then
      raise exception 'A referral attribution decision id cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    return next replay_event;
    return;
  end if;

  -- Canonical lock order prevents two admins assigning the same pair in
  -- opposite roles from deadlocking before the cycle checks run.
  perform 1
  from public.portal_clients client
  where client.id in (p_referred_client_id, p_referrer_client_id)
  order by client.id
  for update;

  select * into referred_client
  from public.portal_clients client
  where client.id = p_referred_client_id;
  referred_found := found;

  select * into referrer_client
  from public.portal_clients client
  where client.id = p_referrer_client_id;
  referrer_found := found;

  if not referred_found or not referrer_found then
    raise exception 'Both referral clients must exist.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.profiles profile
    where profile.id in (p_referred_client_id, p_referrer_client_id)
      and profile.role = 'admin'
  ) then
    raise exception 'Staff portal identities cannot participate in referrals.'
      using errcode = '22023';
  end if;

  if referrer_client.approval_status <> 'approved' then
    raise exception 'The referrer must be an approved client.'
      using errcode = '22023';
  end if;

  if referred_client.approval_status = 'rejected' then
    raise exception 'A rejected client cannot receive a referral attribution.'
      using errcode = '22023';
  end if;

  if referred_client.referred_by is not null then
    raise exception 'This client already has a permanent referral attribution.'
      using errcode = '22023';
  end if;

  if public.clients_share_workspace(
    p_referred_client_id,
    p_referrer_client_id
  ) then
    raise exception 'Clients who share a workspace cannot refer one another.'
      using errcode = '22023';
  end if;

  if exists (
    with recursive referrer_ancestry(id) as (
      select p_referrer_client_id
      union
      select client.referred_by
      from public.portal_clients client
      join referrer_ancestry ancestry on ancestry.id = client.id
      where client.referred_by is not null
    )
    select 1
    from referrer_ancestry
    where id = p_referred_client_id
  ) then
    raise exception 'A referral attribution cannot create a referral cycle.'
      using errcode = '22023';
  end if;

  perform set_config(
    'dropscale.manual_referral_attribution_rpc',
    'on',
    true
  );

  update public.portal_clients
  set referred_by = p_referrer_client_id
  where id = p_referred_client_id
    and referred_by is null;

  if not found then
    raise exception 'The referral attribution changed while it was being reviewed.'
      using errcode = '40001';
  end if;

  insert into public.referral_attribution_events (
    decision_id,
    referred_client_id,
    referrer_client_id,
    reason,
    reviewed_by
  ) values (
    p_decision_id,
    p_referred_client_id,
    p_referrer_client_id,
    btrim(p_reason),
    p_reviewed_by
  )
  returning * into created_event;

  return next created_event;
end
$$;

revoke all on function public.assign_manual_referral_attribution(
  uuid, uuid, uuid, text, uuid
) from public, authenticated, anon;
grant execute on function public.assign_manual_referral_attribution(
  uuid, uuid, uuid, text, uuid
) to service_role;
