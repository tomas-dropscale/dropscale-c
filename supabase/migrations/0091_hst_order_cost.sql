-- =============================================================================
-- 0091 - The supplier's ACTUAL per-order cost, so HST stores reconcile to HST.
--
-- 0087 stored the per-order import tariff. It did not store the goods cost,
-- because the goods went in as per-PRODUCT unit costs (product_costs) and the
-- rollup priced each Shopify order from those. That over-counts for an HST
-- store: HST quotes and bills each ORDER individually (its g_cost), spread
-- across days, while the per-product model applies one latest unit cost to every
-- unit. On a real day the two differed by a third (€1113 vs €831).
--
-- This adds the figure that reconciles: g_cost, the total the supplier charged
-- for THIS order (goods + tariff), in the settlement currency already stored
-- alongside. The rollup uses it for HST stores, bucketed to the order's day from
-- the paid_at instant, and falls back to the per-product estimate only where the
-- supplier has not quoted an order yet.
-- =============================================================================

alter table public.hst_order_charges
  add column if not exists our_cost numeric check (our_cost is null or our_cost >= 0);
