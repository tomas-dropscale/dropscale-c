-- Root cause of the intermittent /admin/billing crash (caught live via tail +
-- admin_server_errors): the Windsor single-day path sums hourly floats without
-- rounding, so daily_metrics.ad_spend could store an IEEE artifact like
-- 13.332999999999998 — and billing's money parser correctly refuses anything
-- beyond six decimals, killing the whole dashboard render.
--
-- daily_metrics is a recomputed read model, so rounding is always safe. Give
-- every fractional money column an explicit six-decimal scale: Postgres then
-- rounds on every write, no matter which writer produced the float, and this
-- ALTER rounds the already-stored artifacts in place.

alter table public.daily_metrics
  alter column ad_spend type numeric(18,6),
  alter column conversions type numeric(18,6),
  alter column conversion_value type numeric(18,6),
  alter column revenue type numeric(18,6),
  alter column refunds_amount type numeric(18,6),
  alter column product_cost type numeric(18,6),
  alter column payment_fees type numeric(18,6),
  alter column shipping_cost type numeric(18,6),
  alter column revenue_ex_social type numeric(18,6),
  alter column revenue_share_base type numeric(18,6),
  alter column revenue_share_amount type numeric(18,6),
  alter column attributed_revenue type numeric(18,6);
