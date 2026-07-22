# Connecting Google Ads (per-client OAuth)

Each client authorises their own Google Ads account from inside the portal
("Connect Google Ads" on Settings → Google Ads Accounts). The portal stores
that client's OAuth refresh token on their `ad_accounts` row, **encrypted**
(AES-GCM, key in `GOOGLE_ADS_TOKEN_ENC_KEY`, server-only). There is no agency
refresh token.

The portal reads over the **REST API** (not the gRPC `google-ads-api` npm
package — that does not run on Cloudflare Workers).

Until the four env vars are set, the portal shows **seeded demo data**. Once
they are set and a client connects an account (with a Customer ID), that
account shows **live data** — and a connected account never falls back to demo.

## 1. Developer token

Google Ads → **Tools → API Center**. Copy the developer token.

- **Test access** only returns data for *test* accounts — fine for wiring, but
  real client accounts come back empty until you have **Basic access**.
- Apply for Basic access in the same screen; approval takes days to weeks.

→ `GOOGLE_ADS_DEVELOPER_TOKEN`

## 2. OAuth client

Google Cloud Console → **APIs & Services → Credentials → Create credentials →
OAuth client ID → Web application**.

- Enable the **Google Ads API** for the project first (APIs & Services →
  Library).
- Under *Authorized redirect URIs* add BOTH:
  - `https://dropscale.app/api/google-ads/callback`
  - `http://localhost:3001/api/google-ads/callback`  (local dev)
- Configure the **OAuth consent screen**. While it is in *Testing*, only Google
  accounts you add as *Test users* can connect — publish it before real clients
  use it. The scopes are `openid`, `email`, and `.../auth/adwords`.

→ `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`

## 3. Token encryption key

32 random bytes, base64:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

→ `GOOGLE_ADS_TOKEN_ENC_KEY`

Keep it stable: rotating it makes every already-stored token undecryptable, so
every client would have to reconnect.

## 4. Set the vars

- **Local:** put all four in `.env.local`.
- **Production (Cloudflare):** `npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN`
  (repeat for each). They are server-only and never enter the browser bundle.

## How a client connects

1. Settings → Google Ads Accounts → enter the **Customer ID**, Save.
2. Click **Connect Google Ads**, sign in with the Google account that has
   access to that Customer ID, and consent.
3. The account now shows live campaigns and metrics. Disconnect any time — the
   stored token is deleted.

No Customer ID, not connected, or the API not configured → it stays on demo
data.
