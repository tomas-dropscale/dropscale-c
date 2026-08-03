import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0026_manual_agency_billing.sql",
  "utf8",
);

const ADMIN = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const ACCOUNT = "00000000-0000-4000-8000-000000000003";
const SOURCE = "00000000-0000-4000-8000-000000000004";
const ROW_A = "00000000-0000-4000-8000-000000000005";
const ROW_B = "00000000-0000-4000-8000-000000000006";
const ROW_C = "00000000-0000-4000-8000-000000000007";
const CAPTURE = "00000000-0000-4000-8000-000000000008";
const REQUEST = "00000000-0000-4000-8000-000000000009";
const END_CAPTURE = "00000000-0000-4000-8000-000000000010";
const START = "2026-07-20";
const END = "2026-07-26";
const VERSION = "agency-fee-eur-10-v2-google-baseline";

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
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create or replace function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);

create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles profile
    where profile.id = auth.uid() and profile.role = 'admin'
  )
$$;

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null,
  approval_status text not null,
  stripe_customer_id text
);

alter table public.portal_clients enable row level security;
create policy portal_clients_update_self on public.portal_clients
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients (id),
  store_name text not null,
  currency text not null default 'EUR',
  google_ads_customer_id text,
  status text not null default 'active',
  google_ads_connected boolean not null default false,
  google_ads_refresh_token text,
  google_ads_connected_email text,
  commission_rate numeric not null default 10,
  list_commission_rate numeric not null default 10,
  revenue_share_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.account_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients (id),
  request_type text not null,
  google_ads_customer_id text,
  store_name text,
  shopify_collaborator_code text,
  myshopify_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create or replace function public.effective_commission_rate(
  p_client_id uuid,
  p_list numeric
) returns numeric language sql stable as $$
  select p_list
$$;

create table public.revenue_sources (
  id uuid primary key,
  name text not null
);

create table public.commissions (
  id uuid primary key,
  source_id uuid not null references public.revenue_sources (id),
  ad_account_id uuid references public.ad_accounts (id),
  occurred_on date not null,
  gross_amount numeric not null,
  rate numeric not null default 10,
  amount numeric not null default 0,
  currency text not null,
  status text not null,
  updated_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  amount numeric(12,2) not null,
  currency text not null default 'EUR',
  status text not null default 'draft',
  due_date date,
  line_items jsonb not null default '[]',
  stripe_invoice_id text unique,
  stripe_hosted_url text,
  issued_at timestamptz,
  paid_at timestamptz,
  payment_failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, period_start)
);

alter table public.invoices enable row level security;
create policy invoices_client_read on public.invoices
  for select using (client_id = auth.uid() or public.is_admin());
create policy invoices_admin_all on public.invoices
  for all using (public.is_admin()) with check (public.is_admin());

create or replace function public.set_workspace_stripe_customer(
  p_client_id uuid,
  p_customer_id text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.portal_clients
  set stripe_customer_id = p_customer_id
  where id = p_client_id;
end
$$;
grant execute on function public.set_workspace_stripe_customer(uuid, text)
  to authenticated;

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;
`;

type LedgerSeed = { id: string; date: string; gross: string };

let db: PGlite;

async function actAs(id: string | null, role = id ? "authenticated" : "") {
  await db.query(
    "select set_config('test.uid', $1, false), set_config('test.role', $2, false)",
    [id ?? "", role],
  );
}

async function actAsService() {
  await actAs(null, "service_role");
}

function dayAfter(iso: string): string {
  const value = new Date(`${iso}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function commitStart(options?: {
  accountId?: string | null;
  requestId?: string | null;
  customerId?: string;
  startDate?: string;
  timeZone?: string;
  baselineMicros?: string;
  captureId?: string;
  reviewedBy?: string;
  source?: string;
  capturedAt?: string;
  assumeRole?: boolean;
}) {
  const startDate = options?.startDate ?? START;
  const capturedAt = options?.capturedAt ?? `${startDate}T12:00:00.000Z`;
  if (options?.assumeRole !== false) await actAsService();
  return db.query(
    `select * from public.commit_google_ads_billing_start(
       $1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, 'EUR', $7::numeric,
       $8::timestamptz, $9::timestamptz, $10, $11::uuid
     )`,
    [
      options?.accountId === undefined ? ACCOUNT : options.accountId,
      options?.requestId ?? null,
      options?.captureId ?? CAPTURE,
      options?.customerId ?? "1234567890",
      startDate,
      options?.timeZone ?? "UTC",
      options?.baselineMicros ?? "0",
      capturedAt,
      capturedAt,
      options?.source ?? "agency",
      options?.reviewedBy ?? ADMIN,
    ],
  );
}

async function commitEnd(options?: {
  accountId?: string;
  captureId?: string;
  customerId?: string;
  endDate?: string;
  timeZone?: string;
  endMicros?: string;
  captureStartedAt?: string;
  capturedAt?: string;
  source?: string;
  reviewedBy?: string;
  assumeRole?: boolean;
}) {
  const endDate = options?.endDate ?? "2026-07-23";
  const capturedAt = options?.capturedAt ?? `${endDate}T18:00:00.000Z`;
  const captureStartedAt = options?.captureStartedAt ?? capturedAt;
  if (options?.assumeRole !== false) await actAsService();
  return db.query(
    `select * from public.commit_google_ads_billing_end(
       $1::uuid, $2::uuid, $3, $4::date, $5, 'EUR', $6::numeric,
       $7::timestamptz, $8::timestamptz, $9, $10::uuid
     )`,
    [
      options?.accountId ?? ACCOUNT,
      options?.captureId ?? END_CAPTURE,
      options?.customerId ?? "1234567890",
      endDate,
      options?.timeZone ?? "UTC",
      options?.endMicros ?? "0",
      captureStartedAt,
      capturedAt,
      options?.source ?? "agency",
      options?.reviewedBy ?? ADMIN,
    ],
  );
}

async function recordSync(options?: {
  accountId?: string;
  periodStart?: string;
  periodEnd?: string;
  status?: "in_progress" | "complete" | "failed";
}) {
  const accountId = options?.accountId ?? ACCOUNT;
  const periodStart = options?.periodStart ?? START;
  const periodEnd = options?.periodEnd ?? END;
  const status = options?.status ?? "complete";
  await db.query(
    `insert into public.google_ledger_sync_windows (
       ad_account_id, billing_start_id, billing_end_id, period_start, period_end,
       status, synced_at, ledger_snapshot
     )
     select
       $1, billing_start.id, billing_end.id, $2, $3, $4, $5::timestamptz,
       coalesce(
         jsonb_agg(
           jsonb_build_object(
             'id', commission.id::text,
             'occurred_on', commission.occurred_on::text,
             'gross_amount',
               to_char(commission.gross_amount, 'FM999999999999999990.000000'),
             'currency', upper(commission.currency),
             'status', commission.status
           ) order by commission.id
         ) filter (where commission.id is not null),
         '[]'::jsonb
       )
     from public.ad_account_billing_starts billing_start
     left join public.ad_account_billing_ends billing_end
       on billing_end.ad_account_id = billing_start.ad_account_id
      and billing_end.billing_start_id = billing_start.id
     left join public.commissions commission
       on commission.ad_account_id = billing_start.ad_account_id
      and commission.status = 'confirmed'
      and commission.source_id in (
        select id from public.revenue_sources where name = 'Google Ads Management'
      )
      and commission.occurred_on between
        greatest($2::date, billing_start.google_local_date)
        and least($3::date, coalesce(billing_end.google_local_date, $3::date))
     where billing_start.ad_account_id = $1
     group by billing_start.id, billing_end.id
     on conflict (ad_account_id, period_start, period_end) do update set
       billing_start_id = excluded.billing_start_id,
       billing_end_id = excluded.billing_end_id,
       run_id = gen_random_uuid(),
       status = excluded.status,
       synced_at = excluded.synced_at,
       ledger_snapshot = excluded.ledger_snapshot`,
    [accountId, periodStart, periodEnd, status, `${dayAfter(periodEnd)}T12:00:00.000Z`],
  );
}

async function seed(options?: {
  clientStatus?: "approved" | "rejected";
  accountStatus?: "active" | "suspended";
  startDate?: string;
  baselineMicros?: string;
  rows?: LedgerSeed[];
  periodStart?: string;
  periodEnd?: string;
  sync?: boolean;
  skipBillingStart?: boolean;
}) {
  await db.query("insert into public.profiles (id, role) values ($1, 'admin')", [ADMIN]);
  await db.query(
    `insert into public.portal_clients (id, full_name, email, approval_status)
     values ($1, 'Client', 'client@example.com', $2)`,
    [CLIENT, options?.clientStatus ?? "approved"],
  );
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, currency, google_ads_customer_id,
       google_ads_connected, google_ads_refresh_token, status, created_at
     ) values ($1, $2, 'Store', 'EUR', '1234567890', true, 'cipher', 'pending', now())`,
    [ACCOUNT, CLIENT],
  );
  await db.query(
    "insert into public.revenue_sources (id, name) values ($1, 'Google Ads Management')",
    [SOURCE],
  );

  if (options?.skipBillingStart) {
    await db.exec("alter table public.ad_accounts disable trigger ad_accounts_guard_billing_identity");
    await db.query("update public.ad_accounts set status = $2 where id = $1", [
      ACCOUNT,
      options?.accountStatus ?? "active",
    ]);
    await db.exec("alter table public.ad_accounts enable trigger ad_accounts_guard_billing_identity");
  } else {
    await commitStart({
      startDate: options?.startDate,
      baselineMicros: options?.baselineMicros,
    });
    if (options?.accountStatus === "suspended") {
      await db.query("update public.ad_accounts set status = 'suspended' where id = $1", [ACCOUNT]);
    }
  }

  const rows = options?.rows ?? [
    { id: ROW_A, date: START, gross: "100" },
    { id: ROW_B, date: END, gross: "200" },
  ];
  for (const row of rows) {
    await db.query(
      `insert into public.commissions (
         id, source_id, ad_account_id, occurred_on, gross_amount, currency, status
       ) values ($1, $2, $3, $4, $5::numeric, 'EUR', 'confirmed')`,
      [row.id, SOURCE, ACCOUNT, row.date, row.gross],
    );
  }

  if (!options?.skipBillingStart && options?.sync !== false) {
    await recordSync({
      periodStart: options?.periodStart,
      periodEnd: options?.periodEnd,
    });
  }
  await actAs(ADMIN);
}

type LinePatch = Record<string, unknown>;

async function issueSql(options?: {
  ledgerIds?: string[];
  periodStart?: string;
  periodEnd?: string;
  linePatch?: LinePatch;
  omitLineKeys?: string[];
  version?: string;
  amount?: number;
}) {
  await actAsService();
  const ledgerIds = options?.ledgerIds ?? [ROW_A, ROW_B];
  const periodStart = options?.periodStart ?? START;
  const periodEnd = options?.periodEnd ?? END;
  const aggregate = await db.query<{
    account_id: string;
    store_name: string;
    billing_start_id: string;
    billing_start_date: string;
    billing_started_at: string | Date;
    billing_time_zone: string;
    opening_baseline_applied: boolean;
    billing_end_id: string | null;
    billing_end_date: string | null;
    billing_ended_at: string | Date | null;
    billing_end_time_zone: string | null;
    billing_end_counter_micros: string | null;
    ending_cap_applied: boolean;
    source_gross_exact: string;
    baseline_deduction_exact: string;
    end_deduction_exact: string;
    billable_gross_exact: string;
    source_gross_rounded: string;
    baseline_deduction_rounded: string;
    end_deduction_rounded: string;
    billable_gross_rounded: string;
    start_baseline_rounded: string;
    end_counter_rounded: string | null;
    fee_amount: string;
  }>(
    `with requested as (
       select jsonb_array_elements_text($4::jsonb) as commission_id
     )
     select
       authoritative.account_id,
       authoritative.store_name,
       authoritative.billing_start_id,
       authoritative.billing_start_date::text,
       authoritative.billing_started_at,
       authoritative.billing_time_zone,
       bool_or(authoritative.opening_baseline_applied) as opening_baseline_applied,
       authoritative.billing_end_id,
       authoritative.billing_end_date::text,
       authoritative.billing_ended_at,
       authoritative.billing_end_time_zone,
       authoritative.billing_end_counter_micros,
       bool_or(authoritative.ending_cap_applied) as ending_cap_applied,
       sum(authoritative.source_gross_amount) as source_gross_exact,
       sum(authoritative.baseline_deduction_amount) as baseline_deduction_exact,
       sum(authoritative.end_deduction_amount) as end_deduction_exact,
       sum(authoritative.billable_gross_amount) as billable_gross_exact,
       round(sum(authoritative.source_gross_amount), 2) as source_gross_rounded,
       round(sum(authoritative.baseline_deduction_amount), 2) as baseline_deduction_rounded,
       round(sum(authoritative.end_deduction_amount), 2) as end_deduction_rounded,
       round(sum(authoritative.billable_gross_amount), 2) as billable_gross_rounded,
       round(max(authoritative.billing_start_baseline_micros) / 1000000, 2)
         as start_baseline_rounded,
       round(authoritative.billing_end_counter_micros / 1000000, 2)
         as end_counter_rounded,
       round(sum(authoritative.billable_gross_amount) * 0.10, 2)
         as fee_amount
     from public.manual_invoice_authoritative_rows($1, $2, $3) authoritative
     join requested on requested.commission_id = authoritative.commission_id::text
     group by
       authoritative.account_id,
       authoritative.store_name,
       authoritative.billing_start_id,
       authoritative.billing_start_date,
       authoritative.billing_started_at,
       authoritative.billing_time_zone,
       authoritative.billing_end_id,
       authoritative.billing_end_date,
       authoritative.billing_ended_at,
       authoritative.billing_end_time_zone,
       authoritative.billing_end_counter_micros`,
    [CLIENT, periodStart, periodEnd, JSON.stringify(ledgerIds)],
  );
  if (aggregate.rows.length !== 1) throw new Error("Test line aggregate is not unique.");

  const totals = aggregate.rows[0];
  const billable = Number(totals.billable_gross_rounded);
  const raw = Number(totals.source_gross_rounded);
  const deduction = Number(totals.baseline_deduction_rounded);
  const exactBillable = Number(totals.billable_gross_exact);
  const exactRaw = Number(totals.source_gross_exact);
  const exactDeduction = Number(totals.baseline_deduction_exact);
  const exactEndDeduction = Number(totals.end_deduction_exact);
  const exactEndCounter = Number(totals.billing_end_counter_micros) / 1_000_000;
  const fee = Number(totals.fee_amount);
  const startedAt = new Date(totals.billing_started_at).toISOString();
  const endedAt = totals.billing_ended_at
    ? new Date(totals.billing_ended_at).toISOString()
    : null;
  const label = totals.opening_baseline_applied && totals.ending_cap_applied
    ? `${totals.store_name} - Google Ads agency fee (10% of exact billable spend: EUR ${exactBillable.toFixed(6)}; billing started ${startedAt}; billing ended ${endedAt} at Google day counter EUR ${exactEndCounter.toFixed(6)}; billable period ${totals.billing_start_date} to ${totals.billing_end_date} in ${totals.billing_end_time_zone}; exact Google spend EUR ${exactRaw.toFixed(6)} minus opening baseline EUR ${exactDeduction.toFixed(6)} minus post-service spend EUR ${exactEndDeduction.toFixed(6)})`
    : totals.opening_baseline_applied
      ? `${totals.store_name} - Google Ads agency fee (10% of exact billable spend: EUR ${exactBillable.toFixed(6)}; billing started ${startedAt}; first billable period ${totals.billing_start_date} to ${periodEnd} in ${totals.billing_time_zone}; exact Google spend EUR ${exactRaw.toFixed(6)} minus opening baseline EUR ${exactDeduction.toFixed(6)})`
      : totals.ending_cap_applied
        ? `${totals.store_name} - Google Ads agency fee (10% of exact billable spend: EUR ${exactBillable.toFixed(6)}; billing ended ${endedAt} at Google day counter EUR ${exactEndCounter.toFixed(6)}; final billable period ${periodStart} to ${totals.billing_end_date} in ${totals.billing_end_time_zone}; exact Google spend EUR ${exactRaw.toFixed(6)} minus post-service spend EUR ${exactEndDeduction.toFixed(6)})`
        : `${totals.store_name} - Google Ads agency fee (10% of exact billable spend: EUR ${exactBillable.toFixed(6)})`;
  const line: Record<string, unknown> = {
    accountId: totals.account_id,
    kind: "fee",
    store: totals.store_name,
    rate: 10,
    baseAmount: billable,
    sourceGrossAmount: raw,
    billingStartBaselineAmount: Number(totals.start_baseline_rounded),
    billingStartId: totals.billing_start_id,
    billingStartDate: totals.billing_start_date,
    billingStartedAt: startedAt,
    billingTimeZone: totals.billing_time_zone,
    label,
    amount: fee,
    ...(totals.opening_baseline_applied
      ? { baselineDeductionAmount: deduction }
      : {}),
    ...(totals.ending_cap_applied
      ? {
          billingEndId: totals.billing_end_id,
          billingEndDate: totals.billing_end_date,
          billingEndedAt: endedAt,
          billingEndTimeZone: totals.billing_end_time_zone,
          billingEndCounterAmount: Number(totals.end_counter_rounded),
          endingCapApplied: true,
          endDeductionAmount: Number(totals.end_deduction_rounded),
        }
      : {}),
    ...options?.linePatch,
  };
  for (const key of options?.omitLineKeys ?? []) delete line[key];

  return db.query(
    `select * from public.create_manual_invoice(
       $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8
     )`,
    [
      CLIENT,
      periodStart,
      periodEnd,
      options?.amount ?? fee,
      JSON.stringify([line]),
      JSON.stringify(ledgerIds.map((commission_id) => ({ commission_id }))),
      ADMIN,
      options?.version ?? VERSION,
    ],
  );
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);
  await actAs(null);
});

describe("manual agency billing migration", () => {
  it("commits one source-owned baseline and activates an existing pending account", async () => {
    await seed({ sync: false, baselineMicros: "123456789" });
    const result = await db.query<{
      status: string;
      baseline_cost_micros: string;
      source: string;
      google_local_date: string;
    }>(
      `select account.status, billing_start.baseline_cost_micros,
              billing_start.source, billing_start.google_local_date::text
       from public.ad_accounts account
       join public.ad_account_billing_starts billing_start
         on billing_start.ad_account_id = account.id
       where account.id = $1`,
      [ACCOUNT],
    );
    expect(result.rows[0]).toMatchObject({
      status: "active",
      baseline_cost_micros: "123456789",
      source: "agency",
      google_local_date: START,
    });

    await expect(
      commitStart({ baselineMicros: "123456789" }),
    ).resolves.toMatchObject({ rows: [{ id: ACCOUNT, status: "active" }] });
  });

  it("allows only service role and validates capture identity, micros and Google-local date", async () => {
    await db.query("insert into public.profiles (id, role) values ($1, 'admin')", [ADMIN]);
    await db.query(
      "insert into public.portal_clients values ($1, 'Client', 'c@example.com', 'approved', null)",
      [CLIENT],
    );
    await db.query(
      `insert into public.ad_accounts (
         id, client_id, store_name, currency, google_ads_customer_id, status
       ) values ($1, $2, 'Store', 'EUR', '1234567890', 'pending')`,
      [ACCOUNT, CLIENT],
    );

    await actAs(ADMIN);
    await expect(commitStart({ assumeRole: false })).rejects.toThrow(/only the service role/i);
    await expect(commitStart({ baselineMicros: "1.5" })).rejects.toThrow(/invalid authoritative/i);
    await expect(commitStart({ customerId: "123-456-7890" })).rejects.toThrow(/invalid authoritative/i);
    await expect(commitStart({ timeZone: "Definitely/Not_A_Zone" })).rejects.toThrow(
      /recognised IANA identifier/i,
    );
    await expect(
      commitStart({ capturedAt: "2026-07-21T00:00:00.000Z" }),
    ).rejects.toThrow(/local date does not match/i);
  });

  it("provisions and approves a pending Google request in the same commit", async () => {
    await db.query("insert into public.profiles (id, role) values ($1, 'admin')", [ADMIN]);
    await db.query(
      "insert into public.portal_clients values ($1, 'Client', 'c@example.com', 'approved', null)",
      [CLIENT],
    );
    await db.query(
      `insert into public.account_requests (
         id, client_id, request_type, google_ads_customer_id, store_name, status
       ) values ($1, $2, 'google_ads', '987-654-3210', 'Requested store', 'pending')`,
      [REQUEST, CLIENT],
    );

    const committed = await commitStart({
      accountId: null,
      requestId: REQUEST,
      customerId: "9876543210",
      captureId: CAPTURE,
    });
    expect(committed.rows).toMatchObject([
      { client_id: CLIENT, store_name: "Requested store", status: "active" },
    ]);
    const request = await db.query<{ status: string }>(
      "select status from public.account_requests where id = $1",
      [REQUEST],
    );
    const starts = await db.query<{ count: string }>(
      "select count(*) from public.ad_account_billing_starts",
    );
    expect(request.rows[0].status).toBe("approved");
    expect(Number(starts.rows[0].count)).toBe(1);

    await expect(
      commitStart({
        accountId: null,
        requestId: REQUEST,
        customerId: "9876543210",
        captureId: CAPTURE,
      }),
    ).resolves.toMatchObject({ rows: [{ status: "active" }] });
  });

  it("preserves suspended during legacy baseline remediation", async () => {
    await seed({ sync: false, accountStatus: "suspended" });
    const account = await db.query<{ status: string }>(
      "select status from public.ad_accounts where id = $1",
      [ACCOUNT],
    );
    expect(account.rows[0].status).toBe("suspended");
  });

  it("commits one immutable billing end through service role and retries only identical evidence", async () => {
    await seed({ sync: false, accountStatus: "suspended", rows: [] });

    await actAs(ADMIN);
    await expect(commitEnd({ assumeRole: false })).rejects.toThrow(/only the service role/i);
    await expect(commitEnd({ timeZone: "Definitely/Not_A_Zone" })).rejects.toThrow(
      /recognised IANA identifier/i,
    );
    await expect(commitEnd({ endMicros: "1.5" })).rejects.toThrow(
      /invalid authoritative/i,
    );
    await expect(
      commitEnd({
        endDate: "2026-07-19",
        capturedAt: "2026-07-19T18:00:00.000Z",
      }),
    ).rejects.toThrow(/cannot precede/i);

    await recordSync();
    const committed = await commitEnd({ endMicros: "125123456" });
    expect(committed.rows).toMatchObject([
      {
        ad_account_id: ACCOUNT,
        google_ads_customer_id: "1234567890",
        google_local_date: new Date("2026-07-23T00:00:00.000Z"),
        google_time_zone: "UTC",
        currency: "EUR",
        end_cost_micros: "125123456",
        capture_id: END_CAPTURE,
        source: "agency",
        reviewed_by: ADMIN,
      },
    ]);
    const staleProof = await db.query<{ count: string }>(
      "select count(*) from public.google_ledger_sync_windows",
    );
    expect(Number(staleProof.rows[0].count)).toBe(0);
    await expect(commitEnd({ endMicros: "125123456" })).resolves.toMatchObject({
      rows: [{ id: (committed.rows[0] as { id: string }).id }],
    });
    await expect(commitEnd({ endMicros: "125123457" })).rejects.toThrow(
      /cannot be replayed with different evidence/i,
    );
    await expect(
      commitEnd({ captureId: "00000000-0000-4000-8000-000000000011", endMicros: "125123456" }),
    ).rejects.toThrow(/already has a different Google billing end|cannot restart silently/i);

    await actAsService();
    await expect(
      db.query(
        "update public.ad_account_billing_ends set end_cost_micros = 0 where ad_account_id = $1",
        [ACCOUNT],
      ),
    ).rejects.toThrow(/billing end is immutable/i);
    await expect(
      db.query("delete from public.ad_account_billing_ends where ad_account_id = $1", [ACCOUNT]),
    ).rejects.toThrow(/billing end is immutable/i);
    await expect(
      db.query("update public.ad_accounts set status = 'pending' where id = $1", [ACCOUNT]),
    ).rejects.toThrow(/billing boundary.*cannot return to pending/i);

    const account = await db.query<{ status: string }>(
      "select status from public.ad_accounts where id = $1",
      [ACCOUNT],
    );
    expect(account.rows[0].status).toBe("suspended");

    const privileges = await db.query<{ authenticated: boolean; service: boolean }>(
      `select
         has_function_privilege(
           'authenticated',
           'public.commit_google_ads_billing_end(uuid,uuid,text,date,text,text,numeric,timestamptz,timestamptz,text,uuid)',
           'EXECUTE'
         ) as authenticated,
         has_function_privilege(
           'service_role',
           'public.commit_google_ads_billing_end(uuid,uuid,text,date,text,text,numeric,timestamptz,timestamptz,text,uuid)',
           'EXECUTE'
         ) as service`,
    );
    expect(privileges.rows[0]).toEqual({ authenticated: false, service: true });
  });

  it("blocks direct activation, baseline mutation and started identity deletion", async () => {
    await seed({ sync: false });
    await actAsService();
    await expect(
      db.query(
        `insert into public.ad_accounts (
           client_id, store_name, currency, google_ads_customer_id, status
         ) values ($1, 'Bypass', 'EUR', '1112223333', 'active')`,
        [CLIENT],
      ),
    ).rejects.toThrow(/requires a committed billing start/i);
    await expect(
      db.query(
        "update public.ad_account_billing_starts set baseline_cost_micros = 0 where ad_account_id = $1",
        [ACCOUNT],
      ),
    ).rejects.toThrow(/billing start is immutable/i);
    await expect(
      db.query("delete from public.ad_account_billing_starts where ad_account_id = $1", [ACCOUNT]),
    ).rejects.toThrow(/billing start is immutable/i);
    await expect(
      db.query("update public.ad_accounts set google_ads_customer_id = '1112223333' where id = $1", [ACCOUNT]),
    ).rejects.toThrow(/cannot change billing identity/i);
    await expect(
      db.query("delete from public.ad_accounts where id = $1", [ACCOUNT]),
    ).rejects.toThrow(/billing start cannot be deleted/i);
  });

  it("issues a fixed 10% EUR v2 snapshot and stores exact claim evidence", async () => {
    await seed();
    const issued = await issueSql();
    expect(issued.rows).toMatchObject([
      {
        client_id: CLIENT,
        amount: "30.00",
        currency: "EUR",
        status: "draft",
        calculation_version: VERSION,
      },
    ]);
    const invoice = issued.rows[0] as { line_items: Record<string, unknown>[] };
    expect(invoice.line_items[0]).toMatchObject({
      baseAmount: 300,
      sourceGrossAmount: 300,
      baselineDeductionAmount: 0,
      billingStartBaselineAmount: 0,
      rate: 10,
      amount: 30,
      label:
        "Store - Google Ads agency fee (10% of exact billable spend: EUR 300.000000; billing started 2026-07-20T12:00:00.000Z; first billable period 2026-07-20 to 2026-07-26 in UTC; exact Google spend EUR 300.000000 minus opening baseline EUR 0.000000)",
    });

    const claims = await db.query<{
      gross_amount: string;
      baseline_deduction_amount: string;
      billable_gross_amount: string;
      billing_start_id: string;
    }>(
      `select gross_amount, baseline_deduction_amount, billable_gross_amount,
              billing_start_id
       from public.invoice_commission_rows
       order by commission_id`,
    );
    expect(claims.rows).toMatchObject([
      {
        gross_amount: "100.000000",
        baseline_deduction_amount: "0.000000",
        billable_gross_amount: "100.000000",
      },
      {
        gross_amount: "200.000000",
        baseline_deduction_amount: "0.000000",
        billable_gross_amount: "200.000000",
      },
    ]);
    expect(new Set(claims.rows.map((row) => row.billing_start_id)).size).toBe(1);
  });

  it("multiplies exact Google micros before rounding the 10% fee to cents", async () => {
    await seed({ rows: [{ id: ROW_A, date: START, gross: "10.045000" }] });
    const issued = await issueSql({ ledgerIds: [ROW_A] });

    expect(issued.rows).toMatchObject([{ amount: "1.00" }]);
    const line = (issued.rows[0] as { line_items: Record<string, unknown>[] }).line_items[0];
    expect(line).toMatchObject({ baseAmount: 10.05, amount: 1 });
  });

  it("handles a Thursday start: excludes pre-start rows and deducts exact opening micros once", async () => {
    const thursday = "2026-07-23";
    await seed({
      startDate: thursday,
      baselineMicros: "40123456",
      rows: [
        { id: ROW_A, date: START, gross: "50.000000" },
        { id: ROW_B, date: thursday, gross: "100.123456" },
        { id: ROW_C, date: END, gross: "200.000000" },
      ],
    });

    await expect(
      issueSql({ ledgerIds: [ROW_A, ROW_B, ROW_C] }),
    ).rejects.toThrow(/pre-start/i);
    const issued = await issueSql({ ledgerIds: [ROW_B, ROW_C] });
    expect(issued.rows).toMatchObject([{ amount: "26.00" }]);
    const line = (issued.rows[0] as { line_items: Record<string, unknown>[] }).line_items[0];
    expect(line).toMatchObject({
      baseAmount: 260,
      sourceGrossAmount: 300.12,
      baselineDeductionAmount: 40.12,
      billingStartBaselineAmount: 40.12,
      label:
        "Store - Google Ads agency fee (10% of exact billable spend: EUR 260.000000; billing started 2026-07-23T12:00:00.000Z; first billable period 2026-07-23 to 2026-07-26 in UTC; exact Google spend EUR 300.123456 minus opening baseline EUR 40.123456)",
    });

    const claims = await db.query<{
      commission_id: string;
      gross_amount: string;
      baseline_deduction_amount: string;
      billable_gross_amount: string;
    }>(
      `select commission_id, gross_amount, baseline_deduction_amount, billable_gross_amount
       from public.invoice_commission_rows order by commission_id`,
    );
    expect(claims.rows).toEqual([
      {
        commission_id: ROW_B,
        gross_amount: "100.123456",
        baseline_deduction_amount: "40.123456",
        billable_gross_amount: "60.000000",
      },
      {
        commission_id: ROW_C,
        gross_amount: "200.000000",
        baseline_deduction_amount: "0.000000",
        billable_gross_amount: "200.000000",
      },
    ]);
  });

  it("handles a Sunday start as a one-day first billing week", async () => {
    await seed({
      startDate: END,
      baselineMicros: "150000000",
      rows: [
        { id: ROW_A, date: START, gross: "100" },
        { id: ROW_B, date: END, gross: "200" },
      ],
    });
    const issued = await issueSql({ ledgerIds: [ROW_B] });
    expect(issued.rows).toMatchObject([{ amount: "5.00" }]);
    const claims = await db.query<{
      gross_amount: string;
      baseline_deduction_amount: string;
      billable_gross_amount: string;
    }>(
      `select gross_amount, baseline_deduction_amount, billable_gross_amount
       from public.invoice_commission_rows`,
    );
    expect(claims.rows).toEqual([
      {
        gross_amount: "200.000000",
        baseline_deduction_amount: "150.000000",
        billable_gross_amount: "50.000000",
      },
    ]);
  });

  it("handles a Thursday end: caps that day and excludes every later row", async () => {
    const thursday = "2026-07-23";
    const friday = "2026-07-24";
    await seed({
      sync: false,
      startDate: "2026-07-13",
      rows: [
        { id: ROW_A, date: START, gross: "100.000000" },
        { id: ROW_B, date: thursday, gross: "200.000000" },
        { id: ROW_C, date: friday, gross: "300.000000" },
      ],
    });
    const ended = await commitEnd({
      endDate: thursday,
      endMicros: "125000000",
    });
    await recordSync();

    const proof = await db.query<{ billing_end_id: string; row_count: number }>(
      `select billing_end_id, jsonb_array_length(ledger_snapshot) as row_count
       from public.google_ledger_sync_windows`,
    );
    expect(proof.rows).toEqual([
      {
        billing_end_id: (ended.rows[0] as { id: string }).id,
        row_count: 2,
      },
    ]);
    await db.query("update public.commissions set gross_amount = 301 where id = $1", [ROW_C]);
    const proofAfterPostEndChange = await db.query<{ count: string }>(
      "select count(*) from public.google_ledger_sync_windows",
    );
    expect(Number(proofAfterPostEndChange.rows[0].count)).toBe(1);

    const authoritative = await db.query<{
      commission_id: string;
      gross: string;
      opening: string;
      ending: string;
      billable: string;
    }>(
      `select commission_id,
              to_char(source_gross_amount, 'FM999999999999999990.000000') as gross,
              to_char(baseline_deduction_amount, 'FM999999999999999990.000000') as opening,
              to_char(end_deduction_amount, 'FM999999999999999990.000000') as ending,
              to_char(billable_gross_amount, 'FM999999999999999990.000000') as billable
       from public.manual_invoice_authoritative_rows($1, $2, $3)
       order by commission_id`,
      [CLIENT, START, END],
    );
    expect(authoritative.rows).toEqual([
      {
        commission_id: ROW_A,
        gross: "100.000000",
        opening: "0.000000",
        ending: "0.000000",
        billable: "100.000000",
      },
      {
        commission_id: ROW_B,
        gross: "200.000000",
        opening: "0.000000",
        ending: "75.000000",
        billable: "125.000000",
      },
    ]);

    await expect(
      issueSql({ ledgerIds: [ROW_A, ROW_B, ROW_C] }),
    ).rejects.toThrow(/post-end/i);
    await db.query(
      "update public.google_ledger_sync_windows set billing_end_id = null",
    );
    await expect(
      issueSql({ ledgerIds: [ROW_A, ROW_B] }),
    ).rejects.toThrow(/refreshed for the closed week/i);
    await recordSync();
    await expect(
      issueSql({
        ledgerIds: [ROW_A, ROW_B],
        linePatch: { billingEndCounterAmount: 124 },
      }),
    ).rejects.toThrow(/Google boundary evidence/i);
    await expect(
      issueSql({
        ledgerIds: [ROW_A, ROW_B],
        omitLineKeys: ["endingCapApplied"],
      }),
    ).rejects.toThrow(/Google boundary evidence/i);
    const issued = await issueSql({ ledgerIds: [ROW_A, ROW_B] });
    expect(issued.rows).toMatchObject([{ amount: "22.50" }]);
    const line = (issued.rows[0] as { line_items: Record<string, unknown>[] }).line_items[0];
    expect(line).toMatchObject({
      baseAmount: 225,
      sourceGrossAmount: 300,
      billingEndDate: thursday,
      billingEndCounterAmount: 125,
      endingCapApplied: true,
      endDeductionAmount: 75,
      label:
        "Store - Google Ads agency fee (10% of exact billable spend: EUR 225.000000; billing ended 2026-07-23T18:00:00.000Z at Google day counter EUR 125.000000; final billable period 2026-07-20 to 2026-07-23 in UTC; exact Google spend EUR 300.000000 minus post-service spend EUR 75.000000)",
    });

    const claims = await db.query<{
      commission_id: string;
      billing_end_id: string;
      end_deduction_amount: string;
      billable_gross_amount: string;
    }>(
      `select commission_id, billing_end_id, end_deduction_amount,
              billable_gross_amount
       from public.invoice_commission_rows order by commission_id`,
    );
    expect(claims.rows).toEqual([
      {
        commission_id: ROW_A,
        billing_end_id: (ended.rows[0] as { id: string }).id,
        end_deduction_amount: "0.000000",
        billable_gross_amount: "100.000000",
      },
      {
        commission_id: ROW_B,
        billing_end_id: (ended.rows[0] as { id: string }).id,
        end_deduction_amount: "75.000000",
        billable_gross_amount: "125.000000",
      },
    ]);

    const future = await db.query<{ count: string }>(
      `select count(*) from public.manual_invoice_authoritative_rows(
         $1, '2026-07-27', '2026-08-02'
       )`,
      [CLIENT],
    );
    expect(Number(future.rows[0].count)).toBe(0);
  });

  it("uses the interval between opening and closing counters when start and end share a day", async () => {
    const thursday = "2026-07-23";
    await seed({
      sync: false,
      startDate: thursday,
      baselineMicros: "40000000",
      rows: [
        { id: ROW_B, date: thursday, gross: "200.000000" },
        { id: ROW_C, date: "2026-07-24", gross: "300.000000" },
      ],
    });
    await commitEnd({ endDate: thursday, endMicros: "125000000" });
    await recordSync();

    const issued = await issueSql({ ledgerIds: [ROW_B] });
    expect(issued.rows).toMatchObject([{ amount: "8.50" }]);
    const line = (issued.rows[0] as { line_items: Record<string, unknown>[] }).line_items[0];
    expect(line).toMatchObject({
      baseAmount: 85,
      sourceGrossAmount: 200,
      baselineDeductionAmount: 40,
      billingStartBaselineAmount: 40,
      billingEndCounterAmount: 125,
      endDeductionAmount: 75,
      label:
        "Store - Google Ads agency fee (10% of exact billable spend: EUR 85.000000; billing started 2026-07-23T12:00:00.000Z; billing ended 2026-07-23T18:00:00.000Z at Google day counter EUR 125.000000; billable period 2026-07-23 to 2026-07-23 in UTC; exact Google spend EUR 200.000000 minus opening baseline EUR 40.000000 minus post-service spend EUR 75.000000)",
    });

    const claim = await db.query<{
      gross_amount: string;
      baseline_deduction_amount: string;
      end_deduction_amount: string;
      billable_gross_amount: string;
    }>(
      `select gross_amount, baseline_deduction_amount, end_deduction_amount,
              billable_gross_amount
       from public.invoice_commission_rows`,
    );
    expect(claim.rows).toEqual([
      {
        gross_amount: "200.000000",
        baseline_deduction_amount: "40.000000",
        end_deduction_amount: "75.000000",
        billable_gross_amount: "85.000000",
      },
    ]);
  });

  it("treats a same-day downward Google restatement as zero, never negative spend", async () => {
    const thursday = "2026-07-23";
    await seed({
      sync: false,
      startDate: thursday,
      baselineMicros: "150000000",
      rows: [{ id: ROW_B, date: thursday, gross: "200.000000" }],
    });
    await commitEnd({ endDate: thursday, endMicros: "100000000" });

    const evidence = await db.query<{
      opening: string;
      ending: string;
      billable: string;
    }>(
      `select
         to_char(baseline_deduction_amount, 'FM999999999999999990.000000') as opening,
         to_char(end_deduction_amount, 'FM999999999999999990.000000') as ending,
         to_char(billable_gross_amount, 'FM999999999999999990.000000') as billable
       from public.manual_invoice_authoritative_rows($1, $2, $3)`,
      [CLIENT, START, END],
    );
    expect(evidence.rows).toEqual([
      { opening: "100.000000", ending: "100.000000", billable: "0.000000" },
    ]);
  });

  it("caps the opening deduction at raw spend after a downward restatement", async () => {
    await seed({
      startDate: END,
      baselineMicros: "250000000",
      rows: [{ id: ROW_B, date: END, gross: "200" }],
    });
    const evidence = await db.query<{
      source_gross_amount: string;
      baseline_deduction_amount: string;
      billable_gross_amount: string;
    }>(
      `select round(source_gross_amount, 6)::text as source_gross_amount,
              round(baseline_deduction_amount, 6)::text as baseline_deduction_amount,
              round(billable_gross_amount, 6)::text as billable_gross_amount
       from public.manual_invoice_authoritative_rows($1, $2, $3)`,
      [CLIENT, START, END],
    );
    expect(evidence.rows).toEqual([
      {
        source_gross_amount: "200.000000",
        baseline_deduction_amount: "200.000000",
        billable_gross_amount: "0.000000",
      },
    ]);
  });

  it("never reapplies the opening baseline in a later week", async () => {
    const laterStart = "2026-07-27";
    const laterEnd = "2026-08-02";
    await seed({
      baselineMicros: "50000000",
      periodStart: laterStart,
      periodEnd: laterEnd,
      rows: [
        { id: ROW_A, date: laterStart, gross: "100" },
        { id: ROW_B, date: laterEnd, gross: "200" },
      ],
    });
    const issued = await issueSql({ periodStart: laterStart, periodEnd: laterEnd });
    const line = (issued.rows[0] as { line_items: Record<string, unknown>[] }).line_items[0];
    expect(line).toMatchObject({
      baseAmount: 300,
      sourceGrossAmount: 300,
      billingStartBaselineAmount: 50,
      label: "Store - Google Ads agency fee (10% of exact billable spend: EUR 300.000000)",
    });
    expect(line).not.toHaveProperty("baselineDeductionAmount");
  });

  it("fails closed when any approved account has no billing start", async () => {
    await seed({ skipBillingStart: true, sync: false });
    await actAsService();
    await expect(
      db.query(
        `select * from public.create_manual_invoice(
           $1, $2, $3, 10, '[{"accountId":"${ACCOUNT}"}]'::jsonb,
           '[{"commission_id":"${ROW_A}"}]'::jsonb, $4, $5
         )`,
        [CLIENT, START, END, ADMIN, VERSION],
      ),
    ).rejects.toThrow(/needs a verified Google billing start/i);
  });

  it("requires a bound, post-close, exact canonical ledger proof", async () => {
    await seed({ sync: false });
    await expect(issueSql()).rejects.toThrow(/refreshed for the closed week/i);

    await recordSync();
    const marker = await db.query<{ value_type: string; value: string }>(
      `select jsonb_typeof(ledger_snapshot->0->'gross_amount') as value_type,
              ledger_snapshot->0->>'gross_amount' as value
       from public.google_ledger_sync_windows`,
    );
    expect(marker.rows[0]).toEqual({ value_type: "string", value: "100.000000" });

    await db.query(
      "update public.google_ledger_sync_windows set ledger_snapshot = '[]'::jsonb",
    );
    await expect(issueSql()).rejects.toThrow(/refreshed for the closed week/i);

    await expect(
      db.query(
        "update public.google_ledger_sync_windows set billing_start_id = gen_random_uuid()",
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("rejects omitted, duplicated and tampered commercial evidence", async () => {
    await seed({ baselineMicros: "10000000" });
    await expect(issueSql({ ledgerIds: [ROW_A] })).rejects.toThrow(/claim every/i);
    await expect(
      issueSql({ ledgerIds: [ROW_A, ROW_B, ROW_B] }),
    ).rejects.toThrow(/duplicated/i);
    await expect(
      issueSql({ linePatch: { rate: 9 } }),
    ).rejects.toThrow(/fixed 10% EUR fee/i);
    await expect(
      issueSql({ linePatch: { sourceGrossAmount: 299 } }),
    ).rejects.toThrow(/fixed 10% EUR fee/i);
    await expect(
      issueSql({ linePatch: { billingStartBaselineAmount: 0 } }),
    ).rejects.toThrow(/fixed 10% EUR fee/i);
    await expect(
      issueSql({ omitLineKeys: ["baselineDeductionAmount"] }),
    ).rejects.toThrow(/fixed 10% EUR fee/i);
    await expect(
      issueSql({ version: "agency-fee-eur-10-v1" }),
    ).rejects.toThrow(/invalid manual agency-fee calculation/i);
  });

  it("blocks legacy discounts, custom rates and revenue share instead of silently charging 10%", async () => {
    await seed();
    await actAsService();
    await db.query(
      "update public.ad_accounts set commission_rate = 9.5 where id = $1",
      [ACCOUNT],
    );
    await expect(issueSql()).rejects.toThrow(/legacy discount.*must be resolved/i);
  });

  it("retains the final closed week when access is revoked or the account is suspended", async () => {
    await seed({ clientStatus: "rejected", accountStatus: "suspended" });
    await expect(issueSql()).resolves.toMatchObject({ rows: [{ amount: "30.00" }] });
  });

  it("keeps invoices and commercial snapshots append-only", async () => {
    await seed();
    const issued = await issueSql();
    const invoiceId = (issued.rows[0] as { id: string }).id;
    await actAsService();
    await expect(
      db.query("update public.invoices set amount = 1 where id = $1", [invoiceId]),
    ).rejects.toThrow(/commercial snapshot is immutable/i);
    await db.query(
      "update public.invoices set stripe_invoice_id = 'in_first', status = 'open', amount_remaining = amount where id = $1",
      [invoiceId],
    );
    await expect(
      db.query("update public.invoices set stripe_invoice_id = 'in_replaced' where id = $1", [invoiceId]),
    ).rejects.toThrow(/Stripe invoice link cannot be replaced/i);

    const writePolicies = await db.query<{ count: string }>(
      `select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'invoices'
         and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')`,
    );
    expect(Number(writePolicies.rows[0].count)).toBe(0);

    const authenticatedExecute = await db.query<{ allowed: boolean }>(
      `select has_function_privilege(
         'authenticated',
         'public.create_manual_invoice(uuid,date,date,numeric,jsonb,jsonb,uuid,text)',
         'EXECUTE'
       ) as allowed`,
    );
    expect(authenticatedExecute.rows[0].allowed).toBe(false);

    await expect(issueSql()).rejects.toThrow(/already being invoiced|already exists|duplicate/i);
  });

  it("protects Stripe identity and removes PUBLIC access to the legacy binding RPC", async () => {
    await seed({ sync: false });
    const privilege = await db.query<{ allowed: boolean }>(
      `select has_function_privilege(
         'authenticated',
         'public.set_workspace_stripe_customer(uuid,text)',
         'EXECUTE'
       ) as allowed`,
    );
    expect(privilege.rows[0].allowed).toBe(false);
    await actAs(CLIENT);
    await expect(
      db.query(
        "update public.portal_clients set stripe_customer_id = 'cus_other' where id = $1",
        [CLIENT],
      ),
    ).rejects.toThrow(/only the billing service can bind/i);
    await actAs(ADMIN);
    await expect(
      db.query(
        "update public.portal_clients set stripe_customer_id = 'cus_admin' where id = $1",
        [CLIENT],
      ),
    ).rejects.toThrow(/only the billing service can bind/i);
    await actAsService();
    await expect(
      db.query(
        "update public.portal_clients set stripe_customer_id = 'cus_server' where id = $1",
        [CLIENT],
      ),
    ).resolves.toBeDefined();
    await expect(
      db.query(
        "update public.portal_clients set stripe_customer_id = 'cus_replaced' where id = $1",
        [CLIENT],
      ),
    ).rejects.toThrow(/Stripe customer binding cannot be replaced/i);

    await actAs(CLIENT);
    await expect(
      db.query("update public.ad_accounts set created_at = now() where id = $1", [ACCOUNT]),
    ).rejects.toThrow(/creation date is immutable/i);
  });

  it("normalises customer ids and aborts migration on formatted duplicates", async () => {
    const preflightDb = await PGlite.create();
    try {
      await preflightDb.exec("drop schema if exists public cascade; create schema public;");
      await preflightDb.exec("drop schema if exists auth cascade;");
      await preflightDb.exec(PRELUDE);
      await preflightDb.query(
        `insert into public.portal_clients (id, full_name, email, approval_status) values
           ('00000000-0000-4000-8000-000000000011', 'One', 'one@example.com', 'approved'),
           ('00000000-0000-4000-8000-000000000012', 'Two', 'two@example.com', 'approved')`,
      );
      await preflightDb.query(
        `insert into public.ad_accounts (
           id, client_id, store_name, currency, google_ads_customer_id
         ) values
           ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000011', 'One', 'EUR', '1234567890'),
           ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000012', 'Two', 'EUR', '123-456-7890')`,
      );
      await expect(preflightDb.exec(MIGRATION)).rejects.toThrow(
        /customer 1234567890 is linked to multiple ad accounts/i,
      );
    } finally {
      await preflightDb.close();
    }
  });
});
