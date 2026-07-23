-- =============================================================================
-- 0009 — real COGS + the profit chain.
--
-- The principle the whole schema serves: COGS never changes REVENUE — it
-- changes PROFIT and MARGIN. Costs attach to products with EFFECTIVE DATES,
-- so editing a cost today never rewrites June's profit.
--
-- Cost configuration belongs to the merchant: clients manage the costs,
-- tiers and collections of their OWN stores (owns_* chain), the team can do
-- it for them (is_admin). These are the client's inputs about their own
-- business — the "clients never delete" rule guards agency data, not this.
-- =============================================================================

-- ---- products (catalog + anything ever sold, discovered from line items) ----
create table if not exists public.store_products (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  -- Platform variant id when there is one, else product id. The stable key
  -- line items resolve against.
  platform_key text not null,
  title text not null,
  -- Latest known unit selling price, in the store's base currency.
  price numeric not null default 0,
  currency text not null default 'EUR',
  -- 'orders' = discovered from a sold line item; 'catalog' = product sync.
  source text not null default 'orders' check (source in ('orders', 'catalog')),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (ad_account_id, platform_key)
);

create index if not exists store_products_account_idx
  on public.store_products (ad_account_id);

-- ---- manual costs WITH effective dates --------------------------------------
create table if not exists public.product_costs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.store_products (id) on delete cascade,
  cost numeric not null check (cost >= 0),
  currency text not null default 'EUR',
  effective_from date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists product_costs_product_idx
  on public.product_costs (product_id, effective_from desc);

-- ---- per-product quantity tiers ---------------------------------------------
-- total_cost is the TOTAL for min_qty units, not per-unit.
create table if not exists public.product_cost_tiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.store_products (id) on delete cascade,
  min_qty integer not null check (min_qty >= 1),
  total_cost numeric not null check (total_cost >= 0),
  unique (product_id, min_qty)
);

-- ---- collections: members share tiers over their COMBINED order quantity ----
create table if not exists public.cogs_collections (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.cogs_collection_members (
  collection_id uuid not null references public.cogs_collections (id) on delete cascade,
  product_id uuid not null references public.store_products (id) on delete cascade,
  -- A product pools into at most one collection.
  primary key (product_id),
  unique (collection_id, product_id)
);

create table if not exists public.cogs_collection_tiers (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.cogs_collections (id) on delete cascade,
  min_qty integer not null check (min_qty >= 1),
  total_cost numeric not null check (total_cost >= 0),
  unique (collection_id, min_qty)
);

-- ---- per-store cost settings ------------------------------------------------
alter table public.ad_accounts
  add column if not exists default_product_cost_pct numeric not null default 30,
  add column if not exists payment_fee_pct numeric not null default 2.9,
  add column if not exists payment_fee_fixed numeric not null default 0.30,
  add column if not exists shipping_cost_per_order numeric not null default 0;

-- ---- the rollup gains the cost side of the chain ---------------------------
alter table public.daily_metrics
  add column if not exists product_cost numeric not null default 0,
  add column if not exists payment_fees numeric not null default 0,
  add column if not exists shipping_cost numeric not null default 0;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.store_products enable row level security;
alter table public.product_costs enable row level security;
alter table public.product_cost_tiers enable row level security;
alter table public.cogs_collections enable row level security;
alter table public.cogs_collection_members enable row level security;
alter table public.cogs_collection_tiers enable row level security;

-- Chain helpers, SECURITY DEFINER so the check is not blocked by RLS itself.
create or replace function public.owns_store_product(p_product_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.store_products p
    join public.ad_accounts a on a.id = p.ad_account_id
    where p.id = p_product_id
      and a.client_id = auth.uid()
  );
$$;

create or replace function public.owns_cogs_collection(p_collection_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.cogs_collections c
    join public.ad_accounts a on a.id = c.ad_account_id
    where c.id = p_collection_id
      and a.client_id = auth.uid()
  );
$$;

-- store_products: read own; writes come from the sync (rides the client's own
-- session) and from the Costs page.
drop policy if exists store_products_select_own on public.store_products;
create policy store_products_select_own on public.store_products
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists store_products_insert_own on public.store_products;
create policy store_products_insert_own on public.store_products
  for insert with check (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists store_products_update_own on public.store_products;
create policy store_products_update_own on public.store_products
  for update using (public.owns_ad_account(ad_account_id) or public.is_admin())
  with check (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists store_products_delete_own on public.store_products;
create policy store_products_delete_own on public.store_products
  for delete using (public.owns_ad_account(ad_account_id) or public.is_admin());

-- product_costs / tiers: full control over one's own products' cost config.
drop policy if exists product_costs_select_own on public.product_costs;
create policy product_costs_select_own on public.product_costs
  for select using (public.owns_store_product(product_id) or public.is_admin());

drop policy if exists product_costs_insert_own on public.product_costs;
create policy product_costs_insert_own on public.product_costs
  for insert with check (public.owns_store_product(product_id) or public.is_admin());

drop policy if exists product_costs_update_own on public.product_costs;
create policy product_costs_update_own on public.product_costs
  for update using (public.owns_store_product(product_id) or public.is_admin())
  with check (public.owns_store_product(product_id) or public.is_admin());

drop policy if exists product_costs_delete_own on public.product_costs;
create policy product_costs_delete_own on public.product_costs
  for delete using (public.owns_store_product(product_id) or public.is_admin());

drop policy if exists product_tiers_select_own on public.product_cost_tiers;
create policy product_tiers_select_own on public.product_cost_tiers
  for select using (public.owns_store_product(product_id) or public.is_admin());

drop policy if exists product_tiers_insert_own on public.product_cost_tiers;
create policy product_tiers_insert_own on public.product_cost_tiers
  for insert with check (public.owns_store_product(product_id) or public.is_admin());

drop policy if exists product_tiers_update_own on public.product_cost_tiers;
create policy product_tiers_update_own on public.product_cost_tiers
  for update using (public.owns_store_product(product_id) or public.is_admin())
  with check (public.owns_store_product(product_id) or public.is_admin());

drop policy if exists product_tiers_delete_own on public.product_cost_tiers;
create policy product_tiers_delete_own on public.product_cost_tiers
  for delete using (public.owns_store_product(product_id) or public.is_admin());

-- collections + members + their tiers
drop policy if exists cogs_collections_select_own on public.cogs_collections;
create policy cogs_collections_select_own on public.cogs_collections
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists cogs_collections_insert_own on public.cogs_collections;
create policy cogs_collections_insert_own on public.cogs_collections
  for insert with check (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists cogs_collections_update_own on public.cogs_collections;
create policy cogs_collections_update_own on public.cogs_collections
  for update using (public.owns_ad_account(ad_account_id) or public.is_admin())
  with check (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists cogs_collections_delete_own on public.cogs_collections;
create policy cogs_collections_delete_own on public.cogs_collections
  for delete using (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists cogs_members_select_own on public.cogs_collection_members;
create policy cogs_members_select_own on public.cogs_collection_members
  for select using (public.owns_cogs_collection(collection_id) or public.is_admin());

drop policy if exists cogs_members_insert_own on public.cogs_collection_members;
create policy cogs_members_insert_own on public.cogs_collection_members
  for insert with check (
    (public.owns_cogs_collection(collection_id) and public.owns_store_product(product_id))
    or public.is_admin()
  );

drop policy if exists cogs_members_delete_own on public.cogs_collection_members;
create policy cogs_members_delete_own on public.cogs_collection_members
  for delete using (public.owns_cogs_collection(collection_id) or public.is_admin());

drop policy if exists cogs_ctiers_select_own on public.cogs_collection_tiers;
create policy cogs_ctiers_select_own on public.cogs_collection_tiers
  for select using (public.owns_cogs_collection(collection_id) or public.is_admin());

drop policy if exists cogs_ctiers_insert_own on public.cogs_collection_tiers;
create policy cogs_ctiers_insert_own on public.cogs_collection_tiers
  for insert with check (public.owns_cogs_collection(collection_id) or public.is_admin());

drop policy if exists cogs_ctiers_update_own on public.cogs_collection_tiers;
create policy cogs_ctiers_update_own on public.cogs_collection_tiers
  for update using (public.owns_cogs_collection(collection_id) or public.is_admin())
  with check (public.owns_cogs_collection(collection_id) or public.is_admin());

drop policy if exists cogs_ctiers_delete_own on public.cogs_collection_tiers;
create policy cogs_ctiers_delete_own on public.cogs_collection_tiers
  for delete using (public.owns_cogs_collection(collection_id) or public.is_admin());
