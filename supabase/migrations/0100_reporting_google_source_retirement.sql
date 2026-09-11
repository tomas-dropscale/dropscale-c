-- 0100 - Retire a Google source the client closed for good.
--
-- A client shuts a Google Ads account down. Windsor stops answering for it,
-- the health probe latches not_connected, and because the account is still a
-- bound reporting source the whole client turns "blocked" in the cutover
-- queue - every action hidden, including the ones that would fix it. Nothing
-- in the product could take a dead source out: after the cutover a plain
-- revoke is refused ("demote the V2 rollout"), which is not an answer for a
-- client who simply moved to another account (Miguel Casal, 163-954-1537,
-- closed on purpose - 2026-09-08).
--
-- Removing a Google account from a live client now means: close its billing
-- boundary first if it ever billed, then the account leaves reporting and the
-- store keeps everything it already recorded. A PAIR keeps reporting its own
-- store through a replacement binding on the same account, exactly as a store
-- handover does; a CHILD simply leaves, and the projections keep its history
-- grouped under the store it spent for.
--
-- Three pieces: 'source_retired' joins the immutable anchor-event vocabulary;
-- the two guards gain one purpose-bound escape each, spliced into their live
-- text with the rest byte-identical; and retire_client_reporting_google_source
-- performs the whole thing in one transaction.

-- 'source_retired' joins the immutable anchor-event vocabulary.
alter table public.client_reporting_anchor_events
  drop constraint if exists client_reporting_anchor_events_event_type_check;
alter table public.client_reporting_anchor_events
  add constraint client_reporting_anchor_events_event_type_check
  check (event_type in (
    'provisioned', 'adopted', 'upgraded', 'restaged',
    'source_added', 'source_abandoned', 'handed_over', 'store_retired',
    'source_retired'
  ));

-- Baseline: the deployed 0097 guard, byte-identical, plus the retire escape.
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
    -- Retiring a Google source that the client closed for good: its
    -- purpose-bound RPC revokes this binding and the connection behind it in
    -- one transaction, keeping the recorded history under the store that spent
    -- it. The asset MAPPING is left in place - it is unique per connection, so
    -- a re-delivered account brings its own. Only that RPC writes this GUC, and
    -- every shape check above has already run.
    if current_setting('dropscale.reporting_source_retire', true)
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

-- Baseline: the deployed 0095 insert guard, byte-identical, plus the shape a
-- retired pair's replacement needs.
create or replace function public.guard_post_cutover_reporting_binding_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cutover_time timestamptz;
begin
  select rollout.reporting_cutover_at into cutover_time
  from public.client_rollout_states rollout
  where rollout.client_id = new.client_id
    and rollout.operational_surface = 'v2_active'
    and rollout.reporting_cutover_at is not null;

  if found and (
    auth.role() is distinct from 'service_role'
    or current_setting('dropscale.reporting_source_stage_client', true)
         is distinct from new.client_id::text
  ) then
    -- A store handover commits its two replacement rows directly instead of
    -- staging: the retired pair's Shopify side re-bound to the same account,
    -- and the Google source as a child of its new store's anchor. Only the
    -- handover RPC writes this GUC, and only those two exact shapes may pass -
    -- anything else still has to stage.
    if auth.role() is not distinct from 'service_role'
      and current_setting('dropscale.reporting_handover_client', true)
            is not distinct from new.client_id::text
      and new.status = 'active'
      and (
        (
          new.shopify_connection_id is not null
          and new.google_ads_connection_id is null
          and new.shopify_anchor_binding_id is null
        )
        or (
          new.google_ads_connection_id is not null
          and new.shopify_connection_id is null
          and new.shopify_anchor_binding_id is not null
        )
      )
    then
      return new;
    end if;
    -- Retiring the Google side of a PAIR leaves its store reporting through a
    -- replacement binding on the same account: same identity, same history,
    -- only the closed Google account leaves. That is the one shape this GUC
    -- admits, and only the retirement RPC writes it.
    if auth.role() is not distinct from 'service_role'
      and current_setting('dropscale.reporting_source_retire_client', true)
            is not distinct from new.client_id::text
      and new.status = 'active'
      and new.shopify_connection_id is not null
      and new.google_ads_connection_id is null
      and new.shopify_anchor_binding_id is null
    then
      return new;
    end if;
    raise exception 'A post-cutover reporting source must be staged before activation.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.retire_client_reporting_google_source(
  p_binding_id uuid,
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
  source public.client_reporting_bindings%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  source_account public.ad_accounts%rowtype;
  billing_start public.ad_account_billing_starts%rowtype;
  replacement_binding_id uuid;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can retire a Google source.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_binding_id is null
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 88
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting source retirement.' using errcode = '22023';
  end if;

  -- Same lock order as every other lifecycle RPC: the immutable events table
  -- first, then the rows.
  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_event.event_type = 'source_retired'
      and existing_event.binding_id = p_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
    then
      return existing_event.binding_id;
    end if;
    raise exception 'Reporting source retirement idempotency key is already used.'
      using errcode = '23505';
  end if;

  select * into source
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'active'
  for update;
  if not found then
    raise exception 'Active reporting source not found.' using errcode = '23514';
  end if;
  if source.google_ads_connection_id is null then
    raise exception 'Only a Google-bearing source can be retired here.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.client_rollout_states rollout
    where rollout.client_id = source.client_id
      and rollout.operational_surface = 'v2_active'
      and rollout.reporting_cutover_at is not null
  ) then
    raise exception 'Before the reporting cutover a source is unbound, not retired.'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.client_reporting_bindings child
    where child.shopify_anchor_binding_id = source.id
      and child.status in ('active', 'staged')
  ) then
    raise exception 'Retire the Google sources reporting under this store first.'
      using errcode = '23514';
  end if;

  select * into source_account
  from public.ad_accounts account
  where account.id = source.ad_account_id
  for update;
  if not found then
    raise exception 'The reporting source has no ad account.' using errcode = '23514';
  end if;
  -- A source with no store at all has nowhere to leave its spend: the totals
  -- are built per store, so retiring it would drop every euro it recorded out
  -- of the client's reporting with no error anywhere. Link it to a store
  -- first - that is one dropdown in Clients - and then retire it.
  if source.shopify_connection_id is null
    and source.shopify_anchor_binding_id is null
  then
    raise exception 'Link this Google account to a store before retiring it, or its recorded spend leaves the client totals.'
      using errcode = '23514';
  end if;

  -- A PAIR may only be retired from a legacy account. A shopify_anchor pair
  -- would keep writing metrics through its replacement Shopify-only binding,
  -- and guard_normalized_daily_metric_family forbids such an anchor to store
  -- the Google history it already carries - its sync would fail for ever. The
  -- same refusal 0095 and 0096 make, for the same reason, and handing the
  -- store over is refused for it too. A CHILD has no such hazard: its account
  -- is left unbound and its history freezes as recorded.
  if source.shopify_connection_id is not null
    and source_account.reporting_role <> 'legacy_hybrid'
  then
    raise exception 'Only a legacy paired account can retire its Google source for now: this account would keep Google history a Shopify-only anchor cannot store.'
      using errcode = '23514';
  end if;

  select * into google_ads
  from public.client_google_ads_connections connection
  where connection.id = source.google_ads_connection_id
  for update;
  if not found then
    raise exception 'The reporting source has no Google Ads connection.'
      using errcode = '23514';
  end if;

  -- Money first: an account that ever billed must have its closing counter
  -- on file before it leaves, so the final invoice is bounded by a captured
  -- boundary instead of by a source that simply vanished.
  select * into billing_start
  from public.ad_account_billing_starts start_row
  where start_row.ad_account_id = source.ad_account_id
  for share;
  if found and not exists (
    select 1 from public.ad_account_billing_ends billing_end
    where billing_end.ad_account_id = source.ad_account_id
  ) then
    raise exception 'Stop counting this Google account first: its billing is still open.'
      using errcode = '23514';
  end if;
  -- The source leaves first: only one active binding may hold an account, so
  -- a pair's replacement can only be committed once the pair is revoked. Same
  -- order the store handover uses.
  perform set_config('dropscale.reporting_source_retire', source.id::text, true);
  perform public.revoke_client_reporting_binding(
    source.id,
    p_admin_id,
    p_idempotency_key || ':retire',
    normal_reason
  );

  -- A PAIR keeps reporting its own store through a replacement binding on the
  -- same account; a CHILD leaves its account unbound, and the projections keep
  -- its recorded history under the store it spent for.
  if source.shopify_connection_id is not null then
    perform set_config(
      'dropscale.reporting_source_retire_client', source.client_id::text, true
    );
    replacement_binding_id := public.commit_client_reporting_binding(
      source.ad_account_id,
      source.shopify_connection_id,
      null,
      null,
      p_idempotency_key || ':keep-store',
      p_admin_id,
      normal_reason
    );
  end if;

  -- The Google connection leaves the same way every other removed asset
  -- does. An earlier draft froze it as 'connected' instead, so the
  -- commission ledger could still read the account: the ledger may be asked
  -- to re-read any past week, and an account it cannot see can never certify
  -- the week it closed in, leaving that invoice unissuable for ever.
  --
  -- Freezing the row bought that at too high a price. A connection nothing
  -- can revoke also cannot be cancelled with its onboarding link, cannot be
  -- replaced when the client reopens the same Google account, and turns one
  -- mistaken click into a permanent dead end. The ledger's reach is a
  -- property of how the ledger READS, not of this row's status, so it is
  -- fixed there: the ledger now falls back to a revoked connection when the
  -- account has no connected one. Revoking here is then free, and it leaves
  -- the ordinary doors open - cancelling the link, and re-delivering the
  -- account later as a fresh connection the queue can stage again.
  --
  -- The mapping is left in place: it is unique per connection, so a
  -- re-delivered account gets its own, and this one simply stops matching
  -- anything once the queue no longer sees a connected source behind it.
  update public.client_google_ads_connections
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where id = google_ads.id;
  insert into public.client_reporting_anchor_events (
    binding_id, prior_binding_id, ad_account_id, event_type,
    idempotency_key, actor_id, reason, details
  ) values (
    source.id, null, source.ad_account_id, 'source_retired',
    p_idempotency_key, p_admin_id, normal_reason,
    jsonb_build_object(
      'googleAdsConnectionId', google_ads.id,
      'windsorAccountId', google_ads.windsor_account_id,
      'replacementBindingId', replacement_binding_id
    )
  );

  -- A retired PAIR leaves a second active binding behind, born after the
  -- cutover, so it must carry its own evidence: without it the cutover queue
  -- reads an unexplained post-cutover binding and fails the whole client
  -- closed - the very block this migration exists to lift. 0095 shipped
  -- without this and 0096 had to repair it; not again.
  if replacement_binding_id is not null then
    insert into public.client_reporting_anchor_events (
      binding_id, prior_binding_id, ad_account_id, event_type,
      idempotency_key, actor_id, reason, details
    ) values (
      replacement_binding_id, source.id, source.ad_account_id, 'source_retired',
      p_idempotency_key || ':keep-store', p_admin_id, normal_reason,
      jsonb_build_object(
        'keepsShopifyConnectionId', source.shopify_connection_id,
        'retiredGoogleAdsConnectionId', google_ads.id
      )
    );
  end if;
  -- No 'source_abandoned' event here, deliberately, and that is where this
  -- parts company with the store retirement in 0097. Abandoning an identity
  -- is what makes it restageable, and a store identity is safe to restage: a
  -- shopify_anchor account is pinned to its own shop domain, so it can only
  -- come back as the same shop. A google_spend account is pinned to nothing
  -- but its Google customer id - the restage path accepts ANY healthy anchor
  -- of the client - so offering a retired source for reuse would let the
  -- euros it already recorded for one store reappear under another, with no
  -- error anywhere. Should the same account ever come back, it arrives as a
  -- FRESH connection - the revoked one cannot be reused - and the queue offers
  -- it through the ordinary add-a-source path, where the admin picks the store
  -- it belongs to. Reuse of the retired identity itself waits for a gate that
  -- ties an abandoned Google identity to the store it spent for.
  return source.id;
end
$$;

revoke all on function public.retire_client_reporting_google_source(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.retire_client_reporting_google_source(uuid, uuid, text, text)
  to service_role;

-- Linking a closed Google account to the store it spent for records
-- HISTORY. It never moves spend to another ad account, never touches the
-- immutable billing identity, its start boundary or any issued invoice
-- line - which is why 0094 allows it where a revoke is refused. So it may
-- not demand that the account still be ALIVE: last_error_code is a
-- liveness latch, and the retirement above sends the admin here precisely
-- for an account that is not alive any more. Identity is still proven:
-- same client, still connected, verified at least once.
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

revoke all on function public.adopt_client_reporting_google_child(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.adopt_client_reporting_google_child(uuid, uuid, uuid, text, text)
  to service_role;
