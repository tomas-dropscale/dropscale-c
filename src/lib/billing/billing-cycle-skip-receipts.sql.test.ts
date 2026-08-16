import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const AUTOMATION = readFileSync(
  "supabase/migrations/0036_billing_automation_receipts.sql",
  "utf8",
);
const CYCLE_SKIPS = readFileSync(
  "supabase/migrations/0038_billing_cycle_skips.sql",
  "utf8",
);
const RECEIPT_FIX = readFileSync(
  "supabase/migrations/0053_billing_cycle_skip_receipts.sql",
  "utf8",
);
const INVOICE_GUARD = readFileSync(
  "supabase/migrations/0066_billing_cycle_skip_invoice_guard.sql",
  "utf8",
);

const ADMIN = "53000000-0000-4000-8000-000000000001";
const CLIENT = "53000000-0000-4000-8000-000000000002";
const RUN = "53000000-0000-4000-8000-000000000003";
const ITEM = "53000000-0000-4000-8000-000000000004";
const ACCOUNT = "53000000-0000-4000-8000-000000000005";
const START = "53000000-0000-4000-8000-000000000006";
const SOURCE = "53000000-0000-4000-8000-000000000007";
const LEGACY_CLIENT = "53000000-0000-4000-8000-000000000010";
const LEGACY_RUN = "53000000-0000-4000-8000-000000000011";
const LEGACY_ITEM = "53000000-0000-4000-8000-000000000012";
const MONDAY = "2026-07-20";
const SUNDAY = "2026-07-26";

const PRELUDE = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;
grant usage on schema public, auth to authenticated, anon, service_role;

create table public.profiles (
  id uuid primary key,
  role text not null
);
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  )
$$;

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null,
  approval_status text not null
);
create function public.is_client_member(p_client_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() = p_client_id
$$;

create table public.manual_referral_billing_config (
  singleton boolean primary key,
  v3_cutover_monday date not null
);
insert into public.manual_referral_billing_config values (true, date '2026-07-20');

create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  status text not null,
  currency text not null,
  google_ads_customer_id text not null
);
create table public.ad_account_billing_starts (
  id uuid primary key,
  ad_account_id uuid not null unique references public.ad_accounts(id),
  google_local_date date not null,
  google_ads_customer_id text not null,
  google_time_zone text not null,
  currency text not null,
  baseline_cost_micros numeric
);
create table public.ad_account_billing_ends (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique references public.ad_accounts(id),
  billing_start_id uuid not null references public.ad_account_billing_starts(id),
  google_local_date date not null
);
create table public.revenue_sources (
  id uuid primary key,
  name text not null
);
create table public.commissions (
  id uuid primary key,
  source_id uuid not null references public.revenue_sources(id),
  ad_account_id uuid references public.ad_accounts(id),
  occurred_on date not null,
  gross_amount numeric(18,6) not null,
  currency text not null,
  status text not null
);
create table public.google_ledger_sync_windows (
  ad_account_id uuid not null references public.ad_accounts(id),
  billing_start_id uuid not null references public.ad_account_billing_starts(id),
  billing_end_id uuid references public.ad_account_billing_ends(id),
  period_start date not null,
  period_end date not null,
  synced_at timestamptz not null,
  status text not null,
  ledger_snapshot jsonb not null,
  primary key (ad_account_id, period_start, period_end)
);
create table public.invoices (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  period_start date not null,
  period_end date not null,
  amount numeric(12,2) not null,
  status text not null,
  issuer_kind text,
  issued_at timestamptz,
  stripe_sent_at timestamptz,
  stripe_delivery_assumed_at timestamptz
);
create table public.historical_billing_rollovers (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  period_start date not null,
  period_end date not null,
  unique (client_id, period_start)
);
create function public.manual_invoice_authoritative_rows(
  p_client_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (billable_gross_micros numeric)
language sql stable security definer set search_path = public as $$
  select round(commission.gross_amount * 1000000, 0)
  from public.commissions commission
  join public.revenue_sources source on source.id = commission.source_id
  join public.ad_accounts account on account.id = commission.ad_account_id
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  left join public.ad_account_billing_ends billing_end
    on billing_end.ad_account_id = account.id
   and billing_end.billing_start_id = billing_start.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and source.name = 'Google Ads Management'
    and commission.status = 'confirmed'
    and commission.occurred_on between
      greatest(p_period_start, billing_start.google_local_date)
      and least(p_period_end, coalesce(billing_end.google_local_date, p_period_end))
$$;
`;

type Receipt = {
  id: string;
  state: string;
  claim_version: number;
  claimed_by_run_id: string | null;
  no_charge_reason: string | null;
  billing_cycle_skip_id: string | null;
  billable_spend_snapshot: string | number | null;
};

let db: PGlite;

async function actAsService() {
  await db.query("select set_config('test.role', 'service_role', false)");
}

async function seedProcessingItem() {
  await db.query(
    `insert into public.profiles (id, role) values ($1, 'admin')`,
    [ADMIN],
  );
  await db.query(
    `insert into public.portal_clients (id, full_name, email, approval_status)
     values ($1, 'Client', 'client@example.com', 'approved')`,
    [CLIENT],
  );
  await db.query(
    `insert into public.billing_automation_runs (id, status, issuance_enabled)
     values ($1, 'running', true)`,
    [RUN],
  );
  await db.query(
    `insert into public.billing_automation_items (
       id, client_id, period_start, period_end, state, stage,
       claimed_by_run_id, claim_version, claim_expires_at
     ) values (
       $1, $2, $3, $4, 'processing', 'discovered', $5, 1,
       clock_timestamp() + interval '5 minutes'
     )`,
    [ITEM, CLIENT, MONDAY, SUNDAY, RUN],
  );
}

async function recordNoCharge(spend: number, evidenceAccounts: number) {
  return db.query<Receipt>(
    `select * from public.record_billing_automation_item_result(
       $1, $2, 1, 'no_charge', 'complete', null, null, 0, $3, $4
     )`,
    [ITEM, RUN, spend, evidenceAccounts],
  );
}

async function addExactZeroEvidence() {
  await db.query(
    `insert into public.ad_accounts
       (id, client_id, status, currency, google_ads_customer_id)
     values ($1, $2, 'active', 'EUR', '1234567890')`,
    [ACCOUNT, CLIENT],
  );
  await db.query(
    `insert into public.ad_account_billing_starts (
       id, ad_account_id, google_local_date, google_ads_customer_id,
       google_time_zone, currency, baseline_cost_micros
     ) values ($1, $2, $3, '1234567890', 'UTC', 'EUR', 0)`,
    [START, ACCOUNT, MONDAY],
  );
  await db.query(
    `insert into public.google_ledger_sync_windows (
       ad_account_id, billing_start_id, period_start, period_end,
       synced_at, status, ledger_snapshot
     ) values (
       $1, $2, $3, $4, timestamptz '2026-07-27 01:00:00+00',
       'complete', '[]'::jsonb
     )`,
    [ACCOUNT, START, MONDAY, SUNDAY],
  );
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(PRELUDE);
  await db.exec(AUTOMATION);
  await db.exec(CYCLE_SKIPS);

  // A pre-0053 receipt can only be exact zero because the old constraint
  // rejects every positive-spend no-charge row.
  await db.query(
    `insert into public.portal_clients (id, full_name, email, approval_status)
     values ($1, 'Legacy', 'legacy@example.com', 'approved')`,
    [LEGACY_CLIENT],
  );
  await db.query(
    `insert into public.billing_automation_runs (
       id, status, issuance_enabled, finished_at, no_charge_items
     ) values ($1, 'succeeded', true, clock_timestamp(), 1)`,
    [LEGACY_RUN],
  );
  await db.query(
    `insert into public.billing_automation_items (
       id, client_id, period_start, period_end, state, stage,
       amount_snapshot, billable_spend_snapshot, evidence_account_count,
       resolved_at, last_run_id
     ) values (
       $1, $2, $3, $4, 'no_charge', 'complete', 0, 0, 1,
       clock_timestamp(), $5
     )`,
    [LEGACY_ITEM, LEGACY_CLIENT, MONDAY, SUNDAY, LEGACY_RUN],
  );

  await db.exec(RECEIPT_FIX);
  await db.exec(INVOICE_GUARD);
  await actAsService();
  await db.query(
    "insert into public.revenue_sources (id, name) values ($1, 'Google Ads Management')",
    [SOURCE],
  );
});

describe("0053 skipped-cycle no-charge receipts", () => {
  it("rejects invoice creation after the exact client cycle was skipped", async () => {
    await seedProcessingItem();
    await db.query(
      `insert into public.billing_cycle_skips (
         client_id, period_start, period_end, reason, created_by
       ) values ($1, $2, $3, 'Goodwill', $4)`,
      [CLIENT, MONDAY, SUNDAY, ADMIN],
    );

    await expect(
      db.query(
        `insert into public.invoices (
           id, client_id, period_start, period_end, amount, status
         ) values ($1, $2, $3, $4, 10, 'draft')`,
        ["53000000-0000-4000-8000-000000000099", CLIENT, MONDAY, SUNDAY],
      ),
    ).rejects.toThrow(/skipped and cannot be invoiced/i);
  });

  it("backfills only the provenance already guaranteed by the old constraint", async () => {
    const result = await db.query<Receipt>(
      "select * from public.billing_automation_items where id = $1",
      [LEGACY_ITEM],
    );
    expect(result.rows[0]).toMatchObject({
      state: "no_charge",
      no_charge_reason: "exact_zero",
      billing_cycle_skip_id: null,
    });
  });

  it("settles a skipped cycle with positive spend and pins the decision", async () => {
    await seedProcessingItem();
    const skipped = await db.query<{ id: string }>(
      `insert into public.billing_cycle_skips (
         client_id, period_start, period_end, reason, created_by
       ) values ($1, $2, $3, 'Goodwill', $4) returning id`,
      [CLIENT, MONDAY, SUNDAY, ADMIN],
    );

    const result = await recordNoCharge(1231.149839, 1);
    expect(result.rows[0]).toMatchObject({
      state: "no_charge",
      no_charge_reason: "cycle_skipped",
      billing_cycle_skip_id: skipped.rows[0].id,
    });
    expect(Number(result.rows[0].billable_spend_snapshot)).toBeCloseTo(
      1231.149839,
      6,
    );
  });

  it("keeps positive spend fail-closed when there is no skip", async () => {
    await seedProcessingItem();
    await expect(recordNoCharge(1, 1)).rejects.toThrow(
      /without a cycle skip requires exact complete zero-spend proof/i,
    );
  });

  it("retains the original exact-zero proof path", async () => {
    await seedProcessingItem();
    await addExactZeroEvidence();

    const result = await recordNoCharge(0, 1);
    expect(result.rows[0]).toMatchObject({
      state: "no_charge",
      no_charge_reason: "exact_zero",
      billing_cycle_skip_id: null,
    });
  });

  it("prevents a decision being removed after it settles a receipt", async () => {
    await seedProcessingItem();
    await db.query(
      `insert into public.billing_cycle_skips (
         client_id, period_start, period_end, reason, created_by
       ) values ($1, $2, $3, 'Goodwill', $4)`,
      [CLIENT, MONDAY, SUNDAY, ADMIN],
    );
    await recordNoCharge(25, 1);

    await expect(
      db.query("select public.remove_billing_cycle_skip($1, $2, $3)", [
        CLIENT,
        MONDAY,
        ADMIN,
      ]),
    ).rejects.toThrow(/durable no-charge receipt/i);
  });

  it("still removes a skip before automation settles it", async () => {
    await seedProcessingItem();
    await db.query(
      `insert into public.billing_cycle_skips (
         client_id, period_start, period_end, reason, created_by
       ) values ($1, $2, $3, 'Mistake', $4)`,
      [CLIENT, MONDAY, SUNDAY, ADMIN],
    );

    const removed = await db.query<{ remove_billing_cycle_skip: boolean }>(
      "select public.remove_billing_cycle_skip($1, $2, $3)",
      [CLIENT, MONDAY, ADMIN],
    );
    expect(removed.rows[0].remove_billing_cycle_skip).toBe(true);
  });

  it("recovers only an expired processing item with the exact skip", async () => {
    await seedProcessingItem();
    await db.query(
      "update public.billing_automation_runs set issuance_enabled = false where id = $1",
      [RUN],
    );
    await db.query(
      "update public.billing_automation_items set claim_expires_at = clock_timestamp() - interval '1 minute' where id = $1",
      [ITEM],
    );

    const withoutSkip = await db.query<Receipt>(
      "select * from public.claim_expired_skipped_billing_automation_items($1, 20)",
      [RUN],
    );
    expect(withoutSkip.rows).toEqual([]);

    await db.query(
      `insert into public.billing_cycle_skips (
         client_id, period_start, period_end, reason, created_by
       ) values ($1, $2, $3, 'Recovery', $4)`,
      [CLIENT, MONDAY, SUNDAY, ADMIN],
    );
    await db.query(
      "update public.billing_automation_items set claim_expires_at = clock_timestamp() + interval '1 minute' where id = $1",
      [ITEM],
    );
    const notExpired = await db.query<Receipt>(
      "select * from public.claim_expired_skipped_billing_automation_items($1, 20)",
      [RUN],
    );
    expect(notExpired.rows).toEqual([]);

    await db.query(
      "update public.billing_automation_items set claim_expires_at = clock_timestamp() - interval '1 minute' where id = $1",
      [ITEM],
    );
    const recovered = await db.query<Receipt>(
      "select * from public.claim_expired_skipped_billing_automation_items($1, 20)",
      [RUN],
    );
    expect(recovered.rows).toHaveLength(1);
    expect(recovered.rows[0]).toMatchObject({
      id: ITEM,
      state: "processing",
      claim_version: 2,
      claimed_by_run_id: RUN,
    });

    const repeated = await db.query<Receipt>(
      "select * from public.claim_expired_skipped_billing_automation_items($1, 20)",
      [RUN],
    );
    expect(repeated.rows).toEqual([]);
  });

  it("refuses recovery through an issuance-enabled run", async () => {
    await seedProcessingItem();
    await expect(
      db.query(
        "select * from public.claim_expired_skipped_billing_automation_items($1, 20)",
        [RUN],
      ),
    ).rejects.toThrow(/active non-issuance run/i);
  });

  it("prevents a recovery run from recording an issued invoice", async () => {
    await seedProcessingItem();
    await db.query(
      "update public.billing_automation_runs set issuance_enabled = false where id = $1",
      [RUN],
    );

    await expect(
      db.query(
        `select * from public.record_billing_automation_item_result(
           $1, $2, 1, 'issued', 'complete', null,
           '53000000-0000-4000-8000-000000000099', 10, 100, 1
         )`,
        [ITEM, RUN],
      ),
    ).rejects.toThrow(/non-issuance automation run cannot record/i);
  });

  it("keeps the recovery claim service-only", async () => {
    await seedProcessingItem();
    await db.query(
      "update public.billing_automation_runs set issuance_enabled = false where id = $1",
      [RUN],
    );
    await db.query("select set_config('test.role', 'authenticated', false)");

    await expect(
      db.query(
        "select * from public.claim_expired_skipped_billing_automation_items($1, 20)",
        [RUN],
      ),
    ).rejects.toThrow(/only the billing service/i);
  });
});
