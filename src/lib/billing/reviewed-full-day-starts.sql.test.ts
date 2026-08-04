import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0034_reviewed_full_day_billing_starts.sql",
  "utf8",
);

const productionFixtureSource = readFileSync(
  "src/lib/billing/manual-referrals.sql.test.ts",
  "utf8",
);
const productionPreludeMatch = /const PRELUDE = `([\s\S]*?)`;\n\nlet db:/.exec(
  productionFixtureSource,
);
if (!productionPreludeMatch) {
  throw new Error("Could not load the production billing SQL test prelude.");
}
const PRODUCTION_PRELUDE = productionPreludeMatch[1];
const PRODUCTION_MIGRATIONS_BEFORE_REVIEWED = [
  "0028_manual_agency_billing.sql",
  "0029_legacy_billing_cutover.sql",
  "0030_manual_referral_discounts.sql",
  "0031_manual_referral_attribution.sql",
  "0032_billing_issue_leases.sql",
  "0033_disable_direct_invoice_inserts.sql",
].map((name) => readFileSync(`supabase/migrations/${name}`, "utf8"));
const HISTORICAL_ROLLOVER_MIGRATION = readFileSync(
  "supabase/migrations/0035_historical_full_day_rollover.sql",
  "utf8",
);

const ADMIN = "35000000-0000-4000-8000-000000000001";
const CLIENT = "35000000-0000-4000-8000-000000000002";
const STAFF_CLIENT = "35000000-0000-4000-8000-000000000003";
const PRE_ACCOUNT = "35000000-0000-4000-8000-000000000004";
const ZERO_ACCOUNT = "35000000-0000-4000-8000-000000000005";
const POST_ACCOUNT = "35000000-0000-4000-8000-000000000006";
const STAFF_ACCOUNT = "35000000-0000-4000-8000-000000000007";
const OBSERVED_ACCOUNT = "35000000-0000-4000-8000-000000000008";
const OBSERVED_START = "35000000-0000-4000-8000-000000000009";
const OBSERVED_CAPTURE = "35000000-0000-4000-8000-000000000010";
const SOURCE = "35000000-0000-4000-8000-000000000011";
const COMMISSION = "35000000-0000-4000-8000-000000000012";
const PRE_METADATA_CAPTURE = "35000000-0000-4000-8000-000000000013";
const ZERO_METADATA_CAPTURE = "35000000-0000-4000-8000-000000000014";

const POLICY_VERSION =
  "agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2";

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

create table public.profiles (
  id uuid primary key,
  role text not null
);
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles profile
    where profile.id = auth.uid() and profile.role = 'admin'
  )
$$;

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null,
  approval_status text not null
);

create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  store_name text not null,
  google_ads_customer_id text,
  status text not null,
  currency text not null,
  commission_rate numeric not null default 10,
  list_commission_rate numeric not null default 10,
  revenue_share_enabled boolean not null default false,
  google_ads_connected boolean not null default false,
  google_ads_refresh_token text,
  google_ads_connected_email text,
  shopify_url text,
  shopify_admin_token text,
  created_at timestamptz not null
);

create table public.manual_referral_billing_config (
  singleton boolean primary key,
  v3_cutover_monday date not null
);

create table public.ad_account_billing_starts (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique references public.ad_accounts(id),
  google_ads_customer_id text not null check (google_ads_customer_id ~ '^[0-9]{10}$'),
  google_local_date date not null,
  google_time_zone text not null check (btrim(google_time_zone) <> ''),
  currency text not null check (currency = 'EUR'),
  baseline_cost_micros numeric(24,0) not null check (baseline_cost_micros >= 0),
  capture_started_at timestamptz not null,
  captured_at timestamptz not null,
  capture_id uuid not null unique,
  source text not null check (source = 'agency'),
  reviewed_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (captured_at >= capture_started_at)
);
alter table public.ad_account_billing_starts enable row level security;
create policy ad_account_billing_starts_admin_read
  on public.ad_account_billing_starts for select using (public.is_admin());

create function public.guard_ad_account_billing_start_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'A Google billing start is immutable.';
end
$$;
create trigger ad_account_billing_starts_guard_immutable
  before update or delete on public.ad_account_billing_starts
  for each row execute function public.guard_ad_account_billing_start_immutable();

create table public.ad_account_billing_ends (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique references public.ad_accounts(id),
  billing_start_id uuid not null unique references public.ad_account_billing_starts(id),
  google_ads_customer_id text not null,
  google_local_date date not null,
  google_time_zone text not null,
  currency text not null,
  end_cost_micros numeric(24,0) not null,
  capture_started_at timestamptz not null,
  captured_at timestamptz not null,
  capture_id uuid not null unique,
  source text not null,
  reviewed_by uuid not null references public.profiles(id)
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
  rate numeric not null,
  amount numeric(18,6) not null,
  currency text not null,
  status text not null,
  updated_at timestamptz not null default now()
);

create table public.google_ledger_sync_windows (
  ad_account_id uuid not null references public.ad_accounts(id),
  billing_start_id uuid not null references public.ad_account_billing_starts(id),
  billing_end_id uuid references public.ad_account_billing_ends(id),
  period_start date not null,
  period_end date not null,
  status text not null,
  synced_at timestamptz not null,
  ledger_snapshot jsonb not null,
  primary key (ad_account_id, period_start, period_end)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  period_start date not null,
  period_end date not null,
  amount numeric(12,2) not null,
  line_items jsonb not null default '[]'
);

create function public.manual_referral_rate_text(p_rate numeric)
returns text language sql immutable as $$ select p_rate::text $$;

-- Focused catalog fixture: 0034 must find and replace the same three audited
-- regions of the production v3 function. The reconstructed region is valid
-- SQL before replacement, so pg_get_functiondef preserves exact body text.
create function public.create_manual_referral_invoice(
  p_client_id uuid,
  p_period_start date,
  p_period_end date,
  p_amount numeric,
  p_line_items jsonb,
  p_ledger_rows jsonb,
  p_billing_recipient jsonb,
  p_referral_term_id uuid,
  p_issued_by uuid,
  p_calculation_version text
)
returns setof public.invoices
language plpgsql security definer set search_path = public as $$
declare
  account_count integer;
  valid_lines integer;
  commercial_term record;
begin
  lock table public.ad_account_billing_starts in share row exclusive mode;
  lock table public.ad_account_billing_ends in share row exclusive mode;

  select
    count(*) filter (
      where upper(account.currency) = 'EUR'
        and billing_start.currency = 'EUR'
        and billing_start.google_ads_customer_id = account.google_ads_customer_id
        and not exists (
          select 1 from public.commissions invalid_commission
          where invalid_commission.ad_account_id = account.id
        )
    )
    into account_count
  from public.ad_accounts account
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id;

  -- Reconstruct every visible field and the exact Stripe/local description.
  with store as (
    select 0::numeric as start_baseline_rounded, ''::text as expected_label
  ), line as (
    select 0::numeric as "billingStartBaselineAmount", ''::text as label
  )
  select count(*) into valid_lines
  from store cross join line
  where line."billingStartBaselineAmount" = store.start_baseline_rounded
    and line.label = store.expected_label;

  return;
end
$$;

grant usage on schema public to authenticated, anon, service_role;
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;
grant execute on function public.create_manual_referral_invoice(
  uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text
) to service_role;
`;

type ReviewedMetadata = {
  accountId: string;
  captureId: string;
  customerId: string;
  googleLocalDate: string;
  googleTimeZone: string;
  captureStartedAt?: string;
  capturedAt?: string;
};

async function commitReviewedStart(
  db: PGlite,
  metadata: ReviewedMetadata,
) {
  await db.query("select set_config('test.role', 'service_role', false)");
  return db.query<{
    id: string;
    ad_account_id: string;
    google_local_date: string;
    google_time_zone: string;
    start_basis: string;
  }>(
    `select id, ad_account_id, google_local_date::text, google_time_zone,
            start_basis
     from public.commit_reviewed_full_day_billing_start(
       $1, $2, $3, $4, $5, 'EUR', $6, $7,
       'client_oauth', 'google-customer-metadata-v1'
     )`,
    [
      metadata.accountId,
      metadata.captureId,
      metadata.customerId,
      metadata.googleLocalDate,
      metadata.googleTimeZone,
      metadata.captureStartedAt ?? "2026-08-04T09:00:00Z",
      metadata.capturedAt ?? "2026-08-04T09:00:01Z",
    ],
  );
}

async function database(options: { commitReviewed?: boolean } = {}) {
  const { commitReviewed = true } = options;
  const db = new PGlite();
  await db.exec(PRELUDE);
  await db.query(
    `insert into public.profiles (id, role)
     values ($1, 'admin'), ($2, 'admin')`,
    [ADMIN, STAFF_CLIENT],
  );
  await db.query(
    `insert into public.portal_clients (id, full_name, email, approval_status)
     values
       ($1, 'Client', 'client@example.com', 'approved'),
       ($2, 'Staff', 'staff@example.com', 'approved')`,
    [CLIENT, STAFF_CLIENT],
  );
  await db.query(
    `insert into public.manual_referral_billing_config
       (singleton, v3_cutover_monday)
     values (true, '2026-08-03')`,
  );
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, google_ads_customer_id, status, currency,
       google_ads_connected, google_ads_refresh_token,
       google_ads_connected_email, shopify_url,
       shopify_admin_token, created_at
     ) values
       ($1, $6, 'Pre-cutover', '1111111111', 'active', 'EUR', true,
        'encrypted-google-secret', 'owner@example.com', 'secret.myshopify.com',
        'encrypted-shopify-secret', '2026-07-30T23:30:00Z'),
       ($2, $6, 'Zero spend', '2222222222', 'suspended', 'EUR', false,
        null, null, null, null, '2026-07-23T12:00:00Z'),
       ($3, $6, 'Post-cutover', '3333333333', 'active', 'EUR', true,
        null, null, null, null, '2026-08-04T09:00:00Z'),
       ($4, $7, 'Staff account', '4444444444', 'active', 'EUR', true,
        null, null, null, null, '2026-07-20T09:00:00Z'),
       ($5, $6, 'Observed account', '5555555555', 'active', 'EUR', true,
        null, null, null, null, '2026-07-25T09:00:00Z')`,
    [
      PRE_ACCOUNT,
      ZERO_ACCOUNT,
      POST_ACCOUNT,
      STAFF_ACCOUNT,
      OBSERVED_ACCOUNT,
      CLIENT,
      STAFF_CLIENT,
    ],
  );
  await db.query(
    `insert into public.ad_account_billing_starts (
       id, ad_account_id, google_ads_customer_id, google_local_date,
       google_time_zone, currency, baseline_cost_micros, capture_started_at,
       captured_at, capture_id, source, reviewed_by
     ) values (
       $1, $2, '5555555555', '2026-07-25', 'Europe/Lisbon', 'EUR', 123000000,
       '2026-07-25T10:00:00Z', '2026-07-25T10:00:01Z', $3, 'agency', $4
     )`,
    [OBSERVED_START, OBSERVED_ACCOUNT, OBSERVED_CAPTURE, ADMIN],
  );
  await db.query(
    `insert into public.revenue_sources (id, name)
     values ($1, 'Google Ads Management')`,
    [SOURCE],
  );
  await db.query(
    `insert into public.commissions (
       id, source_id, ad_account_id, occurred_on, gross_amount, rate, amount,
       currency, status
     ) values ($1, $2, $3, '2026-07-31', 96.200000, 10, 9.620000,
       'EUR', 'confirmed')`,
    [COMMISSION, SOURCE, PRE_ACCOUNT],
  );
  await db.exec(MIGRATION);
  if (commitReviewed) {
    await commitReviewedStart(db, {
      accountId: PRE_ACCOUNT,
      captureId: PRE_METADATA_CAPTURE,
      customerId: "1111111111",
      // 23:30 UTC is already the next commercial day in Lisbon but remains
      // the previous Google reporting day in New York.
      googleLocalDate: "2026-07-30",
      googleTimeZone: "America/New_York",
    });
  }
  return db;
}

describe("reviewed full-day recurring billing starts", () => {
  it("leaves every account without live metadata unresolved instead of bulk-sealing it", async () => {
    const db = await database({ commitReviewed: false });
    try {
      const unresolved = await db.query<{
        boundary_count: number;
        reviewed_start_count: number;
      }>(
        `select
           (select count(*)::int
              from public.reviewed_full_day_billing_boundaries) as boundary_count,
           (select count(*)::int
              from public.ad_account_billing_starts
             where start_basis = 'reviewed_full_day') as reviewed_start_count`,
      );
      expect(unresolved.rows[0]).toEqual({
        boundary_count: 0,
        reviewed_start_count: 0,
      });

      const observed = await db.query<{
        start_basis: string;
        baseline_cost_micros: string;
        reviewed_full_day_boundary_id: string | null;
      }>(
        `select start_basis, baseline_cost_micros,
                reviewed_full_day_boundary_id
         from public.ad_account_billing_starts where id = $1`,
        [OBSERVED_START],
      );
      expect(observed.rows[0]).toEqual({
        start_basis: "observed_google_counter",
        baseline_cost_micros: "123000000",
        reviewed_full_day_boundary_id: null,
      });
    } finally {
      await db.close();
    }
  }, 15_000);

  it("commits only the evidenced account and separates Lisbon entry from Google reporting", async () => {
    const db = await database();
    try {
      const rows = await db.query<{
        ad_account_id: string;
        entry_day: string;
        entry_time_zone: string;
        google_local_date: string;
        google_time_zone: string;
        metadata_authority: string;
        policy_version: string;
        start_basis: string;
        baseline_cost_micros: string | null;
        captured_at: Date | null;
        capture_id: string | null;
        reviewed_by: string | null;
      }>(
        `select boundary.ad_account_id, boundary.entry_day::text,
                boundary.entry_time_zone,
                boundary.google_local_date::text,
                boundary.google_time_zone,
                boundary.metadata_authority,
                boundary.policy_version, billing_start.start_basis,
                billing_start.baseline_cost_micros,
                billing_start.captured_at, billing_start.capture_id,
                billing_start.reviewed_by
         from public.reviewed_full_day_billing_boundaries boundary
         join public.ad_account_billing_starts billing_start
           on billing_start.reviewed_full_day_boundary_id = boundary.id
         order by boundary.ad_account_id`,
      );
      expect(rows.rows).toEqual([
        {
          ad_account_id: PRE_ACCOUNT,
          entry_day: "2026-07-31",
          entry_time_zone: "Europe/Lisbon",
          google_local_date: "2026-07-30",
          google_time_zone: "America/New_York",
          metadata_authority: "client_oauth",
          policy_version: POLICY_VERSION,
          start_basis: "reviewed_full_day",
          baseline_cost_micros: null,
          captured_at: null,
          capture_id: null,
          reviewed_by: null,
        },
      ]);

      const excluded = await db.query<{
        account_id: string;
        start_count: number;
        proof_count: number;
      }>(
        `select
           account.id as account_id,
           (select count(*)::int from public.ad_account_billing_starts
             where ad_account_id = account.id) as start_count,
           (select count(*)::int from public.reviewed_full_day_billing_boundaries
             where ad_account_id = account.id) as proof_count
         from public.ad_accounts account
         where account.id in ($1, $2)
         order by account.id`,
        [ZERO_ACCOUNT, POST_ACCOUNT],
      );
      expect(excluded.rows).toEqual([
        { account_id: ZERO_ACCOUNT, start_count: 0, proof_count: 0 },
        { account_id: POST_ACCOUNT, start_count: 0, proof_count: 0 },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("stores only the financial classification allowlist, never account secrets", async () => {
    const db = await database();
    try {
      const result = await db.query<{
        source_snapshot: Record<string, unknown>;
        source_fingerprint: string;
      }>(
        `select source_snapshot, source_fingerprint
         from public.reviewed_full_day_billing_boundaries
         where ad_account_id = $1`,
        [PRE_ACCOUNT],
      );
      const snapshot = result.rows[0].source_snapshot;
      expect(Object.keys(snapshot).sort()).toEqual(
        [
          "accountCreatedAt",
          "accountId",
          "clientId",
          "commissionRate",
          "currency",
          "entryDay",
          "entryTimeZone",
          "googleAdsConnected",
          "googleAdsCustomerId",
          "googleLocalDate",
          "googleTimeZone",
          "listCommissionRate",
          "metadataAuthority",
          "metadataCaptureId",
          "metadataCapturedAt",
          "metadataCaptureStartedAt",
          "metadataContract",
          "revenueShareEnabled",
          "status",
          "storeName",
        ].sort(),
      );
      expect(snapshot).toMatchObject({
        entryDay: "2026-07-31",
        entryTimeZone: "Europe/Lisbon",
        googleLocalDate: "2026-07-30",
        googleTimeZone: "America/New_York",
        metadataAuthority: "client_oauth",
        metadataContract: "google-customer-metadata-v1",
      });
      expect(JSON.stringify(snapshot)).not.toContain("encrypted-google-secret");
      expect(JSON.stringify(snapshot)).not.toContain("encrypted-shopify-secret");
      expect(JSON.stringify(snapshot)).not.toContain("owner@example.com");
      expect(JSON.stringify(snapshot)).not.toContain("secret.myshopify.com");
      expect(result.rows[0].source_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await db.close();
    }
  });

  it("is service-only, idempotent for one capture and rejects capture reuse or replacement", async () => {
    const db = await database();
    const exactMetadata: ReviewedMetadata = {
      accountId: PRE_ACCOUNT,
      captureId: PRE_METADATA_CAPTURE,
      customerId: "1111111111",
      googleLocalDate: "2026-07-30",
      googleTimeZone: "America/New_York",
    };
    try {
      const before = await db.query<{ id: string }>(
        `select id from public.ad_account_billing_starts
         where ad_account_id = $1`,
        [PRE_ACCOUNT],
      );
      const replay = await commitReviewedStart(db, exactMetadata);
      expect(replay.rows).toEqual([
        expect.objectContaining({
          id: before.rows[0].id,
          ad_account_id: PRE_ACCOUNT,
          google_local_date: "2026-07-30",
          google_time_zone: "America/New_York",
          start_basis: "reviewed_full_day",
        }),
      ]);

      await expect(
        commitReviewedStart(db, {
          ...exactMetadata,
          googleLocalDate: "2026-07-31",
          googleTimeZone: "Europe/Lisbon",
        }),
      ).rejects.toThrow(/capture id cannot be replayed/i);

      await expect(
        commitReviewedStart(db, {
          ...exactMetadata,
          captureId: "35000000-0000-4000-8000-000000000015",
        }),
      ).rejects.toThrow(/already has a different Google billing start/i);

      await db.query("select set_config('test.role', 'authenticated', false)");
      await expect(
        db.query(
          `select * from public.commit_reviewed_full_day_billing_start(
             $1, $2, '1111111111', '2026-07-30', 'America/New_York',
             'EUR', '2026-08-04T09:00:00Z', '2026-08-04T09:00:01Z',
             'client_oauth', 'google-customer-metadata-v1'
           )`,
          [PRE_ACCOUNT, PRE_METADATA_CAPTURE],
        ),
      ).rejects.toThrow(/only the service role/i);
    } finally {
      await db.close();
    }
  });

  it("keeps a disconnected account unstarted without affecting an evidenced account", async () => {
    const db = await database();
    try {
      await expect(
        commitReviewedStart(db, {
          accountId: ZERO_ACCOUNT,
          captureId: ZERO_METADATA_CAPTURE,
          customerId: "2222222222",
          googleLocalDate: "2026-07-23",
          googleTimeZone: "Europe/Lisbon",
        }),
      ).rejects.toThrow(/not eligible/i);

      const counts = await db.query<{
        resolved_count: number;
        unresolved_count: number;
      }>(
        `select
           count(*) filter (where ad_account_id = $1)::int as resolved_count,
           count(*) filter (where ad_account_id = $2)::int as unresolved_count
         from public.ad_account_billing_starts`,
        [PRE_ACCOUNT, ZERO_ACCOUNT],
      );
      expect(counts.rows[0]).toEqual({
        resolved_count: 1,
        unresolved_count: 0,
      });
    } finally {
      await db.close();
    }
  });

  it("rejects an invalid Google zone and detects a corrupted replay receipt", async () => {
    const db = await database({ commitReviewed: false });
    try {
      await expect(
        commitReviewedStart(db, {
          accountId: PRE_ACCOUNT,
          captureId: PRE_METADATA_CAPTURE,
          customerId: "1111111111",
          googleLocalDate: "2026-07-30",
          googleTimeZone: "Not/A_Real_Zone",
        }),
      ).rejects.toThrow(/recognised IANA/i);

      await commitReviewedStart(db, {
        accountId: PRE_ACCOUNT,
        captureId: PRE_METADATA_CAPTURE,
        customerId: "1111111111",
        googleLocalDate: "2026-07-30",
        googleTimeZone: "America/New_York",
      });
      await db.exec(
        "alter table public.reviewed_full_day_billing_boundaries disable trigger reviewed_full_day_billing_boundaries_guard_immutable",
      );
      await db.query(
        `update public.reviewed_full_day_billing_boundaries
         set source_fingerprint = repeat('0', 32)
         where ad_account_id = $1`,
        [PRE_ACCOUNT],
      );
      await db.exec(
        "alter table public.reviewed_full_day_billing_boundaries enable trigger reviewed_full_day_billing_boundaries_guard_immutable",
      );

      await expect(
        commitReviewedStart(db, {
          accountId: PRE_ACCOUNT,
          captureId: PRE_METADATA_CAPTURE,
          customerId: "1111111111",
          googleLocalDate: "2026-07-30",
          googleTimeZone: "America/New_York",
        }),
      ).rejects.toThrow(/fingerprint is invalid/i);
    } finally {
      await db.close();
    }
  });

  it("bills from the complete Google reporting day while keeping the nonexistent counter null", async () => {
    const db = await database();
    try {
      const result = await db.query<{
        billing_started_at: Date | null;
        billing_start_baseline_micros: string | null;
        opening_baseline_applied: boolean;
        baseline_deduction_amount: string;
        billable_gross_amount: string;
      }>(
        `select billing_started_at, billing_start_baseline_micros,
                opening_baseline_applied, baseline_deduction_amount,
                billable_gross_amount
         from public.manual_invoice_authoritative_rows(
           $1, '2026-07-27', '2026-08-02'
         )`,
        [CLIENT],
      );
      expect(result.rows).toEqual([
        {
          billing_started_at: null,
          billing_start_baseline_micros: null,
          opening_baseline_applied: false,
          baseline_deduction_amount: "0.000000000000000000000000",
          billable_gross_amount: "96.2000000000000000",
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it("patches v3 validation and keeps proof/start rows immutable and service read-only", async () => {
    const db = await database();
    try {
      const source = await db.query<{ definition: string }>(
        `select pg_get_functiondef(
           'public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure
         ) as definition`,
      );
      expect(source.rows[0].definition).toContain(
        "reviewed_full_day_billing_boundaries",
      );
      expect(source.rows[0].definition).toContain(
        'line."billingStartBasis" = store.billing_start_basis',
      );
      expect(source.rows[0].definition).toContain(
        "not (item ? 'billingStartedAt')",
      );

      const privileges = await db.query<{
        proof_select: boolean;
        proof_insert: boolean;
        start_select: boolean;
        start_insert: boolean;
        rpc_service_execute: boolean;
        rpc_authenticated_execute: boolean;
      }>(`
        select
          has_table_privilege(
            'service_role', 'public.reviewed_full_day_billing_boundaries', 'SELECT'
          ) as proof_select,
          has_table_privilege(
            'service_role', 'public.reviewed_full_day_billing_boundaries', 'INSERT'
          ) as proof_insert,
          has_table_privilege(
            'service_role', 'public.ad_account_billing_starts', 'SELECT'
          ) as start_select,
          has_table_privilege(
            'service_role', 'public.ad_account_billing_starts', 'INSERT'
          ) as start_insert,
          has_function_privilege(
            'service_role',
            'public.commit_reviewed_full_day_billing_start(uuid,uuid,text,date,text,text,timestamptz,timestamptz,text,text)',
            'EXECUTE'
          ) as rpc_service_execute,
          has_function_privilege(
            'authenticated',
            'public.commit_reviewed_full_day_billing_start(uuid,uuid,text,date,text,text,timestamptz,timestamptz,text,text)',
            'EXECUTE'
          ) as rpc_authenticated_execute
      `);
      expect(privileges.rows[0]).toEqual({
        proof_select: true,
        proof_insert: false,
        start_select: true,
        start_insert: false,
        rpc_service_execute: true,
        rpc_authenticated_execute: false,
      });

      await expect(
        db.query(
          `update public.reviewed_full_day_billing_boundaries
           set entry_day = '2026-07-30' where ad_account_id = $1`,
          [PRE_ACCOUNT],
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        db.query(
          `update public.ad_account_billing_starts
           set baseline_cost_micros = 0 where ad_account_id = $1`,
          [PRE_ACCOUNT],
        ),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await db.close();
    }
  });

  it("can run before 0035 and keeps both catalog patches valid", async () => {
    const db = new PGlite();
    try {
      await db.exec(PRODUCTION_PRELUDE);
      for (const migration of PRODUCTION_MIGRATIONS_BEFORE_REVIEWED) {
        await db.exec(migration);
      }
      await db.query(
        `insert into public.portal_clients (
           id, full_name, email, approval_status, referral_code
         ) values ($1, 'Real schema client', 'real@example.com', 'approved', 'REAL35')`,
        [CLIENT],
      );
      // Reproduce the deployed pre-v3 legacy row. Current application writes
      // cannot create an active account without a live start, by design.
      await db.exec(
        "alter table public.ad_accounts disable trigger ad_accounts_guard_billing_identity",
      );
      await db.query(
        `insert into public.ad_accounts (
           id, client_id, store_name, google_ads_customer_id, status, currency,
           google_ads_connected, created_at
         ) values (
           $1, $2, 'Real schema account', '6666666666', 'active', 'EUR',
           true, '2026-08-02T10:00:00Z'
         )`,
        [PRE_ACCOUNT, CLIENT],
      );
      await db.exec(
        "alter table public.ad_accounts enable trigger ad_accounts_guard_billing_identity",
      );

      await db.exec(MIGRATION);
      await commitReviewedStart(db, {
        accountId: PRE_ACCOUNT,
        captureId: PRE_METADATA_CAPTURE,
        customerId: "6666666666",
        googleLocalDate: "2026-08-02",
        googleTimeZone: "Europe/Lisbon",
      });
      // The rollout installs reviewed starts first. The historical rollover
      // remains independently applicable afterwards and must preserve this
      // migration's catalog patch.
      await db.exec(HISTORICAL_ROLLOVER_MIGRATION);

      const start = await db.query<{
        start_basis: string;
        baseline_cost_micros: string | null;
        captured_at: Date | null;
      }>(
        `select start_basis, baseline_cost_micros, captured_at
         from public.ad_account_billing_starts where ad_account_id = $1`,
        [PRE_ACCOUNT],
      );
      expect(start.rows[0]).toEqual({
        start_basis: "reviewed_full_day",
        baseline_cost_micros: null,
        captured_at: null,
      });

      const definition = await db.query<{ body: string }>(
        `select pg_get_functiondef(
           'public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure
         ) as body`,
      );
      expect(definition.rows[0].body).toContain(
        "billing_start.start_basis = 'reviewed_full_day'",
      );
      expect(definition.rows[0].body).toContain(
        'line."reviewedFullDayBoundaryId" =',
      );

      await db.query(
        `insert into public.billing_profiles (client_id)
         values ($1)`,
        [CLIENT],
      );
      await db.query(
        `insert into public.revenue_sources (id, name)
         values ($1, 'Google Ads Management')`,
        [SOURCE],
      );
      await db.query(
        `insert into public.commissions (
           id, source_id, ad_account_id, occurred_on, gross_amount, rate,
           amount, currency, status
         ) values (
           $1, $2, $3, '2026-08-02', 96.200000, 10, 9.620000,
           'EUR', 'confirmed'
         )`,
        [COMMISSION, SOURCE, PRE_ACCOUNT],
      );

      const proof = await db.query<{
        start_id: string;
        boundary_id: string;
      }>(
        `select billing_start.id as start_id, boundary.id as boundary_id
         from public.ad_account_billing_starts billing_start
         join public.reviewed_full_day_billing_boundaries boundary
           on boundary.id = billing_start.reviewed_full_day_boundary_id
         where billing_start.ad_account_id = $1`,
        [PRE_ACCOUNT],
      );
      await db.query(
        `insert into public.google_ledger_sync_windows (
           ad_account_id, billing_start_id, billing_end_id, period_start,
           period_end, run_id, status, started_at, synced_at, ledger_snapshot
         ) values (
           $1, $2, null, '2026-07-27', '2026-08-02', $3,
           'complete', '2026-08-03T14:10:00Z', '2026-08-03T14:10:01Z',
           $4::jsonb
         )`,
        [
          PRE_ACCOUNT,
          proof.rows[0].start_id,
          OBSERVED_CAPTURE,
          JSON.stringify([
            {
              id: COMMISSION,
              occurred_on: "2026-08-02",
              gross_amount: "96.200000",
              currency: "EUR",
              status: "confirmed",
            },
          ]),
        ],
      );

      const line = {
        accountId: PRE_ACCOUNT,
        kind: "fee",
        store: "Real schema account",
        label:
          `Real schema account - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 96.200000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%; billing began under reviewed full-day policy ${POLICY_VERSION}; full Europe/Lisbon Google reporting day 2026-08-02 included; commercial entry 2026-08-02 in Europe/Lisbon; first billable period 2026-08-02 to 2026-08-02; Google-reported spend EUR 96.200000)`,
        rate: 10,
        amount: 9.62,
        listRate: 10,
        referralDiscountRate: 0,
        referralCount: 0,
        baseAmount: 96.2,
        sourceGrossAmount: 96.2,
        billingStartBasis: "reviewed_full_day",
        billingStartId: proof.rows[0].start_id,
        billingStartDate: "2026-08-02",
        billingTimeZone: "Europe/Lisbon",
        reviewedFullDayBoundaryId: proof.rows[0].boundary_id,
        billingPolicyVersion: POLICY_VERSION,
        entryDate: "2026-08-02",
        entryTimeZone: "Europe/Lisbon",
        entryDayTreatment: "full-day-inclusive",
      };
      const recipient = {
        email: "real@example.com",
        fallbackName: "Real schema client",
        billingName: null,
        taxId: null,
        addressLine1: null,
        addressLine2: null,
        addressCity: null,
        addressPostalCode: null,
        addressState: null,
        addressCountry: null,
      };
      await db.query(
        "select set_config('test.role', 'service_role', false)",
      );
      // The fixed test clock is 2026-08-04. Move only the isolated fixture's
      // v3 floor back one week so the closed entry-day line can execute.
      await db.query(
        `update public.manual_referral_billing_config
         set v3_cutover_monday = '2026-07-27' where singleton`,
      );
      const invoice = await db.query<{
        amount: string;
        issuer_kind: string;
        issued_by: string | null;
        line_items: Record<string, unknown>[];
      }>(
        `select * from public.create_manual_referral_invoice(
           $1, '2026-07-27', '2026-08-02', 9.62, $2::jsonb, $3::jsonb,
           $4::jsonb, null, null,
           'agency-fee-eur-v3-manual-referrals-google-boundaries'
         )`,
        [
          CLIENT,
          JSON.stringify([line]),
          JSON.stringify([{ commission_id: COMMISSION }]),
          JSON.stringify(recipient),
        ],
      );
      expect(invoice.rows[0]).toMatchObject({
        amount: "9.62",
        issuer_kind: "automation",
        issued_by: null,
        line_items: [expect.objectContaining({
          billingStartBasis: "reviewed_full_day",
          reviewedFullDayBoundaryId: proof.rows[0].boundary_id,
        })],
      });
      expect(invoice.rows[0].line_items[0]).not.toHaveProperty(
        "billingStartedAt",
      );
      expect(invoice.rows[0].line_items[0]).not.toHaveProperty(
        "billingStartBaselineAmount",
      );
    } finally {
      await db.close();
    }
  });
});
