-- =============================================================================
-- Dropscale IO — Client Portal schema
--
-- Runs on the SAME Supabase project as the admin (dropscale-da). It depends on
-- public.is_admin() from the admin's migration 0001, so apply the admin
-- migrations first.
--
-- Security model
--   * Clients are auth.users rows that ALSO have a row in public.clients.
--     The team creates them (admin app / dashboard invite); there is no
--     self-signup in the portal.
--   * A client can only see rows chained to their own client_id — directly
--     (billing_profiles, ad_accounts, account_requests) or through
--     ad_accounts (campaigns, creative_deliveries).
--   * Clients can NEVER delete anything. Deletes are team-only.
--   * The team (public.is_admin()) can do everything on every table.
--   * The admin's handle_new_user trigger will also give each client a
--     profiles row with role 'member'. That is harmless: the admin app gates
--     on role = 'admin', the portal gates on having a clients row.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- clients — who may use the portal. id doubles as the auth.users id.
-- -----------------------------------------------------------------------------
create table if not exists public.clients (
  id uuid references auth.users (id) on delete cascade primary key,
  full_name text not null,
  email text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- billing_profiles — 1:1 with clients.
-- -----------------------------------------------------------------------------
create table if not exists public.billing_profiles (
  client_id uuid references public.clients (id) on delete cascade primary key,
  profile_type text not null default 'individual'
    check (profile_type in ('company', 'individual')),
  currency text not null default 'EUR',
  available_budget numeric,
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- ad_accounts — one per store / Google Ads account.
-- -----------------------------------------------------------------------------
create table if not exists public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  store_name text not null,
  google_ads_customer_id text,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'pending')),
  currency text not null default 'EUR',
  breakeven_roas numeric,
  lifetime_ads_budget_usd numeric,
  shopify_url text,
  shopify_connected boolean not null default false,
  shopify_client_id text,
  shopify_scopes text,
  color_dot text not null default '#d4a86a',
  created_at timestamptz not null default now()
);

create index if not exists ad_accounts_client_id_idx on public.ad_accounts (client_id);

-- -----------------------------------------------------------------------------
-- account_requests — "Request Account" panel submissions.
-- -----------------------------------------------------------------------------
create table if not exists public.account_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  request_type text not null check (request_type in ('google_ads', 'shopify')),
  google_ads_customer_id text,
  store_name text,
  shopify_collaborator_code text,
  myshopify_url text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists account_requests_client_id_idx
  on public.account_requests (client_id);

-- -----------------------------------------------------------------------------
-- campaigns — written by the team / future Google Ads sync. Clients read only.
-- -----------------------------------------------------------------------------
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'ended')),
  spend numeric not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  ctr numeric not null default 0,
  cpc numeric not null default 0,
  daily_budget numeric,
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_ad_account_id_idx
  on public.campaigns (ad_account_id);

-- -----------------------------------------------------------------------------
-- creative_deliveries — creatives handed over to the client. Clients read only.
-- -----------------------------------------------------------------------------
create table if not exists public.creative_deliveries (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  file_count integer not null default 0,
  size_mb numeric not null default 0,
  thumbnail_urls text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists creative_deliveries_ad_account_id_idx
  on public.creative_deliveries (ad_account_id);

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.clients enable row level security;
alter table public.billing_profiles enable row level security;
alter table public.ad_accounts enable row level security;
alter table public.account_requests enable row level security;
alter table public.campaigns enable row level security;
alter table public.creative_deliveries enable row level security;

-- Does the ad account belong to the caller? Used by the chained tables.
-- SECURITY DEFINER so the check itself is not blocked by ad_accounts' RLS.
create or replace function public.owns_ad_account(p_ad_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.ad_accounts a
    where a.id = p_ad_account_id
      and a.client_id = auth.uid()
  );
$$;

-- ---- clients ----------------------------------------------------------------
-- Read own row; the team reads all. Nobody self-inserts: rows are created by
-- the team (service role / SQL / admin app), both of which bypass or pass RLS.
drop policy if exists clients_select_self on public.clients;
create policy clients_select_self on public.clients
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists clients_update_self on public.clients;
create policy clients_update_self on public.clients
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists clients_admin_insert on public.clients;
create policy clients_admin_insert on public.clients
  for insert with check (public.is_admin());

drop policy if exists clients_admin_delete on public.clients;
create policy clients_admin_delete on public.clients
  for delete using (public.is_admin());

-- ---- billing_profiles ---------------------------------------------------------
drop policy if exists billing_select_own on public.billing_profiles;
create policy billing_select_own on public.billing_profiles
  for select using (client_id = auth.uid() or public.is_admin());

drop policy if exists billing_insert_own on public.billing_profiles;
create policy billing_insert_own on public.billing_profiles
  for insert with check (client_id = auth.uid() or public.is_admin());

drop policy if exists billing_update_own on public.billing_profiles;
create policy billing_update_own on public.billing_profiles
  for update using (client_id = auth.uid() or public.is_admin())
  with check (client_id = auth.uid() or public.is_admin());

drop policy if exists billing_admin_delete on public.billing_profiles;
create policy billing_admin_delete on public.billing_profiles
  for delete using (public.is_admin());

-- ---- ad_accounts --------------------------------------------------------------
drop policy if exists ad_accounts_select_own on public.ad_accounts;
create policy ad_accounts_select_own on public.ad_accounts
  for select using (client_id = auth.uid() or public.is_admin());

drop policy if exists ad_accounts_insert_own on public.ad_accounts;
create policy ad_accounts_insert_own on public.ad_accounts
  for insert with check (client_id = auth.uid() or public.is_admin());

-- Clients may edit their own account settings (breakeven ROAS, Shopify URL…)
-- but NOT flip status back to 'active' — that column is team-controlled via
-- the guard trigger below.
drop policy if exists ad_accounts_update_own on public.ad_accounts;
create policy ad_accounts_update_own on public.ad_accounts
  for update using (client_id = auth.uid() or public.is_admin())
  with check (client_id = auth.uid() or public.is_admin());

drop policy if exists ad_accounts_admin_delete on public.ad_accounts;
create policy ad_accounts_admin_delete on public.ad_accounts
  for delete using (public.is_admin());

-- RLS authorises rows, not columns: without this trigger a suspended client
-- could `update ad_accounts set status = 'active'` on their own row.
create or replace function public.guard_ad_account_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Trusted contexts (SQL editor, migrations, service role) have no uid.
  if auth.uid() is null then
    return new;
  end if;
  if new.status is distinct from old.status and not public.is_admin() then
    raise exception 'Only the team can change an ad account''s status.';
  end if;
  if new.client_id is distinct from old.client_id and not public.is_admin() then
    raise exception 'Only the team can reassign an ad account.';
  end if;
  return new;
end;
$$;

drop trigger if exists ad_accounts_guard_status on public.ad_accounts;
create trigger ad_accounts_guard_status
  before update on public.ad_accounts
  for each row execute function public.guard_ad_account_status();

-- ---- account_requests ---------------------------------------------------------
drop policy if exists requests_select_own on public.account_requests;
create policy requests_select_own on public.account_requests
  for select using (client_id = auth.uid() or public.is_admin());

-- Clients may open requests, but only 'pending' ones for themselves.
drop policy if exists requests_insert_own on public.account_requests;
create policy requests_insert_own on public.account_requests
  for insert with check (
    (client_id = auth.uid() and status = 'pending') or public.is_admin()
  );

-- Approving/rejecting is team-only.
drop policy if exists requests_admin_update on public.account_requests;
create policy requests_admin_update on public.account_requests
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists requests_admin_delete on public.account_requests;
create policy requests_admin_delete on public.account_requests
  for delete using (public.is_admin());

-- ---- campaigns (client: read-only, chained through ad_accounts) ---------------
drop policy if exists campaigns_select_own on public.campaigns;
create policy campaigns_select_own on public.campaigns
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists campaigns_admin_write on public.campaigns;
create policy campaigns_admin_write on public.campaigns
  for insert with check (public.is_admin());

drop policy if exists campaigns_admin_update on public.campaigns;
create policy campaigns_admin_update on public.campaigns
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists campaigns_admin_delete on public.campaigns;
create policy campaigns_admin_delete on public.campaigns
  for delete using (public.is_admin());

-- ---- creative_deliveries (client: read-only) ----------------------------------
drop policy if exists deliveries_select_own on public.creative_deliveries;
create policy deliveries_select_own on public.creative_deliveries
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists deliveries_admin_write on public.creative_deliveries;
create policy deliveries_admin_write on public.creative_deliveries
  for insert with check (public.is_admin());

drop policy if exists deliveries_admin_update on public.creative_deliveries;
create policy deliveries_admin_update on public.creative_deliveries
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists deliveries_admin_delete on public.creative_deliveries;
create policy deliveries_admin_delete on public.creative_deliveries
  for delete using (public.is_admin());
