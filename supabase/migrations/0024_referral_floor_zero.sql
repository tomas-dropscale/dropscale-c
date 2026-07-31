-- =============================================================================
-- 0024 — the fee goes all the way to 0%, and a floor must never RAISE a price.
--
-- Two problems with 0022's floor, one of them live.
--
-- 1. THE DEAL IS 0%, NOT 5%.
--    Every referral takes 0.5 off, and enough of them take the whole fee away.
--    Twenty clients brought in means the management fee is gone. That is the
--    offer, so the floor is 0.
--
-- 2. THE FLOOR WAS RAISING PRICES.  ← this one already happened
--    0022 derived the billed rate as greatest(FLOOR, list − discount) with
--    FLOOR = 5. For a store the agency had deliberately set to 0%, that reads
--    greatest(5, 0) = 5 — the migration silently re-priced it UP to 5%, and it
--    has been billing at 5% ever since. A floor is a limit on the DISCOUNT; it
--    was being applied as a minimum on the price.
--
--    With the floor at 0 the expression can no longer exceed the list rate for
--    any non-negative price, which is what makes this correct rather than just
--    differently wrong.
--
-- Re-derives every account at the end, so anything 0022 pushed up comes back
-- down to what the agency actually set.
-- =============================================================================

create or replace function public.referral_floor()
returns numeric language sql immutable as $$ select 0::numeric $$;

-- Belt and braces: the billed rate can never be more than the list price,
-- whatever a future floor is set to. If the two ever disagree again, the
-- client's own price wins — the failure that costs nobody money.
create or replace function public.effective_commission_rate(p_client_id uuid, p_list numeric)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select least(
    p_list,
    greatest(
      public.referral_floor(),
      p_list - (public.referral_step() * public.active_referral_count(p_client_id))
    )
  );
$$;

-- Put every account back on its correct rate, including the ones 0022 raised.
update public.ad_accounts set list_commission_rate = list_commission_rate;
