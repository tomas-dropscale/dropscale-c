-- =============================================================================
-- 0016 — units sold, per day.
--
-- daily_metrics already counts ORDERS. Units is a different question and the
-- one a store owner actually asks ("how many did we sell?"): one order can
-- carry five of the same product, and a store selling bundles has an order
-- count that says almost nothing about volume.
--
-- Nothing new is fetched for this. The Shopify sync already reads every order's
-- line items — that is where COGS and the revenue share come from — so the
-- quantities are in hand and were simply being thrown away after costing.
--
-- Booked on the order's creation day, exactly like revenue and orders_count, so
-- the three always add up to the same day's story. Refunds are NOT subtracted:
-- refunds_amount is money, and netting units against it would need per-line
-- refund quantities that the current single query does not fetch.
-- =============================================================================

alter table public.daily_metrics
  add column if not exists units_sold integer not null default 0;
