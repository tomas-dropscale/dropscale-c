-- 0101 - Give a client back its own cost settings.
--
-- The costs page lets a client set the four figures that turn its revenue into
-- profit: the default product cost, the payment fee percentage and fixed part,
-- and the shipping cost per order. They are the client's own commercial
-- numbers, not reporting topology, and they live on ad_accounts only because
-- that is where the rollup reads them.
--
-- 0055 tightened the ad_accounts update policy so that a client could no longer
-- rewrite the reporting fields of an account after the cutover. That was right,
-- and it stays. But the cost settings were caught by the same net: the policy
-- now requires reporting_role = 'legacy_hybrid' AND legacy_asset_writes_allowed,
-- and the latter is false for every v2_active client - which is all of them.
--
-- The failure is silent, which is why it read as "the form forces the
-- defaults". An UPDATE the policy filters out matches no rows; PostgREST
-- answers 200 with no error, the page reloads, and the old values come back. Of
-- 44 accounts only 4 carry a customised figure, and all four were written
-- before their client was cut over.
--
-- Widening the policy would reopen exactly what 0055 closed. Instead this is a
-- purpose-bound function that knows how to write these four columns and nothing
-- else, the same shape every other sanctioned write in this database takes.

create or replace function public.set_ad_account_cost_settings(
  p_ad_account_id uuid,
  p_default_product_cost_pct numeric,
  p_payment_fee_pct numeric,
  p_payment_fee_fixed numeric,
  p_shipping_cost_per_order numeric
)
returns table (
  default_product_cost_pct numeric,
  payment_fee_pct numeric,
  payment_fee_fixed numeric,
  shipping_cost_per_order numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  account public.ad_accounts%rowtype;
begin
  select * into account
  from public.ad_accounts
  where id = p_ad_account_id
  for update;
  if not found then
    raise exception 'That store no longer exists.' using errcode = '23514';
  end if;

  -- Membership is the whole authorisation. An admin may act for any client;
  -- anyone else must belong to the workspace that owns the account. The
  -- reporting surface is deliberately NOT consulted: these are the client's own
  -- figures and a client on V2 has the same right to them as one who is not.
  if not (public.is_admin() or public.is_client_member(account.client_id)) then
    raise exception 'This store belongs to another workspace.' using errcode = '42501';
  end if;

  -- A percentage outside 0..100 and a negative cost are always a typing
  -- mistake, and both would silently distort every profit figure the client
  -- reads. Refuse them with a sentence rather than storing them.
  --
  -- Each test is written as "is it inside the range", never as "is it outside",
  -- because numeric carries NaN and Infinity and Postgres sorts NaN ABOVE every
  -- number. Written the other way round, "< 0" is false for NaN, the value is
  -- stored, and the rollup then writes a null into a not-null metrics column
  -- and fails on every run from then on.
  if not (p_default_product_cost_pct >= 0 and p_default_product_cost_pct <= 100) then
    raise exception 'The product cost percentage must be a number between 0 and 100.'
      using errcode = '22023';
  end if;
  if not (p_payment_fee_pct >= 0 and p_payment_fee_pct <= 100) then
    raise exception 'The payment fee percentage must be a number between 0 and 100.'
      using errcode = '22023';
  end if;
  if not (p_payment_fee_fixed >= 0 and p_payment_fee_fixed < 'Infinity'::numeric) then
    raise exception 'The fixed payment fee must be a real amount and cannot be negative.'
      using errcode = '22023';
  end if;
  if not (p_shipping_cost_per_order >= 0
    and p_shipping_cost_per_order < 'Infinity'::numeric)
  then
    raise exception 'The shipping cost per order must be a real amount and cannot be negative.'
      using errcode = '22023';
  end if;

  -- Answering with the four figures, never with the row. ad_accounts also
  -- carries shopify_admin_token and google_ads_refresh_token, and this function
  -- is called from the browser: returning the row would hand a client's own
  -- store credentials to the page, and to anything watching it.
  return query
  update public.ad_accounts
  set default_product_cost_pct = p_default_product_cost_pct,
      payment_fee_pct = p_payment_fee_pct,
      payment_fee_fixed = p_payment_fee_fixed,
      shipping_cost_per_order = p_shipping_cost_per_order
  where id = p_ad_account_id
  returning
    public.ad_accounts.default_product_cost_pct,
    public.ad_accounts.payment_fee_pct,
    public.ad_accounts.payment_fee_fixed,
    public.ad_accounts.shipping_cost_per_order;
end
$$;

revoke all on function public.set_ad_account_cost_settings(uuid, numeric, numeric, numeric, numeric)
  from public, anon;
grant execute on function public.set_ad_account_cost_settings(uuid, numeric, numeric, numeric, numeric)
  to authenticated, service_role;
