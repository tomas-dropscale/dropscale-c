-- 0097 - Retire a store: a Shopify anchor whose store is gone leaves the
-- client's reporting without bricking the client.
--
-- After the cutover every operational binding is immutable on purpose
-- (0056/0095), and a dead store keeps its anchor as AUTHORITY: one Shopify
-- connection that can no longer verify blocks the whole client in the
-- cutover queue, with no action left to take. The only door was "demote the
-- rollout", which is not a door.
--
-- This migration adds the Shopify-side counterpart of the Google handover:
--   * 'store_retired' joins the immutable anchor-event vocabulary;
--   * the binding-change guard gains a second purpose-bound escape
--     (dropscale.reporting_store_retire), spliced into the 0095 text with the
--     rest byte-identical;
--   * retire_client_reporting_store() revokes the anchor under that escape and
--     revokes the store's Shopify connection exactly as
--     revoke_client_shopify_connection (0048) does, in ONE transaction, then
--     records the evidence. Rows already written for the store stay where they
--     are; nothing syncs the account again, and the runtime scope skips it on
--     this event rather than failing the nightly close.
-- Preconditions are strict on purpose: post-cutover client only, a plain
-- Shopify anchor (no Google on the pair - hand it over or stop it first), no
-- active or staged child left under it, and never the client's last store.

-- 'store_retired' joins the immutable anchor-event vocabulary.
alter table public.client_reporting_anchor_events
  drop constraint if exists client_reporting_anchor_events_event_type_check;
alter table public.client_reporting_anchor_events
  add constraint client_reporting_anchor_events_event_type_check
  check (event_type in (
    'provisioned', 'adopted', 'upgraded', 'restaged',
    'source_added', 'source_abandoned', 'handed_over', 'store_retired'
  ));

-- Baseline: the deployed 0095 guard, byte-identical, plus the retire escape.
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
    -- A store handover retires this binding inside its purpose-bound RPC: the
    -- same transaction re-binds the account's Shopify side and commits the
    -- Google source's child under its new store, so the workspace never loses
    -- an operational source. Only that RPC writes this GUC, and every shape
    -- check above (active -> revoked, revocation fields present, identity
    -- columns untouched) has already run by the time it is read.
    if current_setting('dropscale.reporting_source_handover', true)
         is not distinct from old.id::text
    then
      return new;
    end if;
    -- Retiring a store is the Shopify-side counterpart: its purpose-bound RPC
    -- revokes the anchor and the store's own connection together, in one
    -- transaction, and only once every Google source has left the store. Only
    -- that RPC writes this GUC, and the same shape checks above have run.
    if current_setting('dropscale.reporting_store_retire', true)
         is not distinct from old.id::text
    then
      return new;
    end if;
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

create or replace function public.retire_client_reporting_store(
  p_anchor_binding_id uuid,
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
  existing_event public.client_reporting_anchor_events%rowtype;
  anchor public.client_reporting_bindings%rowtype;
  store public.client_shopify_connections%rowtype;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can retire a store.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_anchor_binding_id is null
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 88
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting store retirement.' using errcode = '22023';
  end if;

  -- Same lock order as every other lifecycle RPC: the immutable events table
  -- first, then the rows.
  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_event.event_type = 'store_retired'
      and existing_event.binding_id = p_anchor_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
    then
      return existing_event.binding_id;
    end if;
    raise exception 'Reporting store retirement idempotency key is already used.'
      using errcode = '23505';
  end if;

  select * into anchor
  from public.client_reporting_bindings binding
  where binding.id = p_anchor_binding_id and binding.status = 'active'
  for update;
  if not found then
    raise exception 'Active reporting store anchor not found.' using errcode = '23514';
  end if;
  if anchor.shopify_connection_id is null or anchor.shopify_anchor_binding_id is not null then
    raise exception 'Only a Shopify store anchor can be retired.' using errcode = '23514';
  end if;
  if anchor.google_ads_connection_id is not null then
    raise exception 'Hand the store''s Google account over to its next store, or stop counting and remove it, before retiring the store.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.client_rollout_states rollout
    where rollout.client_id = anchor.client_id
      and rollout.operational_surface = 'v2_active'
      and rollout.reporting_cutover_at is not null
  ) then
    raise exception 'Before the reporting cutover a store is removed, not retired.'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.client_reporting_bindings child
    where child.shopify_anchor_binding_id = anchor.id
      and child.status in ('active', 'staged')
  ) then
    raise exception 'Hand over or remove the Google sources still reporting to this store first.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.client_reporting_bindings other
    where other.client_id = anchor.client_id
      and other.status = 'active'
      and other.id <> anchor.id
      and other.shopify_connection_id is not null
      and other.shopify_anchor_binding_id is null
  ) then
    raise exception 'A live client keeps at least one store; this is its last one.'
      using errcode = '23514';
  end if;

  select * into store
  from public.client_shopify_connections connection
  where connection.id = anchor.shopify_connection_id
  for update;
  if not found or store.status <> 'connected' then
    raise exception 'The store''s Shopify connection is not connected.' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.client_onboarding_sessions session
    where session.reconnect_shopify_connection_id = store.id
      and session.status in ('pending', 'collecting')
  ) then
    raise exception 'Cancel the open reconnect link before retiring this store.'
      using errcode = '23514';
  end if;

  -- The anchor leaves under its purpose-bound escape; the revoke RPC re-checks
  -- the admin, records the binding event and refuses any live child.
  perform set_config('dropscale.reporting_store_retire', anchor.id::text, true);
  perform public.revoke_client_reporting_binding(
    anchor.id,
    p_admin_id,
    p_idempotency_key || ':binding',
    normal_reason
  );

  -- Exactly what revoke_client_shopify_connection (0048) does, in the same
  -- transaction, now that the bound-identity guard no longer holds the row.
  delete from public.client_shopify_credentials where connection_id = store.id;
  delete from public.client_asset_mappings where shopify_connection_id = store.id;
  update public.client_shopify_connections
  set status = 'revoked', credential_hint = null, revoked_at = now(), updated_at = now()
  where id = store.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    store.session_id, 'connections_revoked', 'admin', p_admin_id,
    jsonb_build_object('asset_type', 'shopify', 'connection_id', store.id, 'retired_store', true)
  );

  insert into public.client_reporting_anchor_events (
    binding_id, prior_binding_id, ad_account_id, event_type,
    idempotency_key, actor_id, reason, details
  ) values (
    anchor.id, null, anchor.ad_account_id, 'store_retired',
    p_idempotency_key, p_admin_id, normal_reason,
    jsonb_build_object('shopifyConnectionId', store.id, 'adAccountId', anchor.ad_account_id)
  );
  -- The retired identity stays REUSABLE: should the same shop ever reconnect
  -- to this client, the staged lifecycle (0056) and the queue both recognise
  -- a revoked binding carrying 'source_abandoned' as an identity the admin may
  -- explicitly restage - onto this same account, history intact - instead of
  -- leaving the client blocked with an identity owner nothing can act on.
  insert into public.client_reporting_anchor_events (
    binding_id, prior_binding_id, ad_account_id, event_type,
    idempotency_key, actor_id, reason, details
  ) values (
    anchor.id, null, anchor.ad_account_id, 'source_abandoned',
    p_idempotency_key || ':abandon', p_admin_id, normal_reason,
    jsonb_build_object('retiredStore', true, 'shopifyConnectionId', store.id)
  );
  return anchor.id;
end
$$;

revoke all on function public.retire_client_reporting_store(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.retire_client_reporting_store(uuid, uuid, text, text)
  to service_role;
