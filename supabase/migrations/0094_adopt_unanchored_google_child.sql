-- 0094 - Adopt an unanchored Google reporting source into an existing store.
--
-- A Google source provisioned before its client_asset_mappings row existed is
-- bound standalone: shopify_anchor_binding_id IS NULL. Its spend is real and is
-- billed correctly - billing keys on ad_account_id and never on binding
-- topology - but reporting cannot join it to the store it advertises, so the
-- store shows revenue against zero cost and an invented margin.
--
-- Every existing repair is closed once the client is live:
--   * revoke      - 0056 refuses any active->revoked change post-cutover,
--   * restage     - 0056 refuses an account that has a billing start,
--   * reprovision - 0055 refuses a Google identity an account already owns.
-- Those are billing interlocks, and they are right: an account that has issued
-- invoices must not have its identity replaced underneath them.
--
-- This migration steps over none of them, because it replaces nothing. The
-- binding keeps its id, its ad account, its Google connection and its bound_at;
-- one NULL column is answered with the anchor the source always belonged to.
-- No revoke, no second binding, no new billing identity, and the immutable
-- ad_account_billing_starts row is never read or written.

create or replace function public.guard_client_reporting_binding_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cutover_time timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'A client reporting binding cannot be deleted.' using errcode = '23514';
  end if;

  -- Adopting an unanchored Google source into an existing Shopify anchor is the
  -- one identity field that may still be filled in after the fact. It records
  -- the store the spend already belonged to; it never moves spend to a different
  -- ad account, so the immutable billing identity, its start boundary and every
  -- issued invoice line stay exactly where they are. That is why this is allowed
  -- where a revoke is not: nothing is replaced, a single NULL is answered.
  --
  -- The escape is deliberately narrow: only the purpose-bound RPC may name the
  -- binding, the anchor may only go from NULL to set and never be re-pointed,
  -- and every other column must be byte-identical.
  if old.shopify_anchor_binding_id is null
    and new.shopify_anchor_binding_id is not null
    and current_setting('dropscale.reporting_child_adoption', true)
          is not distinct from old.id::text
  then
    if auth.role() is distinct from 'service_role'
      or new.id is distinct from old.id
      or new.client_id is distinct from old.client_id
      or new.ad_account_id is distinct from old.ad_account_id
      or old.shopify_connection_id is not null
      or new.shopify_connection_id is not null
      or old.google_ads_connection_id is null
      or new.google_ads_connection_id is distinct from old.google_ads_connection_id
      or new.idempotency_key is distinct from old.idempotency_key
      or new.bound_reason is distinct from old.bound_reason
      or new.bound_by is distinct from old.bound_by
      or new.bound_at is distinct from old.bound_at
      or old.status <> 'active'
      or new.status <> 'active'
      or new.revoked_by is not null
      or new.revoked_at is not null
      or new.revoke_reason is not null
    then
      raise exception 'An unanchored Google source may only be adopted unchanged.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.client_id is distinct from old.client_id
    or new.ad_account_id is distinct from old.ad_account_id
    or new.shopify_connection_id is distinct from old.shopify_connection_id
    or new.google_ads_connection_id is distinct from old.google_ads_connection_id
    or new.shopify_anchor_binding_id is distinct from old.shopify_anchor_binding_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.bound_reason is distinct from old.bound_reason
    or new.bound_by is distinct from old.bound_by
    or new.bound_at is distinct from old.bound_at
  then
    raise exception 'A client reporting binding identity is immutable.' using errcode = '23514';
  end if;

  if old.status = 'active' and new.status = 'staged' then
    select rollout.reporting_cutover_at into cutover_time
    from public.client_rollout_states rollout
    where rollout.client_id = old.client_id
      and rollout.operational_surface = 'v2_active'
      and rollout.reporting_cutover_at is not null;
    if auth.role() is distinct from 'service_role'
      or current_setting('dropscale.reporting_source_stage_binding', true)
           is distinct from old.id::text
      or not found
      or old.bound_at <= cutover_time
      or new.revoked_by is not null
      or new.revoked_at is not null
      or new.revoke_reason is not null
    then
      raise exception 'Only a fresh purpose-bound post-cutover source may be staged.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'staged' and new.status = 'active' then
    if auth.role() is distinct from 'service_role'
      or current_setting('dropscale.reporting_source_promote_binding', true)
           is distinct from old.id::text
      or new.revoked_by is not null
      or new.revoked_at is not null
      or new.revoke_reason is not null
    then
      raise exception 'A staged source may only be activated by its promotion RPC.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'staged' and new.status = 'revoked' then
    if auth.role() is distinct from 'service_role'
      or current_setting('dropscale.reporting_source_abandon_binding', true)
           is distinct from old.id::text
      or new.revoked_by is null
      or new.revoked_at is null
      or new.revoke_reason is null
    then
      raise exception 'A staged source may only be abandoned by its lifecycle RPC.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status <> 'active'
    or new.status <> 'revoked'
    or new.revoked_by is null
    or new.revoked_at is null
    or new.revoke_reason is null
  then
    raise exception 'A client reporting binding identity is immutable.' using errcode = '23514';
  end if;
  if exists (
      select 1 from public.client_rollout_states rollout
      where rollout.client_id = old.client_id
        and rollout.operational_surface = 'v2_active'
        and rollout.reporting_cutover_at is not null
    )
  then
    if current_setting('dropscale.reporting_pair_upgrade', true)
         is not distinct from old.id::text
    then
      raise exception 'Post-cutover exact reconnect replacement requires a separate staged replacement lifecycle.'
        using errcode = '23514';
    end if;
    raise exception 'Demote the V2 rollout before revoking an operational reporting binding.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

-- The only writer of that GUC. Everything it asserts mirrors what
-- resolveReportingSources demands of a child binding, so a successful call
-- cannot leave a state the reporting resolver would then reject.
create or replace function public.adopt_client_reporting_google_child(
  p_binding_id uuid,
  p_shopify_anchor_binding_id uuid,
  p_admin_id uuid,
  p_idempotency_key text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  child public.client_reporting_bindings%rowtype;
  anchor public.client_reporting_bindings%rowtype;
  anchor_account public.ad_accounts%rowtype;
  anchor_shopify public.client_shopify_connections%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can adopt a Google source.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_binding_id is null
    or p_shopify_anchor_binding_id is null
    or p_binding_id = p_shopify_anchor_binding_id
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 100
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting child adoption.' using errcode = '22023';
  end if;

  -- Match the stage/promote/abandon lock order: the immutable lifecycle events
  -- table first, then the rows. Taking row locks first deadlocks against them.
  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_event.event_type = 'adopted'
      and existing_event.binding_id = p_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
      and existing_event.details ->> 'shopifyAnchorBindingId'
            = p_shopify_anchor_binding_id::text
    then
      return existing_event.binding_id;
    end if;
    raise exception 'Reporting adoption idempotency key is already used.' using errcode = '23505';
  end if;

  select * into child
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'active'
  for update;
  if not found
    or child.google_ads_connection_id is null
    or child.shopify_connection_id is not null
    or child.shopify_anchor_binding_id is not null
  then
    raise exception 'Active unanchored Google binding not found.' using errcode = '23514';
  end if;

  select * into anchor
  from public.client_reporting_bindings binding
  where binding.id = p_shopify_anchor_binding_id
    and binding.status = 'active'
    and binding.client_id = child.client_id
  for update;
  if not found
    or anchor.shopify_connection_id is null
    or anchor.shopify_anchor_binding_id is not null
  then
    raise exception 'An active Shopify anchor of the same client is required.'
      using errcode = '23514';
  end if;

  select * into anchor_account
  from public.ad_accounts account
  where account.id = anchor.ad_account_id and account.client_id = child.client_id
  for update;
  if not found then
    raise exception 'The Shopify anchor account is unavailable.' using errcode = '23514';
  end if;

  select * into anchor_shopify
  from public.client_shopify_connections connection
  where connection.id = anchor.shopify_connection_id
    and connection.status = 'connected'
    and connection.client_id = child.client_id
  for update;
  if not found
    or anchor_shopify.last_verified_at is null
    or anchor_shopify.last_error_code is not null
    or public.normalize_shopify_reporting_domain(anchor_account.shopify_url)
       is distinct from public.normalize_shopify_reporting_domain(anchor_shopify.shopify_domain)
  then
    raise exception 'The Shopify anchor is not a verified match for its store.'
      using errcode = '23514';
  end if;

  select * into google_ads
  from public.client_google_ads_connections connection
  where connection.id = child.google_ads_connection_id
    and connection.status = 'connected'
    and connection.client_id = child.client_id
  for update;
  if not found
    or google_ads.last_verified_at is null
    or google_ads.last_error_code is not null
  then
    raise exception 'The bound Google Ads source is no longer verified.' using errcode = '23514';
  end if;

  -- ORDER MATTERS. guard_bound_client_asset_mapping rejects a mapping whose
  -- store differs from what the Google source's active binding already says,
  -- and it reads that as coalesce(binding.shopify_connection_id,
  -- anchor.shopify_connection_id). While the anchor is still NULL that
  -- expression is NULL, so the mapping is refused with "The bound Google Ads
  -- source cannot be mapped to a different Shopify source." Answer the binding
  -- first; the mapping then agrees with it and the guard passes.
  perform set_config('dropscale.reporting_child_adoption', child.id::text, true);
  update public.client_reporting_bindings
    set shopify_anchor_binding_id = anchor.id
  where id = child.id;

  -- The resolver demands exactly one mapping for this Google connection, naming
  -- the ANCHOR BINDING's Shopify connection. Session provenance comes from the
  -- Google connection itself, exactly as map_client_google_ads_to_store does.
  insert into public.client_asset_mappings (
    session_id, shopify_connection_id, google_ads_connection_id
  ) values (
    google_ads.session_id, anchor_shopify.id, google_ads.id
  )
  on conflict (google_ads_connection_id) do update
    set shopify_connection_id = excluded.shopify_connection_id,
        session_id = excluded.session_id;

  insert into public.client_reporting_anchor_events (
    binding_id, prior_binding_id, ad_account_id, event_type,
    idempotency_key, actor_id, reason, details
  ) values (
    child.id, null, child.ad_account_id, 'adopted',
    p_idempotency_key, p_admin_id, normal_reason,
    jsonb_build_object(
      'shopifyAnchorBindingId', anchor.id,
      'shopifyConnectionId', anchor_shopify.id,
      'googleAdsConnectionId', google_ads.id
    )
  );

  return child.id;
end
$$;

revoke all on function public.adopt_client_reporting_google_child(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.adopt_client_reporting_google_child(
  uuid, uuid, uuid, text, text
) to service_role;
