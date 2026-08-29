-- =============================================================================
-- 0090 - Cache the client's HST shop list.
--
-- The shop dropdown on the COGS page is filled by a live call to
-- hsterp.com/orders, and for some accounts that call takes ~14 seconds — long
-- enough to trip the request timeout and drop the panel to a bare "type the
-- numeric id" box, even though the shops exist and were reachable a moment
-- before. Caching the last good list lets the dropdown render instantly and
-- survive a slow or briefly unreachable supplier; the live call only
-- repopulates the cache (when it is empty, and on every sync), never gates the
-- render.
--
-- One row per client already (0089); this is one more column on it. No policy
-- change: the table denies everyone under RLS and only the server, on the
-- service role, ever reads or writes it.
-- =============================================================================

alter table public.client_hst_credentials
  add column if not exists shops jsonb;
