-- =============================================================================
-- 0087 - COGS that arrive by themselves for a client supplied by HST.
--
-- 0009 built the cost chain around a merchant typing their own costs, and it
-- holds: costs attach to products with effective dates, so editing one today
-- never rewrites June. Nothing in it distinguishes a cost the client decided
-- from a cost a supplier reported, because until now there was only the first
-- kind.
--
-- A supplier feed changes that in two ways this migration answers.
--
-- First, provenance. Owner decision: HST wins and replaces. Without a source
-- column that instruction is unimplementable — a sync would overwrite the
-- client's own figure with no way to tell afterwards which was which, or to
-- ever hand the product back to them. With it, "replace" means "supersede the
-- HST cost", and a client's manual entry stays legible next to it.
--
-- Second, the tariff. HST bills an EU/US import tariff per ORDER, and this
-- schema has no order: the sync reads them from Shopify and lets them go. The
-- charge therefore needs a home of its own, keyed by the platform order id the
-- supplier already reports, so the recompute can add it to the day that order
-- belongs to.
-- =============================================================================

-- ---- which HST store a Dropscale store is -----------------------------------
-- The supplier's own id for the shop (the "AWU92655-STOCKH…" in its order
-- list), which is not the Shopify domain and not our account id.
alter table public.ad_accounts
  add column if not exists hst_shop_id text;

alter table public.ad_accounts
  drop constraint if exists ad_accounts_hst_shop_id_shape;
alter table public.ad_accounts
  add constraint ad_accounts_hst_shop_id_shape check (
    hst_shop_id is null or (
      hst_shop_id = btrim(hst_shop_id)
      and length(hst_shop_id) between 1 and 64
      and hst_shop_id !~ '[[:cntrl:]]'
    )
  );

create index if not exists ad_accounts_hst_shop_idx
  on public.ad_accounts (hst_shop_id)
  where hst_shop_id is not null;

-- ---- where a cost came from --------------------------------------------------
alter table public.product_costs
  add column if not exists source text not null default 'manual';

alter table public.product_costs
  drop constraint if exists product_costs_source_known;
alter table public.product_costs
  add constraint product_costs_source_known check (source in ('manual', 'hst'));

-- One HST figure per product per day. A sync that runs hourly must land on the
-- same row rather than stacking a new cost every hour, while the client's own
-- entries stay unconstrained — they may correct themselves as often as they
-- like, and each correction is its own dated fact.
create unique index if not exists product_costs_hst_daily_idx
  on public.product_costs (product_id, effective_from)
  where source = 'hst';

-- ---- the per-order import tariff --------------------------------------------
-- Kept apart from product costs on purpose: it is charged per order, not per
-- article, so folding it into a unit cost would make one article of a two-line
-- order carry the whole charge.
create table if not exists public.hst_order_charges (
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  -- The platform (Shopify) order id HST reports back to us, which is what the
  -- metrics sync sees on its own orders.
  platform_order_id text not null,
  order_day date not null,
  -- The instant the customer paid, kept next to the day derived from it.
  -- The supplier writes its whole ERP in UTC+8 and says so nowhere, and the
  -- day an order belongs to is a question about the STORE's timezone, which
  -- this sync learns from Shopify rather than owning. Keeping the instant
  -- means a store whose zone is corrected later can have its days recomputed
  -- from what was recorded, instead of re-fetching a year of orders.
  paid_at timestamptz,
  tariff numeric not null default 0 check (tariff >= 0),
  currency text not null default 'EUR',
  synced_at timestamptz not null default now(),
  primary key (ad_account_id, platform_order_id)
);

create index if not exists hst_order_charges_day_idx
  on public.hst_order_charges (ad_account_id, order_day);

alter table public.hst_order_charges enable row level security;

-- A client reads their own charges through the same ownership chain the rest
-- of the cost tables use; only the server writes them.
drop policy if exists hst_order_charges_select on public.hst_order_charges;
create policy hst_order_charges_select on public.hst_order_charges
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());
