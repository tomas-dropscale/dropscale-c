-- =============================================================================
-- 0040 - Merchant-authorised Shopify connections for internal store audits.
--
-- This is deliberately separate from ad_accounts. Audit credentials must
-- never enter the revenue/COGS/billing sync path used by client workspaces.
-- A pending connection is also the one-time invitation. The bearer token is
-- never stored: only its SHA-256 digest is kept until the invite is consumed.
-- =============================================================================

create table if not exists public.audit_shopify_connections (
  id uuid primary key default gen_random_uuid(),
  store_label text not null,
  status text not null default 'pending'
    check (status in ('pending', 'connected', 'revoked')),
  invite_token_hash text,
  invite_expires_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  last_attempt_at timestamptz,

  shopify_shop_id text,
  shopify_name text,
  shopify_domain text,
  primary_domain text,
  shopify_currency text,
  shopify_client_id text,
  credential_hint text,
  granted_scopes text[] not null default '{}',
  scope_profile text not null default 'store-audit-full-v1',

  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connected_at timestamptz,
  last_verified_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  revoked_at timestamptz,
  last_error_code text,

  constraint audit_shopify_store_label_shape check (
    length(btrim(store_label)) between 1 and 120
  ),
  constraint audit_shopify_invite_hash_shape check (
    invite_token_hash is null or invite_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint audit_shopify_domain_shape check (
    shopify_domain is null
    or shopify_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
  ),
  constraint audit_shopify_currency_shape check (
    shopify_currency is null or shopify_currency ~ '^[A-Z]{3}$'
  ),
  constraint audit_shopify_scope_profile check (
    scope_profile = 'store-audit-full-v1'
  ),
  constraint audit_shopify_state_shape check (
    (
      status = 'pending'
      and invite_token_hash is not null
      and invite_expires_at is not null
      and connected_at is null
      and revoked_at is null
      and shopify_domain is null
    )
    or (
      status = 'connected'
      and invite_token_hash is null
      and invite_expires_at is null
      and connected_at is not null
      and revoked_at is null
      and shopify_shop_id is not null
      and shopify_name is not null
      and shopify_domain is not null
      and shopify_client_id is not null
      and credential_hint is not null
    )
    or (
      status = 'revoked'
      and invite_token_hash is null
      and invite_expires_at is null
      and revoked_at is not null
    )
  )
);

comment on table public.audit_shopify_connections is
  'Admin-created Shopify audit invitations and verified permission metadata. Never used by client metrics or billing.';
comment on column public.audit_shopify_connections.invite_token_hash is
  'SHA-256 hex digest of a one-time bearer secret. The raw secret is returned once and never stored.';

create unique index if not exists audit_shopify_connections_invite_hash_idx
  on public.audit_shopify_connections (invite_token_hash)
  where invite_token_hash is not null;

create unique index if not exists audit_shopify_connections_active_domain_idx
  on public.audit_shopify_connections (lower(shopify_domain))
  where status = 'connected' and shopify_domain is not null;

create index if not exists audit_shopify_connections_status_created_idx
  on public.audit_shopify_connections (status, created_at desc);

-- Ciphertext has no authenticated/admin SELECT policy at all. Every read and
-- write is performed by a server-only service client after an admin session or
-- a valid one-time invitation has been independently verified.
create table if not exists public.audit_shopify_credentials (
  connection_id uuid primary key
    references public.audit_shopify_connections(id) on delete cascade,
  client_secret_ciphertext text not null,
  updated_at timestamptz not null default now(),
  constraint audit_shopify_credential_not_empty check (
    length(btrim(client_secret_ciphertext)) > 0
  )
);

comment on table public.audit_shopify_credentials is
  'Service-role-only AES-GCM Shopify Client Secrets for store audits.';

-- Realtime listens only to this intentionally non-secret event stream. It can
-- refresh an open Connections page without publishing token digests or cipher.
create table if not exists public.audit_shopify_connection_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.audit_shopify_connections(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'invitation_created',
      'invitation_rotated',
      'invitation_revoked',
      'credentials_rejected',
      'store_connected',
      'connection_reviewed',
      'connection_revoked',
      'verification_failed'
    )
  ),
  actor_type text not null check (actor_type in ('admin', 'invite', 'system')),
  actor_profile_id uuid references public.profiles(id),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_shopify_event_details_object check (
    jsonb_typeof(details) = 'object'
  ),
  constraint audit_shopify_event_no_secret_keys check (
    not (details ?| array[
      'token', 'token_hash', 'invite_token', 'invite_token_hash',
      'client_secret', 'access_token', 'ciphertext'
    ])
  )
);

create index if not exists audit_shopify_events_connection_created_idx
  on public.audit_shopify_connection_events (connection_id, created_at desc);

alter table public.audit_shopify_connections enable row level security;
alter table public.audit_shopify_credentials enable row level security;
alter table public.audit_shopify_connection_events enable row level security;

revoke all on table public.audit_shopify_connections
  from public, anon, authenticated;
revoke all on table public.audit_shopify_credentials
  from public, anon, authenticated;
revoke all on table public.audit_shopify_connection_events
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.audit_shopify_connections to service_role;
grant select, insert, update, delete
  on table public.audit_shopify_credentials to service_role;
grant select, insert, update, delete
  on table public.audit_shopify_connection_events to service_role;

-- Event rows are safe notification metadata. Admins can subscribe/read; all
-- writes remain service-role-only.
grant select on table public.audit_shopify_connection_events to authenticated;
create policy audit_shopify_events_admin_read
  on public.audit_shopify_connection_events
  for select to authenticated
  using (public.is_admin());

-- Create a pending invite and its audit event in one transaction. The caller
-- has already generated the random bearer secret and passes only its digest.
create or replace function public.create_audit_shopify_invitation(
  p_connection_id uuid,
  p_store_label text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can create an audit invitation.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_created_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;

  if p_connection_id is null
    or length(btrim(coalesce(p_store_label, ''))) not between 1 and 120
    or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now()
    or p_expires_at > now() + interval '8 days'
  then
    raise exception 'Invalid audit invitation.' using errcode = '22023';
  end if;

  insert into public.audit_shopify_connections (
    id, store_label, invite_token_hash, invite_expires_at, created_by
  ) values (
    p_connection_id, btrim(p_store_label), p_token_hash, p_expires_at, p_created_by
  );

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type, actor_profile_id
  ) values (
    p_connection_id, 'invitation_created', 'admin', p_created_by
  );

  return p_connection_id;
end
$$;

revoke all on function public.create_audit_shopify_invitation(
  uuid, text, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.create_audit_shopify_invitation(
  uuid, text, text, timestamptz, uuid
) to service_role;

-- Complete the invite atomically after the application server has exchanged
-- credentials with Shopify and verified the canonical shop + granted scopes.
create or replace function public.complete_audit_shopify_connection(
  p_connection_id uuid,
  p_token_hash text,
  p_shopify_shop_id text,
  p_shopify_name text,
  p_shopify_domain text,
  p_primary_domain text,
  p_shopify_currency text,
  p_shopify_client_id text,
  p_credential_hint text,
  p_granted_scopes text[],
  p_client_secret_ciphertext text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.audit_shopify_connections%rowtype;
  required_scopes constant text[] := string_to_array(
    'read_all_orders,read_analytics,read_app_proxy,write_app_proxy,read_apps,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,read_audit_events,read_customer_events,read_cart_transforms,write_cart_transforms,read_all_cart_transforms,read_validations,write_validations,read_cash_tracking,write_cash_tracking,read_channels,write_channels,read_checkout_kit_enhanced_buyer_events,read_checkout_and_accounts_configurations,write_checkout_and_accounts_configurations,read_checkout_branding_settings,write_checkout_branding_settings,write_checkouts,read_checkouts,read_companies,write_companies,read_custom_fulfillment_services,write_custom_fulfillment_services,read_custom_pixels,write_custom_pixels,read_customers,write_customers,read_customer_data_erasure,write_customer_data_erasure,read_customer_payment_methods,read_customer_merge,write_customer_merge,read_delivery_customizations,write_delivery_customizations,read_price_rules,write_price_rules,read_discounts,write_discounts,read_discounts_allocator_functions,write_discounts_allocator_functions,read_discovery,write_discovery,write_draft_orders,read_draft_orders,read_files,write_files,read_fulfillment_constraint_rules,write_fulfillment_constraint_rules,read_fulfillments,write_fulfillments,read_gift_card_transactions,write_gift_card_transactions,read_gift_cards,write_gift_cards,write_inventory,read_inventory,write_inventory_shipments,read_inventory_shipments,write_inventory_shipments_received_items,read_inventory_shipments_received_items,write_inventory_transfers,read_inventory_transfers,read_legal_policies,write_legal_policies,read_delivery_option_generators,write_delivery_option_generators,read_locales,write_locales,write_locations,read_locations,read_marketing_integrated_campaigns,write_marketing_integrated_campaigns,write_marketing_events,read_marketing_events,read_markets,write_markets,read_markets_home,write_markets_home,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_online_store_navigation,write_online_store_navigation,read_online_store_pages,write_online_store_pages,write_order_edits,read_order_edits,read_orders,write_orders,write_packing_slip_templates,read_packing_slip_templates,write_payment_mandate,read_payment_mandate,read_payment_notifications,write_payment_notifications,read_payment_terms,write_payment_terms,read_payment_customizations,write_payment_customizations,read_privacy_settings,write_privacy_settings,read_product_feeds,write_product_feeds,read_product_listings,write_product_listings,read_products,write_products,read_publications,write_publications,read_purchase_options,write_purchase_options,write_reports,read_reports,read_resource_feedbacks,write_resource_feedbacks,read_returns,write_returns,read_script_tags,write_script_tags,read_shopify_payments_provider_accounts_sensitive,read_shipping,write_shipping,read_shopify_payments_accounts,read_shopify_payments_payouts,read_shopify_payments_bank_accounts,read_shopify_payments_disputes,write_shopify_payments_disputes,read_content,write_content,read_store_credit_account_transactions,write_store_credit_account_transactions,read_store_credit_accounts,write_own_subscription_contracts,read_own_subscription_contracts,write_theme_code,read_themes,write_themes,read_third_party_fulfillment_orders,write_third_party_fulfillment_orders,read_translations,write_translations,read_pixels,write_pixels',
    ','
  );
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can complete an audit connection.'
      using errcode = '42501';
  end if;

  select * into target
  from public.audit_shopify_connections
  where id = p_connection_id
  for update;

  if not found
    or target.status <> 'pending'
    or target.invite_token_hash is distinct from p_token_hash
  then
    raise exception 'Audit invitation is not available.' using errcode = 'P0002';
  end if;

  if target.invite_expires_at <= now() then
    raise exception 'Audit invitation expired.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = target.created_by and profile.role = 'admin'
  ) then
    raise exception 'The invitation owner is no longer an admin.'
      using errcode = '42501';
  end if;

  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or coalesce(p_shopify_currency, '') !~ '^[A-Z]{3}$'
    or length(btrim(coalesce(p_shopify_shop_id, ''))) = 0
    or length(btrim(coalesce(p_shopify_name, ''))) = 0
    or length(btrim(coalesce(p_shopify_client_id, ''))) = 0
    or length(btrim(coalesce(p_credential_hint, ''))) = 0
    or length(btrim(coalesce(p_client_secret_ciphertext, ''))) = 0
  then
    raise exception 'Verified Shopify metadata is incomplete.' using errcode = '22023';
  end if;

  if not required_scopes <@ coalesce(p_granted_scopes, '{}'::text[]) then
    raise exception 'Required audit scopes are missing.' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
    where scope is null or not (scope = any(required_scopes))
  ) then
    raise exception 'Unexpected scopes are not allowed for an audit connection.'
      using errcode = '22023';
  end if;

  insert into public.audit_shopify_credentials (
    connection_id, client_secret_ciphertext, updated_at
  ) values (
    target.id, p_client_secret_ciphertext, now()
  );

  update public.audit_shopify_connections
  set status = 'connected',
      invite_token_hash = null,
      invite_expires_at = null,
      shopify_shop_id = btrim(p_shopify_shop_id),
      shopify_name = btrim(p_shopify_name),
      shopify_domain = lower(btrim(p_shopify_domain)),
      primary_domain = nullif(lower(btrim(coalesce(p_primary_domain, ''))), ''),
      shopify_currency = upper(btrim(p_shopify_currency)),
      shopify_client_id = btrim(p_shopify_client_id),
      credential_hint = btrim(p_credential_hint),
      granted_scopes = (
        select coalesce(array_agg(distinct scope order by scope), '{}'::text[])
        from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
      ),
      connected_at = now(),
      last_verified_at = now(),
      reviewed_at = null,
      reviewed_by = null,
      last_error_code = null,
      updated_at = now()
  where id = target.id;

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type,
    details
  ) values (
    target.id, 'store_connected', 'invite',
    jsonb_build_object('shopify_domain', lower(btrim(p_shopify_domain)))
  );

  return target.id;
exception
  when unique_violation then
    raise exception 'This Shopify store already has an active audit connection.'
      using errcode = '23505';
end
$$;

revoke all on function public.complete_audit_shopify_connection(
  uuid, text, text, text, text, text, text, text, text, text[], text
) from public, anon, authenticated;
grant execute on function public.complete_audit_shopify_connection(
  uuid, text, text, text, text, text, text, text, text, text[], text
) to service_role;

-- Replace a lost/expired pending link without ever storing its raw bearer.
create or replace function public.rotate_audit_shopify_invitation(
  p_connection_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can rotate an audit invitation.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_admin_id and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now()
    or p_expires_at > now() + interval '8 days'
  then
    raise exception 'Invalid replacement invitation.' using errcode = '22023';
  end if;

  update public.audit_shopify_connections
  set invite_token_hash = p_token_hash,
      invite_expires_at = p_expires_at,
      failed_attempts = 0,
      last_attempt_at = null,
      last_error_code = null,
      updated_at = now()
  where id = p_connection_id and status = 'pending';

  if not found then
    raise exception 'Only a pending invitation can be replaced.' using errcode = 'P0002';
  end if;

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type, actor_profile_id
  ) values (
    p_connection_id, 'invitation_rotated', 'admin', p_admin_id
  );

  return p_connection_id;
end
$$;

revoke all on function public.rotate_audit_shopify_invitation(
  uuid, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.rotate_audit_shopify_invitation(
  uuid, text, timestamptz, uuid
) to service_role;

-- Record a merchant-side rejection only against the exact bearer that was
-- validated. The atomic predicate prevents a rotated, completed or revoked
-- invitation from inheriting a stale request's failure event. Ten failures
-- lock the bearer until an admin deliberately creates a replacement link.
create or replace function public.record_audit_shopify_invitation_failure(
  p_connection_id uuid,
  p_token_hash text,
  p_error_code text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  attempts integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can record an audit invitation failure.'
      using errcode = '42501';
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_error_code, '') !~ '^[a-z0-9_]{2,64}$'
  then
    raise exception 'Invalid audit failure metadata.' using errcode = '22023';
  end if;

  update public.audit_shopify_connections
  set failed_attempts = failed_attempts + 1,
      last_attempt_at = now(),
      last_error_code = p_error_code,
      updated_at = now()
  where id = p_connection_id
    and status = 'pending'
    and invite_token_hash = p_token_hash
    and invite_expires_at > now()
    and failed_attempts < 10
  returning failed_attempts into attempts;

  if not found then
    return null;
  end if;

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type, details
  ) values (
    p_connection_id, 'credentials_rejected', 'invite',
    jsonb_build_object('code', p_error_code, 'attempt', attempts)
  );

  return attempts;
end
$$;

revoke all on function public.record_audit_shopify_invitation_failure(
  uuid, text, text
) from public, anon, authenticated;
grant execute on function public.record_audit_shopify_invitation_failure(
  uuid, text, text
) to service_role;

-- Revocation is recoverable as history, but the credential is destroyed.
create or replace function public.revoke_audit_shopify_connection(
  p_connection_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.audit_shopify_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke an audit connection.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_admin_id and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;

  select * into target
  from public.audit_shopify_connections
  where id = p_connection_id
  for update;

  if not found or target.status = 'revoked' then
    raise exception 'Audit connection not found.' using errcode = 'P0002';
  end if;

  delete from public.audit_shopify_credentials
  where connection_id = target.id;

  update public.audit_shopify_connections
  set status = 'revoked',
      invite_token_hash = null,
      invite_expires_at = null,
      credential_hint = null,
      revoked_at = now(),
      reviewed_at = coalesce(reviewed_at, now()),
      reviewed_by = coalesce(reviewed_by, p_admin_id),
      updated_at = now()
  where id = target.id;

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type, actor_profile_id
  ) values (
    target.id,
    case when target.status = 'pending'
      then 'invitation_revoked'
      else 'connection_revoked'
    end,
    'admin',
    p_admin_id
  );

  return target.id;
end
$$;

revoke all on function public.revoke_audit_shopify_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_audit_shopify_connection(uuid, uuid)
  to service_role;

create or replace function public.review_audit_shopify_connection(
  p_connection_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can review an audit connection.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_admin_id and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;

  update public.audit_shopify_connections
  set reviewed_at = coalesce(reviewed_at, now()),
      reviewed_by = coalesce(reviewed_by, p_admin_id),
      updated_at = now()
  where id = p_connection_id and status = 'connected';

  if not found then
    raise exception 'Connected audit store not found.' using errcode = 'P0002';
  end if;

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type, actor_profile_id
  ) values (
    p_connection_id, 'connection_reviewed', 'admin', p_admin_id
  );

  return p_connection_id;
end
$$;

revoke all on function public.review_audit_shopify_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.review_audit_shopify_connection(uuid, uuid)
  to service_role;

-- Only the non-secret event stream is eligible for browser Realtime. The DO
-- block keeps local/PGlite-style environments safe when the publication is not
-- installed, and avoids duplicate-publication errors on repeat migrations.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'audit_shopify_connection_events'
  ) then
    alter publication supabase_realtime
      add table public.audit_shopify_connection_events;
  end if;
end
$$;
