-- =============================================================================
-- 0028 - Admin-owned referral attribution.
--
-- A referral code entered during signup may still create the original claim,
-- but a missing claim must not prevent the team from recording a genuine
-- referral. This migration adds a second, service-only path through which a
-- verified admin may fill an empty attribution exactly once. Attribution and
-- pricing remain separate decisions: this RPC never grants the 0.5 pp fee
-- discount or changes an existing Monday-effective commercial term.
-- =============================================================================

-- The legacy claim path prevented self-referral but did not prevent longer
-- cycles, staff identities or fellow workspace members. 0027 and 0028 are
-- separate transactions, so a live 0025 claim can still arrive between them.
-- Do not seal an invalid relationship permanently: an operator must inspect
-- and repair it explicitly before installing the stricter writer.
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
    with recursive referral_walk(origin_id, node_id, path, has_cycle) as (
      select client.id, client.id, array[client.id], false
      from public.portal_clients client
      where client.referred_by is not null

      union all

      select
        walk.origin_id,
        client.referred_by,
        walk.path || client.referred_by,
        client.referred_by = any(walk.path)
      from referral_walk walk
      join public.portal_clients client on client.id = walk.node_id
      where client.referred_by is not null
        and not walk.has_cycle
    )
    select 1
    from referral_walk
    where has_cycle
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0028 preflight: the existing referral graph contains a cycle and requires explicit repair before admin attribution can be installed.';
  end if;

  if exists (
    select 1
    from public.portal_clients referred_client
    join public.portal_clients referrer
      on referrer.id = referred_client.referred_by
    where exists (
      select 1
      from public.profiles profile
      where profile.id in (referred_client.id, referrer.id)
        and profile.role = 'admin'
    )
       or public.clients_share_workspace(referred_client.id, referrer.id)
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0028 preflight: a legacy referral involves staff or shared-workspace identities and requires explicit repair before attribution can be sealed.';
  end if;
end
$$;

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

-- Signup claims and admin assignments share the same serialisation domain.
-- The older claim function checked only self-referral; two reciprocal claims,
-- or a claim racing an admin assignment, could therefore create a cycle.
create or replace function public.claim_referral_code(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  claimant_id uuid := auth.uid();
  referral_code_text text := upper(trim(coalesce(p_code, '')));
  referrer_id uuid;
  existing_referrer_id uuid;
begin
  if claimant_id is null then
    return 'not_signed_in';
  end if;
  if referral_code_text = '' then
    return 'empty';
  end if;
  if exists (
    select 1
    from public.profiles profile
    where profile.id = claimant_id
      and profile.role = 'admin'
  ) then
    return 'staff_account';
  end if;

  -- The admin RPC takes the same lock before inspecting either relationship.
  -- SECURITY DEFINER lets the function owner take it without granting browser
  -- users any direct table-lock or event-write privilege.
  lock table public.referral_attribution_events in share row exclusive mode;

  select client.referred_by into existing_referrer_id
  from public.portal_clients client
  where client.id = claimant_id
  for update;

  if not found then
    return 'not_a_client';
  end if;
  if existing_referrer_id is not null then
    return 'already_referred';
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
  if referrer_id = claimant_id then
    return 'own_code';
  end if;

  if public.clients_share_workspace(claimant_id, referrer_id) then
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
    where id = claimant_id
  ) then
    return 'cycle';
  end if;

  perform set_config('dropscale.referral_claim', 'on', true);
  update public.portal_clients
  set referred_by = referrer_id
  where id = claimant_id
    and referred_by is null;

  if not found then
    return 'already_referred';
  end if;
  return 'ok';
end
$$;

revoke all on function public.claim_referral_code(text) from public, anon;
grant execute on function public.claim_referral_code(text) to authenticated;

-- Preserve the signup-claim path introduced in 0025, add one tightly scoped
-- admin path, and seal INSERT as well as UPDATE. The previous trigger ran only
-- on UPDATE, so an authenticated admin INSERT could forge referred_by without
-- a reviewed decision or receipt.
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

    if coalesce(
         current_setting('dropscale.referral_signup_insert', true),
         ''
       ) = 'on' then
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
    if coalesce(current_setting('dropscale.referral_claim', true), '') = 'on'
       and old.referred_by is null
       and new.referred_by is not null
       and auth.uid() = old.id then
      return new;
    end if;

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

-- Email/password signup is the only legitimate INSERT that may arrive with a
-- referral already resolved. Keep the original confirmed-email semantics, but
-- mark only this transaction and exclude internal staff identities as referral
-- sources. OAuth clients are inserted without attribution and may claim later.
create or replace function public.handle_new_portal_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  referral_code_text text;
  referrer_id uuid;
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
  if referral_code_text <> '' then
    select client.id into referrer_id
    from public.portal_clients client
    where upper(client.referral_code) = referral_code_text
      and client.approval_status = 'approved'
      and client.id <> new.id
      and not exists (
        select 1
        from public.profiles profile
        where profile.id = client.id
          and profile.role = 'admin'
      );
  end if;

  perform set_config('dropscale.referral_signup_insert', 'on', true);
  insert into public.portal_clients (
    id,
    full_name,
    email,
    approval_status,
    referred_by
  ) values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    'pending',
    referrer_id
  )
  on conflict (id) do nothing;

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
