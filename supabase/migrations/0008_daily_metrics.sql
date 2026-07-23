-- =============================================================================
-- 0008 — daily_metrics: the pre-aggregated read model for every client-facing
-- dashboard, plus the Shopify connection columns that feed its revenue side.
--
-- Why a table instead of live queries: the restructured client dashboard
-- (RevFlow-style overview + per-store Google section) reads ONLY from here.
-- Pages never aggregate over live Google Ads / Shopify calls — recompute
-- writes days, pages read days. One slow upstream call happens in the sync
-- path, never while a page renders.
--
-- Write model (matches the commission-ledger pattern — no cron, no service
-- key): recomputeDailyMetrics() runs server-side on page opens, rides the
-- viewer's OWN session, and self-throttles per account. RLS therefore allows
-- clients to write rows for THEIR OWN accounts. A client tampering with these
-- rows via the API can only distort their own dashboard: the agency's books
-- (commissions ledger) sync straight from Google and never read this table.
-- =============================================================================

-- ---- Shopify connection secrets on the account ------------------------------
-- shopify_admin_token is AES-GCM ciphertext (same key as the Google Ads
-- tokens). It must NEVER be selected into an account payload — portal selects
-- list columns explicitly (ACCOUNT_COLUMNS in lib/portal/data.ts) and omit it;
-- the UI shows only shopify_token_last4 (e.g. "shp•••••1234").
alter table public.ad_accounts
  add column if not exists shopify_admin_token text,
  add column if not exists shopify_token_last4 text,
  add column if not exists shopify_connected_at timestamptz;

-- ---- daily_metrics -----------------------------------------------------------
create table if not exists public.daily_metrics (
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  day date not null,

  -- Google Ads side
  ad_spend numeric not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,

  -- Shopify side
  revenue numeric not null default 0,
  orders_count integer not null default 0,
  refunds_amount numeric not null default 0,

  computed_at timestamptz not null default now(),

  primary key (ad_account_id, day)
);

create index if not exists daily_metrics_day_idx on public.daily_metrics (day);

alter table public.daily_metrics enable row level security;

-- Clients read and (via the lazy recompute riding their session) write the
-- rows of their own accounts. The team sees and fixes everything.
drop policy if exists daily_metrics_select_own on public.daily_metrics;
create policy daily_metrics_select_own on public.daily_metrics
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists daily_metrics_insert_own on public.daily_metrics;
create policy daily_metrics_insert_own on public.daily_metrics
  for insert with check (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists daily_metrics_update_own on public.daily_metrics;
create policy daily_metrics_update_own on public.daily_metrics
  for update using (public.owns_ad_account(ad_account_id) or public.is_admin())
  with check (public.owns_ad_account(ad_account_id) or public.is_admin());

drop policy if exists daily_metrics_admin_delete on public.daily_metrics;
create policy daily_metrics_admin_delete on public.daily_metrics
  for delete using (public.is_admin());
