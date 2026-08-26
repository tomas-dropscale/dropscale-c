-- =============================================================================
-- 0085 - Let the team map a Google Ads account to a store.
--
-- The mapping decides which store a Google account's spend belongs to, and it
-- could only ever be set by the client, inside the onboarding flow, on a step
-- labelled "Match to store (optional)".
--
-- That step is unreachable in practice. The Windsor poll submits the session
-- the moment the requested assets are connected — one second after the account
-- appears — so the client is carried past the mapping before they can use it.
-- Submitting also clears invite_token_hash, and replace_client_asset_mappings
-- requires that hash, so afterwards nobody can set the mapping at all: not the
-- client, not the team. An unmapped account is stranded.
--
-- This is the admin path. It deliberately does not touch bindings, billing or
-- metrics: a mapping is a statement about which store an account belongs to,
-- and the reporting lifecycle reads it later on its own terms.
-- =============================================================================

create or replace function public.map_client_google_ads_to_store(
  p_google_ads_connection_id uuid,
  p_shopify_connection_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  google_ads public.client_google_ads_connections%rowtype;
  shopify public.client_shopify_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can map a reporting asset.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;

  select * into google_ads
  from public.client_google_ads_connections
  where id = p_google_ads_connection_id and status = 'connected'
  for update;
  if not found then
    raise exception 'Connected Google Ads asset not found.' using errcode = 'P0002';
  end if;

  select * into shopify
  from public.client_shopify_connections
  where id = p_shopify_connection_id and status = 'connected'
  for update;
  if not found then
    raise exception 'Connected Shopify store not found.' using errcode = 'P0002';
  end if;

  -- Both sides must belong to the same workspace. Without this an admin could
  -- attribute one client's ad spend to another client's store.
  if google_ads.client_id is distinct from shopify.client_id then
    raise exception 'The Google Ads account and the store belong to different clients.'
      using errcode = '23514';
  end if;

  -- The mapping row is owned by the session that connected the account, which
  -- is what the rest of the lifecycle already expects to find.
  insert into public.client_asset_mappings (
    session_id, shopify_connection_id, google_ads_connection_id
  ) values (
    google_ads.session_id, shopify.id, google_ads.id
  )
  on conflict (google_ads_connection_id) do update
    set shopify_connection_id = excluded.shopify_connection_id,
        session_id = excluded.session_id;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    google_ads.session_id, 'assets_mapped', 'admin', p_admin_id,
    jsonb_build_object(
      'googleAdsConnectionId', google_ads.id,
      'shopifyConnectionId', shopify.id,
      'setBy', 'admin'
    )
  );

  return google_ads.id;
end;
$$;

revoke all on function public.map_client_google_ads_to_store(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.map_client_google_ads_to_store(uuid, uuid, uuid)
  to service_role;
