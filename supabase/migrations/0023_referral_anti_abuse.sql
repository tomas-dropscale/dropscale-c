-- =============================================================================
-- 0023 — a referral only counts while it is real.
--
-- Two ways the affiliate discount could be farmed, closed here:
--
--   1. SELF-REFERRAL THROUGH A SÓCIO. Sign up a second account, use your own
--      code, then add that account as a partner of your workspace (0015) — one
--      person, two logins, permanent discount. A referral where the two people
--      share a workspace, in EITHER direction, stops counting.
--
--   2. DORMANT REFERRALS. Bring in an account that never advertises, and the
--      discount lasts forever for nothing. A referral counts only while that
--      client has spent on ads in the last 7 days.
--
-- Both are folded into active_referral_count(), which is still the single
-- place that decides — so every rate, everywhere, follows automatically.
--
-- THE TIME PROBLEM
--   Rule 2 is the first thing here that changes with NOTHING being written.
--   commission_rate is a stored column refreshed by trigger, and no trigger
--   fires because seven quiet days passed. Left alone, a client who stopped
--   advertising would keep earning their referrer a discount indefinitely.
--   refresh_all_referral_rates() below is the sweep, called from the hourly
--   cron. Rule 1 needs no sweep: joining a workspace is itself a write.
-- =============================================================================

-- Days without ad spend after which a referral stops counting.
create or replace function public.referral_activity_days()
returns integer language sql immutable as $$ select 7 $$;

/**
 * Referrals that are currently earning their referrer a discount.
 *
 * Approved, at arm's length, and advertising. The joins are all on indexed
 * columns and this runs on every ad_accounts write, so it stays a count.
 */
create or replace function public.active_referral_count(p_client_id uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int
  from public.portal_clients c
  where c.referred_by = p_client_id
    and c.approval_status = 'approved'
    -- (1) Not the same household. Either direction: it does not matter who
    -- invited whom into whose workspace, the two are not independent.
    and not exists (
      select 1
      from public.client_members m
      where (m.client_id = p_client_id and m.member_id = c.id)
         or (m.client_id = c.id and m.member_id = p_client_id)
    )
    -- (2) Actually advertising. Spend, not campaign rows: a paused campaign
    -- still exists in Google, and "has campaigns" would keep paying out on an
    -- account that stopped months ago.
    and exists (
      select 1
      from public.daily_metrics dm
      join public.ad_accounts a on a.id = dm.ad_account_id
      where a.client_id = c.id
        and dm.day >= (current_date - public.referral_activity_days())
        and dm.ad_spend > 0
    );
$$;

-- -----------------------------------------------------------------------------
-- The sweep
-- -----------------------------------------------------------------------------

/**
 * Re-derive every account whose billed rate no longer matches the rule.
 *
 * Only touches rows that actually change, so the hourly cron writes nothing on
 * a quiet hour — and every write it does make is a real re-pricing worth having
 * in the row's history.
 */
create or replace function public.refresh_all_referral_rates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  with stale as (
    select a.id
    from public.ad_accounts a
    where a.commission_rate is distinct from
      public.effective_commission_rate(a.client_id, a.list_commission_rate)
  ),
  touched as (
    -- The BEFORE trigger from 0022 recomputes commission_rate from this.
    update public.ad_accounts a
    set list_commission_rate = a.list_commission_rate
    from stale
    where a.id = stale.id
    returning 1
  )
  select count(*)::int into v_changed from touched;

  return v_changed;
end;
$$;

-- -----------------------------------------------------------------------------
-- Joining or leaving a workspace re-prices the pair
--
-- Rule 1 turns on and off with membership, and membership is a write — so this
-- is a trigger, not part of the sweep. Both sides are refreshed because either
-- of them may be the referrer.
-- -----------------------------------------------------------------------------
create or replace function public.on_client_membership_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  v_row := coalesce(new, old);
  perform public.refresh_referrer_rates(v_row.client_id);
  perform public.refresh_referrer_rates(v_row.member_id);
  return null;
end;
$$;

drop trigger if exists client_members_referral_rates on public.client_members;
create trigger client_members_referral_rates
  after insert or delete on public.client_members
  for each row execute function public.on_client_membership_changed();

-- -----------------------------------------------------------------------------
-- What the client is shown
--
-- The referrer cannot read the referred client's stores or metrics — RLS is
-- right to refuse that — but they do need to know WHY a name they brought in is
-- not earning them anything. A listed referral with no explanation reads as a
-- broken discount and becomes a support message.
--
-- So: one definer function that answers with a STATUS per referral and nothing
-- else. No spend, no store, no dates. Callable only about a workspace you can
-- already open, so it cannot be used to enumerate somebody else's referrals.
--
--   counting  earning the discount right now
--   pending   signed up, waiting on the team's approval
--   partner   shares a workspace with the referrer — rule 1
--   inactive  no ad spend in the last 7 days — rule 2
-- -----------------------------------------------------------------------------
create or replace function public.referral_summary(p_client_id uuid)
returns table (name text, status text)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not (public.is_client_member(p_client_id) or public.is_admin()) then
    return;
  end if;

  return query
  select
    c.full_name,
    case
      when c.approval_status <> 'approved' then 'pending'
      when exists (
        select 1
        from public.client_members m
        where (m.client_id = p_client_id and m.member_id = c.id)
           or (m.client_id = c.id and m.member_id = p_client_id)
      ) then 'partner'
      when not exists (
        select 1
        from public.daily_metrics dm
        join public.ad_accounts a on a.id = dm.ad_account_id
        where a.client_id = c.id
          and dm.day >= (current_date - public.referral_activity_days())
          and dm.ad_spend > 0
      ) then 'inactive'
      else 'counting'
    end
  from public.portal_clients c
  where c.referred_by = p_client_id
  order by c.created_at;
end;
$$;

grant execute on function public.referral_summary(uuid) to authenticated;

-- Apply both rules to everything that already exists.
select public.refresh_all_referral_rates();
