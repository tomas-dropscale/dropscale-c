-- =============================================================================
-- 0093 - Let a client whose Google source bills in an ECB-convertible currency
--        reach the V2 reporting cutover (Live) without the EUR billing baseline.
--
-- The activation RPC's Google billing gate required, for every Google-bound
-- binding: account.currency = source.currency AND an open EUR billing start.
-- A Google account billing in USD (Filipe & João / Elena Granada) can never
-- satisfy either — billing-start capture is EUR-only at every layer — so the
-- client stayed permanently "blocked" even though its reporting is complete:
-- the sync FX-converts Google money columns into the account's reporting
-- currency with the day's ECB rate, and receipts record the native currency.
--
-- This migration re-creates activate_client_reporting_cutover with ONE change,
-- the billing gate:
--   · EUR sources keep the full immutable-baseline requirement, unchanged:
--     account active/suspended, currency equality, open exact billing start.
--   · A source billing in another ECB-convertible currency (the frankfurter/
--     ECB reference set mirrored from src/lib/shopify/fx.ts) may activate
--     WITHOUT a billing start and with the account still pending: the client
--     goes Live for REPORTING, while billing automation keeps skipping the
--     account silently (auto-start, commission sync and invoicing all filter
--     it out) — it reports but is not auto-billed until billing learns
--     foreign currencies. Identity checks and the billing-end refusal remain
--     for every currency.
--   · A currency outside the ECB set still fails the gate: its spend could
--     never be converted, so such a client stays fail-closed at the database
--     even if the TypeScript queue were bypassed.
-- =============================================================================

create or replace function public.activate_client_reporting_cutover(
  p_client_id uuid,
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
  onboarding_session public.client_onboarding_sessions%rowtype;
  normal_reason text := btrim(coalesce(p_reason, ''));
  source_count integer;
  binding_count integer;
  cutover_time timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can activate a cutover.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_client_id is null or length(normal_reason) not between 3 and 500 then
    raise exception 'Invalid reporting cutover request.' using errcode = '22023';
  end if;

  -- Cutover is a rare admin boundary, so serialize the complete source
  -- snapshot rather than relying on row locks that cannot prevent phantoms at
  -- READ COMMITTED. Every writer to a covered source/binding/receipt waits
  -- until the rollout flip commits, or finishes first and becomes visible to
  -- the checks below.
  lock table
    public.client_shopify_connections,
    public.client_shopify_credentials,
    public.client_google_ads_connections,
    public.client_asset_mappings,
    public.client_reporting_bindings,
    public.client_reporting_sync_states,
    public.daily_metrics
  in share row exclusive mode;

  perform client.id
  from public.portal_clients client
  join public.profiles profile on profile.id = client.id
  where client.id = p_client_id
    and client.approval_status = 'approved'
    and profile.role <> 'admin'
  for share of client, profile;
  if not found then
    raise exception 'Only an approved non-admin client can activate reporting.'
      using errcode = '23514';
  end if;

  select * into rollout
  from public.client_rollout_states state
  where state.client_id = p_client_id
  for update;
  if not found
    or rollout.onboarding_session_id is null
    or rollout.operational_surface not in ('v2_ready_for_cutover', 'v2_active')
  then
    raise exception 'Client rollout is not ready for reporting cutover.'
      using errcode = '23514';
  end if;

  if rollout.reporting_cutover_at is not null then
    if rollout.operational_surface = 'v2_active'
      and rollout.reporting_cutover_by = p_admin_id
      and rollout.reporting_cutover_reason = normal_reason
      and exists (
        select 1
        from public.client_onboarding_events event
        join public.client_onboarding_sessions event_session
          on event_session.id = event.session_id
        where event_session.claimed_user_id = p_client_id
          and event.event_type = 'activated'
          and event.actor_type = 'admin'
          and event.actor_id = rollout.reporting_cutover_by
          and event.details ->> 'reportingBindings' = 'true'
          and event.details ->> 'reason' = rollout.reporting_cutover_reason
          and event.details ->> 'reportingCutoverAt'
                = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
      )
    then
      return p_client_id;
    end if;
    raise exception 'Reporting cutover is already recorded with different authority or is rolled back.'
      using errcode = '23514';
  end if;

  select * into onboarding_session
  from public.client_onboarding_sessions session
  where session.id = rollout.onboarding_session_id
    and session.claimed_user_id = p_client_id
    and session.status in ('submitted', 'reviewed', 'active')
  for update;
  if not found or cardinality(onboarding_session.requested_assets) = 0 then
    raise exception 'Asset reporting cutover requires a reviewed asset session.'
      using errcode = '23514';
  end if;

  -- These no-op locks intentionally serialize connection health/source changes
  -- with the complete coverage checks that follow.
  perform connection.id
  from public.client_shopify_connections connection
  where connection.client_id = p_client_id and connection.status = 'connected'
  for update;
  perform credential.connection_id
  from public.client_shopify_credentials credential
  join public.client_shopify_connections connection
    on connection.id = credential.connection_id
  where connection.client_id = p_client_id and connection.status = 'connected'
  for share of credential;
  perform connection.id
  from public.client_google_ads_connections connection
  where connection.client_id = p_client_id and connection.status = 'connected'
  for update;
  perform binding.id
  from public.client_reporting_bindings binding
  where binding.client_id = p_client_id and binding.status = 'active'
  for share;
  perform receipt.binding_id
  from public.client_reporting_sync_states receipt
  join public.client_reporting_bindings binding on binding.id = receipt.binding_id
  where binding.client_id = p_client_id and binding.status = 'active'
  for share of receipt;

  select
    (select count(*) from public.client_shopify_connections source
      where source.client_id = p_client_id and source.status = 'connected')
    +
    (select count(*) from public.client_google_ads_connections source
      where source.client_id = p_client_id and source.status = 'connected')
  into source_count;
  if source_count = 0 then
    raise exception 'Asset reporting cutover requires at least one connected source.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.client_reporting_bindings binding
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and binding.shopify_connection_id is not null
  ) then
    raise exception 'Asset reporting cutover requires at least one active Shopify anchor.'
      using errcode = '23514';
  end if;

  select
    count(binding.shopify_connection_id)
    + count(binding.google_ads_connection_id)
  into binding_count
  from public.client_reporting_bindings binding
  where binding.client_id = p_client_id and binding.status = 'active';
  if binding_count <> source_count
    or exists (
      select 1
      from public.client_shopify_connections source
      where source.client_id = p_client_id
        and source.status = 'connected'
        and (
          source.last_verified_at is null
          or source.last_error_code is not null
          or not exists (
            select 1 from public.client_shopify_credentials credential
            where credential.connection_id = source.id
          )
          or not exists (
            select 1 from public.client_reporting_bindings binding
            where binding.client_id = p_client_id
              and binding.status = 'active'
              and binding.shopify_connection_id = source.id
          )
        )
    )
    or exists (
      select 1
      from public.client_google_ads_connections source
      where source.client_id = p_client_id
        and source.status = 'connected'
        and (
          source.last_verified_at is null
          or source.last_error_code is not null
          or source.currency is null
          or source.currency !~ '^[A-Z]{3}$'
          or nullif(btrim(coalesce(source.time_zone, '')), '') is null
          or not exists (
            select 1 from public.client_reporting_bindings binding
            where binding.client_id = p_client_id
              and binding.status = 'active'
              and binding.google_ads_connection_id = source.id
          )
        )
    )
  then
    raise exception 'Connected reporting sources are not covered exactly once and healthy.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.client_reporting_bindings binding
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and (
        (
          binding.shopify_connection_id is not null
          and not exists (
            select 1 from public.client_reporting_sync_states receipt
            where receipt.binding_id = binding.id
              and receipt.source_type = 'shopify'
              and receipt.last_success_at > binding.bound_at
              and receipt.last_success_from <= current_date - 90
              and receipt.last_success_to >= current_date - 1
              and receipt.source_currency = (
                select source.shopify_currency
                from public.client_shopify_connections source
                where source.id = binding.shopify_connection_id
              )
          )
        )
        or (
          binding.google_ads_connection_id is not null
          and not exists (
            select 1 from public.client_reporting_sync_states receipt
            where receipt.binding_id = binding.id
              and receipt.source_type = 'google_ads'
              and receipt.last_success_at > binding.bound_at
              and receipt.last_success_from <= current_date - 90
              and receipt.last_success_to >= current_date - 1
              and receipt.source_currency = (
                select source.currency
                from public.client_google_ads_connections source
                where source.id = binding.google_ads_connection_id
              )
          )
        )
      )
  ) then
    raise exception 'Every bound source requires a fresh post-binding sync receipt.'
      using errcode = '23514';
  end if;

  -- A receipt is only a claim about an adapter commit. Re-prove the actual
  -- materialized facts at the authority boundary so a missing day, a crash
  -- between upsert and receipt, or a later legacy overwrite cannot ride a
  -- stale receipt into V2. The table lock above closes the check-to-marker
  -- race against normal legacy/browser writers.
  if exists (
    select 1
    from public.client_reporting_bindings binding
    left join public.client_reporting_sync_states shopify_receipt
      on shopify_receipt.binding_id = binding.id
     and shopify_receipt.source_type = 'shopify'
    left join public.client_reporting_sync_states google_receipt
      on google_receipt.binding_id = binding.id
     and google_receipt.source_type = 'google_ads'
    cross join lateral (
      select
        count(*)::integer as day_count,
        count(distinct metric.day)::integer as distinct_day_count,
        count(metric.computed_at)::integer as computed_count,
        min(metric.day) as min_day,
        max(metric.day) as max_day,
        min(metric.computed_at) as min_computed_at,
        max(metric.computed_at) as max_computed_at
      from public.daily_metrics metric
      where metric.ad_account_id = binding.ad_account_id
        and metric.day between current_date - 90 and current_date - 1
    ) materialized
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and (
        materialized.day_count <> 90
        or materialized.distinct_day_count <> 90
        or materialized.computed_count <> 90
        or materialized.min_day is distinct from current_date - 90
        or materialized.max_day is distinct from current_date - 1
        or materialized.min_computed_at is null
        or materialized.min_computed_at <= binding.bound_at
        or materialized.max_computed_at is null
        or (
          binding.shopify_connection_id is not null
          and (
            shopify_receipt.last_success_at is null
            or shopify_receipt.last_success_at < materialized.max_computed_at
          )
        )
        or (
          binding.google_ads_connection_id is not null
          and (
            google_receipt.last_success_at is null
            or google_receipt.last_success_at < materialized.max_computed_at
          )
        )
      )
  ) then
    raise exception 'Every active reporting binding requires complete receipt-owned materialized 90-day facts.'
      using errcode = '23514';
  end if;

  -- A reporting receipt proves that the adapter can read Google, but it does
  -- not authorize agency billing. An EUR source still never reaches the
  -- normalized surface without the immutable billing baseline created by the
  -- reviewed billing-start flow. A source billing in another ECB-convertible
  -- currency has no possible baseline (billing-start capture is EUR-only), so
  -- it activates for REPORTING alone: its spend is ECB-converted at sync, its
  -- account stays pending, and every billing automation keeps skipping it.
  -- Identity checks and the billing-end refusal apply to every currency, and
  -- a currency outside the ECB reference set still fails closed here.
  if exists (
    select 1
    from public.client_reporting_bindings binding
    join public.client_google_ads_connections source
      on source.id = binding.google_ads_connection_id
    join public.ad_accounts account
      on account.id = binding.ad_account_id
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and binding.google_ads_connection_id is not null
      and (
        source.client_id is distinct from p_client_id
        or account.client_id is distinct from p_client_id
        or account.google_ads_customer_id is distinct from
             public.normalize_google_ads_customer_id(source.windsor_account_id)
        or exists (
          select 1
          from public.ad_account_billing_ends billing_end
          where billing_end.ad_account_id = account.id
        )
        or (
          source.currency = 'EUR'
          and (
            account.status not in ('active', 'suspended')
            or account.currency is distinct from source.currency
            or not exists (
              select 1
              from public.ad_account_billing_starts billing_start
              where billing_start.ad_account_id = account.id
                and billing_start.google_ads_customer_id = account.google_ads_customer_id
                and billing_start.currency = account.currency
            )
          )
        )
        or (
          source.currency is distinct from 'EUR'
          -- The ECB reference set — mirror of FX_SUPPORTED_CURRENCIES in
          -- src/lib/shopify/fx.ts. Anything else can never be converted.
          and source.currency not in (
            'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'GBP',
            'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN',
            'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB',
            'TRY', 'USD', 'ZAR'
          )
        )
      )
  ) then
    raise exception 'Every Google reporting source requires an open exact immutable billing start.'
      using errcode = '23514';
  end if;

  cutover_time := clock_timestamp();
  perform set_config('dropscale.reporting_cutover_marker', p_client_id::text, true);
  update public.client_rollout_states
  set operational_surface = 'v2_active',
      reporting_cutover_at = cutover_time,
      reporting_cutover_by = p_admin_id,
      reporting_cutover_reason = normal_reason,
      updated_by = p_admin_id,
      updated_at = cutover_time
  where client_id = p_client_id;

  update public.client_onboarding_sessions
  set status = 'active',
      reviewed_at = coalesce(reviewed_at, clock_timestamp()),
      reviewed_by = coalesce(reviewed_by, p_admin_id),
      activated_at = coalesce(activated_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where id = onboarding_session.id;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    onboarding_session.id, 'activated', 'admin', p_admin_id,
    jsonb_build_object(
      'reason', normal_reason,
      'reportingBindings', true,
      'reportingCutoverAt', cutover_time,
      'requiredHistoryDays', 90
    )
  );

  return p_client_id;
end
$$;
