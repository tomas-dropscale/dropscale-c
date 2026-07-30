-- =============================================================================
-- 0019 — conversions that mean something next to Google ad spend.
--
-- The store cards show CONVERSIONS beside AD SPEND, and both numbers on offer
-- were wrong for that slot:
--
--   Google's `conversions`  almost always 0, because conversion tracking is
--                           rarely wired up. A store doing €167 of orders that
--                           reads "0 conversions" reads as a broken product.
--   Shopify's orders_count  too generous: the same store also sells through
--                           Instagram and Facebook, and Google spend had
--                           nothing to do with those orders.
--
-- So: every real order EXCEPT the ones Meta referred. The classification is in
-- lib/shopify/referrer.ts (unit-tested), computed in the sync, stored here.
--
-- NULLABLE ON PURPOSE, with no default.
--   NULL means "this day was written before the column existed, nobody has
--   computed it". 0 means "computed, and every order that day came from Meta".
--   A default of 0 would collapse those two into one value, and the dashboard
--   would confidently show zero conversions for months of history — the exact
--   failure the units_sold column already walked into (see the backfill in
--   lib/metrics/recompute.ts, which uses this NULL as its marker).
-- =============================================================================

alter table public.daily_metrics
  add column if not exists attributed_orders integer,
  -- The VALUE of those same orders, so the card pair reads as one statement:
  -- "N conversions worth €X". Google's conversion_value is 0 for the same
  -- reason its conversion count is, which left the card beside it dead.
  --
  -- Gross order totals, in the account's REPORTING currency like every other
  -- money column here — the FX pass in recompute.ts converts it alongside
  -- revenue. Same NULL-means-never-computed rule as above.
  add column if not exists attributed_revenue numeric;

comment on column public.daily_metrics.attributed_orders is
  'Real orders minus those referred by Instagram/Facebook — the store''s conversions figure. NULL = never computed for this day (pre-0019 row), 0 = computed and all orders were Meta-referred.';

comment on column public.daily_metrics.attributed_revenue is
  'Gross revenue of the attributed_orders, reporting currency — the conversion value shown beside that count. NULL = never computed for this day.';
