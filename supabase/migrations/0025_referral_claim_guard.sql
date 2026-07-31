-- =============================================================================
-- 0025 — claim_referral_code() could never actually write.
--
-- 0022 shipped two things that contradict each other:
--
--   claim_referral_code()   sets portal_clients.referred_by for the caller
--   guard_referral_fields() raises if referred_by changes and the caller is
--                           neither a trusted context (auth.uid() is null) nor
--                           an admin
--
-- The claim function is SECURITY DEFINER, and its comment claimed that put it
-- outside the guard. It does not. SECURITY DEFINER changes the POSTGRES role
-- the body runs as; auth.uid() reads the request's JWT, which is untouched. So
-- the guard saw an ordinary client changing their own referred_by and refused —
-- every single call — with "Only the sign-up flow can set who referred you".
--
-- It matters because the Google sign-up path depends on this function: OAuth
-- carries no metadata, so the code typed on /register is applied by calling it
-- from the callback. Nobody signing up with Google could ever have been
-- credited to whoever referred them.
--
-- Found by running the migrations against a real Postgres
-- (src/lib/billing/referrals.sql.test.ts), which is the only reason it was
-- caught before it started costing referrers their discount.
--
-- THE FIX
--   A transaction-local flag, set by the claim function and honoured by the
--   guard. Transaction-local (the `true` third argument) is what makes it safe:
--   it cannot leak past COMMIT into another request on a pooled connection, and
--   nothing outside a transaction that called the function can ever see it set.
-- =============================================================================

create or replace function public.claim_referral_code(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_referrer uuid;
  v_existing uuid;
begin
  if auth.uid() is null then
    return 'not_signed_in';
  end if;
  if v_code = '' then
    return 'empty';
  end if;

  select referred_by into v_existing from public.portal_clients where id = auth.uid();
  if not found then
    return 'not_a_client';
  end if;
  if v_existing is not null then
    return 'already_referred';
  end if;

  select id into v_referrer
  from public.portal_clients
  where upper(referral_code) = v_code
    and approval_status = 'approved';

  if v_referrer is null then
    return 'unknown_code';
  end if;
  if v_referrer = auth.uid() then
    return 'own_code';
  end if;

  -- Tells the guard below that this particular write is the sign-up flow.
  -- Scoped to the transaction, so it is gone the moment this returns.
  perform set_config('dropscale.referral_claim', 'on', true);
  update public.portal_clients set referred_by = v_referrer where id = auth.uid();

  return 'ok';
end;
$$;

grant execute on function public.claim_referral_code(text) to authenticated;

create or replace function public.guard_referral_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  -- The one sanctioned way for a client's own referred_by to change.
  if coalesce(current_setting('dropscale.referral_claim', true), '') = 'on' then
    return new;
  end if;

  if new.referral_code is distinct from old.referral_code then
    raise exception 'A referral code cannot be changed.';
  end if;
  if new.referred_by is distinct from old.referred_by then
    raise exception 'Only the sign-up flow can set who referred you.';
  end if;

  return new;
end;
$$;
