-- =============================================================================
-- 0046 - Bind Shopify reconnect invitations to one exact existing store.
--
-- Older `reconnect` invitations were client-wide add-asset links. Preserve
-- those rows truthfully as add-assets sessions, then require every new
-- reconnect to name exactly one locked legacy or V2 Shopify connection.
-- =============================================================================

update public.client_onboarding_sessions
set mode = 'add_assets', updated_at = now()
where mode = 'reconnect';

alter table public.client_onboarding_sessions
  add column reconnect_legacy_ad_account_id uuid
    references public.ad_accounts(id) on delete restrict,
  add column reconnect_shopify_connection_id uuid
    references public.client_shopify_connections(id) on delete restrict,
  add column reconnect_completed_at timestamptz;

alter table public.client_onboarding_sessions
  drop constraint client_onboarding_requested_assets_shape,
  drop constraint client_onboarding_mode_target_shape,
  add constraint client_onboarding_requested_assets_shape check (
    cardinality(requested_assets) between 0 and 2
    and requested_assets <@ array['shopify', 'google_ads']::text[]
    and (
      (
        mode = 'new_client'
        and (
          cardinality(requested_assets) = 0
          or (
            cardinality(requested_assets) = 2
            and requested_assets @> array['shopify', 'google_ads']::text[]
          )
        )
      )
      or (
        mode = 'add_assets'
        and (
          cardinality(requested_assets) = 1
          or (
            cardinality(requested_assets) = 2
            and requested_assets @> array['shopify', 'google_ads']::text[]
          )
        )
      )
      or (mode = 'reconnect' and requested_assets = array['shopify']::text[])
    )
  ),
  add constraint client_onboarding_mode_target_shape check (
    (
      mode = 'new_client'
      and target_client_id is null
      and reconnect_legacy_ad_account_id is null
      and reconnect_shopify_connection_id is null
    )
    or (
      mode = 'add_assets'
      and target_client_id is not null
      and reconnect_legacy_ad_account_id is null
      and reconnect_shopify_connection_id is null
    )
    or (
      mode = 'reconnect'
      and target_client_id is not null
      and num_nonnulls(
        reconnect_legacy_ad_account_id,
        reconnect_shopify_connection_id
      ) = 1
    )
  ),
  add constraint client_onboarding_reconnect_completion_shape check (
    mode = 'reconnect' or reconnect_completed_at is null
  );

create index client_onboarding_reconnect_legacy_target_idx
  on public.client_onboarding_sessions(reconnect_legacy_ad_account_id)
  where reconnect_legacy_ad_account_id is not null;
create index client_onboarding_reconnect_shopify_target_idx
  on public.client_onboarding_sessions(reconnect_shopify_connection_id)
  where reconnect_shopify_connection_id is not null;

-- Generic invitations can create identities or add assets. Exact-store
-- reconnects must go through create_client_shopify_reconnect_invitation so the
-- database, rather than a browser-supplied client id, derives ownership.
create or replace function public.create_client_onboarding_invitation(
  p_session_id uuid,
  p_mode text,
  p_requested_assets text[],
  p_target_client_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can create an onboarding invitation.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_created_by and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_session_id is null
    or p_mode not in ('new_client', 'add_assets')
    or p_requested_assets is null
    or cardinality(p_requested_assets) not between 0 and 2
    or not p_requested_assets <@ array['shopify', 'google_ads']::text[]
    or (cardinality(p_requested_assets) = 0 and p_mode <> 'new_client')
    or (cardinality(p_requested_assets) = 1 and p_mode = 'new_client')
    or (
      cardinality(p_requested_assets) = 2
      and not p_requested_assets @> array['shopify', 'google_ads']::text[]
    )
    or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now()
    or p_expires_at > now() + interval '8 days'
    or (p_mode = 'new_client' and p_target_client_id is not null)
    or (p_mode = 'add_assets' and p_target_client_id is null)
  then
    raise exception 'Invalid client onboarding invitation.' using errcode = '22023';
  end if;
  if p_target_client_id is not null and not exists (
    select 1 from public.portal_clients where id = p_target_client_id
  ) then
    raise exception 'Target client not found.' using errcode = 'P0002';
  end if;

  insert into public.client_onboarding_sessions (
    id, mode, requested_assets, target_client_id, invite_token_hash,
    invite_expires_at, created_by
  ) values (
    p_session_id, p_mode,
    coalesce(
      (select array_agg(asset order by asset) from unnest(p_requested_assets) asset),
      '{}'::text[]
    ),
    p_target_client_id, p_token_hash, p_expires_at, p_created_by
  );

  if p_target_client_id is not null then
    insert into public.client_rollout_states (
      client_id, operational_surface, onboarding_session_id, updated_by
    ) values (
      p_target_client_id, 'v2_onboarding', p_session_id, p_created_by
    ) on conflict (client_id) do update
      set operational_surface = case
            when client_rollout_states.operational_surface = 'v2_active'
              then 'v2_active'
            else 'v2_onboarding'
          end,
          onboarding_session_id = excluded.onboarding_session_id,
          updated_by = excluded.updated_by,
          updated_at = now();
  end if;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    p_session_id, 'invitation_created', 'admin', p_created_by,
    jsonb_build_object('mode', p_mode, 'requested_assets', p_requested_assets)
  );
  return p_session_id;
end
$$;

create or replace function public.create_client_shopify_reconnect_invitation(
  p_session_id uuid,
  p_target_source text,
  p_target_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  derived_client_id uuid;
  target_domain text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can create a Shopify reconnect invitation.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_created_by and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_session_id is null
    or p_target_source is null
    or p_target_source not in ('legacy', 'onboarding')
    or p_target_id is null
    or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at is null
    or p_expires_at <= now()
    or p_expires_at > now() + interval '8 days'
  then
    raise exception 'Invalid Shopify reconnect invitation.' using errcode = '22023';
  end if;

  if p_target_source = 'legacy' then
    select account.client_id,
           lower(regexp_replace(
             regexp_replace(btrim(coalesce(account.shopify_url, '')), '^https?://', '', 'i'),
             '/.*$', ''
           ))
    into derived_client_id, target_domain
    from public.ad_accounts account
    where account.id = p_target_id
      and account.status = 'active'
      and account.shopify_connected = true
    for update;
  else
    select connection.client_id, lower(btrim(connection.shopify_domain))
    into derived_client_id, target_domain
    from public.client_shopify_connections connection
    where connection.id = p_target_id
      and connection.status = 'connected'
    for update;
  end if;

  if derived_client_id is null
    or coalesce(target_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or not exists (
      select 1 from public.portal_clients client where client.id = derived_client_id
    )
  then
    raise exception 'Reconnect Shopify target not found.' using errcode = 'P0002';
  end if;

  insert into public.client_onboarding_sessions (
    id, mode, requested_assets, target_client_id,
    reconnect_legacy_ad_account_id, reconnect_shopify_connection_id,
    invite_token_hash, invite_expires_at, created_by
  ) values (
    p_session_id, 'reconnect', array['shopify']::text[], derived_client_id,
    case when p_target_source = 'legacy' then p_target_id else null end,
    case when p_target_source = 'onboarding' then p_target_id else null end,
    p_token_hash, p_expires_at, p_created_by
  );

  insert into public.client_rollout_states (
    client_id, operational_surface, onboarding_session_id, updated_by
  ) values (
    derived_client_id, 'v2_onboarding', p_session_id, p_created_by
  ) on conflict (client_id) do update
    set operational_surface = case
          when client_rollout_states.operational_surface = 'v2_active'
            then 'v2_active'
          else 'v2_onboarding'
        end,
        onboarding_session_id = excluded.onboarding_session_id,
        updated_by = excluded.updated_by,
        updated_at = now();

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    p_session_id, 'invitation_created', 'admin', p_created_by,
    jsonb_build_object(
      'mode', 'reconnect',
      'requested_assets', array['shopify']::text[],
      'target_source', p_target_source,
      'target_id', p_target_id
    )
  );
  return p_session_id;
end
$$;

revoke all on function public.create_client_shopify_reconnect_invitation(
  uuid, text, uuid, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.create_client_shopify_reconnect_invitation(
  uuid, text, uuid, text, timestamptz, uuid
) to service_role;

-- P4409 is reserved here for an authenticated Shopify shop whose verified
-- identity/domain does not match the exact reconnect target.
create or replace function public.complete_client_shopify_connection(
  p_connection_id uuid,
  p_session_id uuid,
  p_token_hash text,
  p_shopify_shop_id text,
  p_shopify_name text,
  p_shopify_domain text,
  p_primary_domain text,
  p_shopify_currency text,
  p_shopify_client_id text,
  p_credential_hint text,
  p_granted_scopes text[],
  p_client_secret_ciphertext text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  result_id uuid;
  existing_client_id uuid;
  existing_session_id uuid;
  existing_shop_id text;
  existing_domain text;
  legacy_client_id uuid;
  legacy_domain text;
  reused boolean := false;
  required_scopes constant text[] := array[
    'read_all_orders', 'read_analytics', 'read_inventory', 'read_locations',
    'read_orders', 'read_products', 'read_reports', 'read_returns',
    'read_shopify_payments_accounts', 'read_shopify_payments_payouts'
  ]::text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save a Shopify reporting connection.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
    or not ('shopify' = any(target.requested_assets))
  then
    raise exception 'Shopify onboarding is not available.' using errcode = 'P0002';
  end if;
  if p_connection_id is null
    or coalesce(p_shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or coalesce(p_shopify_currency, '') !~ '^[A-Z]{3}$'
    or length(btrim(coalesce(p_shopify_shop_id, ''))) = 0
    or length(btrim(coalesce(p_shopify_name, ''))) = 0
    or length(btrim(coalesce(p_shopify_client_id, ''))) = 0
    or length(btrim(coalesce(p_credential_hint, ''))) = 0
    or length(btrim(coalesce(p_client_secret_ciphertext, ''))) = 0
    or not required_scopes <@ coalesce(p_granted_scopes, '{}'::text[])
    or exists (
      select 1 from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
      where not (scope = any(required_scopes))
    )
    or exists (
      select 1 from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
      where scope like 'write\_%' escape '\'
    )
  then
    raise exception 'Verified Shopify reporting metadata is incomplete.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
    where scope is null or scope <> lower(btrim(scope)) or scope !~ '^[a-z0-9_]+$'
  ) then
    raise exception 'Invalid Shopify scope metadata.' using errcode = '22023';
  end if;

  if target.mode = 'reconnect' and target.reconnect_shopify_connection_id is not null then
    select connection.client_id, connection.session_id,
           connection.shopify_shop_id, lower(btrim(connection.shopify_domain))
    into existing_client_id, existing_session_id, existing_shop_id, existing_domain
    from public.client_shopify_connections connection
    where connection.id = target.reconnect_shopify_connection_id
      and connection.status = 'connected'
    for update;

    if not found or existing_client_id is distinct from target.claimed_user_id then
      raise exception 'Reconnect Shopify target is not available.' using errcode = 'P0002';
    end if;
    if existing_shop_id is distinct from btrim(p_shopify_shop_id)
      or existing_domain is distinct from lower(btrim(p_shopify_domain))
    then
      raise exception 'Verified Shopify store does not match the reconnect target.'
        using errcode = 'P4409';
    end if;
    result_id := target.reconnect_shopify_connection_id;
    reused := true;

  elsif target.mode = 'reconnect' and target.reconnect_legacy_ad_account_id is not null then
    select account.client_id,
           lower(regexp_replace(
             regexp_replace(btrim(coalesce(account.shopify_url, '')), '^https?://', '', 'i'),
             '/.*$', ''
           ))
    into legacy_client_id, legacy_domain
    from public.ad_accounts account
    where account.id = target.reconnect_legacy_ad_account_id
      and account.status = 'active'
      and account.shopify_connected = true
    for update;

    if not found
      or legacy_client_id is distinct from target.claimed_user_id
      or coalesce(legacy_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    then
      raise exception 'Reconnect Shopify target is not available.' using errcode = 'P0002';
    end if;
    if legacy_domain is distinct from lower(btrim(p_shopify_domain)) then
      raise exception 'Verified Shopify store does not match the reconnect target.'
        using errcode = 'P4409';
    end if;

    select connection.id, connection.client_id, connection.session_id,
           connection.shopify_shop_id, lower(btrim(connection.shopify_domain))
    into result_id, existing_client_id, existing_session_id,
         existing_shop_id, existing_domain
    from public.client_shopify_connections connection
    where connection.status = 'connected'
      and (
        connection.shopify_shop_id = btrim(p_shopify_shop_id)
        or lower(connection.shopify_domain) = lower(btrim(p_shopify_domain))
      )
    order by case when connection.shopify_shop_id = btrim(p_shopify_shop_id) then 0 else 1 end
    limit 1
    for update;

    if result_id is not null and existing_client_id is distinct from target.claimed_user_id then
      raise exception 'This Shopify store belongs to another client.' using errcode = '23505';
    end if;
    if result_id is not null and (
      existing_shop_id is distinct from btrim(p_shopify_shop_id)
      or existing_domain is distinct from lower(btrim(p_shopify_domain))
    ) then
      raise exception 'Verified Shopify store does not match the reconnect target.'
        using errcode = 'P4409';
    end if;
    reused := result_id is not null;

  else
    select connection.id, connection.client_id, connection.session_id
    into result_id, existing_client_id, existing_session_id
    from public.client_shopify_connections connection
    where connection.status = 'connected'
      and (
        connection.shopify_shop_id = btrim(p_shopify_shop_id)
        or lower(connection.shopify_domain) = lower(btrim(p_shopify_domain))
      )
    order by case when connection.shopify_shop_id = btrim(p_shopify_shop_id) then 0 else 1 end
    limit 1
    for update;

    if result_id is not null and existing_client_id <> target.claimed_user_id then
      raise exception 'This Shopify store belongs to another client.' using errcode = '23505';
    end if;
    if result_id is not null and existing_session_id <> target.id then
      raise exception 'This Shopify store is already connected in another onboarding session.'
        using errcode = '23505';
    end if;
    reused := result_id is not null;
  end if;

  if result_id is null then
    result_id := p_connection_id;
    begin
      insert into public.client_shopify_connections (
        id, session_id, client_id, shopify_shop_id, shopify_name,
        shopify_domain, primary_domain, shopify_currency, credential_hint,
        granted_scopes, last_verified_at
      ) values (
        result_id, target.id, target.claimed_user_id,
        btrim(p_shopify_shop_id), btrim(p_shopify_name), lower(btrim(p_shopify_domain)),
        nullif(lower(btrim(coalesce(p_primary_domain, ''))), ''),
        upper(btrim(p_shopify_currency)), btrim(p_credential_hint),
        (select array_agg(distinct scope order by scope) from unnest(p_granted_scopes) scope),
        now()
      );
    exception
      when unique_violation then
        raise exception 'This Shopify store already has an active reporting connection.'
          using errcode = '23505';
    end;
  else
    update public.client_shopify_connections
    set shopify_shop_id = btrim(p_shopify_shop_id),
        shopify_name = btrim(p_shopify_name),
        shopify_domain = lower(btrim(p_shopify_domain)),
        primary_domain = nullif(lower(btrim(coalesce(p_primary_domain, ''))), ''),
        shopify_currency = upper(btrim(p_shopify_currency)),
        credential_hint = btrim(p_credential_hint),
        granted_scopes = (
          select array_agg(distinct scope order by scope) from unnest(p_granted_scopes) scope
        ),
        last_verified_at = now(),
        last_error_code = null,
        updated_at = now()
    where id = result_id;
  end if;

  insert into public.client_shopify_credentials (
    connection_id, shopify_client_id, client_secret_ciphertext
  ) values (
    result_id, btrim(p_shopify_client_id), p_client_secret_ciphertext
  ) on conflict (connection_id) do update
    set shopify_client_id = excluded.shopify_client_id,
        client_secret_ciphertext = excluded.client_secret_ciphertext,
        updated_at = now();

  update public.client_onboarding_sessions
  set reconnect_completed_at = case
        when target.mode = 'reconnect' then now()
        else reconnect_completed_at
      end,
      updated_at = now()
  where id = target.id;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.id, 'shopify_connected', 'invite', target.claimed_user_id,
    jsonb_build_object(
      'connection_id', result_id,
      'shopify_domain', lower(btrim(p_shopify_domain)),
      'reused', reused,
      'target_source', case
        when target.reconnect_legacy_ad_account_id is not null then 'legacy'
        when target.reconnect_shopify_connection_id is not null then 'onboarding'
        else null
      end
    )
  );
  return result_id;
end
$$;

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
    insert into public.client_rollout_states (
      client_id, operational_surface, onboarding_session_id, updated_by
    ) values (
      target.claimed_user_id, 'v2_ready_for_cutover', target.id, target.created_by
    ) on conflict (client_id) do update
      set operational_surface = case
            when client_rollout_states.operational_surface = 'v2_active'
              then 'v2_active'
            else 'v2_ready_for_cutover'
          end,
          onboarding_session_id = excluded.onboarding_session_id,
          updated_at = now();
  end if;
  return target.id;
end
$$;

revoke all on function public.create_client_onboarding_invitation(
  uuid, text, text[], uuid, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.create_client_onboarding_invitation(
  uuid, text, text[], uuid, text, timestamptz, uuid
) to service_role;

revoke all on function public.complete_client_shopify_connection(
  uuid, uuid, text, text, text, text, text, text, text, text, text[], text
) from public, anon, authenticated;
grant execute on function public.complete_client_shopify_connection(
  uuid, uuid, text, text, text, text, text, text, text, text, text[], text
) to service_role;

revoke all on function public.submit_client_onboarding_session(uuid, text)
  from public, anon, authenticated;
grant execute on function public.submit_client_onboarding_session(uuid, text)
  to service_role;
