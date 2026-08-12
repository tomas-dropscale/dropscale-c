-- =============================================================================
-- 0044 - Purpose-bound client onboarding and reporting connections.
--
-- This is a parallel V2 surface. It deliberately does not write ad_accounts,
-- billing evidence or Stripe state. Existing clients remain operational on the
-- legacy surface until an admin explicitly reviews and activates one session.
-- Shopify credentials belong to Dropscale reporting; Windsor is Google Ads only.
-- Raw invitation and Windsor access tokens never live in public metadata.
-- =============================================================================

create table public.client_onboarding_sessions (
  id uuid primary key,
  mode text not null check (mode in ('new_client', 'add_assets', 'reconnect')),
  requested_assets text[] not null,
  status text not null default 'pending'
    check (status in ('pending', 'collecting', 'submitted', 'reviewed', 'active', 'revoked')),
  invite_token_hash text,
  invite_expires_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 10),
  last_attempt_at timestamptz,
  target_client_id uuid references public.portal_clients(id) on delete restrict,
  claimed_user_id uuid references auth.users(id) on delete restrict,
  first_name text,
  last_name text,
  email text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  identity_created_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  activated_at timestamptz,
  revoked_at timestamptz,
  last_error_code text,

  constraint client_onboarding_requested_assets_shape check (
    cardinality(requested_assets) between 0 and 2
    and requested_assets <@ array['shopify', 'google_ads']::text[]
    and (
      (cardinality(requested_assets) = 0 and mode = 'new_client')
      or cardinality(requested_assets) = 1
      or (
        cardinality(requested_assets) = 2
        and requested_assets @> array['shopify', 'google_ads']::text[]
      )
    )
  ),
  constraint client_onboarding_invite_hash_shape check (
    invite_token_hash is null or invite_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint client_onboarding_mode_target_shape check (
    (mode = 'new_client' and target_client_id is null)
    or (mode in ('add_assets', 'reconnect') and target_client_id is not null)
  ),
  constraint client_onboarding_name_shape check (
    (first_name is null or length(btrim(first_name)) between 1 and 80)
    and (last_name is null or length(btrim(last_name)) between 1 and 80)
  ),
  constraint client_onboarding_email_shape check (
    email is null or (
      length(email) between 3 and 320
      and email = lower(btrim(email))
      and position('@' in email) > 1
    )
  ),
  constraint client_onboarding_state_shape check (
    (
      status in ('pending', 'collecting')
      and invite_token_hash is not null
      and invite_expires_at is not null
      and revoked_at is null
    )
    or (
      status in ('submitted', 'reviewed', 'active')
      and invite_token_hash is null
      and invite_expires_at is null
      and claimed_user_id is not null
      and submitted_at is not null
      and revoked_at is null
    )
    or (
      status = 'revoked'
      and invite_token_hash is null
      and invite_expires_at is null
      and revoked_at is not null
    )
  ),
  constraint client_onboarding_review_shape check (
    (status not in ('reviewed', 'active') and reviewed_at is null and reviewed_by is null)
    or (status in ('reviewed', 'active') and reviewed_at is not null and reviewed_by is not null)
  ),
  constraint client_onboarding_activation_shape check (
    (status <> 'active' and activated_at is null)
    or (status = 'active' and activated_at is not null)
  )
);

comment on table public.client_onboarding_sessions is
  'V2 client-led onboarding sessions. Parallel to legacy clients/ad_accounts; never starts billing.';
comment on column public.client_onboarding_sessions.invite_token_hash is
  'SHA-256 digest of the fragment bearer. The raw invitation is returned once and never stored.';

create unique index client_onboarding_invite_hash_idx
  on public.client_onboarding_sessions(invite_token_hash)
  where invite_token_hash is not null;
create index client_onboarding_status_created_idx
  on public.client_onboarding_sessions(status, created_at desc);
create index client_onboarding_target_idx
  on public.client_onboarding_sessions(target_client_id, created_at desc)
  where target_client_id is not null;
create unique index client_onboarding_one_open_target_idx
  on public.client_onboarding_sessions(target_client_id)
  where target_client_id is not null
    and status in ('pending', 'collecting');
create unique index client_onboarding_one_open_new_identity_idx
  on public.client_onboarding_sessions(lower(email))
  where mode = 'new_client'
    and email is not null
    and status in ('collecting', 'submitted', 'reviewed', 'active');

-- Service-role-only secret material. The same AES-GCM key rotation path used
-- by the existing third-party integrations protects both columns.
create table public.client_onboarding_secrets (
  session_id uuid primary key
    references public.client_onboarding_sessions(id) on delete cascade,
  windsor_access_token_ciphertext text,
  updated_at timestamptz not null default now(),
  constraint client_onboarding_windsor_secret_shape check (
    windsor_access_token_ciphertext is null
    or length(btrim(windsor_access_token_ciphertext)) > 0
  )
);

create table public.client_shopify_connections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.client_onboarding_sessions(id) on delete restrict,
  client_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'connected' check (status in ('connected', 'revoked')),
  shopify_shop_id text not null,
  shopify_name text not null,
  shopify_domain text not null,
  primary_domain text,
  shopify_currency text not null,
  credential_hint text,
  granted_scopes text[] not null default '{}',
  scope_profile text not null default 'client-reporting-read-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  revoked_at timestamptz,
  last_error_code text,
  constraint client_shopify_domain_shape check (
    shopify_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
  ),
  constraint client_shopify_currency_shape check (shopify_currency ~ '^[A-Z]{3}$'),
  constraint client_shopify_scope_profile_shape check (
    scope_profile = 'client-reporting-read-v1'
  ),
  constraint client_shopify_status_shape check (
    (status = 'connected' and revoked_at is null and credential_hint is not null)
    or (status = 'revoked' and revoked_at is not null and credential_hint is null)
  )
);

create unique index client_shopify_active_domain_idx
  on public.client_shopify_connections(lower(shopify_domain))
  where status = 'connected';
create unique index client_shopify_active_shop_id_idx
  on public.client_shopify_connections(shopify_shop_id)
  where status = 'connected';
create index client_shopify_client_created_idx
  on public.client_shopify_connections(client_id, created_at desc);
create index client_shopify_session_idx
  on public.client_shopify_connections(session_id, created_at);

create table public.client_shopify_credentials (
  connection_id uuid primary key
    references public.client_shopify_connections(id) on delete cascade,
  shopify_client_id text not null,
  client_secret_ciphertext text not null,
  updated_at timestamptz not null default now(),
  constraint client_shopify_client_id_not_empty check (
    length(btrim(shopify_client_id)) > 0
  ),
  constraint client_shopify_secret_not_empty check (
    length(btrim(client_secret_ciphertext)) > 0
  )
);

create table public.client_google_ads_connections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.client_onboarding_sessions(id) on delete restrict,
  client_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'connected' check (status in ('connected', 'revoked')),
  windsor_account_id text not null,
  account_name text not null,
  currency text,
  time_zone text,
  data_source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  revoked_at timestamptz,
  last_error_code text,
  constraint client_google_account_id_not_empty check (
    length(btrim(windsor_account_id)) between 1 and 160
  ),
  constraint client_google_account_name_not_empty check (
    length(btrim(account_name)) between 1 and 240
  ),
  constraint client_google_currency_shape check (
    currency is null or currency ~ '^[A-Z]{3}$'
  ),
  constraint client_google_status_shape check (
    (status = 'connected' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index client_google_active_account_idx
  on public.client_google_ads_connections(windsor_account_id)
  where status = 'connected';
create index client_google_session_idx
  on public.client_google_ads_connections(session_id, created_at);

create table public.client_asset_mappings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.client_onboarding_sessions(id) on delete restrict,
  shopify_connection_id uuid not null
    references public.client_shopify_connections(id) on delete restrict,
  google_ads_connection_id uuid not null
    references public.client_google_ads_connections(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint client_asset_mappings_google_unique unique (google_ads_connection_id)
);

create table public.client_rollout_states (
  client_id uuid primary key references public.portal_clients(id) on delete restrict,
  operational_surface text not null default 'legacy_only' check (
    operational_surface in (
      'legacy_only', 'v2_onboarding', 'v2_ready_for_cutover',
      'v2_active', 'rollback_legacy'
    )
  ),
  onboarding_session_id uuid
    references public.client_onboarding_sessions(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

create table public.client_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.client_onboarding_sessions(id) on delete cascade,
  event_type text not null check (event_type in (
    'invitation_created', 'invitation_rotated', 'identity_claimed',
    'shopify_connected', 'google_connected', 'assets_mapped',
    'submitted', 'reviewed', 'activated', 'invitation_revoked',
    'connections_revoked', 'verification_succeeded', 'verification_failed'
  )),
  actor_type text not null check (actor_type in ('admin', 'invite', 'client', 'system')),
  actor_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint client_onboarding_event_details_object check (jsonb_typeof(details) = 'object'),
  constraint client_onboarding_event_no_secret_keys check (
    not (details ?| array[
      'token', 'token_hash', 'invite_token', 'invite_token_hash',
      'client_secret', 'access_token', 'ciphertext', 'password', 'api_key'
    ])
  )
);

create index client_onboarding_events_session_created_idx
  on public.client_onboarding_events(session_id, created_at desc);

-- V2-active workspaces must not fall back to the legacy client-writable asset
-- tables through a handcrafted Supabase request. Admin/service operations
-- remain available for migration and support.
create or replace function public.legacy_asset_writes_allowed(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select not exists (
    select 1
    from public.client_rollout_states
    where client_id = p_client_id
      and operational_surface = 'v2_active'
  )
$$;

revoke all on function public.legacy_asset_writes_allowed(uuid)
  from public, anon, authenticated;
grant execute on function public.legacy_asset_writes_allowed(uuid)
  to authenticated, service_role;

alter table public.client_onboarding_sessions enable row level security;
alter table public.client_onboarding_secrets enable row level security;
alter table public.client_shopify_connections enable row level security;
alter table public.client_shopify_credentials enable row level security;
alter table public.client_google_ads_connections enable row level security;
alter table public.client_asset_mappings enable row level security;
alter table public.client_rollout_states enable row level security;
alter table public.client_onboarding_events enable row level security;

revoke all on table public.client_onboarding_sessions from public, anon, authenticated;
revoke all on table public.client_onboarding_secrets from public, anon, authenticated;
revoke all on table public.client_shopify_connections from public, anon, authenticated;
revoke all on table public.client_shopify_credentials from public, anon, authenticated;
revoke all on table public.client_google_ads_connections from public, anon, authenticated;
revoke all on table public.client_asset_mappings from public, anon, authenticated;
revoke all on table public.client_rollout_states from public, anon, authenticated;
revoke all on table public.client_onboarding_events from public, anon, authenticated;

grant select, insert, update, delete on table public.client_onboarding_sessions to service_role;
grant select, insert, update, delete on table public.client_onboarding_secrets to service_role;
grant select, insert, update, delete on table public.client_shopify_connections to service_role;
grant select, insert, update, delete on table public.client_shopify_credentials to service_role;
grant select, insert, update, delete on table public.client_google_ads_connections to service_role;
grant select, insert, update, delete on table public.client_asset_mappings to service_role;
grant select, insert, update, delete on table public.client_rollout_states to service_role;
grant select, insert, update, delete on table public.client_onboarding_events to service_role;

drop policy if exists ad_accounts_insert_own on public.ad_accounts;
create policy ad_accounts_insert_own on public.ad_accounts
  for insert with check (
    public.is_admin()
    or (
      public.can_open_workspace(client_id)
      and public.legacy_asset_writes_allowed(client_id)
    )
  );

drop policy if exists ad_accounts_update_own on public.ad_accounts;
create policy ad_accounts_update_own on public.ad_accounts
  for update using (
    public.is_admin()
    or (
      public.is_client_member(client_id)
      and public.legacy_asset_writes_allowed(client_id)
    )
  ) with check (
    public.is_admin()
    or (
      public.is_client_member(client_id)
      and public.legacy_asset_writes_allowed(client_id)
    )
  );

drop policy if exists requests_insert_own on public.account_requests;
create policy requests_insert_own on public.account_requests
  for insert with check (
    public.is_admin()
    or (
      public.can_open_workspace(client_id)
      and status = 'pending'
      and public.legacy_asset_writes_allowed(client_id)
    )
  );

-- The functions below provide the atomic lifecycle boundaries. Every caller is
-- server-side and must authenticate the admin, invitation or client first.
create or replace function public.create_client_onboarding_invitation(
  p_session_id uuid,
  p_mode text,
  p_requested_assets text[],
  p_target_client_id uuid,
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
    raise exception 'Only the server can create an onboarding invitation.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_created_by and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_session_id is null
    or p_mode not in ('new_client', 'add_assets', 'reconnect')
    or p_requested_assets is null
    or cardinality(p_requested_assets) not between 0 and 2
    or not p_requested_assets <@ array['shopify', 'google_ads']::text[]
    or (cardinality(p_requested_assets) = 0 and p_mode <> 'new_client')
    or (
      cardinality(p_requested_assets) = 2
      and not p_requested_assets @> array['shopify', 'google_ads']::text[]
    )
    or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now()
    or p_expires_at > now() + interval '8 days'
    or (p_mode = 'new_client' and p_target_client_id is not null)
    or (p_mode in ('add_assets', 'reconnect') and p_target_client_id is null)
  then
    raise exception 'Invalid client onboarding invitation.' using errcode = '22023';
  end if;
  if p_target_client_id is not null and not exists (
    select 1 from public.portal_clients where id = p_target_client_id
  ) then
    raise exception 'Target client not found.' using errcode = 'P0002';
  end if;

  insert into public.client_onboarding_sessions (
    id, mode, requested_assets, target_client_id, invite_token_hash,
    invite_expires_at, created_by
  ) values (
    p_session_id, p_mode,
    coalesce(
      (select array_agg(asset order by asset) from unnest(p_requested_assets) asset),
      '{}'::text[]
    ),
    p_target_client_id, p_token_hash, p_expires_at, p_created_by
  );

  if p_target_client_id is not null then
    insert into public.client_rollout_states (
      client_id, operational_surface, onboarding_session_id, updated_by
    ) values (
      p_target_client_id, 'v2_onboarding', p_session_id, p_created_by
    ) on conflict (client_id) do update
      set operational_surface = case
            when client_rollout_states.operational_surface = 'v2_active'
              then 'v2_active'
            else 'v2_onboarding'
          end,
          onboarding_session_id = excluded.onboarding_session_id,
          updated_by = excluded.updated_by,
          updated_at = now();
  end if;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id,
    details
  ) values (
    p_session_id, 'invitation_created', 'admin', p_created_by,
    jsonb_build_object('mode', p_mode, 'requested_assets', p_requested_assets)
  );
  return p_session_id;
end
$$;

revoke all on function public.create_client_onboarding_invitation(
  uuid, text, text[], uuid, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.create_client_onboarding_invitation(
  uuid, text, text[], uuid, text, timestamptz, uuid
) to service_role;

create or replace function public.rotate_client_onboarding_invitation(
  p_session_id uuid,
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
    raise exception 'Only the server can rotate an onboarding invitation.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now()
    or p_expires_at > now() + interval '8 days'
  then
    raise exception 'Invalid replacement invitation.' using errcode = '22023';
  end if;
  update public.client_onboarding_sessions
  set invite_token_hash = p_token_hash,
      invite_expires_at = p_expires_at,
      failed_attempts = 0,
      last_attempt_at = null,
      last_error_code = null,
      updated_at = now()
  where id = p_session_id and status in ('pending', 'collecting');
  if not found then
    raise exception 'Only an open onboarding invitation can be replaced.' using errcode = 'P0002';
  end if;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (p_session_id, 'invitation_rotated', 'admin', p_admin_id);
  return p_session_id;
end
$$;

revoke all on function public.rotate_client_onboarding_invitation(uuid, text, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.rotate_client_onboarding_invitation(uuid, text, timestamptz, uuid)
  to service_role;

create or replace function public.claim_client_onboarding_identity(
  p_session_id uuid,
  p_token_hash text,
  p_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  normal_email text := lower(btrim(coalesce(p_email, '')));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can claim an onboarding identity.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status not in ('pending', 'collecting')
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
    or target.failed_attempts >= 10
  then
    raise exception 'Onboarding invitation is not available.' using errcode = 'P0002';
  end if;
  if p_user_id is null or not exists (
    select 1 from auth.users
    where id = p_user_id and lower(email) = normal_email
  ) then
    raise exception 'Identity not found.' using errcode = 'P0002';
  end if;
  if target.mode = 'new_client' and exists (
    select 1 from public.portal_clients where id = p_user_id
  ) then
    raise exception 'This identity already belongs to a portal client.' using errcode = '23505';
  end if;
  if target.target_client_id is not null and target.target_client_id <> p_user_id then
    raise exception 'This invitation belongs to another client.' using errcode = '42501';
  end if;
  if target.claimed_user_id is not null and target.claimed_user_id <> p_user_id then
    raise exception 'This invitation has already been claimed.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_first_name, ''))) not between 1 and 80
    or length(btrim(coalesce(p_last_name, ''))) not between 1 and 80
    or length(normal_email) not between 3 and 320
    or position('@' in normal_email) <= 1
  then
    raise exception 'Invalid client identity.' using errcode = '22023';
  end if;

  update public.client_onboarding_sessions
  set claimed_user_id = p_user_id,
      first_name = btrim(p_first_name),
      last_name = btrim(p_last_name),
      email = normal_email,
      status = 'collecting',
      identity_created_at = coalesce(identity_created_at, now()),
      updated_at = now(),
      last_error_code = null
  where id = target.id;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (target.id, 'identity_claimed', 'client', p_user_id);
  return target.id;
end
$$;

revoke all on function public.claim_client_onboarding_identity(
  uuid, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.claim_client_onboarding_identity(
  uuid, text, uuid, text, text, text
) to service_role;

create or replace function public.store_client_windsor_authorization(
  p_session_id uuid,
  p_token_hash text,
  p_ciphertext text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save a Windsor authorization.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or not ('google_ads' = any(target.requested_assets))
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
  then
    raise exception 'Google Ads onboarding is not available.' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_ciphertext, ''))) = 0 then
    raise exception 'Invalid Windsor authorization ciphertext.' using errcode = '22023';
  end if;

  insert into public.client_onboarding_secrets (
    session_id, windsor_access_token_ciphertext, updated_at
  ) values (
    target.id, p_ciphertext, now()
  ) on conflict (session_id) do update
    set windsor_access_token_ciphertext = excluded.windsor_access_token_ciphertext,
        updated_at = now();
  return target.id;
end
$$;

revoke all on function public.store_client_windsor_authorization(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.store_client_windsor_authorization(uuid, text, text)
  to service_role;

create or replace function public.complete_client_shopify_connection(
  p_connection_id uuid,
  p_session_id uuid,
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
  target public.client_onboarding_sessions%rowtype;
  result_id uuid;
  existing_client_id uuid;
  existing_session_id uuid;
  reused boolean := false;
  required_scopes constant text[] := array[
    'read_all_orders', 'read_analytics', 'read_inventory', 'read_locations',
    'read_orders', 'read_products', 'read_reports', 'read_returns',
    'read_shopify_payments_accounts', 'read_shopify_payments_payouts'
  ]::text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save a Shopify reporting connection.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
    or not ('shopify' = any(target.requested_assets))
  then
    raise exception 'Shopify onboarding is not available.' using errcode = 'P0002';
  end if;
  if coalesce(p_shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or coalesce(p_shopify_currency, '') !~ '^[A-Z]{3}$'
    or length(btrim(coalesce(p_shopify_shop_id, ''))) = 0
    or length(btrim(coalesce(p_shopify_name, ''))) = 0
    or length(btrim(coalesce(p_shopify_client_id, ''))) = 0
    or length(btrim(coalesce(p_credential_hint, ''))) = 0
    or length(btrim(coalesce(p_client_secret_ciphertext, ''))) = 0
    or not required_scopes <@ coalesce(p_granted_scopes, '{}'::text[])
    or exists (
      select 1 from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
      where not (scope = any(required_scopes))
    )
    or exists (
      select 1 from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
      where scope like 'write\_%' escape '\'
    )
  then
    raise exception 'Verified Shopify reporting metadata is incomplete.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_granted_scopes, '{}'::text[])) scope
    where scope is null or scope <> lower(btrim(scope)) or scope !~ '^[a-z0-9_]+$'
  ) then
    raise exception 'Invalid Shopify scope metadata.' using errcode = '22023';
  end if;

  select id, client_id, session_id
  into result_id, existing_client_id, existing_session_id
  from public.client_shopify_connections
  where status = 'connected'
    and (
      shopify_shop_id = btrim(p_shopify_shop_id)
      or lower(shopify_domain) = lower(btrim(p_shopify_domain))
    )
  order by case when shopify_shop_id = btrim(p_shopify_shop_id) then 0 else 1 end
  limit 1
  for update;

  if result_id is not null and existing_client_id <> target.claimed_user_id then
    raise exception 'This Shopify store belongs to another client.' using errcode = '23505';
  end if;
  if result_id is not null and existing_session_id <> target.id then
    raise exception 'This Shopify store is already connected in another onboarding session.'
      using errcode = '23505';
  end if;

  if result_id is null then
    result_id := p_connection_id;
    begin
      insert into public.client_shopify_connections (
        id, session_id, client_id, shopify_shop_id, shopify_name,
        shopify_domain, primary_domain, shopify_currency, credential_hint,
        granted_scopes, last_verified_at
      ) values (
        result_id, target.id, target.claimed_user_id,
        btrim(p_shopify_shop_id), btrim(p_shopify_name), lower(btrim(p_shopify_domain)),
        nullif(lower(btrim(coalesce(p_primary_domain, ''))), ''),
        upper(btrim(p_shopify_currency)), btrim(p_credential_hint),
        (select array_agg(distinct scope order by scope) from unnest(p_granted_scopes) scope),
        now()
      );
    exception
      when unique_violation then
        raise exception 'This Shopify store already has an active reporting connection.'
          using errcode = '23505';
    end;
  else
    reused := true;
    update public.client_shopify_connections
    set shopify_shop_id = btrim(p_shopify_shop_id),
        shopify_name = btrim(p_shopify_name),
        shopify_domain = lower(btrim(p_shopify_domain)),
        primary_domain = nullif(lower(btrim(coalesce(p_primary_domain, ''))), ''),
        shopify_currency = upper(btrim(p_shopify_currency)),
        credential_hint = btrim(p_credential_hint),
        granted_scopes = (
          select array_agg(distinct scope order by scope) from unnest(p_granted_scopes) scope
        ),
        last_verified_at = now(),
        last_error_code = null,
        updated_at = now()
    where id = result_id;
  end if;
  insert into public.client_shopify_credentials (
    connection_id, shopify_client_id, client_secret_ciphertext
  ) values (
    result_id, btrim(p_shopify_client_id), p_client_secret_ciphertext
  ) on conflict (connection_id) do update
    set shopify_client_id = excluded.shopify_client_id,
        client_secret_ciphertext = excluded.client_secret_ciphertext,
        updated_at = now();
  update public.client_onboarding_sessions set updated_at = now() where id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id,
    details
  ) values (
    target.id, 'shopify_connected', 'invite', target.claimed_user_id,
    jsonb_build_object(
      'connection_id', result_id,
      'shopify_domain', lower(btrim(p_shopify_domain)),
      'reused', reused
    )
  );
  return result_id;
end
$$;

revoke all on function public.complete_client_shopify_connection(
  uuid, uuid, text, text, text, text, text, text, text, text, text[], text
) from public, anon, authenticated;
grant execute on function public.complete_client_shopify_connection(
  uuid, uuid, text, text, text, text, text, text, text, text, text[], text
) to service_role;

create or replace function public.record_client_shopify_health(
  p_connection_id uuid,
  p_admin_id uuid,
  p_ok boolean,
  p_tested_at timestamptz,
  p_error_code text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_shopify_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can record Shopify health.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_tested_at is null
    or p_tested_at > now() + interval '5 minutes'
    or p_tested_at < now() - interval '1 hour'
    or (
      not p_ok
      and coalesce(p_error_code, '') !~ '^[a-z0-9_]{2,64}$'
    )
  then
    raise exception 'Invalid Shopify health metadata.' using errcode = '22023';
  end if;
  select * into target from public.client_shopify_connections
  where id = p_connection_id and status = 'connected' for update;
  if not found then
    raise exception 'Connected Shopify asset not found.' using errcode = 'P0002';
  end if;
  update public.client_shopify_connections
  set last_verified_at = case when p_ok then p_tested_at else last_verified_at end,
      last_error_code = case when p_ok then null else p_error_code end,
      updated_at = now()
  where id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.session_id,
    case when p_ok then 'verification_succeeded' else 'verification_failed' end,
    'admin', p_admin_id,
    jsonb_build_object('asset_type', 'shopify', 'connection_id', target.id)
  );
  return target.id;
end
$$;

revoke all on function public.record_client_shopify_health(
  uuid, uuid, boolean, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.record_client_shopify_health(
  uuid, uuid, boolean, timestamptz, text
) to service_role;

create or replace function public.revoke_client_shopify_connection(
  p_connection_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_shopify_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke a Shopify asset.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_shopify_connections
  where id = p_connection_id and status = 'connected' for update;
  if not found then
    raise exception 'Connected Shopify asset not found.' using errcode = 'P0002';
  end if;
  delete from public.client_shopify_credentials where connection_id = target.id;
  delete from public.client_asset_mappings where shopify_connection_id = target.id;
  update public.client_shopify_connections
  set status = 'revoked', credential_hint = null, revoked_at = now(), updated_at = now()
  where id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.session_id, 'connections_revoked', 'admin', p_admin_id,
    jsonb_build_object('asset_type', 'shopify', 'connection_id', target.id)
  );
  return target.id;
end
$$;

revoke all on function public.revoke_client_shopify_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_client_shopify_connection(uuid, uuid)
  to service_role;

create or replace function public.upsert_client_google_ads_connection(
  p_session_id uuid,
  p_token_hash text,
  p_windsor_account_id text,
  p_account_name text,
  p_currency text,
  p_time_zone text,
  p_data_source_id text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  result_id uuid;
  existing_client_id uuid;
  existing_session_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save a Google Ads connection.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
    or not ('google_ads' = any(target.requested_assets))
  then
    raise exception 'Google Ads onboarding is not available.' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_windsor_account_id, ''))) not between 1 and 160
    or length(btrim(coalesce(p_account_name, ''))) not between 1 and 240
    or (p_currency is not null and upper(btrim(p_currency)) !~ '^[A-Z]{3}$')
  then
    raise exception 'Invalid Google Ads account metadata.' using errcode = '22023';
  end if;

  select id, client_id, session_id
  into result_id, existing_client_id, existing_session_id
  from public.client_google_ads_connections
  where windsor_account_id = btrim(p_windsor_account_id)
    and status = 'connected'
  for update;

  if result_id is not null and existing_client_id <> target.claimed_user_id then
    raise exception 'This Google Ads account belongs to another client.' using errcode = '23505';
  end if;
  if result_id is not null and existing_session_id <> target.id then
    raise exception 'This Google Ads account is already connected in another onboarding session.'
      using errcode = '23505';
  end if;

  if result_id is null then
    insert into public.client_google_ads_connections (
      session_id, client_id, windsor_account_id, account_name,
      currency, time_zone, data_source_id, last_verified_at
    ) values (
      target.id, target.claimed_user_id, btrim(p_windsor_account_id),
      btrim(p_account_name), nullif(upper(btrim(coalesce(p_currency, ''))), ''),
      nullif(btrim(coalesce(p_time_zone, '')), ''),
      nullif(btrim(coalesce(p_data_source_id, '')), ''), now()
    ) returning id into result_id;
    insert into public.client_onboarding_events (
      session_id, event_type, actor_type, actor_id,
      details
    ) values (
      target.id, 'google_connected', 'invite', target.claimed_user_id,
      jsonb_build_object('connection_id', result_id)
    );
  else
    update public.client_google_ads_connections
    set account_name = btrim(p_account_name),
        currency = nullif(upper(btrim(coalesce(p_currency, ''))), ''),
        time_zone = nullif(btrim(coalesce(p_time_zone, '')), ''),
        data_source_id = nullif(btrim(coalesce(p_data_source_id, '')), ''),
        last_verified_at = now(),
        updated_at = now(),
        last_error_code = null
    where id = result_id;
  end if;
  update public.client_onboarding_sessions set updated_at = now() where id = target.id;
  return result_id;
end
$$;

revoke all on function public.upsert_client_google_ads_connection(
  uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.upsert_client_google_ads_connection(
  uuid, text, text, text, text, text, text
) to service_role;

create or replace function public.upsert_client_google_ads_connections(
  p_session_id uuid,
  p_token_hash text,
  p_accounts jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  account jsonb;
  account_id text;
  seen_account_ids text[] := '{}'::text[];
  result_ids uuid[] := '{}'::uuid[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save Google Ads connections.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
    or not ('google_ads' = any(target.requested_assets))
  then
    raise exception 'Google Ads onboarding is not available.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_accounts) <> 'array'
    or jsonb_array_length(p_accounts) not between 1 and 100
  then
    raise exception 'Invalid Google Ads account batch.' using errcode = '22023';
  end if;

  -- Validate the entire selection before the first write. Every object uses a
  -- closed, stable contract so an upstream Windsor response cannot smuggle
  -- unexpected metadata into persistence.
  for account in select value from jsonb_array_elements(p_accounts)
  loop
    if jsonb_typeof(account) <> 'object'
      or not account ?& array[
        'windsorAccountId', 'accountName', 'currency', 'timeZone', 'dataSourceId'
      ]::text[]
      or exists (
        select 1 from jsonb_object_keys(account) key
        where key not in (
          'windsorAccountId', 'accountName', 'currency', 'timeZone', 'dataSourceId'
        )
      )
      or jsonb_typeof(account -> 'windsorAccountId') <> 'string'
      or jsonb_typeof(account -> 'accountName') <> 'string'
      or (
        account -> 'currency' <> 'null'::jsonb
        and jsonb_typeof(account -> 'currency') <> 'string'
      )
      or (
        account -> 'timeZone' <> 'null'::jsonb
        and jsonb_typeof(account -> 'timeZone') <> 'string'
      )
      or (
        account -> 'dataSourceId' <> 'null'::jsonb
        and jsonb_typeof(account -> 'dataSourceId') <> 'string'
      )
      or length(btrim(coalesce(account ->> 'windsorAccountId', ''))) not between 1 and 160
      or length(btrim(coalesce(account ->> 'accountName', ''))) not between 1 and 240
      or (
        account ->> 'currency' is not null
        and upper(btrim(account ->> 'currency')) !~ '^[A-Z]{3}$'
      )
    then
      raise exception 'Invalid Google Ads account metadata.' using errcode = '22023';
    end if;

    account_id := btrim(account ->> 'windsorAccountId');
    if account_id = any(seen_account_ids) then
      raise exception 'Duplicate Google Ads account in batch.' using errcode = '22023';
    end if;
    seen_account_ids := array_append(seen_account_ids, account_id);
  end loop;

  -- Lock and reject every active ownership/session conflict before inserting
  -- anything. A later uniqueness race also aborts the enclosing RPC transaction.
  perform id
  from public.client_google_ads_connections
  where windsor_account_id = any(seen_account_ids)
    and status = 'connected'
    and (client_id <> target.claimed_user_id or session_id <> target.id)
  for update;
  if found then
    raise exception 'A Google Ads account is already active in another onboarding.'
      using errcode = '23505';
  end if;

  for account in select value from jsonb_array_elements(p_accounts)
  loop
    result_ids := array_append(
      result_ids,
      public.upsert_client_google_ads_connection(
        target.id,
        p_token_hash,
        account ->> 'windsorAccountId',
        account ->> 'accountName',
        account ->> 'currency',
        account ->> 'timeZone',
        account ->> 'dataSourceId'
      )
    );
  end loop;
  return result_ids;
end
$$;

revoke all on function public.upsert_client_google_ads_connections(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_client_google_ads_connections(uuid, text, jsonb)
  to service_role;

create or replace function public.record_client_google_ads_health(
  p_connection_id uuid,
  p_admin_id uuid,
  p_ok boolean,
  p_tested_at timestamptz,
  p_error_code text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_google_ads_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can record Google Ads health.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_tested_at is null
    or p_tested_at > now() + interval '5 minutes'
    or p_tested_at < now() - interval '1 hour'
    or (not p_ok and coalesce(p_error_code, '') !~ '^[a-z0-9_]{2,64}$')
  then
    raise exception 'Invalid Google Ads health metadata.' using errcode = '22023';
  end if;
  select * into target from public.client_google_ads_connections
  where id = p_connection_id and status = 'connected' for update;
  if not found then
    raise exception 'Connected Google Ads asset not found.' using errcode = 'P0002';
  end if;
  update public.client_google_ads_connections
  set last_verified_at = case when p_ok then p_tested_at else last_verified_at end,
      last_error_code = case when p_ok then null else p_error_code end,
      updated_at = now()
  where id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.session_id,
    case when p_ok then 'verification_succeeded' else 'verification_failed' end,
    'admin', p_admin_id,
    jsonb_build_object('asset_type', 'google_ads', 'connection_id', target.id)
  );
  return target.id;
end
$$;

revoke all on function public.record_client_google_ads_health(
  uuid, uuid, boolean, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.record_client_google_ads_health(
  uuid, uuid, boolean, timestamptz, text
) to service_role;

create or replace function public.revoke_client_google_ads_connection(
  p_connection_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_google_ads_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke a Google Ads asset.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_google_ads_connections
  where id = p_connection_id and status = 'connected' for update;
  if not found then
    raise exception 'Connected Google Ads asset not found.' using errcode = 'P0002';
  end if;
  delete from public.client_asset_mappings where google_ads_connection_id = target.id;
  update public.client_google_ads_connections
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.session_id, 'connections_revoked', 'admin', p_admin_id,
    jsonb_build_object('asset_type', 'google_ads', 'connection_id', target.id)
  );
  return target.id;
end
$$;

revoke all on function public.revoke_client_google_ads_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_client_google_ads_connection(uuid, uuid)
  to service_role;

create or replace function public.replace_client_asset_mappings(
  p_session_id uuid,
  p_token_hash text,
  p_mappings jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  mapping jsonb;
  shop_id uuid;
  google_id uuid;
  shop_session_id uuid;
  google_session_id uuid;
  submitted_google_ids uuid[] := '{}'::uuid[];
  inserted_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save asset mappings.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
  then
    raise exception 'Asset mapping is not available.' using errcode = 'P0002';
  end if;
  if p_mappings is null
    or jsonb_typeof(p_mappings) is distinct from 'array'
    or jsonb_array_length(p_mappings) > 100
  then
    raise exception 'Invalid asset mappings.' using errcode = '22023';
  end if;

  -- Validate the full replacement before the first mutation. Each Google Ads
  -- account has one optional Shopify match, and an older asset may only be
  -- changed when the other side of that pair was added by this invitation.
  for mapping in select value from jsonb_array_elements(p_mappings)
  loop
    if jsonb_typeof(mapping) <> 'object'
      or not mapping ?& array['shopifyConnectionId', 'googleAdsConnectionId']::text[]
      or exists (
        select 1 from jsonb_object_keys(mapping) key
        where key not in ('shopifyConnectionId', 'googleAdsConnectionId')
      )
      or jsonb_typeof(mapping -> 'shopifyConnectionId') is distinct from 'string'
      or jsonb_typeof(mapping -> 'googleAdsConnectionId') is distinct from 'string'
    then
      raise exception 'Invalid asset mapping.' using errcode = '22023';
    end if;
    begin
      shop_id := (mapping ->> 'shopifyConnectionId')::uuid;
      google_id := (mapping ->> 'googleAdsConnectionId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invalid asset mapping.' using errcode = '22023';
    end;

    if google_id = any(submitted_google_ids) then
      raise exception 'Duplicate Google Ads account in asset mappings.' using errcode = '22023';
    end if;

    select session_id into shop_session_id
    from public.client_shopify_connections
    where id = shop_id
      and client_id = target.claimed_user_id
      and status = 'connected';
    if not found then
      raise exception 'Asset mapping does not belong to this onboarding.' using errcode = '42501';
    end if;

    select session_id into google_session_id
    from public.client_google_ads_connections
    where id = google_id
      and client_id = target.claimed_user_id
      and status = 'connected';
    if not found then
      raise exception 'Asset mapping does not belong to this onboarding.' using errcode = '42501';
    end if;

    if shop_session_id <> target.id and google_session_id <> target.id then
      raise exception 'At least one mapped asset must belong to this onboarding.'
        using errcode = '42501';
    end if;
    submitted_google_ids := array_append(submitted_google_ids, google_id);
  end loop;

  -- An empty payload intentionally clears matches involving assets from this
  -- session. Submitted older Google IDs are also removed first so selecting a
  -- newly connected Shopify store performs a real one-to-one remap.
  delete from public.client_asset_mappings existing_mapping
  where existing_mapping.google_ads_connection_id = any(submitted_google_ids)
    or exists (
      select 1 from public.client_shopify_connections shopify_connection
      where shopify_connection.id = existing_mapping.shopify_connection_id
        and shopify_connection.session_id = target.id
    )
    or exists (
      select 1 from public.client_google_ads_connections google_connection
      where google_connection.id = existing_mapping.google_ads_connection_id
        and google_connection.session_id = target.id
    );

  for mapping in select value from jsonb_array_elements(p_mappings)
  loop
    shop_id := (mapping ->> 'shopifyConnectionId')::uuid;
    google_id := (mapping ->> 'googleAdsConnectionId')::uuid;
    insert into public.client_asset_mappings (
      session_id, shopify_connection_id, google_ads_connection_id
    ) values (target.id, shop_id, google_id);
    inserted_count := inserted_count + 1;
  end loop;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    target.id, 'assets_mapped', 'client', target.claimed_user_id,
    jsonb_build_object('mapping_count', inserted_count)
  );
  return inserted_count;
end
$$;

revoke all on function public.replace_client_asset_mappings(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_client_asset_mappings(uuid, text, jsonb)
  to service_role;

create or replace function public.submit_client_onboarding_session(
  p_session_id uuid,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can submit an onboarding session.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
  then
    raise exception 'Onboarding session is not available.' using errcode = 'P0002';
  end if;
  if 'shopify' = any(target.requested_assets) and not exists (
    select 1 from public.client_shopify_connections
    where session_id = target.id and status = 'connected'
  ) then
    raise exception 'At least one Shopify store is required.' using errcode = '23514';
  end if;
  if 'google_ads' = any(target.requested_assets) and not exists (
    select 1 from public.client_google_ads_connections
    where session_id = target.id and status = 'connected'
  ) then
    raise exception 'At least one Google Ads account is required.' using errcode = '23514';
  end if;
  update public.client_onboarding_sessions
  set status = 'submitted',
      invite_token_hash = null,
      invite_expires_at = null,
      submitted_at = now(),
      updated_at = now(),
      last_error_code = null
  where id = target.id;
  delete from public.client_onboarding_secrets where session_id = target.id;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (target.id, 'submitted', 'client', target.claimed_user_id);
  if exists (select 1 from public.portal_clients where id = target.claimed_user_id) then
    insert into public.client_rollout_states (
      client_id, operational_surface, onboarding_session_id, updated_by
    ) values (
      target.claimed_user_id, 'v2_ready_for_cutover', target.id, target.created_by
    ) on conflict (client_id) do update
      set operational_surface = case
            when client_rollout_states.operational_surface = 'v2_active'
              then 'v2_active'
            else 'v2_ready_for_cutover'
          end,
          onboarding_session_id = excluded.onboarding_session_id,
          updated_at = now();
  end if;
  return target.id;
end
$$;

revoke all on function public.submit_client_onboarding_session(uuid, text)
  from public, anon, authenticated;
grant execute on function public.submit_client_onboarding_session(uuid, text)
  to service_role;

create or replace function public.review_client_onboarding_session(
  p_session_id uuid,
  p_admin_id uuid,
  p_activate boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can review onboarding.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found or target.status not in ('submitted', 'reviewed') or target.claimed_user_id is null then
    raise exception 'Submitted onboarding session not found.' using errcode = 'P0002';
  end if;
  if p_activate and not exists (
    select 1 from auth.users
    where id = target.claimed_user_id
      and email_confirmed_at is not null
      and lower(email) = target.email
  ) then
    raise exception 'The client must confirm their email before activation.' using errcode = '23514';
  end if;
  if p_activate and cardinality(target.requested_assets) > 0 then
    raise exception 'V2 reporting activation is not available until the portal adapter is enabled.'
      using errcode = '23514';
  end if;

  update public.client_onboarding_sessions
  set status = case when p_activate then 'active' else 'reviewed' end,
      reviewed_at = coalesce(reviewed_at, now()),
      reviewed_by = coalesce(reviewed_by, p_admin_id),
      activated_at = case when p_activate then coalesce(activated_at, now()) else null end,
      updated_at = now()
  where id = target.id;

  if p_activate then
    insert into public.portal_clients (
      id, full_name, email, approval_status, approved_at, approved_by
    ) values (
      target.claimed_user_id,
      btrim(target.first_name || ' ' || target.last_name),
      target.email,
      'approved',
      now(),
      p_admin_id
    ) on conflict (id) do update
      set approval_status = 'approved',
          approved_at = coalesce(portal_clients.approved_at, now()),
          approved_by = coalesce(portal_clients.approved_by, p_admin_id);
    insert into public.client_rollout_states (
      client_id, operational_surface, onboarding_session_id, updated_by
    ) values (
      target.claimed_user_id, 'v2_active', target.id, p_admin_id
    ) on conflict (client_id) do update
      set operational_surface = 'v2_active',
          onboarding_session_id = excluded.onboarding_session_id,
          updated_by = excluded.updated_by,
          updated_at = now();
  end if;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (
    target.id, case when p_activate then 'activated' else 'reviewed' end,
    'admin', p_admin_id
  );
  return target.id;
end
$$;

revoke all on function public.review_client_onboarding_session(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.review_client_onboarding_session(uuid, uuid, boolean)
  to service_role;

create or replace function public.revoke_client_onboarding_session(
  p_session_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  was_connected boolean;
  rollout_was_v2_active boolean := false;
  surviving_session_id uuid;
  surviving_session_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke onboarding.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found or target.status not in ('pending', 'collecting') then
    raise exception 'Only an open onboarding session can be revoked.' using errcode = 'P0002';
  end if;
  if target.target_client_id is not null then
    select operational_surface = 'v2_active'
    into rollout_was_v2_active
    from public.client_rollout_states
    where client_id = target.target_client_id
    for update;
    rollout_was_v2_active := coalesce(rollout_was_v2_active, false);
  end if;
  was_connected := exists (
    select 1 from public.client_shopify_connections
    where session_id = target.id and status = 'connected'
  ) or exists (
    select 1 from public.client_google_ads_connections
    where session_id = target.id and status = 'connected'
  );

  delete from public.client_shopify_credentials
  where connection_id in (
    select id from public.client_shopify_connections where session_id = target.id
  );
  delete from public.client_onboarding_secrets where session_id = target.id;
  update public.client_shopify_connections
  set status = 'revoked', credential_hint = null, revoked_at = now(), updated_at = now()
  where session_id = target.id and status = 'connected';
  update public.client_google_ads_connections
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where session_id = target.id and status = 'connected';
  update public.client_onboarding_sessions
  set status = 'revoked', invite_token_hash = null, invite_expires_at = null,
      revoked_at = now(), updated_at = now()
  where id = target.id;

  if target.target_client_id is not null then
    select session.id, session.status
    into surviving_session_id, surviving_session_status
    from public.client_onboarding_sessions session
    where session.status <> 'revoked'
      and (
        session.target_client_id = target.target_client_id
        or session.claimed_user_id = target.target_client_id
      )
    order by session.created_at desc, session.id desc
    limit 1;

    update public.client_rollout_states
    set operational_surface = case
          when rollout_was_v2_active then 'v2_active'
          when surviving_session_status = 'active' then 'v2_active'
          when surviving_session_status in ('submitted', 'reviewed')
            then 'v2_ready_for_cutover'
          when surviving_session_status in ('pending', 'collecting')
            then 'v2_onboarding'
          else 'legacy_only'
        end,
        onboarding_session_id = surviving_session_id,
        updated_by = p_admin_id,
        updated_at = now()
    where client_id = target.target_client_id;
  end if;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (
    target.id,
    case when was_connected then 'connections_revoked' else 'invitation_revoked' end,
    'admin', p_admin_id
  );
  return target.id;
end
$$;

revoke all on function public.revoke_client_onboarding_session(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_client_onboarding_session(uuid, uuid)
  to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'client_onboarding_events'
    )
  then
    alter publication supabase_realtime add table public.client_onboarding_events;
  end if;
end
$$;
