-- 0098 - Let a Google account billing in an ECB-convertible currency join a
-- store BEFORE the cutover, as a spend child of that store's anchor.
--
-- 0093 let such a client ACTIVATE (the cutover gate accepts a non-EUR Google
-- source without the EUR billing baseline). Binding the source in the first
-- place still refused it: provision_client_reporting_anchor demanded the
-- anchor account and the Google account share a currency, and a new client's
-- Shopify-only anchor is always EUR. The cutover queue never even offered the
-- candidate. A client onboarded with a USD Google account (David e Tiago,
-- 923-195-6172) therefore sat at "1/2 sources bound" with nothing to click,
-- and the portal showed no ad spend and no campaigns.
--
-- This migration re-creates provision_client_reporting_anchor as 0055's text
-- with two edits, everything else byte-identical:
--   * the child-anchor join accepts a Google account in any ECB-convertible
--     currency (the same reference set 0093 mirrors from src/lib/shopify/fx.ts,
--     kept here in one helper);
--   * the child account is created in the ANCHOR's currency, never the Google
--     one: the sync converts Google money columns into the account's currency
--     with the day's ECB rate, and receipts keep the native currency. For an
--     equal-currency child this is the value it already had.
-- Pairs are untouched (a pair's account still takes the Google currency), the
-- staged post-cutover lifecycle (0056) is untouched (its promotion still needs
-- the EUR billing baseline), and a currency outside the ECB set is refused
-- exactly as before. Billing keeps skipping non-EUR accounts (auto-start,
-- commission sync, invoicing): such a source reports but is not auto-billed.

create or replace function public.reporting_fx_convertible_currency(p_currency text)
returns boolean
language sql
immutable
as $$
  -- The ECB reference set - mirror of FX_SUPPORTED_CURRENCIES in
  -- src/lib/shopify/fx.ts and of the inline list in 0093. EUR itself needs no
  -- conversion and is deliberately not listed: callers treat it as equality.
  select p_currency in (
    'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'GBP',
    'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN',
    'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB',
    'TRY', 'USD', 'ZAR'
  );
$$;

revoke all on function public.reporting_fx_convertible_currency(text)
  from public, anon, authenticated;
grant execute on function public.reporting_fx_convertible_currency(text)
  to service_role;

-- Baseline: the deployed 0055 provision RPC, byte-identical, plus the two edits.
create or replace function public.provision_client_reporting_anchor(
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
  shopify public.client_shopify_connections%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  anchor public.client_reporting_bindings%rowtype;
  account public.ad_accounts%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  result_binding_id uuid;
  owner_id uuid;
  source_currency text;
  shopify_domain text;
  google_customer_id text;
  prior_shopify_domain text;
  prior_google_customer_id text;
  prior_currency text;
  event_type text;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can provision an anchor.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if (p_shopify_connection_id is null and p_google_ads_connection_id is null)
    or p_shopify_anchor_binding_id is not null and (
      p_shopify_connection_id is not null or p_google_ads_connection_id is null
    )
    or p_existing_ad_account_id is not null and p_shopify_connection_id is null
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 100
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting anchor request.' using errcode = '22023';
  end if;

  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_event.event_type = (case
          when p_existing_ad_account_id is null then 'provisioned'
          else 'adopted'
        end)
      and existing_event.actor_id = p_admin_id
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
      return existing_event.binding_id;
    end if;
    raise exception 'Reporting anchor idempotency key is already used.' using errcode = '23505';
  end if;

  if p_shopify_connection_id is not null then
    select * into shopify
    from public.client_shopify_connections connection
    where connection.id = p_shopify_connection_id
      and connection.status = 'connected'
    for update;
    if not found
      or shopify.last_verified_at is null
      or shopify.last_error_code is not null
      or not exists (
        select 1 from public.client_shopify_credentials credential
        where credential.connection_id = shopify.id
        for share
      )
    then
      raise exception 'A verified credentialed Shopify reporting source is required.'
        using errcode = '23514';
    end if;
    shopify_domain := public.normalize_shopify_reporting_domain(shopify.shopify_domain);
    if coalesce(shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
      or shopify.shopify_currency !~ '^[A-Z]{3}$'
    then
      raise exception 'Shopify reporting metadata is invalid.' using errcode = '23514';
    end if;
    owner_id := shopify.client_id;
    -- The normalized metric surface is portfolio-wide and currently reports
    -- in EUR. Shopify receipts keep the store's native shopMoney currency,
    -- while the adapter performs the fail-closed daily ECB conversion before
    -- writing facts to this EUR anchor.
    source_currency := 'EUR';
  end if;

  if p_google_ads_connection_id is not null then
    select * into google_ads
    from public.client_google_ads_connections connection
    where connection.id = p_google_ads_connection_id
      and connection.status = 'connected'
    for update;
    if not found
      or google_ads.last_verified_at is null
      or google_ads.last_error_code is not null
    then
      raise exception 'A verified Google Ads reporting source is required.'
        using errcode = '23514';
    end if;
    if btrim(google_ads.windsor_account_id) !~ '^[0-9[:space:]-]+$' then
      raise exception 'Google Ads source has no canonical customer identifier.'
        using errcode = '23514';
    end if;
    google_customer_id := public.normalize_google_ads_customer_id(
      google_ads.windsor_account_id
    );
    if length(coalesce(google_customer_id, '')) <> 10
      or google_ads.currency is null
      or google_ads.currency !~ '^[A-Z]{3}$'
      or nullif(btrim(coalesce(google_ads.time_zone, '')), '') is null
    then
      raise exception 'Google Ads reporting metadata is incomplete.'
        using errcode = '23514';
    end if;
    if owner_id is not null and owner_id is distinct from google_ads.client_id then
      raise exception 'Reporting sources belong to different clients.' using errcode = '23514';
    end if;
    owner_id := google_ads.client_id;
    -- Google Ads defines the canonical reporting/billing currency for a pair.
    -- Shopify reports native shopMoney and the adapter converts it into this
    -- currency before writing daily_metrics. Shopify-only anchors use the EUR
    -- portfolio currency assigned above.
    source_currency := google_ads.currency;
  end if;

  perform client.id
  from public.portal_clients client
  join public.profiles profile on profile.id = client.id
  where client.id = owner_id
    and client.approval_status = 'approved'
    and profile.role <> 'admin'
  for share of client, profile;
  if not found then
    raise exception 'Only an approved non-admin client can receive a reporting anchor.'
      using errcode = '23514';
  end if;

  if p_shopify_anchor_binding_id is not null then
    select binding.* into anchor
    from public.client_reporting_bindings binding
    join public.ad_accounts anchor_account
      on anchor_account.id = binding.ad_account_id
     -- Exact legacy pairs upgraded above deliberately retain their historical
     -- surrogate role and id. Their active Shopify binding is still the sole
     -- Shopify fact source and may anchor additional explicitly-mapped Google
     -- spend children under the same owner/canonical currency.
     and anchor_account.reporting_role in ('shopify_anchor', 'legacy_hybrid')
     and (
       anchor_account.currency = google_ads.currency
       or public.reporting_fx_convertible_currency(google_ads.currency)
     )
    join public.client_shopify_connections anchor_shopify
      on anchor_shopify.id = binding.shopify_connection_id
     and anchor_shopify.status = 'connected'
     and anchor_shopify.last_verified_at is not null
     and anchor_shopify.last_error_code is null
    join public.client_shopify_credentials anchor_credential
      on anchor_credential.connection_id = anchor_shopify.id
    where binding.id = p_shopify_anchor_binding_id
      and binding.status = 'active'
      and binding.shopify_connection_id is not null
    for share of binding, anchor_account, anchor_shopify, anchor_credential;
    if not found or anchor.client_id is distinct from owner_id then
      raise exception 'Active same-owner Shopify anchor not found.' using errcode = '23514';
    end if;
    -- A spend child reports in its STORE's currency. When the Google account
    -- bills in another ECB-convertible currency the sync converts every money
    -- column into the anchor's currency with the day's rate (0093's model),
    -- so the child account is created in the anchor's currency - one store,
    -- one currency, no split daily_metrics. For an equal-currency child this
    -- assigns the value it already had.
    select anchor_account.currency into source_currency
    from public.ad_accounts anchor_account
    where anchor_account.id = anchor.ad_account_id;
    if not exists (
      select 1 from public.client_asset_mappings mapping
      where mapping.shopify_connection_id = anchor.shopify_connection_id
        and mapping.google_ads_connection_id = google_ads.id
      for share
    ) then
      raise exception 'Google Ads source is not explicitly mapped to the Shopify anchor.'
        using errcode = '23514';
    end if;
  elsif p_shopify_connection_id is not null and p_google_ads_connection_id is not null then
    if not exists (
      select 1 from public.client_asset_mappings mapping
      where mapping.shopify_connection_id = shopify.id
        and mapping.google_ads_connection_id = google_ads.id
      for share
    ) then
      raise exception 'Shopify and Google Ads sources are not explicitly mapped.'
        using errcode = '23514';
    end if;
  elsif p_shopify_connection_id is null and p_google_ads_connection_id is not null then
    if exists (
      select 1 from public.client_asset_mappings mapping
      where mapping.google_ads_connection_id = google_ads.id
      for share
    ) then
      raise exception 'A mapped Google Ads source requires its Shopify anchor.'
        using errcode = '23514';
    end if;
  end if;

  if p_existing_ad_account_id is null then
    if shopify_domain is not null and exists (
      select 1 from public.ad_accounts existing
      where public.normalize_shopify_reporting_domain(existing.shopify_url) = shopify_domain
    ) then
      raise exception 'Shopify reporting identity already belongs to an ad account; use reviewed adoption.'
        using errcode = '23505';
    end if;
    if google_customer_id is not null and exists (
      select 1 from public.ad_accounts existing
      where existing.google_ads_customer_id = google_customer_id
    ) then
      raise exception 'Google Ads reporting identity already belongs to an ad account; use reviewed adoption.'
        using errcode = '23505';
    end if;
  end if;

  if p_existing_ad_account_id is not null then
    select * into account
    from public.ad_accounts target
    where target.id = p_existing_ad_account_id
    for update;
    if not found
      or account.client_id is distinct from owner_id
      or account.status <> 'pending'
      or account.reporting_role <> 'legacy_hybrid'
      or (
        account.shopify_url is not null
        and public.normalize_shopify_reporting_domain(account.shopify_url)
              is distinct from shopify_domain
      )
      or (
        account.google_ads_customer_id is not null
        and (
          google_customer_id is null
          or account.google_ads_customer_id is distinct from google_customer_id
        )
      )
      or account.shopify_connected
      or account.shopify_client_id is not null
      or account.shopify_scopes is not null
      or account.shopify_admin_token is not null
      or account.shopify_token_last4 is not null
      or account.shopify_connected_at is not null
      or account.google_ads_refresh_token is not null
      or account.google_ads_connected_email is not null
      or account.google_ads_connected
      or account.currency is distinct from source_currency
      or public.ad_account_has_reporting_or_financial_history(account.id)
      or exists (
        select 1 from public.client_reporting_bindings binding
        where binding.ad_account_id = account.id
      )
    then
      raise exception 'Only an exact pristine pending legacy row can be adopted.'
        using errcode = '23514';
    end if;

    prior_shopify_domain := public.normalize_shopify_reporting_domain(account.shopify_url);
    prior_google_customer_id := account.google_ads_customer_id;
    prior_currency := account.currency;
    perform set_config('dropscale.reporting_anchor_adoption', account.id::text, true);
    update public.ad_accounts
    set shopify_url = shopify_domain,
        google_ads_customer_id = google_customer_id,
        reporting_role = 'shopify_anchor'
    where id = account.id
    returning * into account;
    event_type := 'adopted';
  else
    insert into public.ad_accounts (
      client_id, store_name, google_ads_customer_id, status, currency,
      shopify_url, reporting_role
    ) values (
      owner_id,
      coalesce(
        case when p_shopify_connection_id is not null
          then nullif(btrim(shopify.shopify_name), '') end,
        case when p_google_ads_connection_id is not null
          then nullif(btrim(google_ads.account_name), '') end,
        'Reporting source'
      ),
      google_customer_id,
      'pending',
      source_currency,
      shopify_domain,
      case when p_shopify_connection_id is not null
        then 'shopify_anchor' else 'google_spend' end
    ) returning * into account;
    event_type := 'provisioned';
  end if;

  result_binding_id := public.commit_client_reporting_binding(
    account.id,
    p_shopify_connection_id,
    p_google_ads_connection_id,
    p_shopify_anchor_binding_id,
    p_idempotency_key,
    p_admin_id,
    normal_reason
  );

  insert into public.client_reporting_anchor_events (
    binding_id, ad_account_id, event_type, idempotency_key,
    actor_id, reason, details
  ) values (
    result_binding_id, account.id, event_type, p_idempotency_key,
    p_admin_id, normal_reason,
    jsonb_build_object(
      'shopifyConnectionId', p_shopify_connection_id,
      'googleAdsConnectionId', p_google_ads_connection_id,
      'shopifyAnchorBindingId', p_shopify_anchor_binding_id,
      'requestedExistingAdAccountId', p_existing_ad_account_id,
      'reportingRole', account.reporting_role,
      'priorShopifyDomain', prior_shopify_domain,
      'priorGoogleAdsCustomerId', prior_google_customer_id,
      'priorCurrency', prior_currency,
      'committedShopifyDomain', shopify_domain,
      'committedGoogleAdsCustomerId', google_customer_id,
      'committedCurrency', account.currency
    )
  );

  return result_binding_id;
end
$$;
