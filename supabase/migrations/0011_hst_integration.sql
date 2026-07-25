-- =============================================================================
-- 0011 — HST supplier-commission integration.
--
-- HST is the agency's supplier/partner. Their ERP exposes the salesman
-- commission at /commission-salesman-mingxi behind a bearer token that the
-- operator pastes (the token is short-lived; a human logs in past the captcha
-- and refreshes it). We store ONLY the ciphertext, and book the commission
-- into the existing finance ledger as a "HST" revenue source, so it shows up
-- everywhere the admin already reads commissions/revenue_sources.
-- =============================================================================

-- Single-row config table (id can only ever be true), admin-only.
create table if not exists public.hst_integration (
  id boolean primary key default true check (id),
  -- AES-GCM ciphertext of the HST access token (same key as the other secrets).
  access_token text,
  last_synced_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Refresh token + access-token expiry, so the sync renews itself (vue-pure-admin
-- issues both at login). Added via alter so this is safe to re-run over an
-- earlier version of the table.
alter table public.hst_integration
  add column if not exists refresh_token text,
  add column if not exists token_expires_at timestamptz;

alter table public.hst_integration enable row level security;

drop policy if exists hst_integration_admin_all on public.hst_integration;
create policy hst_integration_admin_all on public.hst_integration
  for all using (public.is_admin()) with check (public.is_admin());

-- The revenue source HST commission rows hang off. Idempotent seed.
insert into public.revenue_sources (name, category, default_rate, recurring, active, notes)
select
  'HST',
  'supplier',
  0,
  true,
  true,
  'Auto-created: salesman commission synced from the HST ERP.'
where not exists (
  select 1 from public.revenue_sources where name = 'HST'
);
