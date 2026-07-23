# Knowledge log — Shopify integration

Append-only. Each entry: symptom → cause → fix. Read this before touching the
Shopify integration again.

## 2026-07-23 — 401 "Shopify rejected these credentials" on Connect

**Symptom:** Connections panel returned "Shopify rejected these credentials.
Check the Admin API access token." for a store whose Client ID + secret were
correct.

**Cause:** the client pasted the app's **API secret key** (`shpss_…`) into a
field the backend sent straight to the `X-Shopify-Access-Token` header. The
secret is not an access token: it only works in the body of the
`client_credentials` token exchange, which returns the actual `shpat_…` token
(valid ~24h).

**Fix:** `resolveAdminToken()` in `src/lib/shopify/client.ts` — `shpss_`
credentials go through `POST /admin/oauth/access_token` (exchange cached per
isolate ~23h), `shpat_` tokens pass through untouched. The connect route
stores whichever was pasted (encrypted); the exchange runs on every use.

**Note against the docs:** Shopify's documentation says the
`client_credentials` grant does not work for admin custom apps. Empirically it
returns 200 and a working token. When docs contradict a real HTTP response,
trust the response.

**Also:** Shopify HTML error pages hide the real message after a large
`<style>` block — strip it before reading (`scripts/shopify-test.mjs` does).

## 2026-07-23 — "Access denied for orders field" with read_all_orders granted

**Symptom:** connect succeeded, first sync failed with ACCESS_DENIED on the
`orders` GraphQL field. The app's scopes were `read_all_orders,
read_analytics, …` — orders access looked covered.

**Cause:** `read_all_orders` does NOT grant the orders field by itself. It is
only the ">60 days of history" extension and requires the base `read_orders`
(or `write_orders`) alongside it. The connect-time scope check treated
`read_all_orders` as sufficient — false positive.

**Fix:** the check now requires `read_orders`/`write_orders` specifically and
its error message spells out the trap. App-side fix: Configuration → Admin
API integration → enable `read_orders` (keep `read_all_orders` too) → save →
install/update the app → reconnect in the panel.
