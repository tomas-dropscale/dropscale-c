-- =============================================================================
-- 0092 - Keep the revenue side in the STORE's own currency (read-time FX).
--
-- daily_metrics stores every figure in the reporting currency (EUR), converted
-- at sync from the store's base currency. That makes a client's revenue in the
-- dashboard differ from the exact number Shopify shows them — Shopify is in the
-- store's currency (JPY, CZK…), and any conversion drifts from it.
--
-- The fix is RevFlow's model: keep the revenue side in the store's OWN currency
-- (the untouched Shopify figure) and convert only at read time, per store. This
-- migration is the additive foundation — it stores the raw store-currency
-- revenue alongside the existing EUR columns, changing no reader yet:
--   · revenue_store, refunds_store, attributed_revenue_store — the Shopify
--     figures in the store's base currency, before any FX.
--   · store_currency — that base currency, so a reader knows what the *_store
--     columns are in and can convert them on display.
--
-- The cost side (ad_spend, product_cost, fees, shipping) stays in EUR: standard
-- billing is a percentage of ad spend and never touches revenue, so it is
-- untouched. Only revenue-share reads revenue, and it converts at its own point.
-- =============================================================================

alter table public.daily_metrics
  add column if not exists revenue_store numeric,
  add column if not exists refunds_store numeric,
  add column if not exists attributed_revenue_store numeric,
  add column if not exists store_currency text;
