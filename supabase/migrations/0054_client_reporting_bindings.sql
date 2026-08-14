-- =============================================================================
-- 0054 - Explicit V2 asset bindings to immutable legacy reporting/billing rows.
--
-- A binding only points at an existing ad_accounts row. It never creates,
-- copies or rewrites reporting, credentials or financial evidence. Shopify is
-- bound once as the store fact anchor; additional mapped Google accounts point
-- at that anchor without repeating the Shopify source.
-- =============================================================================

create table public.client_reporting_bindings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null
    references public.portal_clients(id) on delete restrict,
  ad_account_id uuid not null
    references public.ad_accounts(id) on delete restrict,
  shopify_connection_id uuid
    references public.client_shopify_connections(id) on delete restrict,
  google_ads_connection_id uuid
    references public.client_google_ads_connections(id) on delete restrict,
  shopify_anchor_binding_id uuid
    references public.client_reporting_bindings(id) on delete restrict,
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  idempotency_key text not null unique,
  bound_reason text not null,
  bound_by uuid not null references public.profiles(id) on delete restrict,
  bound_at timestamptz not null default now(),
  revoked_by uuid references public.profiles(id) on delete restrict,
  revoked_at timestamptz,
  revoke_reason text,

  constraint client_reporting_bindings_asset_shape check (
    shopify_connection_id is not null or google_ads_connection_id is not null
  ),
  constraint client_reporting_bindings_anchor_shape check (
    shopify_anchor_binding_id is null
    or (
      shopify_connection_id is null
      and google_ads_connection_id is not null
      and shopify_anchor_binding_id <> id
    )
  ),
  constraint client_reporting_bindings_idempotency_shape check (
    idempotency_key = btrim(idempotency_key)
    and length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint client_reporting_bindings_bound_reason_shape check (
    bound_reason = btrim(bound_reason)
    and length(bound_reason) between 3 and 500
  ),
  constraint client_reporting_bindings_status_shape check (
    (
      status = 'active'
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
  )
);

comment on table public.client_reporting_bindings is
  'Audited, reversible pointers from connected V2 assets to existing immutable ad_accounts reporting/billing identities.';
comment on column public.client_reporting_bindings.shopify_anchor_binding_id is
  'For a Google-only ad_accounts child, points to the active binding that owns the single Shopify fact source selected by client_asset_mappings.';

create unique index client_reporting_bindings_active_ad_account_idx
  on public.client_reporting_bindings(ad_account_id)
  where status = 'active';
create unique index client_reporting_bindings_active_shopify_idx
  on public.client_reporting_bindings(shopify_connection_id)
  where status = 'active' and shopify_connection_id is not null;
create unique index client_reporting_bindings_active_google_idx
  on public.client_reporting_bindings(google_ads_connection_id)
  where status = 'active' and google_ads_connection_id is not null;
create index client_reporting_bindings_client_status_idx
  on public.client_reporting_bindings(client_id, status, bound_at desc);
create index client_reporting_bindings_active_anchor_idx
  on public.client_reporting_bindings(shopify_anchor_binding_id)
  where status = 'active' and shopify_anchor_binding_id is not null;

create table public.client_reporting_binding_events (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null
    references public.client_reporting_bindings(id) on delete restrict,
  event_type text not null check (event_type in ('bound', 'revoked')),
  idempotency_key text not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint client_reporting_binding_events_idempotency_shape check (
    idempotency_key = btrim(idempotency_key)
    and length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint client_reporting_binding_events_reason_shape check (
    reason = btrim(reason) and length(reason) between 3 and 500
  ),
  constraint client_reporting_binding_events_details_object check (
    jsonb_typeof(details) = 'object'
  ),
  constraint client_reporting_binding_events_no_secret_keys check (
    not (details ?| array[
      'token', 'token_hash', 'invite_token', 'invite_token_hash',
      'client_secret', 'access_token', 'ciphertext', 'password', 'api_key'
    ])
  )
);

create index client_reporting_binding_events_binding_created_idx
  on public.client_reporting_binding_events(binding_id, created_at desc);

alter table public.client_reporting_bindings enable row level security;
alter table public.client_reporting_binding_events enable row level security;

revoke all on table public.client_reporting_bindings
  from public, anon, authenticated, service_role;
revoke all on table public.client_reporting_binding_events
  from public, anon, authenticated, service_role;
grant select on table public.client_reporting_bindings to service_role;
grant select on table public.client_reporting_binding_events to service_role;

-- Binding identity is immutable. The only allowed row change is the explicit
-- active -> revoked transition performed by revoke_client_reporting_binding.
create or replace function public.guard_client_reporting_binding_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
    or old.status <> 'active'
    or new.status <> 'revoked'
    or new.revoked_by is null
    or new.revoked_at is null
    or new.revoke_reason is null
  then
    raise exception 'A client reporting binding identity is immutable.' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger client_reporting_bindings_guard_change
  before update or delete on public.client_reporting_bindings
  for each row execute function public.guard_client_reporting_binding_change();

create or replace function public.guard_client_reporting_binding_event_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'A client reporting binding event is immutable.' using errcode = '23514';
end
$$;

create trigger client_reporting_binding_events_guard_immutable
  before update or delete on public.client_reporting_binding_events
  for each row execute function public.guard_client_reporting_binding_event_immutable();

-- Once bound, none of the stable source identities may drift underneath the
-- audited pointer. Display names and health metadata remain editable.
create or replace function public.guard_bound_ad_account_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.ad_account_id = old.id and binding.status = 'active'
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Revoke the client reporting binding before changing its legacy source identity.'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.client_reporting_bindings binding
    where binding.ad_account_id = old.id
      and binding.status = 'active'
      and (
        new.client_id is distinct from old.client_id
        or (
          binding.google_ads_connection_id is not null
          and new.google_ads_customer_id is distinct from old.google_ads_customer_id
        )
        or (
          binding.shopify_connection_id is not null
          and new.shopify_url is distinct from old.shopify_url
        )
      )
  ) then
    raise exception 'Revoke the client reporting binding before changing its legacy source identity.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger ad_accounts_guard_bound_reporting_identity
  before update or delete on public.ad_accounts
  for each row execute function public.guard_bound_ad_account_identity();

create or replace function public.guard_bound_shopify_connection_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.shopify_connection_id = old.id and binding.status = 'active'
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Revoke the client reporting binding before changing its Shopify source identity.'
      using errcode = '23514';
  end if;
  if new.client_id is distinct from old.client_id
    or new.shopify_domain is distinct from old.shopify_domain
    or new.status is distinct from old.status
  then
    raise exception 'Revoke the client reporting binding before changing its Shopify source identity.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger client_shopify_connections_guard_bound_identity
  before update or delete on public.client_shopify_connections
  for each row execute function public.guard_bound_shopify_connection_identity();

create or replace function public.guard_bound_google_ads_connection_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.google_ads_connection_id = old.id and binding.status = 'active'
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Revoke the client reporting binding before changing its Google Ads source identity.'
      using errcode = '23514';
  end if;
  if new.client_id is distinct from old.client_id
    or new.windsor_account_id is distinct from old.windsor_account_id
    or new.status is distinct from old.status
  then
    raise exception 'Revoke the client reporting binding before changing its Google Ads source identity.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger client_google_ads_connections_guard_bound_identity
  before update or delete on public.client_google_ads_connections
  for each row execute function public.guard_bound_google_ads_connection_identity();

create or replace function public.guard_bound_client_asset_mapping()
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
    where binding.status = 'active'
      and binding.google_ads_connection_id = old.google_ads_connection_id
      and coalesce(binding.shopify_connection_id, anchor.shopify_connection_id)
            = old.shopify_connection_id
  ) then
    raise exception 'Revoke the client reporting binding before changing its asset mapping.'
      using errcode = '23514';
  end if;

  -- There is no mapping row to lock when an unmapped Google source is being
  -- bound. Serialise INSERTs and moves to a different Google source on that
  -- connection row instead. commit_client_reporting_binding takes the same
  -- lock before checking mapping presence, so one transaction must finish
  -- before the other validates the active binding.
  if tg_op = 'INSERT'
    or (
      tg_op = 'UPDATE'
      and new.google_ads_connection_id is distinct from old.google_ads_connection_id
    )
  then
    perform connection.id
    from public.client_google_ads_connections connection
    where connection.id = new.google_ads_connection_id
    for update;
    if not found then
      raise exception 'Google Ads source for asset mapping not found.' using errcode = '23503';
    end if;
  end if;

  -- An INSERT, or an UPDATE from a previously unrelated pair, must not attach
  -- a bound Google source to a different Shopify store. For an intentionally
  -- unmapped Google-only binding the expected Shopify id is NULL, so every new
  -- mapping remains blocked until the binding is explicitly revoked/rebound.
  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1
    from public.client_reporting_bindings binding
    left join public.client_reporting_bindings anchor
      on anchor.id = binding.shopify_anchor_binding_id
     and anchor.status = 'active'
    where binding.status = 'active'
      and binding.google_ads_connection_id = new.google_ads_connection_id
      and coalesce(binding.shopify_connection_id, anchor.shopify_connection_id)
            is distinct from new.shopify_connection_id
  ) then
    raise exception 'The bound Google Ads source cannot be mapped to a different Shopify source.'
      using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger client_asset_mappings_guard_bound_pair
  before insert or update or delete on public.client_asset_mappings
  for each row execute function public.guard_bound_client_asset_mapping();

create or replace function public.commit_client_reporting_binding(
  p_ad_account_id uuid,
  p_shopify_connection_id uuid,
  p_google_ads_connection_id uuid,
  p_shopify_anchor_binding_id uuid,
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
  target_account public.ad_accounts%rowtype;
  target_shopify public.client_shopify_connections%rowtype;
  target_google public.client_google_ads_connections%rowtype;
  anchor_binding public.client_reporting_bindings%rowtype;
  existing_binding public.client_reporting_bindings%rowtype;
  result_id uuid;
  locked_mapping_id uuid;
  normal_reason text := btrim(coalesce(p_reason, ''));
  legacy_shopify_domain text;
  legacy_google_customer_id text;
  v2_google_customer_id text;
  target_client_approval_status text;
  target_profile_role text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can commit a client reporting binding.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_ad_account_id is null
    or (p_shopify_connection_id is null and p_google_ads_connection_id is null)
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 128
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid client reporting binding request.' using errcode = '22023';
  end if;

  select * into existing_binding
  from public.client_reporting_bindings
  where idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_binding.status = 'active'
      and existing_binding.ad_account_id = p_ad_account_id
      and existing_binding.shopify_connection_id is not distinct from p_shopify_connection_id
      and existing_binding.google_ads_connection_id is not distinct from p_google_ads_connection_id
      and existing_binding.shopify_anchor_binding_id is not distinct from p_shopify_anchor_binding_id
      and existing_binding.bound_by = p_admin_id
      and existing_binding.bound_reason = normal_reason
    then
      return existing_binding.id;
    end if;
    raise exception 'Client reporting binding idempotency key is already used.' using errcode = '23505';
  end if;

  select * into target_account
  from public.ad_accounts
  where id = p_ad_account_id
  for update;
  if not found then
    raise exception 'Legacy ad account not found.' using errcode = 'P0002';
  end if;

  -- Serialise exact concurrent retries through the immutable target row. A
  -- request that waited on the lock can now observe the first commit.
  select * into existing_binding
  from public.client_reporting_bindings
  where idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_binding.status = 'active'
      and existing_binding.ad_account_id = p_ad_account_id
      and existing_binding.shopify_connection_id is not distinct from p_shopify_connection_id
      and existing_binding.google_ads_connection_id is not distinct from p_google_ads_connection_id
      and existing_binding.shopify_anchor_binding_id is not distinct from p_shopify_anchor_binding_id
      and existing_binding.bound_by = p_admin_id
      and existing_binding.bound_reason = normal_reason
    then
      return existing_binding.id;
    end if;
    raise exception 'Client reporting binding idempotency key is already used.' using errcode = '23505';
  end if;

  select client.approval_status, profile.role
  into target_client_approval_status, target_profile_role
    from public.portal_clients client
    join public.profiles profile on profile.id = client.id
    where client.id = target_account.client_id
    for share of client, profile;
  if not found
    or target_client_approval_status <> 'approved'
    or target_profile_role = 'admin'
  then
    raise exception 'Only an approved non-admin portal client can receive a reporting binding.'
      using errcode = '23514';
  end if;

  -- Every supplied V2 source must match a source already carried by the legacy
  -- row. The row may carry another, deliberately unbound source: nullable
  -- binding columns record partial coverage truthfully until a reviewed
  -- revoke/rebind completes it.
  if (p_shopify_connection_id is not null and target_account.shopify_url is null)
    or (
      p_google_ads_connection_id is not null
      and target_account.google_ads_customer_id is null
    )
  then
    raise exception 'Binding assets do not match the legacy ad account source shape.'
      using errcode = '23514';
  end if;

  if p_shopify_connection_id is not null then
    select * into target_shopify
    from public.client_shopify_connections
    where id = p_shopify_connection_id and status = 'connected'
    for share;
    if not found then
      raise exception 'Connected Shopify source not found.' using errcode = 'P0002';
    end if;
    legacy_shopify_domain := lower(regexp_replace(
      regexp_replace(btrim(coalesce(target_account.shopify_url, '')), '^https?://', '', 'i'),
      '/.*$', ''
    ));
    if target_shopify.client_id is distinct from target_account.client_id
      or coalesce(legacy_shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
      or lower(btrim(target_shopify.shopify_domain)) is distinct from legacy_shopify_domain
    then
      raise exception 'Shopify source does not exactly match the legacy ad account.'
        using errcode = '23514';
    end if;
  end if;

  if p_google_ads_connection_id is not null then
    select * into target_google
    from public.client_google_ads_connections
    where id = p_google_ads_connection_id and status = 'connected'
    for update;
    if not found then
      raise exception 'Connected Google Ads source not found.' using errcode = 'P0002';
    end if;
    if btrim(target_google.windsor_account_id) !~ '^[0-9[:space:]-]+$' then
      raise exception 'Google Ads source has no canonical customer identifier.'
        using errcode = '23514';
    end if;
    legacy_google_customer_id := public.normalize_google_ads_customer_id(
      target_account.google_ads_customer_id
    );
    v2_google_customer_id := public.normalize_google_ads_customer_id(
      target_google.windsor_account_id
    );
    if target_google.client_id is distinct from target_account.client_id
      or coalesce(target_account.google_ads_customer_id, '') !~ '^[0-9]{10}$'
      or length(v2_google_customer_id) <> 10
      or v2_google_customer_id is distinct from legacy_google_customer_id
    then
      raise exception 'Google Ads source does not exactly match the legacy ad account.'
        using errcode = '23514';
    end if;
  end if;

  -- Existing immutable billing boundaries remain authoritative. Binding is
  -- refused if their source identity is already inconsistent; nothing here
  -- attempts to repair or replace those rows.
  if p_google_ads_connection_id is not null and (
    exists (
      select 1 from public.ad_account_billing_starts billing_start
      where billing_start.ad_account_id = target_account.id
        and (
          billing_start.google_ads_customer_id is distinct from target_account.google_ads_customer_id
          or billing_start.currency is distinct from target_account.currency
        )
    ) or exists (
      select 1 from public.ad_account_billing_ends billing_end
      where billing_end.ad_account_id = target_account.id
        and (
          billing_end.google_ads_customer_id is distinct from target_account.google_ads_customer_id
          or billing_end.currency is distinct from target_account.currency
        )
    )
  ) then
    raise exception 'Legacy billing identity does not match the ad account source.'
      using errcode = '23514';
  end if;

  if p_shopify_anchor_binding_id is not null then
    select * into anchor_binding
    from public.client_reporting_bindings
    where id = p_shopify_anchor_binding_id and status = 'active'
    for share;
    if not found
      or p_shopify_connection_id is not null
      or p_google_ads_connection_id is null
      or anchor_binding.client_id is distinct from target_account.client_id
      or anchor_binding.shopify_connection_id is null
    then
      raise exception 'Active Shopify anchor binding not found for this client.'
        using errcode = '23514';
    end if;
    select mapping.id into locked_mapping_id
    from public.client_asset_mappings mapping
      where mapping.shopify_connection_id = anchor_binding.shopify_connection_id
        and mapping.google_ads_connection_id = p_google_ads_connection_id
    for share;
    if not found then
      raise exception 'Google Ads source is not explicitly mapped to the Shopify anchor.'
        using errcode = '23514';
    end if;
  elsif p_shopify_connection_id is not null and p_google_ads_connection_id is not null then
    select mapping.id into locked_mapping_id
    from public.client_asset_mappings mapping
      where mapping.shopify_connection_id = p_shopify_connection_id
        and mapping.google_ads_connection_id = p_google_ads_connection_id
    for share;
    if not found then
      raise exception 'Shopify and Google Ads sources are not explicitly mapped.'
        using errcode = '23514';
    end if;
  elsif p_shopify_connection_id is null and p_google_ads_connection_id is not null then
    select mapping.id into locked_mapping_id
    from public.client_asset_mappings mapping
    where mapping.google_ads_connection_id = p_google_ads_connection_id
    for share;
    if found then
      raise exception 'Mapped Google Ads sources require their active Shopify anchor binding.'
        using errcode = '23514';
    end if;
  end if;

  insert into public.client_reporting_bindings (
    client_id, ad_account_id, shopify_connection_id,
    google_ads_connection_id, shopify_anchor_binding_id,
    idempotency_key, bound_reason, bound_by
  ) values (
    target_account.client_id, target_account.id, p_shopify_connection_id,
    p_google_ads_connection_id, p_shopify_anchor_binding_id,
    p_idempotency_key, normal_reason, p_admin_id
  ) returning id into result_id;

  insert into public.client_reporting_binding_events (
    binding_id, event_type, idempotency_key, actor_id, reason, details
  ) values (
    result_id, 'bound', p_idempotency_key, p_admin_id, normal_reason,
    jsonb_build_object(
      'clientId', target_account.client_id,
      'adAccountId', target_account.id,
      'shopifyConnectionId', p_shopify_connection_id,
      'shopifyDomain', legacy_shopify_domain,
      'googleAdsConnectionId', p_google_ads_connection_id,
      'googleAdsCustomerId', legacy_google_customer_id,
      'shopifyAnchorBindingId', p_shopify_anchor_binding_id
    )
  );
  return result_id;
end
$$;

revoke all on function public.commit_client_reporting_binding(
  uuid, uuid, uuid, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.commit_client_reporting_binding(
  uuid, uuid, uuid, uuid, text, uuid, text
) to service_role;

create or replace function public.revoke_client_reporting_binding(
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
  existing_event public.client_reporting_binding_events%rowtype;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke a client reporting binding.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_binding_id is null
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 128
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid client reporting binding revocation.' using errcode = '22023';
  end if;

  select * into existing_event
  from public.client_reporting_binding_events
  where idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_event.event_type = 'revoked'
      and existing_event.binding_id = p_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
    then
      return p_binding_id;
    end if;
    raise exception 'Client reporting event idempotency key is already used.' using errcode = '23505';
  end if;

  select * into target
  from public.client_reporting_bindings
  where id = p_binding_id
  for update;
  if not found then
    raise exception 'Active client reporting binding not found.' using errcode = 'P0002';
  end if;

  -- As above, an exact concurrent retry may only become visible after the
  -- binding row lock was released by the first transaction.
  select * into existing_event
  from public.client_reporting_binding_events
  where idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_event.event_type = 'revoked'
      and existing_event.binding_id = p_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
    then
      return p_binding_id;
    end if;
    raise exception 'Client reporting event idempotency key is already used.' using errcode = '23505';
  end if;
  if target.status <> 'active' then
    raise exception 'Binding is already revoked; use the original idempotency key for a retry.'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.client_reporting_bindings child
    where child.shopify_anchor_binding_id = target.id and child.status = 'active'
  ) then
    raise exception 'Revoke the Shopify anchor child bindings first.' using errcode = '23503';
  end if;

  update public.client_reporting_bindings
  set status = 'revoked',
      revoked_by = p_admin_id,
      revoked_at = now(),
      revoke_reason = normal_reason
  where id = target.id;

  insert into public.client_reporting_binding_events (
    binding_id, event_type, idempotency_key, actor_id, reason, details
  ) values (
    target.id, 'revoked', p_idempotency_key, p_admin_id, normal_reason,
    jsonb_build_object(
      'clientId', target.client_id,
      'adAccountId', target.ad_account_id,
      'shopifyConnectionId', target.shopify_connection_id,
      'googleAdsConnectionId', target.google_ads_connection_id,
      'shopifyAnchorBindingId', target.shopify_anchor_binding_id
    )
  );
  return target.id;
end
$$;

revoke all on function public.revoke_client_reporting_binding(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.revoke_client_reporting_binding(uuid, uuid, text, text)
  to service_role;

revoke all on function public.guard_client_reporting_binding_change()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_binding_event_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_bound_ad_account_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_bound_shopify_connection_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_bound_google_ads_connection_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_bound_client_asset_mapping()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
