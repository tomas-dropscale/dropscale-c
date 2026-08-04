# Manual agency billing cutover

This runbook moves the live portal from legacy local drafts to review-first
Google Ads agency billing. Clients continue to pay Google directly. Dropscale
invoices only the reviewed agency fee, in EUR, through Stripe Hosted Invoice
Pages.

## Non-negotiable billing contract

- The service week is Monday through Sunday in `Europe/Lisbon`.
- A new account starts at the exact Google cumulative spend counter captured
  when an admin activates tracking. Spend before that counter is excluded.
- Both `active` and `suspended` accounts remain billable until an immutable
  billing-end counter is captured.
- The list fee is 10% of Google-reported billable spend. A referral can change
  a future Monday-effective term only after a separate admin review.
- Monday's scheduled job refreshes evidence and reconciles Stripe; it never
  creates or sends an invoice.
- Google evidence for the previous Sunday is not reviewable before Monday at
  14:05 UTC.
- An authenticated admin must refresh, inspect and explicitly confirm one
  client/week. The server recalculates and rejects a stale browser preview.
- Clients see only rows with `issued_at` evidence. Payment happens on Stripe's
  hosted page; no saved card is charged automatically.

## Release gates

Keep `BILLING_ISSUANCE_ENABLED` unset or set to anything other than the exact
lowercase string `true` until every gate below is green. With the gate closed,
`POST /api/billing/generate` returns 503 after admin authentication and before
service-role or Stripe access.

The production cutover is ready only when all of the following are true:

1. A recoverable Supabase backup or point-in-time recovery point has been
   verified.
2. Old app/cron billing writers are stopped for the complete multi-migration
   window.
3. Every active or suspended non-admin account is EUR and has one canonical
   10-digit Google Ads customer ID that the agency connection can read.
4. The database migrations `0026` through `0033` have committed in order.
5. Every active or suspended client Google account has a newly captured
   immutable billing start.
6. The deployed Worker has the live Stripe key, Stripe webhook signing secret,
   a server-only Supabase secret with RLS-bypass Data API access and the cron
   secret as encrypted secrets.
7. The Stripe webhook endpoint is configured for the API version and events
   listed in `.env.local.example`, and a signed live event has been observed.
8. One internal/pilot client has been previewed, issued, opened and reconciled
   end to end before enabling the remaining clients.

## Preflight while issuance is disabled

Freeze billing-related writes before running these checks. Do not "repair" a
failed check by deleting evidence.

```sql
-- Active/suspended client accounts that cannot receive an immutable baseline.
select
  account.id,
  account.store_name,
  account.status,
  account.currency,
  account.google_ads_customer_id
from public.ad_accounts account
where account.status in ('active', 'suspended')
  and not exists (
    select 1
    from public.profiles profile
    where profile.id = account.client_id
      and profile.role = 'admin'
  )
  and (
    upper(account.currency) <> 'EUR'
    or account.google_ads_customer_id is null
    or account.google_ads_customer_id !~ '^[0-9]{10}$'
  );

-- Anything here needs explicit Stripe reconciliation before cutover.
select id, status, issued_at, stripe_invoice_id, paid_at, payment_failed_at
from public.invoices
where (
    status = 'draft'
    and (
      calculation_version <> 'legacy'
      or issued_at is not null
      or issued_by is not null
      or stripe_invoice_id is not null
      or stripe_hosted_url is not null
      or stripe_invoice_number is not null
      or stripe_invoice_pdf is not null
      or amount_remaining is not null
      or paid_at is not null
      or payment_failed_at is not null
    )
  )
  or (
    status in ('open', 'paid', 'void', 'uncollectible')
    and (issued_at is null or stripe_invoice_id is null)
  );

-- Attribution is deliberately admin-owned; existing permanent edges are not
-- guessed or silently retained by the generic cutover.
select id, referred_by
from public.portal_clients
where referred_by is not null;
```

The live data audited before this change contained only unissued, unlinked
legacy drafts. Migration `0029` preserves each original row as JSON evidence,
marks those local drafts `void`, and records the exact count. It never deletes
an invoice and it aborts if the live state is more ambiguous than that audit.

## Database migration order

Apply the following files in one controlled maintenance window, in filename
order. Prefer the normal linked Supabase migration workflow. If SQL Editor is
used, run one complete file at a time and stop immediately on the first error.

1. `0026_one_source_per_store.sql`
2. `0027_pre_v3_schema_repair.sql`
3. `0028_manual_agency_billing.sql`
4. `0029_legacy_billing_cutover.sql`
5. `0030_manual_referral_discounts.sql`
6. `0031_manual_referral_attribution.sql`
7. `0032_billing_issue_leases.sql`
8. `0033_disable_direct_invoice_inserts.sql`

The sequence is intentional:

- `0027` restores columns that are present in repository history but missing
  from the audited live schema.
- `0028` installs immutable Google start/end evidence, exact-micros fee
  calculation, invoice consumption records and the Stripe webhook inbox.
- `0029` takes immutable snapshots, retires only safe legacy drafts and resets
  current account terms to the approved 10% fee-only contract.
- `0030` installs append-only, Monday-effective referral terms and the v3
  invoice transaction.
- `0031` replaces self-service attribution with an immutable pending-claim
  journal and an admin-only attribution decision.
- `0032` serialises Stripe issue attempts per client and records explicit send
  evidence so retries cannot double-send or revive an obsolete worker.
- `0033` revokes direct invoice INSERT from browser and service roles. This
  closes the still-deployed legacy admin endpoint during application rollout;
  v3 creation remains available only through its validated SECURITY DEFINER
  transaction.

All migration preflights fail closed. A failure means the live facts differ
from the reviewed cutover contract and require investigation, not a broad SQL
workaround.

## Baseline activation

After all migrations commit, deploy the application with issuance still
disabled. In `/admin/clients`, use **Verify Google & start tracking** for every
active or suspended client account that lacks a billing start.

That action performs this sequence atomically from the operator's perspective:

1. Authenticates the admin and validates the selected account/request.
2. Reads the current same-day cumulative cost, Google-local date, timezone and
   currency through the agency Google connection.
3. Writes one immutable capture receipt through the service-only RPC.
4. Activates a pending account only after that receipt is durable. Existing
   suspended accounts remain suspended.

Do not recreate or move a captured baseline. If Google cannot verify the
account, the route leaves tracking unstarted and returns an error.

## Stripe and Worker configuration

Set the production values as encrypted Worker secrets, never committed vars:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`
- `BILLING_ISSUANCE_ENABLED`

Use a current `sb_secret_…` server secret (preferred) or a legacy JWT whose
payload role is genuinely `service_role`. A browser anon JWT, including one
mistakenly labelled as service-role, is not sufficient. Confirm the deployed
server secret can perform the required service RPCs without ever exposing it
to a browser. Data API access also does not grant migration/DDL access; the
schema cutover still requires a linked Supabase CLI session, database password
or an operator applying the reviewed SQL in Supabase SQL Editor.

Configure Stripe's live webhook at:

```text
https://dropscale.app/api/stripe/webhook
```

Use the API version and event allow-list documented in `.env.local.example`.
The endpoint verifies the raw-body signature, rejects test/live mode mismatch,
stores each event ID in a durable inbox and reconciles the current Stripe
Invoice instead of trusting delivery order.

## Pilot and enablement

1. Leave issuance disabled while the Monday evidence job runs or use the
   explicit **Refresh ledger** action after the 14:05 UTC cutoff.
2. Open `/admin/billing`, choose the closed week and inspect every blocker,
   store line, baseline/end deduction, recipient and referral term.
3. For the pilot, enable issuance with the exact value `true`, reopen the admin
   page and confirm the expected amount in the review dialog.
4. Verify that exactly one Stripe `send_invoice` Invoice exists, is in EUR,
   contains only agency-fee lines, has a hosted URL and matches the local
   invoice ID in metadata.
5. Sign in as the pilot client, open Dashboard → Payments, follow **Pay now**
   and complete payment on Stripe.
6. Confirm the signed webhook changes the admin row to paid. Also run or wait
   for `/api/billing/cron` reconciliation to prove missed-webhook recovery.
7. Only then process the remaining clients one at a time.

For an immediate stop, set `BILLING_ISSUANCE_ENABLED` back to a non-`true`
value. This prevents new issue attempts but does not hide, cancel or mutate
invoices already sent to Stripe.

## Normal weekly operation

1. Monday 14:05 UTC: the Worker refreshes the closed week's Google ledger and
   reconciles Stripe. No invoice is created.
2. Admin opens `/admin/billing`, selects the previous Monday–Sunday week and
   refreshes evidence if required.
3. Admin reviews each client. Missing baseline, unsettled evidence, incomplete
   billing identity, stale referral term, duplicate consumption or amount
   mismatch blocks issue.
4. Admin ticks the explicit confirmation and issues one client/week. The
   server recalculates, compares the review token, acquires a fenced client
   lease, creates/reuses the Stripe objects idempotently, finalises and sends.
5. The client sees the issued invoice under Dashboard → Payments and pays on
   Stripe's hosted page.
6. Stripe webhooks update paid, open, failed, void or uncollectible state. The
   daily reconciliation job is the safety net for missed deliveries.
7. Admin `/admin/billing` shows selected-week billed value, current-month
   billed and paid totals, outstanding balance, failures and invoice history.

Referral attribution and pricing are two separate admin decisions:

- A signup/client referral code creates one immutable pending request.
- Admin `/admin/referrals` may accept or override the suggested referrer.
- A second admin action grants or revokes a discount effective on a valid
  Monday. It never reprices an already settled week.

## Rollback boundary

Before migration commit, restore the verified database recovery point and keep
the old app/cron writers frozen.

After the cutover commits, do not reverse immutable billing evidence with ad
hoc updates. Keep issuance disabled, leave all snapshots and invoice rows in
place, and deploy a forward corrective migration. Any Stripe Invoice already
sent must be reconciled in Stripe and locally before another issue attempt.
