-- 0095 - Store handover: one Google Ads account, a succession of stores.
--
-- A client may replace the Shopify store a Google Ads account advertises. The
-- old store keeps every euro it already spent; from the handover on, the same
-- Google account reports and bills under the new store. The boundary between
-- the two is the CAPTURED GOOGLE COUNTER, not a guess: the old account's
-- billing end (Stop counting) and the successor's billing start are the same
-- number on the same local day, so the boundary day partitions exactly and no
-- euro is billed twice or lost.
--
-- Mechanically, handover_client_reporting_google_source retires the paired
-- binding and, in the same transaction, re-binds the old account's Shopify
-- side (its history and revenue keep flowing) and commits the Google source
-- as a child of the new store's anchor on a NEW google_spend ad account with
-- its own billing boundaries. Nothing is replaced underneath an invoice: the
-- old account keeps its identity, its immutable start/end pair and its ledger.
--
-- The single-owner rule for a Google identity moves from a blunt unique index
-- into a succession-aware guard: a second account for the same customer id is
-- only born inside this RPC, and only while every previous holder has closed
-- billing (or never started it). Every other writer sees the same refusal the
-- index used to give.

-- One Google identity, one commercially-open account - enforced with room for
-- succession. The 0028 unique index allowed no successor at all; the guard
-- keeps its protection (nobody can claim an identity that is already someone
-- else's) while letting the handover RPC append the next holder once the
-- previous one's billing is closed. The advisory lock closes the race the
-- index used to close.
-- Two generations of the same index exist in the lineage: 0026 named it
-- ad_accounts_google_customer_uq, 0028 recreated it as
-- ad_accounts_google_customer_unique_idx. Production carries whichever came
-- first, so both names must go.
drop index if exists public.ad_accounts_google_customer_uq;
drop index if exists public.ad_accounts_google_customer_unique_idx;
create index if not exists ad_accounts_google_customer_idx
  on public.ad_accounts (google_ads_customer_id)
  where google_ads_customer_id is not null;

create or replace function public.guard_ad_account_google_identity_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.google_ads_customer_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
    and new.google_ads_customer_id is not distinct from old.google_ads_customer_id
  then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('ad_account_google_identity'),
    hashtext(new.google_ads_customer_id)
  );

  if exists (
    select 1 from public.ad_accounts other
    where other.google_ads_customer_id = new.google_ads_customer_id
      and other.id <> new.id
  ) then
    if auth.role() is not distinct from 'service_role'
      and current_setting('dropscale.reporting_handover_client', true)
            is not distinct from new.client_id::text
      and new.reporting_role = 'google_spend'
      and not exists (
        select 1
        from public.ad_accounts holder
        where holder.google_ads_customer_id = new.google_ads_customer_id
          and holder.id <> new.id
          and exists (
            select 1 from public.ad_account_billing_starts opened
            where opened.ad_account_id = holder.id
          )
          and not exists (
            select 1 from public.ad_account_billing_ends closed
            where closed.ad_account_id = holder.id
          )
      )
    then
      return new;
    end if;
    raise exception 'This Google Ads identity already belongs to another ad account.'
      using errcode = '23505';
  end if;
  return new;
end
$$;

drop trigger if exists ad_accounts_guard_google_identity_claim on public.ad_accounts;
create trigger ad_accounts_guard_google_identity_claim
  before insert or update of google_ads_customer_id on public.ad_accounts
  for each row execute function public.guard_ad_account_google_identity_claim();

revoke all on function public.guard_ad_account_google_identity_claim()
  from public, anon, authenticated;

-- 'handed_over' joins the immutable anchor-event vocabulary.
alter table public.client_reporting_anchor_events
  drop constraint if exists client_reporting_anchor_events_event_type_check;
alter table public.client_reporting_anchor_events
  add constraint client_reporting_anchor_events_event_type_check
  check (event_type in (
    'provisioned', 'adopted', 'upgraded', 'restaged',
    'source_added', 'source_abandoned', 'handed_over'
  ));

-- Baseline: the deployed 0094 guard, byte-identical, plus the one handover escape.
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

-- Baseline: the deployed 0056 insert guard, byte-identical, plus the handover branch.
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
    raise exception 'A post-cutover reporting source must be staged before activation.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

-- The only writer of both handover GUCs. Preconditions mirror what the
-- resolver demands of the resulting child, and the billing gate makes the
-- succession financially safe before a single row moves.
create or replace function public.handover_client_reporting_google_source(
  p_source_binding_id uuid,
  p_target_anchor_binding_id uuid,
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
  source public.client_reporting_bindings%rowtype;
  anchor public.client_reporting_bindings%rowtype;
  source_account public.ad_accounts%rowtype;
  anchor_account public.ad_accounts%rowtype;
  anchor_shopify public.client_shopify_connections%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  source_start public.ad_account_billing_starts%rowtype;
  source_end public.ad_account_billing_ends%rowtype;
  child_account public.ad_accounts%rowtype;
  replacement_binding_id uuid;
  child_binding_id uuid;
  google_customer_id text;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can hand over a Google source.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_source_binding_id is null
    or p_target_anchor_binding_id is null
    or p_source_binding_id = p_target_anchor_binding_id
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 88
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting source handover.' using errcode = '22023';
  end if;

  -- Match the stage/promote/abandon lock order: the immutable lifecycle events
  -- table first, then the rows. Taking row locks first deadlocks against them.
  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_event.event_type = 'handed_over'
      and existing_event.prior_binding_id = p_source_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
      and existing_event.details ->> 'targetAnchorBindingId'
            = p_target_anchor_binding_id::text
    then
      return existing_event.binding_id;
    end if;
    raise exception 'Reporting handover idempotency key is already used.' using errcode = '23505';
  end if;

  select * into source
  from public.client_reporting_bindings binding
  where binding.id = p_source_binding_id and binding.status = 'active'
  for update;
  if not found then
    raise exception 'Active reporting source not found.' using errcode = '23514';
  end if;
  if source.shopify_anchor_binding_id is not null then
    raise exception 'A handed-over Google source cannot move to a third store yet.'
      using errcode = '23514';
  end if;
  if source.google_ads_connection_id is null or source.shopify_connection_id is null then
    raise exception 'Only a paired store source can hand its Google account over.'
      using errcode = '23514';
  end if;

  select * into anchor
  from public.client_reporting_bindings binding
  where binding.id = p_target_anchor_binding_id
    and binding.status = 'active'
    and binding.client_id = source.client_id
  for update;
  if not found
    or anchor.shopify_connection_id is null
    or anchor.shopify_anchor_binding_id is not null
  then
    raise exception 'An active Shopify anchor of the same client is required.'
      using errcode = '23514';
  end if;
  if anchor.shopify_connection_id = source.shopify_connection_id then
    raise exception 'This Google source already reports to that store.'
      using errcode = '23514';
  end if;

  select * into source_account
  from public.ad_accounts account
  where account.id = source.ad_account_id and account.client_id = source.client_id
  for update;
  if not found then
    raise exception 'The current reporting account is unavailable.' using errcode = '23514';
  end if;
  -- Only a legacy pair can hand over today. A shopify_anchor pair would leave
  -- its account carrying recorded Google history that
  -- guard_normalized_daily_metric_family forbids a Shopify-only anchor to
  -- store - the next sync would fail forever. Those stores need the
  -- carried-history escape in that guard before they can swap.
  if source_account.reporting_role <> 'legacy_hybrid' then
    raise exception 'Only a legacy paired account can hand its Google source over for now.'
      using errcode = '23514';
  end if;

  select * into anchor_account
  from public.ad_accounts account
  where account.id = anchor.ad_account_id and account.client_id = source.client_id
  for update;
  if not found then
    raise exception 'The Shopify anchor account is unavailable.' using errcode = '23514';
  end if;

  select * into anchor_shopify
  from public.client_shopify_connections connection
  where connection.id = anchor.shopify_connection_id
    and connection.status = 'connected'
    and connection.client_id = source.client_id
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
  where connection.id = source.google_ads_connection_id
    and connection.status = 'connected'
    and connection.client_id = source.client_id
  for update;
  if not found
    or google_ads.last_verified_at is null
    or google_ads.last_error_code is not null
    or google_ads.currency is null
    or google_ads.currency !~ '^[A-Z]{3}$'
    or nullif(btrim(coalesce(google_ads.time_zone, '')), '') is null
  then
    raise exception 'The bound Google Ads source is no longer verified.' using errcode = '23514';
  end if;

  -- Stop counting itself is EUR-only (the closing capture refuses any other
  -- currency), so a non-EUR source could only reach this point on the
  -- never-billed path - and would then plant a non-EUR billing boundary in a
  -- pipeline that assumes EUR. Refuse it in words instead of a constraint.
  if google_ads.currency <> 'EUR' then
    raise exception 'Only a EUR Google source can hand over automatically; non-EUR billing is managed manually.'
      using errcode = '23514';
  end if;

  google_customer_id := public.normalize_google_ads_customer_id(google_ads.windsor_account_id);
  if length(coalesce(google_customer_id, '')) <> 10
    or source_account.google_ads_customer_id is distinct from google_customer_id
  then
    raise exception 'The Google identity does not match the account it leaves.'
      using errcode = '23514';
  end if;

  -- THE BILLING GATE. If the old account ever billed, its boundary must be
  -- CLOSED first (Stop counting captured the Google counter), and the
  -- successor starts from that exact counter on that exact local day: the old
  -- store bills through the capture, the new one from it, and the boundary
  -- day partitions to the micro. Without the closed end the same spend would
  -- bill on both sides for every following day.
  select * into source_start
  from public.ad_account_billing_starts boundary
  where boundary.ad_account_id = source_account.id
  for share;
  if found then
    select * into source_end
    from public.ad_account_billing_ends boundary
    where boundary.ad_account_id = source_account.id
    for share;
    if not found then
      raise exception 'Stop counting on the current store first: its Google billing boundary must be closed before the account moves.'
        using errcode = '23514';
    end if;
  end if;

  -- Retire the pair. The GUC is what the 0095 guard branch reads; every
  -- revocation shape check still applies inside the revoke RPC and trigger.
  perform set_config('dropscale.reporting_source_handover', source.id::text, true);
  perform public.revoke_client_reporting_binding(
    source.id,
    p_admin_id,
    p_idempotency_key || ':retire',
    normal_reason
  );

  perform set_config('dropscale.reporting_handover_client', source.client_id::text, true);

  -- The old account keeps reporting its own store: same identity, same
  -- history, only the Google side leaves.
  replacement_binding_id := public.commit_client_reporting_binding(
    source.ad_account_id,
    source.shopify_connection_id,
    null,
    null,
    p_idempotency_key || ':keep-store',
    p_admin_id,
    normal_reason
  );

  -- Re-point the mapping while no active binding holds the Google source:
  -- guard_bound_client_asset_mapping compares against the active binding's
  -- store, and the child commit below demands the mapping name the anchor's.
  insert into public.client_asset_mappings (
    session_id, shopify_connection_id, google_ads_connection_id
  ) values (
    google_ads.session_id, anchor_shopify.id, google_ads.id
  )
  on conflict (google_ads_connection_id) do update
    set shopify_connection_id = excluded.shopify_connection_id,
        session_id = excluded.session_id;

  -- The successor: same Google customer, its own account row, so each store's
  -- history and billing boundaries stay its own. Shape mirrors
  -- provision_client_reporting_anchor exactly - commercial rates are derived
  -- by their own triggers, never set here.
  insert into public.ad_accounts (
    client_id, store_name, google_ads_customer_id, status, currency,
    shopify_url, reporting_role
  ) values (
    source.client_id,
    coalesce(
      nullif(btrim(coalesce(google_ads.admin_label, '')), ''),
      nullif(btrim(google_ads.account_name), ''),
      'Reporting source'
    ),
    google_customer_id,
    'pending',
    google_ads.currency,
    null,
    'google_spend'
  ) returning * into child_account;

  -- The successor's opening boundary, written HERE so the auto-start sweep
  -- never invents one: it would backdate the start to the reused connection's
  -- original connect day with a zero baseline and re-bill the whole overlap.
  -- When the old account billed, the start is the end capture itself - same
  -- day, same counter. When it never billed, the succession starts today with
  -- nothing before it.
  insert into public.ad_account_billing_starts (
    ad_account_id, google_ads_customer_id, google_local_date, google_time_zone,
    currency, baseline_cost_micros, capture_started_at, captured_at,
    capture_id, source, start_basis, reviewed_by
  ) values (
    child_account.id,
    google_customer_id,
    coalesce(source_end.google_local_date, (now() at time zone google_ads.time_zone)::date),
    coalesce(source_end.google_time_zone, google_ads.time_zone),
    coalesce(source_end.currency, google_ads.currency),
    coalesce(source_end.end_cost_micros, 0),
    coalesce(source_end.capture_started_at, now()),
    coalesce(source_end.captured_at, now()),
    gen_random_uuid(),
    'agency',
    'observed_google_counter',
    p_admin_id
  );

  child_binding_id := public.commit_client_reporting_binding(
    child_account.id,
    null,
    google_ads.id,
    anchor.id,
    p_idempotency_key || ':child',
    p_admin_id,
    normal_reason
  );

  -- Activation is the LAST identity step, exactly as the auto-start sweep
  -- activates a fresh account: the activation guard demands both the billing
  -- start (written above) and an active Google-bearing binding (committed
  -- above). A pending account is invisible to commission-sync, so leaving the
  -- successor pending would mean the new store never bills at all.
  update public.ad_accounts
    set status = 'active'
  where id = child_account.id;

  insert into public.client_reporting_anchor_events (
    binding_id, prior_binding_id, ad_account_id, event_type,
    idempotency_key, actor_id, reason, details
  ) values (
    child_binding_id, source.id, child_account.id, 'handed_over',
    p_idempotency_key, p_admin_id, normal_reason,
    jsonb_build_object(
      'targetAnchorBindingId', anchor.id,
      'googleAdsConnectionId', google_ads.id,
      'shopifyConnectionId', anchor_shopify.id,
      'sourceAdAccountId', source.ad_account_id,
      'replacementBindingId', replacement_binding_id,
      'newAdAccountId', child_account.id
    )
  );

  return child_binding_id;
end
$$;

revoke all on function public.handover_client_reporting_google_source(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.handover_client_reporting_google_source(
  uuid, uuid, uuid, text, text
) to service_role;
