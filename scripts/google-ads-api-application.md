# Google Ads API — token application (Dropscale IO)

Text for the Google Ads API access application form. Every claim here was checked
against the code (`src/lib/google-ads/`); if the integration changes, update this file
in the same commit.

> **Note:** the form requires screenshots or mock-ups of the tool — see "Tool Mockups".

---

**Company Name:** Dropscale IO

---

## Business Model

Dropscale IO is a digital marketing agency. We plan, launch and manage Google Ads
campaigns on behalf of our clients, who are independent e-commerce businesses running
Shopify stores. We do not sell products ourselves, and we do not resell the Google Ads
API or any tool built on it.

Each client owns their own Google Ads account and their own Shopify store. We are
granted access to those accounts by the client in order to run their advertising. We
are paid by the client for that service: a management fee calculated as a percentage
of the ad spend we manage (10% by default), and, on some accounts, an agreed
percentage of the store revenue that our campaigns generate. Nothing we charge is
based on reselling API access.

## Tool Access / Use

The tool is a private web application at **dropscale.app**. It is not a product we
sell, and it is not available to the public — there is no sign-up that grants access
to anyone outside the two groups below.

**1. Our own staff (admin area).** Account managers and the agency's finance staff use
it to review performance across all the accounts we manage, to see which campaigns are
running, and to reconcile what each client should be invoiced.

**2. Our clients (client portal).** Each client signs in and sees the performance of
**their own advertising accounts only** — spend, impressions, clicks, conversions,
ROAS — alongside the sales data from their own Shopify store, so they can see the real
profit of their campaigns. A client can never see another client's data; every query is
scoped to the signed-in account at the database level (PostgreSQL row-level security).

A client connects their Google Ads account themselves, through Google's standard OAuth
consent screen. They can revoke that access at any time from their own Google account.
We never ask a client for their Google credentials.

The tool is **read-only with respect to Google Ads**. It does not create, edit, pause
or remove campaigns, ad groups, ads, budgets or keywords. All campaign management is
carried out by our team directly in the Google Ads UI; the tool only reports.

## Tool Design

**Authentication.** Each advertising account is connected via OAuth 2.0
(`https://www.googleapis.com/auth/adwords`). The resulting refresh token is encrypted
(AES-GCM) before it is stored, and is only ever decrypted server-side to make an API
call.

**Data flow.** The application queries the Google Ads API for performance metrics and
stores the results in our own database (Supabase / PostgreSQL) as a daily rollup: one
row per advertising account per day, holding spend, impressions, clicks, conversions
and conversion value. The dashboards read from that rollup, not from the API — so
ordinary page views cost no API calls.

**Refresh cadence.** The rollup is refreshed when a user opens a page that depends on
it, and at most once every 15 minutes per account; a request within that window is
served from the stored data. Each refresh pulls a rolling 7-day window so that Google's
restatements of recent days are picked up. When an account is connected for the first
time, we backfill up to 90 days once, so the client's dashboard is not empty on day
one.

**Reporting.** Users can view performance at account level and campaign level, over a
date range they choose (today, yesterday, last 7/30 days, month to date, year to date,
or a custom range). The same data feeds the agency's internal invoicing figures.

**No write operations.** The application performs no mutate calls of any kind against
the Google Ads API.

## API Services Called

| Service | Method | Use |
|---|---|---|
| `CustomerService` | `ListAccessibleCustomers` | After OAuth consent, list the advertising accounts the connecting user has granted us access to, so they can pick the right one. |
| `GoogleAdsService` | `Search` | All reporting. GAQL queries only — no mutates. |

The `GoogleAdsService.Search` queries read from these resources:

- **`customer`** — account-level metrics (impressions, clicks, cost, conversions,
  conversion value) by day, for the dashboards and the daily rollup.
- **`campaign`** — campaign name, status and per-campaign metrics for the
  campaign-level reporting table.
- **`asset`** — image assets from the account's asset library, so the client can review
  the creatives running on their account.

No other Google Ads API services are called.

## Tool Mockups

Attach these four screenshots:

1. **Client portal — dashboard.** Revenue, net profit, ad spend, ROAS, the daily
   performance chart and the cost breakdown.
2. **Client portal — store performance.** The 10-metric grid (amount spent,
   impressions, clicks, conversions, CTR, CPC, cost/conversion, ROAS, conversion value)
   and the campaigns table underneath.
3. **Admin area — campaigns.** All managed clients, expandable per store, with each
   store's campaigns and spend.
4. **Connection screen.** Where a client starts the Google OAuth consent flow for their
   own advertising account.

---

## If Google asks follow-up questions

- **"Why the `adwords` scope if you only read?"** It is the only scope the Google Ads
  API offers; there is no read-only variant. Our usage is limited to
  `ListAccessibleCustomers` and GAQL `Search` — the codebase contains no mutate call.
- **"How do you isolate clients from each other?"** Every ad account row is owned by a
  client id, and PostgreSQL row-level security policies scope every query to the
  signed-in user. The portal never accepts an account id from the browser without
  re-checking ownership server-side.
- **"How are the OAuth tokens stored?"** Encrypted with AES-GCM using a server-side
  key held as a platform secret; decrypted only in server code at the moment of an API
  call, never sent to a browser.
