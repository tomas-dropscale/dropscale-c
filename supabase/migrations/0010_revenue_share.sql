-- =============================================================================
-- 0010 — agency revenue share (collection-based), a second billing lever.
--
-- Each account already bills `commission_rate`% of AD SPEND (0006/0007). This
-- adds an OPTIONAL revenue share, computed NOT from a per-account rate but from
-- the GOOGLE ADS CAMPAIGN NAMES: a campaign named
--     "... https://shop/collections/<handle> 5%"
-- means "bill 5% of the revenue attributable to the <handle> collection".
-- Attribution (which orders/lines belong to the advertised collection or landed
-- on its URL) is computed in the sync and rolled into daily_metrics.
--
-- A per-account toggle just switches the whole thing on for a client; the rate
-- lives in the campaign name, so there is no per-account rate column. Like the
-- commission rate, the toggle is the AGENCY's to set — the 0006 guard covers it.
-- =============================================================================

alter table public.ad_accounts
  -- Off by default: revenue share is opt-in per client.
  add column if not exists revenue_share_enabled boolean not null default false;

-- The rollup gains the revenue-share numbers, already in reporting currency:
--   base   = revenue the rate was applied to (for display / margins)
--   amount = the € the agency bills that day (Σ over collections of base×rate)
alter table public.daily_metrics
  add column if not exists revenue_share_base numeric not null default 0,
  add column if not exists revenue_share_amount numeric not null default 0;

-- Extend the 0006 guard so a client can't switch their own revenue share on/off.
create or replace function public.guard_ad_account_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if not public.is_admin() and (
    new.commission_rate is distinct from old.commission_rate
    or new.revenue_share_enabled is distinct from old.revenue_share_enabled
  ) then
    raise exception 'Only the team can change an account''s billing settings.';
  end if;
  return new;
end;
$$;

-- ---- commissions can now carry TWO synced rows per account/day -------------
-- (ad-spend management + revenue share), so the idempotency key gains the
-- source. Drop the 0007 index and re-create it per (account, source, day).
drop index if exists public.commissions_ad_account_day_uq;
create unique index if not exists commissions_ad_account_source_day_uq
  on public.commissions (ad_account_id, source_id, occurred_on)
  where ad_account_id is not null;

-- The revenue source rev-share rows hang off. Idempotent seed.
insert into public.revenue_sources (name, category, default_rate, recurring, active, notes)
select
  'Revenue Share',
  'platform',
  0,
  true,
  true,
  'Auto-created: daily revenue-share billed on advertised collections.'
where not exists (
  select 1 from public.revenue_sources where name = 'Revenue Share'
);
