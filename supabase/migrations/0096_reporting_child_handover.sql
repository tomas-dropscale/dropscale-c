-- 0096 - Store handover, second leg: an anchored CHILD source moves too.
--
-- 0095 let a legacy PAIR hand its Google account to a successor store. The
-- successor is an anchored child - so the first time a client swaps stores
-- again, the source being moved IS a child, and v1 refused it in words. This
-- migration completes the succession: a child hands over exactly like a pair,
-- minus the one step that does not apply (the old account needs no
-- replacement binding - its store keeps its own anchor, and the retired
-- account simply stops being written, history frozen as recorded).
--
-- Same billing gate (Stop counting first), same counter-partition boundary,
-- same succession-aware identity claim. The function below is the 0095 body
-- with four anchored edits; everything else is byte-identical.

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
  if source.google_ads_connection_id is null then
    raise exception 'Only a Google-bearing source can hand its account over.'
      using errcode = '23514';
  end if;
  -- A standalone source belongs to the adoption RPC (0094): it has no store
  -- yet, so there is nothing to hand over FROM. Pairs and anchored children
  -- both hand over - children are how a previous handover left the source, so
  -- this is what makes the succession repeatable.
  if source.shopify_connection_id is null and source.shopify_anchor_binding_id is null then
    raise exception 'An unanchored Google source is linked with Store, not handed over.'
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
  if anchor.shopify_connection_id is not distinct from source.shopify_connection_id
    or anchor.id is not distinct from source.shopify_anchor_binding_id
  then
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
  -- A PAIR may only hand over from a legacy account: a shopify_anchor pair
  -- would keep writing metrics through its replacement Shopify-only binding,
  -- and guard_normalized_daily_metric_family forbids such an anchor to store
  -- the Google history the merge carries - its sync would fail forever. A
  -- CHILD has no such hazard: its old account is left unbound, nothing writes
  -- it again, and its history freezes exactly as recorded.
  if source.shopify_connection_id is not null
    and source_account.reporting_role <> 'legacy_hybrid'
  then
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

  -- A pair's old account keeps reporting its own store: same identity, same
  -- history, only the Google side leaves. A child's old account is left
  -- unbound instead - its store keeps its own anchor, and the projections
  -- keep the retired account's history grouped under that store.
  if source.shopify_connection_id is not null then
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

  -- The handover creates TWO active bindings after the cutover, so it must
  -- prove BOTH. The successor is evidenced above; the old store's remaining
  -- Shopify-only binding needs its own event or the cutover queue reads it as
  -- an unexplained post-cutover binding and fails the whole client closed
  -- ("no immutable source_added promotion event"). A child handover leaves no
  -- replacement, so there is nothing to evidence in that case.
  if replacement_binding_id is not null then
    insert into public.client_reporting_anchor_events (
      binding_id, prior_binding_id, ad_account_id, event_type,
      idempotency_key, actor_id, reason, details
    ) values (
      replacement_binding_id, source.id, source.ad_account_id, 'handed_over',
      p_idempotency_key || ':keep-store', p_admin_id, normal_reason,
      jsonb_build_object(
        'keepsShopifyConnectionId', source.shopify_connection_id,
        'handedOverGoogleAdsConnectionId', google_ads.id,
        'successorBindingId', child_binding_id
      )
    );
  end if;

  return child_binding_id;
end
$$;

revoke all on function public.handover_client_reporting_google_source(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.handover_client_reporting_google_source(
  uuid, uuid, uuid, text, text
) to service_role;

-- Repair: the first handover (0095) left its replacement binding with no
-- anchor event, so its client reads as "a post-cutover active binding has no
-- immutable source_added promotion event" and every action on it is withheld.
-- The successor's own event names the orphan in `replacementBindingId`, so the
-- audit trail repairs itself - no ids are hard-coded here, and the NOT EXISTS
-- guard makes a re-run a no-op.
insert into public.client_reporting_anchor_events (
  binding_id, prior_binding_id, ad_account_id, event_type,
  idempotency_key, actor_id, reason, details
)
select
  replacement.id,
  handover.prior_binding_id,
  replacement.ad_account_id,
  'handed_over',
  handover.idempotency_key || ':keep-store',
  handover.actor_id,
  handover.reason,
  jsonb_build_object(
    'keepsShopifyConnectionId', replacement.shopify_connection_id,
    'successorBindingId', handover.binding_id,
    'repairedBy', '0096_reporting_child_handover'
  )
from public.client_reporting_anchor_events handover
join public.client_reporting_bindings replacement
  on replacement.id = (handover.details ->> 'replacementBindingId')::uuid
where handover.event_type = 'handed_over'
  and handover.details ->> 'replacementBindingId' is not null
  and replacement.status = 'active'
  and not exists (
    select 1
    from public.client_reporting_anchor_events existing
    where existing.binding_id = replacement.id
  )
  and not exists (
    select 1
    from public.client_reporting_anchor_events clash
    where clash.idempotency_key = handover.idempotency_key || ':keep-store'
  );
