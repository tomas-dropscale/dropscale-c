-- A verified reporting connection is the approval. Keep empty accounts pending,
-- never revive archived clients, and remove the manual review hop from onboarding.

create or replace function public.approve_connected_portal_client(
  p_client_id uuid,
  p_session_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed boolean := false;
begin
  if p_client_id is null then
    return false;
  end if;

  update public.portal_clients
  set approval_status = 'approved',
      approved_at = coalesce(approved_at, now()),
      approved_by = null
  where id = p_client_id
    and approval_status = 'pending';
  changed := found;

  -- A new-client identity deliberately has no portal row before onboarding.
  -- The connected asset is enough to create that row as approved. ON CONFLICT
  -- does nothing for approved and, critically, rejected/archived identities.
  if not changed and p_session_id is not null then
    insert into public.portal_clients (
      id, full_name, email, discord_handle,
      approval_status, approved_at, approved_by
    )
    select
      session.claimed_user_id,
      btrim(session.first_name || ' ' || session.last_name),
      session.email,
      session.discord_handle,
      'approved',
      now(),
      null
    from public.client_onboarding_sessions session
    where session.id = p_session_id
      and session.mode = 'new_client'
      and session.claimed_user_id = p_client_id
      and not exists (
        select 1 from public.portal_clients client where client.id = p_client_id
      )
    on conflict (id) do nothing;
    changed := found;
  end if;

  return changed;
end
$$;

revoke all on function public.approve_connected_portal_client(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.auto_approve_onboarding_connection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'connected'
    and exists (
      select 1
      from public.client_onboarding_sessions session
      where session.id = new.session_id
        and new.client_id in (session.claimed_user_id, session.target_client_id)
    )
  then
    perform public.approve_connected_portal_client(new.client_id, new.session_id);
  end if;
  return new;
end
$$;

revoke all on function public.auto_approve_onboarding_connection()
  from public, anon, authenticated, service_role;

drop trigger if exists client_shopify_connection_auto_approves_client
  on public.client_shopify_connections;
create trigger client_shopify_connection_auto_approves_client
  after insert or update on public.client_shopify_connections
  for each row execute function public.auto_approve_onboarding_connection();

drop trigger if exists client_google_connection_auto_approves_client
  on public.client_google_ads_connections;
create trigger client_google_connection_auto_approves_client
  after insert or update on public.client_google_ads_connections
  for each row execute function public.auto_approve_onboarding_connection();

create or replace function public.auto_approve_legacy_connection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.shopify_connected is true
    and public.normalize_shopify_reporting_domain(new.shopify_url)
          ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
  ) or (
    new.google_ads_connected is true
    and new.google_ads_customer_id ~ '^[0-9]{10}$'
  ) then
    perform public.approve_connected_portal_client(new.client_id, null);
  end if;
  return new;
end
$$;

revoke all on function public.auto_approve_legacy_connection()
  from public, anon, authenticated, service_role;

drop trigger if exists ad_account_connection_auto_approves_client
  on public.ad_accounts;
create trigger ad_account_connection_auto_approves_client
  after insert or update on public.ad_accounts
  for each row execute function public.auto_approve_legacy_connection();

-- Reconcile clients that were already connected before this invariant existed.
do $$
declare
  connected record;
begin
  for connected in
    select distinct on (source.client_id) source.client_id, source.session_id
    from (
      select connection.client_id, connection.session_id
      from public.client_shopify_connections connection
      join public.client_onboarding_sessions session
        on session.id = connection.session_id
       and connection.client_id in (session.claimed_user_id, session.target_client_id)
      where connection.status = 'connected'
      union all
      select connection.client_id, connection.session_id
      from public.client_google_ads_connections connection
      join public.client_onboarding_sessions session
        on session.id = connection.session_id
       and connection.client_id in (session.claimed_user_id, session.target_client_id)
      where connection.status = 'connected'
      union all
      select client_id, null::uuid as session_id
      from public.ad_accounts
      where (
        shopify_connected is true
        and public.normalize_shopify_reporting_domain(shopify_url)
              ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
      ) or (
        google_ads_connected is true
        and google_ads_customer_id ~ '^[0-9]{10}$'
      )
    ) source
    order by source.client_id, source.session_id nulls last
  loop
    perform public.approve_connected_portal_client(
      connected.client_id,
      connected.session_id
    );
  end loop;
end
$$;

-- Historical submitted setups already passed their connection checks. Move
-- them to the same automatic reviewed state as new submissions.
with reviewed as (
  update public.client_onboarding_sessions session
  set status = 'reviewed',
      reviewed_at = coalesce(session.reviewed_at, now()),
      reviewed_by = null,
      updated_at = now()
  where session.status = 'submitted'
    and cardinality(session.requested_assets) > 0
    and not exists (
      select 1
      from public.portal_clients client
      where client.id = session.claimed_user_id
        and client.approval_status = 'rejected'
    )
    and (
      session.reconnect_completed_at is not null
      or exists (
        select 1 from public.client_shopify_connections shopify
        where shopify.session_id = session.id and shopify.status = 'connected'
      )
      or exists (
        select 1 from public.client_google_ads_connections google_ads
        where google_ads.session_id = session.id and google_ads.status = 'connected'
      )
    )
  returning session.id
)
insert into public.client_onboarding_events (
  session_id, event_type, actor_type, actor_id, details
)
select reviewed.id, 'reviewed', 'system', null,
       jsonb_build_object('reason', 'connected_asset_auto_approval')
from reviewed;

-- Preserve every validation and parallel-link rule from 0048, but a valid
-- asset-bearing submission now records its review atomically and needs no
-- subsequent admin action. Account-only submissions stay unapproved.
create or replace function public.submit_client_onboarding_session(
  p_session_id uuid,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  open_sibling_id uuid;
  auto_review boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can submit an onboarding session.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
  then
    raise exception 'Onboarding session is not available.' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.portal_clients client
    where client.id = target.claimed_user_id
      and client.approval_status = 'rejected'
  ) then
    raise exception 'An archived client cannot be approved from onboarding.'
      using errcode = '23514';
  end if;
  if target.mode = 'reconnect' and target.reconnect_completed_at is null then
    raise exception 'The selected Shopify store must be reconnected.' using errcode = '23514';
  end if;
  if target.mode <> 'reconnect'
    and 'shopify' = any(target.requested_assets)
    and not exists (
      select 1 from public.client_shopify_connections
      where session_id = target.id and status = 'connected'
    )
  then
    raise exception 'At least one Shopify store is required.' using errcode = '23514';
  end if;
  if 'google_ads' = any(target.requested_assets) and not exists (
    select 1 from public.client_google_ads_connections
    where session_id = target.id and status = 'connected'
  ) then
    raise exception 'At least one Google Ads account is required.' using errcode = '23514';
  end if;

  auto_review := cardinality(target.requested_assets) > 0;
  update public.client_onboarding_sessions
  set status = case when auto_review then 'reviewed' else 'submitted' end,
      invite_token_hash = null,
      invite_expires_at = null,
      submitted_at = now(),
      reviewed_at = case when auto_review then now() else reviewed_at end,
      reviewed_by = case when auto_review then null else reviewed_by end,
      updated_at = now(),
      last_error_code = null
  where id = target.id;
  delete from public.client_onboarding_secrets where session_id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (target.id, 'submitted', 'client', target.claimed_user_id);

  if auto_review then
    perform public.approve_connected_portal_client(target.claimed_user_id, target.id);
    insert into public.client_onboarding_events (
      session_id, event_type, actor_type, actor_id, details
    ) values (
      target.id, 'reviewed', 'system', null,
      jsonb_build_object('reason', 'connected_asset_auto_approval')
    );
  end if;

  if exists (select 1 from public.portal_clients where id = target.claimed_user_id) then
    select session.id
    into open_sibling_id
    from public.client_onboarding_sessions session
    where session.id <> target.id
      and session.status in ('pending', 'collecting')
      and (
        session.target_client_id = target.claimed_user_id
        or session.claimed_user_id = target.claimed_user_id
      )
    order by session.created_at desc, session.id desc
    limit 1;

    insert into public.client_rollout_states (
      client_id, operational_surface, onboarding_session_id, updated_by
    ) values (
      target.claimed_user_id,
      case when open_sibling_id is null
        then 'v2_ready_for_cutover'
        else 'v2_onboarding'
      end,
      coalesce(open_sibling_id, target.id),
      target.created_by
    ) on conflict (client_id) do update
      set operational_surface = case
            when client_rollout_states.operational_surface = 'v2_active'
              then 'v2_active'
            when open_sibling_id is not null
              then 'v2_onboarding'
            else 'v2_ready_for_cutover'
          end,
          onboarding_session_id = coalesce(open_sibling_id, target.id),
          updated_at = now();
  end if;
  return target.id;
end
$$;

revoke all on function public.submit_client_onboarding_session(uuid, text)
  from public, anon, authenticated;
grant execute on function public.submit_client_onboarding_session(uuid, text)
  to service_role;
