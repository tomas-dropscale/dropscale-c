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
