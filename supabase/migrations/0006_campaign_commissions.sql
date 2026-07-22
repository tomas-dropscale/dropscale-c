-- =============================================================================
-- Dropscale IO — per-account agency commission rate
--
-- Campaigns are live Google Ads data (not persisted rows), so the agency
-- commission is COMPUTED — spend × rate — wherever it is displayed, rather
-- than written by a trigger that would have nothing to fire on. The rate
-- lives per ad_account so different clients can be on different deals.
-- =============================================================================

alter table public.ad_accounts
  -- Percentage of ad spend the agency bills, e.g. 10 = 10%.
  add column if not exists commission_rate numeric not null default 10
    check (commission_rate >= 0 and commission_rate <= 100);

-- RLS authorises rows, not columns: ad_accounts_update_own lets a client edit
-- their own row (breakeven ROAS, Shopify URL…), and without this they could
-- also quietly lower their own commission_rate. Same pattern as the status
-- guard in 0001 and the approval guard in 0002.
create or replace function public.guard_ad_account_commission()
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
  if new.commission_rate is distinct from old.commission_rate and not public.is_admin() then
    raise exception 'Only the team can change an account''s commission rate.';
  end if;
  return new;
end;
$$;

drop trigger if exists ad_accounts_guard_commission on public.ad_accounts;
create trigger ad_accounts_guard_commission
  before update on public.ad_accounts
  for each row execute function public.guard_ad_account_commission();
