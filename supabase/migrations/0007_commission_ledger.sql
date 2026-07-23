-- =============================================================================
-- Dropscale IO — automatic Google Ads commission ledger
--
-- The campaigns view computes commissions on the fly; this makes them REAL
-- finance rows. The app syncs one commissions row per connected ad account
-- per day (spend from Google × the account's commission_rate), so agency
-- revenue shows up in the finance pages with no manual entry.
--
-- ad_account_id is what separates a synced row from a hand-entered one, and
-- (ad_account_id, occurred_on) is the idempotency key: re-running a sync
-- updates the day, never duplicates it.
-- =============================================================================

alter table public.commissions
  add column if not exists ad_account_id uuid
    references public.ad_accounts (id) on delete set null;

-- Partial: manual entries (null ad_account_id) stay unconstrained. The app
-- checks-then-inserts; this index is the backstop against two admins syncing
-- the same day at the same moment.
create unique index if not exists commissions_ad_account_day_uq
  on public.commissions (ad_account_id, occurred_on)
  where ad_account_id is not null;

create index if not exists commissions_ad_account_id_idx
  on public.commissions (ad_account_id);

-- The revenue source every synced row hangs off. Idempotent seed.
insert into public.revenue_sources (name, category, default_rate, recurring, active, notes)
select
  'Google Ads Management',
  'platform',
  10,
  true,
  true,
  'Auto-created: daily commissions synced from connected Google Ads accounts.'
where not exists (
  select 1 from public.revenue_sources where name = 'Google Ads Management'
);
