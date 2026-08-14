-- =============================================================================
-- 0056 - Receipt-gated reporting sources added after a client's V2 cutover.
--
-- A source first reserves its immutable V2 identity as `staged`. Staged rows
-- are deliberately absent from every normal resolver/RLS authority path. The
-- reporting service may populate their read model and a source can become
-- active only through the atomic promotion RPC after a post-stage 90-day sync.
-- Google billing remains a separate lifecycle: promotion requires its exact
-- immutable billing-start boundary and never creates or changes finance rows.
-- =============================================================================

alter table public.client_reporting_bindings
  drop constraint if exists client_reporting_bindings_status_check;
alter table public.client_reporting_bindings
  add constraint client_reporting_bindings_status_check
  check (status in ('staged', 'active', 'revoked'));

alter table public.client_reporting_bindings
  drop constraint if exists client_reporting_bindings_status_shape;
alter table public.client_reporting_bindings
  add constraint client_reporting_bindings_status_shape check (
    (
      status in ('staged', 'active')
      and revoked_by is null
      and revoked_at is null
      and revoke_reason is null
    )
    or (
      status = 'revoked'
      and revoked_by is not null
      and revoked_at is not null
      and revoke_reason is not null
      and revoke_reason = btrim(revoke_reason)
      and length(revoke_reason) between 3 and 500
    )
  );

-- A staged identity is already reserved. A second active/staged row may not
-- race it for the same legacy account or V2 connection.
create unique index client_reporting_bindings_reserved_ad_account_idx
  on public.client_reporting_bindings(ad_account_id)
  where status in ('staged', 'active');
create unique index client_reporting_bindings_reserved_shopify_idx
  on public.client_reporting_bindings(shopify_connection_id)
  where status in ('staged', 'active') and shopify_connection_id is not null;
create unique index client_reporting_bindings_reserved_google_idx
  on public.client_reporting_bindings(google_ads_connection_id)
  where status in ('staged', 'active') and google_ads_connection_id is not null;
create index client_reporting_bindings_staged_anchor_idx
  on public.client_reporting_bindings(shopify_anchor_binding_id)
  where status = 'staged' and shopify_anchor_binding_id is not null;

alter table public.client_reporting_anchor_events
  drop constraint if exists client_reporting_anchor_events_event_type_check;
alter table public.client_reporting_anchor_events
  add constraint client_reporting_anchor_events_event_type_check
  check (event_type in (
    'provisioned', 'adopted', 'upgraded', 'restaged',
    'source_added', 'source_abandoned'
  ));

alter table public.client_reporting_binding_events
  drop constraint if exists client_reporting_binding_events_event_type_check;
alter table public.client_reporting_binding_events
  add constraint client_reporting_binding_events_event_type_check
  check (event_type in ('bound', 'staged', 'promoted', 'abandoned', 'revoked'));

-- After a reporting cutover, no generic provision/commit call may insert an
-- immediately-active source. stage_client_reporting_source is the only
-- purpose-bound entry point and its transaction demotes the fresh row before
-- it can become visible to another transaction.
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
    raise exception 'A post-cutover reporting source must be staged before activation.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger client_reporting_bindings_guard_post_cutover_insert
  before insert on public.client_reporting_bindings
  for each row execute function public.guard_post_cutover_reporting_binding_insert();

-- Preserve the 0055 revocation contract and add exactly two purpose-bound
-- transitions: fresh post-cutover active -> staged inside the staging RPC,
-- then staged -> active inside the promotion RPC.
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

-- Staging reserves source identity just like activation. Display names and
-- health timestamps may still change, but owner/domain/customer/currency and
-- source status cannot drift underneath either state.
create or replace function public.guard_bound_shopify_connection_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.shopify_connection_id = old.id
      and binding.status in ('staged', 'active')
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Release the reporting binding before changing its Shopify source identity.'
      using errcode = '23514';
  end if;
  if new.client_id is distinct from old.client_id
    or new.shopify_domain is distinct from old.shopify_domain
    or new.shopify_currency is distinct from old.shopify_currency
    or new.status is distinct from old.status
  then
    raise exception 'Release the reporting binding before changing its Shopify source identity.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.guard_bound_google_ads_connection_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  purpose_bound_metadata_fill boolean := false;
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.google_ads_connection_id = old.id
      and binding.status in ('staged', 'active')
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Release the reporting binding before changing its Google Ads source identity.'
      using errcode = '23514';
  end if;

  purpose_bound_metadata_fill :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.google_reporting_identity_refresh', true)
          is not distinct from old.id::text
    and (new.currency is not distinct from old.currency
      or (old.currency is null and new.currency ~ '^[A-Z]{3}$'))
    and (new.time_zone is not distinct from old.time_zone
      or (
        nullif(btrim(coalesce(old.time_zone, '')), '') is null
        and nullif(btrim(coalesce(new.time_zone, '')), '') is not null
      ));

  if new.client_id is distinct from old.client_id
    or new.windsor_account_id is distinct from old.windsor_account_id
    or (
      (new.currency is distinct from old.currency
       or new.time_zone is distinct from old.time_zone)
      and not purpose_bound_metadata_fill
    )
    or new.status is distinct from old.status
  then
    raise exception 'Release the reporting binding before changing its Google Ads source identity.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

-- 0054 already protects active mappings. This additional trigger reserves an
-- exact pair for staged bindings without altering normal active resolution.
create or replace function public.guard_staged_client_asset_mapping()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1
    from public.client_reporting_bindings binding
    left join public.client_reporting_bindings anchor
      on anchor.id = binding.shopify_anchor_binding_id
     and anchor.status = 'active'
    where binding.status = 'staged'
      and binding.google_ads_connection_id = old.google_ads_connection_id
      and coalesce(binding.shopify_connection_id, anchor.shopify_connection_id)
            = old.shopify_connection_id
  ) then
    raise exception 'A staged Google Ads source cannot change its Shopify mapping.'
      using errcode = '23514';
  end if;

  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1
    from public.client_reporting_bindings binding
    left join public.client_reporting_bindings anchor
      on anchor.id = binding.shopify_anchor_binding_id
     and anchor.status = 'active'
    where binding.status = 'staged'
      and binding.google_ads_connection_id = new.google_ads_connection_id
      and coalesce(binding.shopify_connection_id, anchor.shopify_connection_id)
            is distinct from new.shopify_connection_id
  ) then
    raise exception 'A staged Google Ads source is reserved for another Shopify mapping.'
      using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger client_asset_mappings_guard_staged_pair
  before insert or update or delete on public.client_asset_mappings
  for each row execute function public.guard_staged_client_asset_mapping();

-- Normalized metrics still require an active binding by default. The only
-- exception is the exact staged binding named by the database commit RPC.
create or replace function public.guard_normalized_daily_metric_family()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role text;
  prior_role text;
  usable_binding_found boolean := false;
  usable_binding_has_google boolean := false;
begin
  select account.reporting_role into target_role
  from public.ad_accounts account
  where account.id = new.ad_account_id;

  if tg_op = 'UPDATE' and new.ad_account_id is distinct from old.ad_account_id then
    select account.reporting_role into prior_role
    from public.ad_accounts account
    where account.id = old.ad_account_id;
    if target_role <> 'legacy_hybrid' or prior_role <> 'legacy_hybrid' then
      raise exception 'A normalized daily metric cannot be reassigned to another source.'
        using errcode = '23514';
    end if;
  end if;

  if target_role = 'shopify_anchor' then
    select true, binding.google_ads_connection_id is not null
      into usable_binding_found, usable_binding_has_google
    from public.client_reporting_bindings binding
    where binding.ad_account_id = new.ad_account_id
      and binding.shopify_connection_id is not null
      and (
        binding.status = 'active'
        or (
          binding.status = 'staged'
          and auth.role() is not distinct from 'service_role'
          and current_setting('dropscale.reporting_staged_sync_binding', true)
                is not distinct from binding.id::text
        )
      );

    if not usable_binding_found then
      raise exception 'A normalized metric row requires an operational reporting binding.'
        using errcode = '23514';
    end if;

    if not usable_binding_has_google and (
      new.ad_spend <> 0
      or new.impressions <> 0
      or new.clicks <> 0
      or new.conversions <> 0
      or new.conversion_value <> 0
    ) then
      raise exception 'A Shopify-only fact anchor cannot store Google metrics.'
        using errcode = '23514';
    end if;
  elsif target_role = 'google_spend' then
    select true into usable_binding_found
    from public.client_reporting_bindings binding
    where binding.ad_account_id = new.ad_account_id
      and binding.shopify_connection_id is null
      and binding.google_ads_connection_id is not null
      and (
        binding.status = 'active'
        or (
          binding.status = 'staged'
          and auth.role() is not distinct from 'service_role'
          and current_setting('dropscale.reporting_staged_sync_binding', true)
                is not distinct from binding.id::text
        )
      );

    if not usable_binding_found then
      raise exception 'A normalized metric row requires an operational reporting binding.'
        using errcode = '23514';
    end if;

    if new.revenue <> 0
      or new.orders_count <> 0
      or new.refunds_amount <> 0
      or new.product_cost <> 0
      or new.payment_fees <> 0
      or new.shipping_cost <> 0
      or new.revenue_share_base <> 0
      or new.revenue_share_amount <> 0
      or new.units_sold <> 0
      or coalesce(new.attributed_orders, 0) <> 0
      or coalesce(new.attributed_revenue, 0) <> 0
    then
      raise exception 'A Google spend child cannot store Shopify metrics.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

-- Product registration is part of a real Shopify sync. Service-only writes
-- may prepare a staged anchor, while browser ownership remains active-only.
create or replace function public.guard_normalized_shopify_child_family()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role text;
  prior_role text;
begin
  select account.reporting_role into target_role
  from public.ad_accounts account
  where account.id = new.ad_account_id;

  if tg_op = 'UPDATE' and new.ad_account_id is distinct from old.ad_account_id then
    select account.reporting_role into prior_role
    from public.ad_accounts account
    where account.id = old.ad_account_id;
    if target_role <> 'legacy_hybrid' or prior_role <> 'legacy_hybrid' then
      raise exception 'A normalized Shopify child cannot be reassigned to another source.'
        using errcode = '23514';
    end if;
  end if;

  if target_role = 'google_spend' then
    raise exception 'A Google spend child cannot own Shopify products or COGS.'
      using errcode = '23514';
  end if;
  if target_role = 'shopify_anchor' and not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.ad_account_id = new.ad_account_id
      and binding.shopify_connection_id is not null
      and (
        binding.status = 'active'
        or (binding.status = 'staged' and auth.role() is not distinct from 'service_role')
      )
  ) then
    raise exception 'A normalized Shopify child requires an operational anchor binding.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

-- A normalized Google account may cross pending -> billable only while an
-- active or staged binding reserves it. This prevents an abandoned/revoked
-- identity from re-entering generic billing as an orphan. Staged sources also
-- require their complete post-stage receipts first.
create or replace function public.guard_staged_reporting_billing_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  binding public.client_reporting_bindings%rowtype;
  google_receipt public.client_reporting_sync_states%rowtype;
  shopify_receipt public.client_reporting_sync_states%rowtype;
  materialized_day_count integer;
  materialized_min_day date;
  materialized_max_day date;
  materialized_max_computed_at timestamptz;
begin
  if old.status <> 'pending' or new.status not in ('active', 'suspended') then
    return new;
  end if;

  if old.reporting_role not in ('shopify_anchor', 'google_spend')
    or old.google_ads_customer_id is null
  then
    return new;
  end if;

  select source.* into binding
  from public.client_reporting_bindings source
  where source.ad_account_id = old.id
    and source.status in ('active', 'staged')
    and source.google_ads_connection_id is not null;
  if not found then
    raise exception 'A normalized Google billing start requires an active or staged reporting binding.'
      using errcode = '23514';
  end if;
  if binding.status = 'active' then
    return new;
  end if;

  select * into google_receipt
  from public.client_reporting_sync_states state
  where state.binding_id = binding.id and state.source_type = 'google_ads';
  if not found
    or google_receipt.last_success_at <= binding.bound_at
    or google_receipt.last_success_from > current_date - 90
    or google_receipt.last_success_to < current_date - 1
  then
    raise exception 'Sync every staged reporting family for 90 days before starting billing.'
      using errcode = '23514';
  end if;

  if binding.shopify_connection_id is not null then
    select * into shopify_receipt
    from public.client_reporting_sync_states state
    where state.binding_id = binding.id and state.source_type = 'shopify';
    if not found
      or shopify_receipt.last_success_at <= binding.bound_at
      or shopify_receipt.last_success_from > current_date - 90
      or shopify_receipt.last_success_to < current_date - 1
    then
      raise exception 'Sync every staged reporting family for 90 days before starting billing.'
      using errcode = '23514';
    end if;
  end if;

  select count(*)::integer, min(metric.day), max(metric.day), max(metric.computed_at)
  into materialized_day_count, materialized_min_day, materialized_max_day,
    materialized_max_computed_at
  from public.daily_metrics metric
  where metric.ad_account_id = old.id
    and metric.day between current_date - 90 and current_date - 1;
  if materialized_day_count <> 90
    or materialized_min_day is distinct from current_date - 90
    or materialized_max_day is distinct from current_date - 1
    or materialized_max_computed_at is null
    or exists (
      select 1 from public.daily_metrics metric
      where metric.ad_account_id = old.id and metric.computed_at <= binding.bound_at
    )
    or google_receipt.last_success_at < materialized_max_computed_at
    or (
      binding.shopify_connection_id is not null
      and shopify_receipt.last_success_at < materialized_max_computed_at
    )
  then
    raise exception 'Current staged reporting facts must match every 90-day receipt before billing starts.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger ad_accounts_guard_staged_reporting_billing_status
  before update on public.ad_accounts
  for each row execute function public.guard_staged_reporting_billing_status();

-- Reuse every source/adoption/identity/history check in the 0055 provision
-- RPC. Its temporary active insert is transaction-local, then this wrapper
-- changes only the binding lifecycle to staged before commit.
create or replace function public.stage_client_reporting_source(
  p_client_id uuid,
  p_shopify_connection_id uuid,
  p_google_ads_connection_id uuid,
  p_shopify_anchor_binding_id uuid,
  p_existing_ad_account_id uuid,
  p_idempotency_key text,
  p_admin_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rollout public.client_rollout_states%rowtype;
  target public.client_reporting_bindings%rowtype;
  prior public.client_reporting_bindings%rowtype;
  account public.ad_accounts%rowtype;
  shopify public.client_shopify_connections%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  anchor public.client_reporting_bindings%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  result_id uuid;
  shopify_domain text;
  google_customer_id text;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can stage a source.' using errcode = '42501';
  end if;
  if p_client_id is null
    or not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin')
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 100
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid staged reporting source request.' using errcode = '22023';
  end if;

  -- Match promote/abandon/provision lock order: immutable lifecycle events,
  -- then rollout/source rows. This also serialises exact-key retries.
  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into rollout
  from public.client_rollout_states state
  where state.client_id = p_client_id
  for update;
  if not found
    or rollout.operational_surface <> 'v2_active'
    or rollout.reporting_cutover_at is null
  then
    raise exception 'A reporting-cutover V2 client is required for source staging.'
      using errcode = '23514';
  end if;

  perform set_config('dropscale.reporting_source_stage_client', p_client_id::text, true);

  -- Exact retry after an abandoned normalized identity was recommitted.
  select * into existing_event
  from public.client_reporting_anchor_events event
  where event.idempotency_key = p_idempotency_key;
  if found and existing_event.event_type = 'restaged' then
    if existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
      and existing_event.details ->> 'shopifyConnectionId'
            is not distinct from p_shopify_connection_id::text
      and existing_event.details ->> 'googleAdsConnectionId'
            is not distinct from p_google_ads_connection_id::text
      and existing_event.details ->> 'shopifyAnchorBindingId'
            is not distinct from p_shopify_anchor_binding_id::text
      and existing_event.details ->> 'requestedExistingAdAccountId'
            is not distinct from p_existing_ad_account_id::text
    then
      select * into target
      from public.client_reporting_bindings binding
      where binding.id = existing_event.binding_id;
      if target.status = 'staged' or (
        target.status = 'active' and exists (
          select 1 from public.client_reporting_anchor_events event
          where event.binding_id = target.id and event.event_type = 'source_added'
        )
      ) then
        return target.id;
      end if;
    end if;
    raise exception 'Reporting source staging idempotency key is already used.'
      using errcode = '23505';
  end if;

  -- Google billing boundaries are currently EUR-only. Do not create a staged
  -- source that can never obtain the immutable baseline required to promote.
  if p_google_ads_connection_id is not null and not exists (
    select 1
    from public.client_google_ads_connections connection
    where connection.id = p_google_ads_connection_id
      and connection.client_id = p_client_id
      and connection.currency = 'EUR'
  ) then
    raise exception 'Staged Google Ads reporting currently requires EUR billing currency.'
      using errcode = '23514';
  end if;

  -- A deliberately abandoned normalized identity may be reused only when the
  -- admin explicitly supplies that exact ad_account id. No name/domain guess
  -- selects it, and every source health/identity invariant is rechecked.
  if p_existing_ad_account_id is not null then
    select binding.* into prior
    from public.client_reporting_bindings binding
    where binding.client_id = p_client_id
      and binding.ad_account_id = p_existing_ad_account_id
      and binding.status = 'revoked'
      and exists (
        select 1 from public.client_reporting_anchor_events event
        where event.binding_id = binding.id and event.event_type = 'source_abandoned'
      )
    order by binding.revoked_at desc
    limit 1
    for update;
  end if;

  if prior.id is not null then
    select * into account
    from public.ad_accounts source_account
    where source_account.id = prior.ad_account_id
      and source_account.client_id = p_client_id
      and source_account.reporting_role in ('shopify_anchor', 'google_spend')
    for update;
    if not found then
      raise exception 'The abandoned reporting account identity is invalid.'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from public.ad_account_billing_starts billing_start
      where billing_start.ad_account_id = account.id
    ) or exists (
      select 1 from public.ad_account_billing_ends billing_end
      where billing_end.ad_account_id = account.id
    ) then
      raise exception 'A closed or started Google billing identity cannot be restaged.'
        using errcode = '23514';
    end if;

    if (account.reporting_role = 'shopify_anchor' and p_shopify_connection_id is null)
      or (account.reporting_role = 'google_spend' and (
        p_shopify_connection_id is not null or p_google_ads_connection_id is null
      ))
    then
      raise exception 'The abandoned account cannot change reporting source family.'
        using errcode = '23514';
    end if;

    if p_shopify_connection_id is not null then
      select connection.* into shopify
      from public.client_shopify_connections connection
      join public.client_shopify_credentials credential
        on credential.connection_id = connection.id
      where connection.id = p_shopify_connection_id
        and connection.client_id = p_client_id
        and connection.status = 'connected'
        and connection.last_verified_at is not null
        and connection.last_error_code is null
      for update of connection;
      shopify_domain := public.normalize_shopify_reporting_domain(shopify.shopify_domain);
      if not found
        or shopify.shopify_currency !~ '^[A-Z]{3}$'
        or coalesce(shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
        or public.normalize_shopify_reporting_domain(account.shopify_url)
             is distinct from shopify_domain
      then
        raise exception 'The abandoned Shopify source no longer passes reporting validation.'
          using errcode = '23514';
      end if;
    end if;

    if p_google_ads_connection_id is not null then
      select * into google_ads
      from public.client_google_ads_connections connection
      where connection.id = p_google_ads_connection_id
        and connection.client_id = p_client_id
        and connection.status = 'connected'
        and connection.last_verified_at is not null
        and connection.last_error_code is null
      for update;
      google_customer_id := public.normalize_google_ads_customer_id(
        google_ads.windsor_account_id
      );
      if not found
        or btrim(google_ads.windsor_account_id) !~ '^[0-9[:space:]-]+$'
        or length(coalesce(google_customer_id, '')) <> 10
        or google_ads.currency !~ '^[A-Z]{3}$'
        or nullif(btrim(coalesce(google_ads.time_zone, '')), '') is null
        or account.google_ads_customer_id is distinct from google_customer_id
        or account.currency is distinct from google_ads.currency
      then
        raise exception 'The abandoned Google Ads source no longer passes reporting validation.'
          using errcode = '23514';
      end if;
    elsif account.google_ads_customer_id is not null then
      raise exception 'The abandoned account cannot drop its canonical Google identity.'
        using errcode = '23514';
    elsif account.currency <> 'EUR' then
      raise exception 'A Shopify-only reporting anchor must use canonical EUR.'
        using errcode = '23514';
    end if;

    if p_shopify_anchor_binding_id is not null then
      select binding.* into anchor
      from public.client_reporting_bindings binding
      join public.ad_accounts anchor_account
        on anchor_account.id = binding.ad_account_id
       and anchor_account.reporting_role in ('shopify_anchor', 'legacy_hybrid')
       and anchor_account.currency = google_ads.currency
      join public.client_shopify_connections anchor_shopify
        on anchor_shopify.id = binding.shopify_connection_id
       and anchor_shopify.status = 'connected'
       and anchor_shopify.last_verified_at is not null
       and anchor_shopify.last_error_code is null
      join public.client_shopify_credentials anchor_credential
        on anchor_credential.connection_id = anchor_shopify.id
      where binding.id = p_shopify_anchor_binding_id
        and binding.status = 'active'
        and binding.client_id = p_client_id
        and binding.shopify_connection_id is not null
      for share of binding, anchor_account, anchor_shopify, anchor_credential;
      if not found then
        raise exception 'The abandoned Google source has no valid active Shopify anchor.'
          using errcode = '23514';
      end if;
    end if;

    result_id := public.commit_client_reporting_binding(
      account.id,
      p_shopify_connection_id,
      p_google_ads_connection_id,
      p_shopify_anchor_binding_id,
      p_idempotency_key,
      p_admin_id,
      normal_reason
    );
    insert into public.client_reporting_anchor_events (
      binding_id, prior_binding_id, ad_account_id, event_type,
      idempotency_key, actor_id, reason, details
    ) values (
      result_id, prior.id, account.id, 'restaged',
      p_idempotency_key, p_admin_id, normal_reason,
      jsonb_build_object(
        'shopifyConnectionId', p_shopify_connection_id,
        'googleAdsConnectionId', p_google_ads_connection_id,
        'shopifyAnchorBindingId', p_shopify_anchor_binding_id,
        'requestedExistingAdAccountId', p_existing_ad_account_id
      )
    );
  else
    result_id := public.provision_client_reporting_anchor(
      p_shopify_connection_id,
      p_google_ads_connection_id,
      p_shopify_anchor_binding_id,
      p_existing_ad_account_id,
      p_idempotency_key,
      p_admin_id,
      normal_reason
    );
  end if;

  select * into target
  from public.client_reporting_bindings binding
  where binding.id = result_id
  for update;
  if not found or target.client_id is distinct from p_client_id then
    raise exception 'The staged source does not belong to the selected client.'
      using errcode = '23514';
  end if;

  if target.status = 'staged' then
    return target.id;
  end if;
  if target.status = 'active' and exists (
    select 1 from public.client_reporting_anchor_events event
    where event.binding_id = target.id and event.event_type = 'source_added'
  ) then
    return target.id;
  end if;
  if target.status <> 'active' or target.bound_at <= rollout.reporting_cutover_at then
    raise exception 'Only a fresh post-cutover source can enter staging.'
      using errcode = '23514';
  end if;

  perform set_config('dropscale.reporting_source_stage_binding', target.id::text, true);
  update public.client_reporting_bindings
  set status = 'staged'
  where id = target.id and status = 'active';
  if not found then
    raise exception 'The reporting source could not be staged.' using errcode = '40001';
  end if;
  insert into public.client_reporting_binding_events (
    binding_id, event_type, idempotency_key, actor_id, reason, details
  ) values (
    target.id, 'staged', p_idempotency_key || ':staged', p_admin_id, normal_reason,
    jsonb_build_object('clientId', target.client_id, 'stagedAt', target.bound_at)
  );
  return target.id;
end
$$;

-- Write the exact full staged window through one purpose-bound transaction.
-- Unknown/secret-shaped JSON is rejected and computed_at is server-owned.
create or replace function public.commit_client_staged_reporting_metrics(
  p_binding_id uuid,
  p_success_from date,
  p_success_to date,
  p_rows jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_reporting_bindings%rowtype;
  expected_days integer;
  parsed_count integer;
  parsed_distinct_days integer;
  parsed_min_day date;
  parsed_max_day date;
  all_owned boolean;
  sync_time timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can write staged metrics.' using errcode = '42501';
  end if;
  if p_binding_id is null
    or p_success_from is null
    or p_success_to is null
    or p_success_to < p_success_from
    or p_success_to > current_date
    or p_success_to - p_success_from > 365
    or jsonb_typeof(p_rows) <> 'array'
  then
    raise exception 'Invalid staged reporting metrics request.' using errcode = '22023';
  end if;

  select * into target
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'staged'
  for update;
  if not found then
    raise exception 'Staged reporting binding not found.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rows) item
    where jsonb_typeof(item) <> 'object'
      or item ?| array[
        'token', 'token_hash', 'invite_token', 'invite_token_hash',
        'client_secret', 'access_token', 'ciphertext', 'password', 'api_key'
      ]
      or exists (
        select 1 from jsonb_object_keys(item) key
        where key not in (
          'ad_account_id', 'day', 'ad_spend', 'impressions', 'clicks',
          'conversions', 'conversion_value', 'revenue', 'orders_count',
          'refunds_amount', 'product_cost', 'payment_fees', 'shipping_cost',
          'revenue_share_base', 'revenue_share_amount', 'units_sold',
          'attributed_orders', 'attributed_revenue', 'computed_at'
        )
      )
  ) then
    raise exception 'Staged metric rows contain an unsupported field.' using errcode = '22023';
  end if;

  expected_days := p_success_to - p_success_from + 1;
  select count(*)::integer,
         count(distinct row.day)::integer,
         min(row.day), max(row.day),
         coalesce(bool_and(row.ad_account_id = target.ad_account_id), false)
  into parsed_count, parsed_distinct_days, parsed_min_day, parsed_max_day, all_owned
  from jsonb_to_recordset(p_rows) as row(
    ad_account_id uuid, day date, ad_spend numeric, impressions integer,
    clicks integer, conversions numeric, conversion_value numeric,
    revenue numeric, orders_count integer, refunds_amount numeric,
    product_cost numeric, payment_fees numeric, shipping_cost numeric,
    revenue_share_base numeric, revenue_share_amount numeric, units_sold integer,
    attributed_orders integer, attributed_revenue numeric, computed_at timestamptz
  );
  if parsed_count <> expected_days
    or parsed_distinct_days <> expected_days
    or parsed_min_day is distinct from p_success_from
    or parsed_max_day is distinct from p_success_to
    or not all_owned
  then
    raise exception 'Staged metric rows must cover every requested day exactly once.'
      using errcode = '23514';
  end if;

  perform set_config('dropscale.reporting_staged_sync_binding', target.id::text, true);
  insert into public.daily_metrics (
    ad_account_id, day, ad_spend, impressions, clicks, conversions,
    conversion_value, revenue, orders_count, refunds_amount, product_cost,
    payment_fees, shipping_cost, revenue_share_base, revenue_share_amount,
    units_sold, attributed_orders, attributed_revenue, computed_at
  )
  select row.ad_account_id, row.day, row.ad_spend, row.impressions, row.clicks,
    row.conversions, row.conversion_value, row.revenue, row.orders_count,
    row.refunds_amount, row.product_cost, row.payment_fees, row.shipping_cost,
    row.revenue_share_base, row.revenue_share_amount, row.units_sold,
    row.attributed_orders, row.attributed_revenue, sync_time
  from jsonb_to_recordset(p_rows) as row(
    ad_account_id uuid, day date, ad_spend numeric, impressions integer,
    clicks integer, conversions numeric, conversion_value numeric,
    revenue numeric, orders_count integer, refunds_amount numeric,
    product_cost numeric, payment_fees numeric, shipping_cost numeric,
    revenue_share_base numeric, revenue_share_amount numeric, units_sold integer,
    attributed_orders integer, attributed_revenue numeric, computed_at timestamptz
  )
  on conflict (ad_account_id, day) do update set
    ad_spend = excluded.ad_spend,
    impressions = excluded.impressions,
    clicks = excluded.clicks,
    conversions = excluded.conversions,
    conversion_value = excluded.conversion_value,
    revenue = excluded.revenue,
    orders_count = excluded.orders_count,
    refunds_amount = excluded.refunds_amount,
    product_cost = excluded.product_cost,
    payment_fees = excluded.payment_fees,
    shipping_cost = excluded.shipping_cost,
    revenue_share_base = excluded.revenue_share_base,
    revenue_share_amount = excluded.revenue_share_amount,
    units_sold = excluded.units_sold,
    attributed_orders = excluded.attributed_orders,
    attributed_revenue = excluded.attributed_revenue,
    computed_at = excluded.computed_at;

  return target.id;
end
$$;

create or replace function public.record_client_staged_reporting_sync_success(
  p_binding_id uuid,
  p_source_type text,
  p_success_from date,
  p_success_to date,
  p_source_currency text,
  p_row_count integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_reporting_bindings%rowtype;
  expected_currency text;
  metric_days integer;
  oldest_computed_at timestamptz;
  receipt_time timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can record a staged sync receipt.'
      using errcode = '42501';
  end if;
  if p_binding_id is null
    or p_source_type not in ('shopify', 'google_ads')
    or p_success_from is null
    or p_success_to is null
    or p_success_to < p_success_from
    or p_success_to > current_date
    or p_success_to - p_success_from > 365
    or coalesce(p_source_currency, '') !~ '^[A-Z]{3}$'
    or p_row_count is null
    or p_row_count < 0
    or p_row_count > p_success_to - p_success_from + 1
  then
    raise exception 'Invalid staged reporting sync receipt.' using errcode = '22023';
  end if;

  select * into target
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'staged'
  for update;
  if not found then
    raise exception 'Staged reporting binding not found.' using errcode = 'P0002';
  end if;

  if p_source_type = 'shopify' then
    select connection.shopify_currency into expected_currency
    from public.client_shopify_connections connection
    join public.client_shopify_credentials credential
      on credential.connection_id = connection.id
    where connection.id = target.shopify_connection_id
      and connection.client_id = target.client_id
      and connection.status = 'connected'
      and connection.last_verified_at is not null
      and connection.last_error_code is null
    for share of connection, credential;
  else
    select connection.currency into expected_currency
    from public.client_google_ads_connections connection
    where connection.id = target.google_ads_connection_id
      and connection.client_id = target.client_id
      and connection.status = 'connected'
      and connection.last_verified_at is not null
      and connection.last_error_code is null
      and nullif(btrim(coalesce(connection.time_zone, '')), '') is not null
    for share;
  end if;

  select count(*)::integer, min(metric.computed_at)
  into metric_days, oldest_computed_at
  from public.daily_metrics metric
  where metric.ad_account_id = target.ad_account_id
    and metric.day between p_success_from and p_success_to;

  if not found
    or expected_currency is distinct from p_source_currency
    or expected_currency !~ '^[A-Z]{3}$'
    or receipt_time <= target.bound_at
    or metric_days <> p_success_to - p_success_from + 1
    or oldest_computed_at <= target.bound_at
  then
    raise exception 'Staged sync receipt does not match a complete post-stage source write.'
      using errcode = '23514';
  end if;

  perform set_config(
    'dropscale.reporting_sync_receipt',
    p_binding_id::text || ':' || p_source_type,
    true
  );
  insert into public.client_reporting_sync_states (
    binding_id, source_type, last_success_at, last_success_from,
    last_success_to, source_currency, row_count
  ) values (
    p_binding_id, p_source_type, receipt_time, p_success_from,
    p_success_to, p_source_currency, p_row_count
  ) on conflict (binding_id, source_type) do update
    set last_success_at = excluded.last_success_at,
        last_success_from = excluded.last_success_from,
        last_success_to = excluded.last_success_to,
        source_currency = excluded.source_currency,
        row_count = excluded.row_count;

  return target.id;
end
$$;

create or replace function public.abandon_client_reporting_source(
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
  target public.client_reporting_bindings%rowtype;
  account public.ad_accounts%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can abandon a staged source.'
      using errcode = '42501';
  end if;
  if p_binding_id is null
    or not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin')
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 100
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid staged reporting abandonment.' using errcode = '22023';
  end if;

  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events event
  where event.idempotency_key = p_idempotency_key;
  if found then
    select * into target
    from public.client_reporting_bindings binding
    where binding.id = existing_event.binding_id;
    if existing_event.event_type = 'source_abandoned'
      and existing_event.binding_id = p_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
      and target.status = 'revoked'
      and target.revoked_by = p_admin_id
      and target.revoke_reason = normal_reason
    then
      return target.id;
    end if;
    raise exception 'Reporting source abandonment idempotency key is already used.'
      using errcode = '23505';
  end if;

  select * into target
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'staged'
  for update;
  if not found then
    raise exception 'Only a staged reporting binding can be abandoned.'
      using errcode = '23514';
  end if;

  select * into account
  from public.ad_accounts source_account
  where source_account.id = target.ad_account_id
    and source_account.client_id = target.client_id
  for update;
  if not found then
    raise exception 'The staged reporting account no longer exists.' using errcode = '23514';
  end if;
  if target.google_ads_connection_id is not null and exists (
    select 1 from public.ad_account_billing_starts billing_start
    where billing_start.ad_account_id = account.id
      and billing_start.google_ads_customer_id = account.google_ads_customer_id
      and billing_start.currency = account.currency
  ) and not exists (
    select 1 from public.ad_account_billing_ends billing_end
    where billing_end.ad_account_id = account.id
      and billing_end.google_ads_customer_id = account.google_ads_customer_id
      and billing_end.currency = account.currency
  ) then
    raise exception 'Terminate the staged Google billing boundary before abandonment.'
      using errcode = '23514';
  end if;

  perform set_config('dropscale.reporting_source_abandon_binding', target.id::text, true);
  update public.client_reporting_bindings
  set status = 'revoked',
      revoked_by = p_admin_id,
      revoked_at = clock_timestamp(),
      revoke_reason = normal_reason
  where id = target.id and status = 'staged';
  if not found then
    raise exception 'The staged reporting source could not be abandoned.'
      using errcode = '40001';
  end if;

  insert into public.client_reporting_binding_events (
    binding_id, event_type, idempotency_key, actor_id, reason, details
  ) values (
    target.id, 'abandoned', p_idempotency_key || ':abandoned',
    p_admin_id, normal_reason,
    jsonb_build_object('clientId', target.client_id, 'stagedAt', target.bound_at)
  );

  insert into public.client_reporting_anchor_events (
    binding_id, ad_account_id, event_type, idempotency_key,
    actor_id, reason, details
  ) values (
    target.id, target.ad_account_id, 'source_abandoned', p_idempotency_key,
    p_admin_id, normal_reason,
    jsonb_build_object(
      'clientId', target.client_id,
      'stagedAt', target.bound_at,
      'shopifyConnectionId', target.shopify_connection_id,
      'googleAdsConnectionId', target.google_ads_connection_id,
      'shopifyAnchorBindingId', target.shopify_anchor_binding_id
    )
  );

  return target.id;
end
$$;

create or replace function public.promote_client_reporting_source(
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
  target public.client_reporting_bindings%rowtype;
  account public.ad_accounts%rowtype;
  rollout public.client_rollout_states%rowtype;
  shopify public.client_shopify_connections%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  anchor public.client_reporting_bindings%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  shopify_receipt public.client_reporting_sync_states%rowtype;
  google_receipt public.client_reporting_sync_states%rowtype;
  shopify_domain text;
  google_customer_id text;
  materialized_day_count integer;
  materialized_min_day date;
  materialized_max_day date;
  materialized_max_computed_at timestamptz;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can promote a staged source.'
      using errcode = '42501';
  end if;
  if p_binding_id is null
    or not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin')
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 100
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid staged reporting promotion.' using errcode = '22023';
  end if;

  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events event
  where event.idempotency_key = p_idempotency_key;
  if found then
    select * into target
    from public.client_reporting_bindings binding
    where binding.id = existing_event.binding_id;
    select * into rollout
    from public.client_rollout_states state
    where state.client_id = target.client_id;
    if existing_event.event_type = 'source_added'
      and existing_event.binding_id = p_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
      and target.status = 'active'
      and rollout.operational_surface = 'v2_active'
      and rollout.reporting_cutover_at is not null
      and (existing_event.details ->> 'reportingCutoverAt')::timestamptz
            = rollout.reporting_cutover_at
    then
      return target.id;
    end if;
    raise exception 'Reporting source promotion idempotency key is already used.'
      using errcode = '23505';
  end if;

  select * into target
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'staged'
  for update;
  if not found then
    raise exception 'Staged reporting binding not found.' using errcode = 'P0002';
  end if;

  select * into rollout
  from public.client_rollout_states state
  where state.client_id = target.client_id
  for update;
  if not found
    or rollout.operational_surface <> 'v2_active'
    or rollout.reporting_cutover_at is null
    or target.bound_at <= rollout.reporting_cutover_at
  then
    raise exception 'The client has no valid pre-existing reporting cutover marker.'
      using errcode = '23514';
  end if;

  select * into account
  from public.ad_accounts source_account
  where source_account.id = target.ad_account_id
    and source_account.client_id = target.client_id
    and source_account.reporting_role in ('shopify_anchor', 'google_spend')
  for update;
  if not found or account.currency !~ '^[A-Z]{3}$' then
    raise exception 'The staged reporting account identity is invalid.' using errcode = '23514';
  end if;

  if target.shopify_connection_id is not null then
    select connection.* into shopify
    from public.client_shopify_connections connection
    join public.client_shopify_credentials credential
      on credential.connection_id = connection.id
    where connection.id = target.shopify_connection_id
      and connection.client_id = target.client_id
      and connection.status = 'connected'
      and connection.last_verified_at is not null
      and connection.last_error_code is null
    for update of connection;
    shopify_domain := public.normalize_shopify_reporting_domain(shopify.shopify_domain);
    if not found
      or shopify.shopify_currency !~ '^[A-Z]{3}$'
      or coalesce(shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
      or public.normalize_shopify_reporting_domain(account.shopify_url)
           is distinct from shopify_domain
    then
      raise exception 'The staged Shopify source identity or health is invalid.'
        using errcode = '23514';
    end if;

    select * into shopify_receipt
    from public.client_reporting_sync_states receipt
    where receipt.binding_id = target.id and receipt.source_type = 'shopify'
    for update;
    if not found
      or shopify_receipt.last_success_at <= target.bound_at
      or shopify_receipt.last_success_from > current_date - 90
      or shopify_receipt.last_success_to < current_date - 1
      or shopify_receipt.source_currency is distinct from shopify.shopify_currency
    then
      raise exception 'The staged Shopify source requires a post-stage 90-day sync receipt.'
        using errcode = '23514';
    end if;
  end if;

  if target.google_ads_connection_id is not null then
    select * into google_ads
    from public.client_google_ads_connections connection
    where connection.id = target.google_ads_connection_id
      and connection.client_id = target.client_id
      and connection.status = 'connected'
      and connection.last_verified_at is not null
      and connection.last_error_code is null
    for update;
    google_customer_id := public.normalize_google_ads_customer_id(google_ads.windsor_account_id);
    if not found
      or btrim(google_ads.windsor_account_id) !~ '^[0-9[:space:]-]+$'
      or length(coalesce(google_customer_id, '')) <> 10
      or google_ads.currency !~ '^[A-Z]{3}$'
      or google_ads.currency <> 'EUR'
      or nullif(btrim(coalesce(google_ads.time_zone, '')), '') is null
      or account.google_ads_customer_id is distinct from google_customer_id
      or account.currency is distinct from google_ads.currency
    then
      raise exception 'The staged Google Ads source identity or health is invalid.'
        using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.ad_account_billing_starts billing_start
      where billing_start.ad_account_id = account.id
        and billing_start.google_ads_customer_id = google_customer_id
        and billing_start.currency = account.currency
      for share
    ) then
      raise exception 'The staged Google Ads source requires its exact billing start.'
        using errcode = '23514';
    end if;
    if account.status not in ('active', 'suspended') or exists (
      select 1 from public.ad_account_billing_ends billing_end
      where billing_end.ad_account_id = account.id
        and billing_end.google_ads_customer_id = google_customer_id
        and billing_end.currency = account.currency
    ) then
      raise exception 'The staged Google Ads billing lifecycle is not promotable.'
        using errcode = '23514';
    end if;

    select * into google_receipt
    from public.client_reporting_sync_states receipt
    where receipt.binding_id = target.id and receipt.source_type = 'google_ads'
    for update;
    if not found
      or google_receipt.last_success_at <= target.bound_at
      or google_receipt.last_success_from > current_date - 90
      or google_receipt.last_success_to < current_date - 1
      or google_receipt.source_currency is distinct from google_ads.currency
    then
      raise exception 'The staged Google Ads source requires a post-stage 90-day sync receipt.'
        using errcode = '23514';
    end if;
  end if;

  if target.shopify_anchor_binding_id is not null then
    select binding.* into anchor
    from public.client_reporting_bindings binding
    where binding.id = target.shopify_anchor_binding_id
      and binding.status = 'active'
      and binding.client_id = target.client_id
      and binding.shopify_connection_id is not null
    for share;
    if not found
      or target.shopify_connection_id is not null
      or target.google_ads_connection_id is null
      or not exists (
        select 1 from public.client_asset_mappings mapping
        where mapping.shopify_connection_id = anchor.shopify_connection_id
          and mapping.google_ads_connection_id = target.google_ads_connection_id
        for share
      )
    then
      raise exception 'The staged Google Ads child has no exact active Shopify anchor.'
        using errcode = '23514';
    end if;
  elsif target.shopify_connection_id is not null
    and target.google_ads_connection_id is not null
    and not exists (
      select 1 from public.client_asset_mappings mapping
      where mapping.shopify_connection_id = target.shopify_connection_id
        and mapping.google_ads_connection_id = target.google_ads_connection_id
      for share
    )
  then
    raise exception 'The staged pair no longer has its exact asset mapping.'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from public.daily_metrics metric
    where metric.ad_account_id = target.ad_account_id
      and metric.computed_at <= target.bound_at
  ) then
    raise exception 'The staged source still has reporting rows older than this stage.'
      using errcode = '23514';
  end if;

  -- A receipt can outlive facts that were deleted or changed. Re-prove the
  -- exact current 90-day materialization at the authority boundary.
  select count(*)::integer, min(metric.day), max(metric.day), max(metric.computed_at)
  into materialized_day_count, materialized_min_day, materialized_max_day,
    materialized_max_computed_at
  from public.daily_metrics metric
  where metric.ad_account_id = target.ad_account_id
    and metric.day between current_date - 90 and current_date - 1;
  if materialized_day_count <> 90
    or materialized_min_day is distinct from current_date - 90
    or materialized_max_day is distinct from current_date - 1
    or materialized_max_computed_at is null
    or (
      target.shopify_connection_id is not null
      and shopify_receipt.last_success_at < materialized_max_computed_at
    )
    or (
      target.google_ads_connection_id is not null
      and google_receipt.last_success_at < materialized_max_computed_at
    )
  then
    raise exception 'The staged source no longer has complete materialized 90-day reporting facts.'
      using errcode = '23514';
  end if;

  perform set_config('dropscale.reporting_source_promote_binding', target.id::text, true);
  update public.client_reporting_bindings
  set status = 'active'
  where id = target.id and status = 'staged';
  if not found then
    raise exception 'The staged reporting source could not be promoted.' using errcode = '40001';
  end if;

  insert into public.client_reporting_binding_events (
    binding_id, event_type, idempotency_key, actor_id, reason, details
  ) values (
    target.id, 'promoted', p_idempotency_key || ':promoted',
    p_admin_id, normal_reason,
    jsonb_build_object(
      'clientId', target.client_id,
      'reportingCutoverAt', rollout.reporting_cutover_at,
      'stagedAt', target.bound_at
    )
  );

  insert into public.client_reporting_anchor_events (
    binding_id, ad_account_id, event_type, idempotency_key,
    actor_id, reason, details
  ) values (
    target.id, target.ad_account_id, 'source_added', p_idempotency_key,
    p_admin_id, normal_reason,
    jsonb_build_object(
      'clientId', target.client_id,
      'reportingCutoverAt', rollout.reporting_cutover_at,
      'stagedAt', target.bound_at,
      'shopifyConnectionId', target.shopify_connection_id,
      'googleAdsConnectionId', target.google_ads_connection_id,
      'shopifyAnchorBindingId', target.shopify_anchor_binding_id
    )
  );

  return target.id;
end
$$;

revoke all on function public.stage_client_reporting_source(
  uuid, uuid, uuid, uuid, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.stage_client_reporting_source(
  uuid, uuid, uuid, uuid, uuid, text, uuid, text
) to service_role;

revoke all on function public.commit_client_staged_reporting_metrics(
  uuid, date, date, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_client_staged_reporting_metrics(
  uuid, date, date, jsonb
) to service_role;

revoke all on function public.record_client_staged_reporting_sync_success(
  uuid, text, date, date, text, integer
) from public, anon, authenticated;
grant execute on function public.record_client_staged_reporting_sync_success(
  uuid, text, date, date, text, integer
) to service_role;

revoke all on function public.abandon_client_reporting_source(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.abandon_client_reporting_source(
  uuid, uuid, text, text
) to service_role;

revoke all on function public.promote_client_reporting_source(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.promote_client_reporting_source(
  uuid, uuid, text, text
) to service_role;

revoke all on function public.guard_post_cutover_reporting_binding_insert()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_staged_client_asset_mapping()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_staged_reporting_billing_status()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
