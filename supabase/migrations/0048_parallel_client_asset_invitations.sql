-- Allow purpose-bound invitations to coexist. Generic Shopify and Google Ads
-- requests each have one client slot, while exact Shopify reconnects are
-- unique only per target store.

drop index if exists public.client_onboarding_one_open_target_idx;

create unique index client_onboarding_one_open_shopify_add_slot_idx
  on public.client_onboarding_sessions(target_client_id)
  where target_client_id is not null
    and mode = 'add_assets'
    and status in ('pending', 'collecting')
    and requested_assets @> array['shopify']::text[];

create unique index client_onboarding_one_open_google_ads_slot_idx
  on public.client_onboarding_sessions(target_client_id)
  where target_client_id is not null
    and status in ('pending', 'collecting')
    and requested_assets @> array['google_ads']::text[];

create unique index client_onboarding_one_open_reconnect_legacy_target_idx
  on public.client_onboarding_sessions(reconnect_legacy_ad_account_id)
  where reconnect_legacy_ad_account_id is not null
    and status in ('pending', 'collecting');

create unique index client_onboarding_one_open_reconnect_shopify_target_idx
  on public.client_onboarding_sessions(reconnect_shopify_connection_id)
  where reconnect_shopify_connection_id is not null
    and status in ('pending', 'collecting');

-- A mapping may reuse completed assets, but it must not depend on an asset
-- owned by another still-cancellable invitation.
create or replace function public.replace_client_asset_mappings(
  p_session_id uuid,
  p_token_hash text,
  p_mappings jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  mapping jsonb;
  shop_id uuid;
  google_id uuid;
  shop_session_id uuid;
  google_session_id uuid;
  shop_session_status text;
  google_session_status text;
  submitted_google_ids uuid[] := '{}'::uuid[];
  inserted_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save asset mappings.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
  then
    raise exception 'Asset mapping is not available.' using errcode = 'P0002';
  end if;
  if p_mappings is null
    or jsonb_typeof(p_mappings) is distinct from 'array'
    or jsonb_array_length(p_mappings) > 100
  then
    raise exception 'Invalid asset mappings.' using errcode = '22023';
  end if;

  -- Validate the full replacement before the first mutation. Each Google Ads
  -- account has one optional Shopify match, and an older asset may only be
  -- changed when the other side of that pair was added by this invitation.
  for mapping in select value from jsonb_array_elements(p_mappings)
  loop
    if jsonb_typeof(mapping) <> 'object'
      or not mapping ?& array['shopifyConnectionId', 'googleAdsConnectionId']::text[]
      or exists (
        select 1 from jsonb_object_keys(mapping) key
        where key not in ('shopifyConnectionId', 'googleAdsConnectionId')
      )
      or jsonb_typeof(mapping -> 'shopifyConnectionId') is distinct from 'string'
      or jsonb_typeof(mapping -> 'googleAdsConnectionId') is distinct from 'string'
    then
      raise exception 'Invalid asset mapping.' using errcode = '22023';
    end if;
    begin
      shop_id := (mapping ->> 'shopifyConnectionId')::uuid;
      google_id := (mapping ->> 'googleAdsConnectionId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invalid asset mapping.' using errcode = '22023';
    end;

    if google_id = any(submitted_google_ids) then
      raise exception 'Duplicate Google Ads account in asset mappings.' using errcode = '22023';
    end if;

    select session_id into shop_session_id
    from public.client_shopify_connections
    where id = shop_id
      and client_id = target.claimed_user_id
      and status = 'connected'
    for share;
    if not found then
      raise exception 'Asset mapping does not belong to this onboarding.' using errcode = '42501';
    end if;

    select session_id into google_session_id
    from public.client_google_ads_connections
    where id = google_id
      and client_id = target.claimed_user_id
      and status = 'connected'
    for share;
    if not found then
      raise exception 'Asset mapping does not belong to this onboarding.' using errcode = '42501';
    end if;

    if shop_session_id <> target.id then
      select status into shop_session_status
      from public.client_onboarding_sessions
      where id = shop_session_id
      for share;
      if shop_session_status in ('pending', 'collecting') then
        raise exception 'A mapped asset belongs to another open onboarding session.'
          using errcode = '42501';
      end if;
    end if;
    if google_session_id <> target.id then
      select status into google_session_status
      from public.client_onboarding_sessions
      where id = google_session_id
      for share;
      if google_session_status in ('pending', 'collecting') then
        raise exception 'A mapped asset belongs to another open onboarding session.'
          using errcode = '42501';
      end if;
    end if;
    if shop_session_id <> target.id and google_session_id <> target.id then
      raise exception 'At least one mapped asset must belong to this onboarding.'
        using errcode = '42501';
    end if;
    submitted_google_ids := array_append(submitted_google_ids, google_id);
  end loop;

  -- An empty payload intentionally clears matches involving assets from this
  -- session. Submitted older Google IDs are also removed first so selecting a
  -- newly connected Shopify store performs a real one-to-one remap.
  delete from public.client_asset_mappings existing_mapping
  where existing_mapping.google_ads_connection_id = any(submitted_google_ids)
    or exists (
      select 1 from public.client_shopify_connections shopify_connection
      where shopify_connection.id = existing_mapping.shopify_connection_id
        and shopify_connection.session_id = target.id
    )
    or exists (
      select 1 from public.client_google_ads_connections google_connection
      where google_connection.id = existing_mapping.google_ads_connection_id
        and google_connection.session_id = target.id
    );

  for mapping in select value from jsonb_array_elements(p_mappings)
  loop
    shop_id := (mapping ->> 'shopifyConnectionId')::uuid;
    google_id := (mapping ->> 'googleAdsConnectionId')::uuid;
    insert into public.client_asset_mappings (
      session_id, shopify_connection_id, google_ads_connection_id
    ) values (target.id, shop_id, google_id);
    inserted_count := inserted_count + 1;
  end loop;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.id, 'assets_mapped', 'client', target.claimed_user_id,
    jsonb_build_object('mapping_count', inserted_count)
  );
  return inserted_count;
end
$$;

revoke all on function public.replace_client_asset_mappings(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_client_asset_mappings(uuid, text, jsonb)
  to service_role;

-- Keep exact reconnect targets available until their invitation is completed
-- or cancelled. Invitation creation and removal both lock the target asset, so
-- a concurrent operation cannot leave an open link pointing at a removed row.
create or replace function public.revoke_client_shopify_connection(
  p_connection_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_shopify_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke a Shopify asset.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_shopify_connections
  where id = p_connection_id and status = 'connected' for update;
  if not found then
    raise exception 'Connected Shopify asset not found.' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from public.client_onboarding_sessions session
    where session.reconnect_shopify_connection_id = target.id
      and session.status in ('pending', 'collecting')
  ) then
    raise exception 'Cancel the open reconnect link before removing this Shopify store.'
      using errcode = '23514';
  end if;
  delete from public.client_shopify_credentials where connection_id = target.id;
  delete from public.client_asset_mappings where shopify_connection_id = target.id;
  update public.client_shopify_connections
  set status = 'revoked', credential_hint = null, revoked_at = now(), updated_at = now()
  where id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.session_id, 'connections_revoked', 'admin', p_admin_id,
    jsonb_build_object('asset_type', 'shopify', 'connection_id', target.id)
  );
  return target.id;
end
$$;

revoke all on function public.revoke_client_shopify_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_client_shopify_connection(uuid, uuid)
  to service_role;

create or replace function public.disconnect_legacy_shopify_connection(
  p_account_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can disconnect a legacy Shopify asset.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;

  select id into target_id
  from public.ad_accounts
  where id = p_account_id
    and status = 'active'
    and shopify_connected is true
  for update;
  if not found then
    raise exception 'Active legacy Shopify connection not found.' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from public.client_onboarding_sessions session
    where session.reconnect_legacy_ad_account_id = target_id
      and session.status in ('pending', 'collecting')
  ) then
    raise exception 'Cancel the open reconnect link before removing this Shopify store.'
      using errcode = '23514';
  end if;

  update public.ad_accounts
  set shopify_admin_token = null,
      shopify_token_last4 = null,
      shopify_connected = false,
      shopify_connected_at = null
  where id = target_id;

  return target_id;
end
$$;

revoke all on function public.disconnect_legacy_shopify_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.disconnect_legacy_shopify_connection(uuid, uuid)
  to service_role;

-- Submitting one purpose-bound link must not hide another link that is still
-- open for the same client.
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

  update public.client_onboarding_sessions
  set status = 'submitted',
      invite_token_hash = null,
      invite_expires_at = null,
      submitted_at = now(),
      updated_at = now(),
      last_error_code = null
  where id = target.id;
  delete from public.client_onboarding_secrets where session_id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (target.id, 'submitted', 'client', target.claimed_user_id);

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

-- Cancelling one link restores an open sibling before considering newer
-- submitted/reviewed history for the rollout pointer.
create or replace function public.revoke_client_onboarding_session(
  p_session_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  was_connected boolean;
  rollout_was_v2_active boolean := false;
  surviving_session_id uuid;
  surviving_session_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke onboarding.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found or target.status not in ('pending', 'collecting') then
    raise exception 'Only an open onboarding session can be revoked.' using errcode = 'P0002';
  end if;
  if target.target_client_id is not null then
    select operational_surface = 'v2_active'
    into rollout_was_v2_active
    from public.client_rollout_states
    where client_id = target.target_client_id
    for update;
    rollout_was_v2_active := coalesce(rollout_was_v2_active, false);
  end if;
  was_connected := exists (
    select 1 from public.client_shopify_connections
    where session_id = target.id and status = 'connected'
  ) or exists (
    select 1 from public.client_google_ads_connections
    where session_id = target.id and status = 'connected'
  );

  delete from public.client_shopify_credentials
  where connection_id in (
    select id from public.client_shopify_connections where session_id = target.id
  );
  delete from public.client_asset_mappings existing_mapping
  where exists (
    select 1
    from public.client_shopify_connections shopify_connection
    where shopify_connection.id = existing_mapping.shopify_connection_id
      and shopify_connection.session_id = target.id
  ) or exists (
    select 1
    from public.client_google_ads_connections google_connection
    where google_connection.id = existing_mapping.google_ads_connection_id
      and google_connection.session_id = target.id
  );
  delete from public.client_onboarding_secrets where session_id = target.id;
  update public.client_shopify_connections
  set status = 'revoked', credential_hint = null, revoked_at = now(), updated_at = now()
  where session_id = target.id and status = 'connected';
  update public.client_google_ads_connections
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where session_id = target.id and status = 'connected';
  update public.client_onboarding_sessions
  set status = 'revoked', invite_token_hash = null, invite_expires_at = null,
      revoked_at = now(), updated_at = now()
  where id = target.id;

  if target.target_client_id is not null then
    select session.id, session.status
    into surviving_session_id, surviving_session_status
    from public.client_onboarding_sessions session
    where session.status <> 'revoked'
      and (
        session.target_client_id = target.target_client_id
        or session.claimed_user_id = target.target_client_id
      )
    order by
      case when session.status in ('pending', 'collecting') then 0 else 1 end,
      session.created_at desc,
      session.id desc
    limit 1;

    update public.client_rollout_states
    set operational_surface = case
          when rollout_was_v2_active then 'v2_active'
          when surviving_session_status = 'active' then 'v2_active'
          when surviving_session_status in ('submitted', 'reviewed')
            then 'v2_ready_for_cutover'
          when surviving_session_status in ('pending', 'collecting')
            then 'v2_onboarding'
          else 'legacy_only'
        end,
        onboarding_session_id = surviving_session_id,
        updated_by = p_admin_id,
        updated_at = now()
    where client_id = target.target_client_id;
  end if;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (
    target.id,
    case when was_connected then 'connections_revoked' else 'invitation_revoked' end,
    'admin', p_admin_id
  );
  return target.id;
end
$$;

revoke all on function public.revoke_client_onboarding_session(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_client_onboarding_session(uuid, uuid)
  to service_role;
