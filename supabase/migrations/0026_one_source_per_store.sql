-- One data source, one store.
--
-- Nothing stopped the same Shopify shop or the same Google Ads customer being
-- attached to two rows in ad_accounts. When that happens the sync pulls the
-- same numbers twice, once under each ad_account_id, and daily_metrics — keyed
-- (ad_account_id, day) — happily stores both. Revenue, orders, COGS and ad
-- spend then read roughly double on the dashboard, and the commission computed
-- from that spend doubles with them.
--
-- Nothing errors in that state. It is a silent, plausible-looking inflation,
-- which is exactly the kind of thing a constraint should make impossible rather
-- than a reviewer catch.
--
-- These are GLOBAL, not per client: a Shopify store belongs to one business, so
-- the same domain under two different clients is a mistake in every case worth
-- allowing for.
--
-- On the Google side this also encodes a real limit of the model: the sync
-- pulls a customer's WHOLE spend for the window, so one Google Ads account
-- cannot be split across two stores here even if the advertiser thinks of it
-- that way. Better to refuse the setup than to report both stores as spending
-- the full amount.

-- ---------------------------------------------------------------------------
-- BEFORE RUNNING: check for existing duplicates. The index creation below FAILS
-- if any exist, and the failure message will not tell you which rows clash.
--
--   select shopify_url, count(*), array_agg(store_name)
--   from public.ad_accounts
--   where shopify_url is not null
--   group by shopify_url having count(*) > 1;
--
--   select google_ads_customer_id, count(*), array_agg(store_name)
--   from public.ad_accounts
--   where google_ads_customer_id is not null
--   group by google_ads_customer_id having count(*) > 1;
--
-- Anything returned is a store whose figures are currently double-counted.
-- Decide which row keeps the connection and null the other one out first.
-- ---------------------------------------------------------------------------

-- Partial: only rows that actually carry a connection. Unconnected stores all
-- hold NULL, and a plain unique index would treat those as distinct anyway —
-- the WHERE clause makes that explicit and keeps the index small.
create unique index if not exists ad_accounts_shopify_url_uq
  on public.ad_accounts (shopify_url)
  where shopify_url is not null;

create unique index if not exists ad_accounts_google_customer_uq
  on public.ad_accounts (google_ads_customer_id)
  where google_ads_customer_id is not null;
