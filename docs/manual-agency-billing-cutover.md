# Automatic agency billing cutover

This runbook moves the live portal from legacy local drafts to automatic,
evidence-backed Google Ads agency billing. Clients continue to pay Google
directly. Dropscale invoices only the agency fee, in EUR, through Stripe Hosted
Invoice Pages. Admin review is for exceptions and monitoring; a healthy weekly
invoice does not require an admin click.

## Non-negotiable billing contract

- The service week is Monday through Sunday in `Europe/Lisbon`.
- A new account starts at the exact Google cumulative spend counter captured
  when an admin activates tracking. Spend before that counter is excluded.
- Both `active` and `suspended` accounts remain billable until an immutable
  billing-end counter is captured.
- The list fee is 10% of Google-reported billable spend. A referral can change
  a future Monday-effective term only after a separate admin review.
- Monday's scheduled job refreshes evidence, issues every eligible closed-week
  invoice idempotently and reconciles Stripe.
- Google evidence for the previous Sunday is not reviewable before Monday at
  14:05 UTC.
- A client/week with incomplete or contradictory evidence is blocked and shown
  to an admin; it is never estimated or issued from partial data.
- A newly joined account is billable from its immutable Google start counter.
  The reviewed historical cutover is the only exception: approved pre-cutover
  accounts start at the beginning of their recorded entry day.
- Clients see only rows with `issued_at` evidence. Payment happens on Stripe's
  hosted page; no saved card is charged automatically.

## Release gates

Keep both `BILLING_ISSUANCE_ENABLED` and `BILLING_AUTOMATION_ENABLED` unset or
set to anything other than the exact lowercase string `true` until every gate
below is green. Automatic issue requires both gates; this prevents a manual
gate left enabled by an older deploy from arming the all-client worker. With
either gate closed, `POST /api/billing/cron` refuses to create or send new
invoices before Stripe access. Existing Stripe invoices can still be
reconciled safely.

The production cutover is ready only when all of the following are true:

1. A recoverable Supabase backup or point-in-time recovery point has been
   verified.
2. Old app/cron billing writers are stopped for the complete multi-migration
   window.
3. Every account carrying positive billable evidence is EUR, has one canonical
   10-digit Google Ads customer ID and a valid per-client OAuth connection.
   Unresolved accounts with no spend are isolated and visible to admins; they
   do not block certified siblings or other clients.
4. The database migrations `0026` through `0036` have committed in order.
5. Every account carrying positive billable evidence has either an observed
   Google start counter or the reviewed full-day cutover proof installed by
   `0034`; any unresolved zero-spend account is explicitly recorded as an
   isolated blocker.
6. The deployed Worker has the live Stripe key, Stripe webhook signing secret,
   a server-only Supabase secret with RLS-bypass Data API access and the cron
   secret as encrypted secrets.
7. The Stripe webhook endpoint is configured for the API version and events
   listed in `.env.local.example`, and a signed live event has been observed.
8. The complete eligible batch has been reviewed and consciously accepted;
   there is no single-client pilot scope in the automatic worker.

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

Apply the following files in filename order. Prefer the normal linked Supabase
migration workflow. The new rollout is deliberately phased: apply `0034`,
commit the reviewed starts account by account from client-OAuth metadata, run
the exact closed-week Google sync, and only then apply `0035` and `0036`. Never
expose all three pending files to one blind `db push`. If SQL Editor is used,
run one complete file at a time and stop immediately on the first error.

1. `0026_one_source_per_store.sql`
2. `0027_pre_v3_schema_repair.sql`
3. `0028_manual_agency_billing.sql`
4. `0029_legacy_billing_cutover.sql`
5. `0030_manual_referral_discounts.sql`
6. `0031_manual_referral_attribution.sql`
7. `0032_billing_issue_leases.sql`
8. `0033_disable_direct_invoice_inserts.sql`
9. `0034_reviewed_full_day_billing_starts.sql`
10. `0035_historical_full_day_rollover.sql`
11. `0036_billing_automation_receipts.sql`

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
- `0034` installs the reviewed full-day proof contract and its service-only,
  per-account commit RPC. It creates no starts by itself and never invents a
  Google counter. Each pre-cutover account remains unstarted until a valid
  client-OAuth metadata read is committed. Accounts joining after the cutover
  still require a real observed Google start.
- `0035` seals the reviewed 27 July–2 August historical full-day rollover only
  from starts and exact completed Google sync windows created after `0034`. It
  preserves the calculation proof but does not create or send an invoice while
  the migration is running.
- `0036` installs the durable automatic-issuance queue, run receipts, fenced
  claims and database proofs for legitimate zero-charge weeks. A failed item is
  retried on a later run without blocking other clients.

Recurring ledger reads preserve the portal's established per-client OAuth
model. A disconnected or revoked client credential blocks only that account;
the billing worker never substitutes the agency service account.

All migration preflights fail closed. A failure means the live facts differ
from the reviewed cutover contract and require investigation, not a broad SQL
workaround.

## Baseline activation

After `0034` commits, keep issuance disabled. For every explicitly approved
pre-cutover account, read the non-secret customer ID, EUR currency and IANA
timezone through that account's existing client OAuth and call
`commit_reviewed_full_day_billing_start`. The RPC derives both the Lisbon
commercial entry day and the separate Google-local start day from the stored
account creation instant. It does not update status, OAuth, connection flags or
the configured Google customer. A failed or revoked account remains unstarted
without blocking independent accounts.

Run a forced exact sync for 27 July–2 August after those starts exist. Confirm
each positive account has one complete sync window whose canonical snapshot
matches the six-decimal Google ledger. Only then apply `0035` and `0036` and
deploy the application with issuance still disabled.

For each newer active or suspended account that lacks a billing start, use
**Verify Google & start tracking** in `/admin/clients`.

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
- `BILLING_AUTOMATION_ENABLED`

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

## Enablement

1. Leave automatic issuance disabled while the Monday evidence job runs or use
   the explicit **Refresh closed Google week** action after the 14:05 UTC
   cutoff.
2. Open `/admin/billing` and confirm the latest closed-week total, client
   positions, blocked items, billing identities and referral terms.
3. Use the read-only Stripe check to verify the live restricted key. Separately
   confirm the required write permissions and the deployed webhook signing
   secret; the read-only check cannot prove either by itself.
4. Review every eligible historical recipient and amount. The current worker
   has no single-client pilot mode: arming it processes the complete eligible
   batch, not one selected client.
5. Only after accepting that batch, set both gates to the exact value `true`
   and invoke the protected billing cron. No admin confirmation dialog is part
   of the normal issuance path.
6. Verify that each expected Stripe `send_invoice` Invoice is in EUR, contains
   only agency-fee lines, has a hosted URL and matches its local invoice ID in
   metadata.
7. Sign in as a client, open Dashboard → Payments, follow **Pay now** and
   complete payment on Stripe.
8. Confirm the signed webhook changes the admin row to paid. Also run or wait
   for `/api/billing/cron` reconciliation to prove missed-webhook recovery.

For an immediate automatic stop, set `BILLING_AUTOMATION_ENABLED` back to a
non-`true` value. Set `BILLING_ISSUANCE_ENABLED` back as well to stop emergency
manual issue. Neither action hides, cancels or mutates invoices already sent to
Stripe.

## Normal weekly operation

1. Monday 14:05 UTC: the Worker refreshes the complete Monday–Sunday Google
   ledger, seeds all closed eligible client/weeks and starts the protected
   billing run.
2. The queue processes oldest weeks first. Each item is claimed with a fenced
   lease; the server recalculates from immutable evidence, creates or reuses
   Stripe objects idempotently, finalises and sends the invoice.
3. Missing baseline, unsettled Google evidence, incomplete billing identity,
   stale referral term, duplicate consumption or an amount mismatch blocks
   only that client/week. A proved exact €0 week is recorded as `no_charge`.
4. A daily 23:55 UTC run retries blocked work whose evidence is now complete
   and reconciles Stripe. It cannot reclaim the same failed item repeatedly in
   one run.
5. The client sees the issued invoice under Dashboard → Payments and pays on
   Stripe's hosted page.
6. Stripe webhooks update paid, open, failed, void or uncollectible state. The
   daily reconciliation job is the safety net for missed deliveries.
7. Admin `/admin/billing` starts with latest-week billed, month billed, month
   paid and outstanding totals, followed by one client-position list and a
   compact needs-attention view. It is a control surface, not an issue button.

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
