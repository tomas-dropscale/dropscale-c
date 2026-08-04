import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0036_billing_automation_receipts.sql",
  "utf8",
);

const ADMIN = "36000000-0000-4000-8000-000000000001";
const CLIENT = "36000000-0000-4000-8000-000000000002";
const PENDING = "36000000-0000-4000-8000-000000000003";
const ACCOUNT = "36000000-0000-4000-8000-000000000004";
const ADMIN_ACCOUNT = "36000000-0000-4000-8000-000000000005";
const PENDING_ACCOUNT = "36000000-0000-4000-8000-000000000006";
const START = "36000000-0000-4000-8000-000000000007";
const ADMIN_START = "36000000-0000-4000-8000-000000000008";
const PENDING_START = "36000000-0000-4000-8000-000000000009";
const SOURCE = "36000000-0000-4000-8000-000000000010";
const COMMISSION = "36000000-0000-4000-8000-000000000011";
const INVOICE = "36000000-0000-4000-8000-000000000012";
const ROLLOVER = "36000000-0000-4000-8000-000000000013";
const WAIVED_INVOICE = "36000000-0000-4000-8000-000000000014";

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

grant usage on schema public, auth to authenticated, anon, service_role;

create table public.profiles (
  id uuid primary key,
  role text not null
);

create or replace function public.is_admin() returns boolean
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

create table public.manual_referral_billing_config (
  singleton boolean primary key,
  v3_cutover_monday date not null
);

insert into public.manual_referral_billing_config (
  singleton,
  v3_cutover_monday
) values (true, date '2026-07-20');

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

create or replace function public.manual_invoice_authoritative_rows(
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

type ItemRow = {
  id: string;
  client_id: string;
  period_start: string;
  state: string;
  blocker_code: string | null;
  safe_message: string | null;
  invoice_id: string | null;
  claim_version: number;
};

let db: PGlite;

function isoDate(value: string | Date) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

async function actAs(role: string, userId: string | null = null) {
  await db.query(
    "select set_config('test.role', $1, false), set_config('test.uid', $2, false)",
    [role, userId ?? ""],
  );
}

async function beginRun() {
  await actAs("service_role");
  const result = await db.query<{ id: string }>(
    "select id from public.begin_billing_automation_run(true)",
  );
  return result.rows[0].id;
}

async function seedClient({
  clientId = CLIENT,
  accountId = ACCOUNT,
  startId = START,
  approval = "approved",
  startDate = "2026-07-20",
}: {
  clientId?: string;
  accountId?: string;
  startId?: string;
  approval?: string;
  startDate?: string;
} = {}) {
  await db.query(
    `insert into public.portal_clients (id, full_name, email, approval_status)
     values ($1, 'Client', $2, $3)`,
    [clientId, `${clientId}@example.com`, approval],
  );
  await db.query(
    `insert into public.ad_accounts
       (id, client_id, status, currency, google_ads_customer_id)
     values ($1, $2, 'active', 'EUR', $3)`,
    [accountId, clientId, `customer-${accountId}`],
  );
  await db.query(
    `insert into public.ad_account_billing_starts
       (id, ad_account_id, google_local_date, google_ads_customer_id,
        google_time_zone, currency, baseline_cost_micros)
     values ($1, $2, $3, $4, 'UTC', 'EUR', 0)`,
    [startId, accountId, startDate, `customer-${accountId}`],
  );
}

async function seedAndClaim(
  closedThrough = "2026-07-26",
): Promise<{ runId: string; item: ItemRow }> {
  await seedClient();
  const runId = await beginRun();
  await db.query(
    "select public.seed_billing_automation_items($1, $2::date)",
    [runId, closedThrough],
  );
  const claimed = await db.query<ItemRow>(
    "select * from public.claim_billing_automation_items($1, 20)",
    [runId],
  );
  return { runId, item: claimed.rows[0] };
}

async function recordResult(
  item: ItemRow,
  runId: string,
  values: {
    state: "blocked" | "issued" | "no_charge";
    stage: "preview" | "google_evidence" | "stripe_issue" | "complete";
    code?: string | null;
    invoiceId?: string | null;
    amount?: number | null;
    billableSpend?: number | null;
    evidenceAccounts?: number;
  },
) {
  return db.query<ItemRow>(
    `select * from public.record_billing_automation_item_result(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
     )`,
    [
      item.id,
      runId,
      item.claim_version,
      values.state,
      values.stage,
      values.code ?? null,
      values.invoiceId ?? null,
      values.amount ?? null,
      values.billableSpend ?? null,
      values.evidenceAccounts ?? 0,
    ],
  );
}

async function insertExactWindow(snapshot: unknown[] = []) {
  await db.query(
    `insert into public.google_ledger_sync_windows
       (ad_account_id, billing_start_id, billing_end_id, period_start,
        period_end, synced_at, status, ledger_snapshot)
     values ($1, $2, null, date '2026-07-20', date '2026-07-26',
             timestamptz '2026-07-27 01:00:00+00', 'complete', $3::jsonb)`,
    [ACCOUNT, START, JSON.stringify(snapshot)],
  );
}

describe("0036 durable billing automation receipts", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(PRELUDE);
    await db.exec(MIGRATION);
  });

  beforeEach(async () => {
    await actAs("service_role");
    await db.exec(`
      truncate table
        public.billing_automation_items,
        public.billing_automation_runs,
        public.google_ledger_sync_windows,
        public.historical_billing_rollovers,
        public.invoices,
        public.commissions,
        public.ad_account_billing_ends,
        public.ad_account_billing_starts,
        public.ad_accounts,
        public.portal_clients,
        public.profiles,
        public.revenue_sources
      cascade;
    `);
    await db.query(
      "insert into public.revenue_sources (id, name) values ($1, 'Google Ads Management')",
      [SOURCE],
    );
    await db.exec(`
      insert into public.manual_referral_billing_config (
        singleton,
        v3_cutover_monday
      ) values (true, date '2026-07-20')
      on conflict (singleton) do update
      set v3_cutover_monday = excluded.v3_cutover_monday;
    `);
  });

  it("seeds only recurring weeks on or after the immutable v3 cutover", async () => {
    await seedClient({ startDate: "2026-05-04" });
    await seedClient({
      clientId: PENDING,
      accountId: PENDING_ACCOUNT,
      startId: PENDING_START,
      approval: "pending",
      startDate: "2026-05-04",
    });
    await seedClient({
      clientId: ADMIN,
      accountId: ADMIN_ACCOUNT,
      startId: ADMIN_START,
      startDate: "2026-05-04",
    });
    await db.query("insert into public.profiles (id, role) values ($1, 'admin')", [
      ADMIN,
    ]);
    await db.query(
      `insert into public.historical_billing_rollovers
         (id, client_id, period_start, period_end)
       values ($1, $2, date '2026-07-27', date '2026-08-02')`,
      [ROLLOVER, CLIENT],
    );
    await db.exec(
      "update public.manual_referral_billing_config set v3_cutover_monday = date '2026-08-03' where singleton",
    );

    const runId = await beginRun();
    const seeded = await db.query<{ seed_billing_automation_items: number }>(
      "select public.seed_billing_automation_items($1, date '2026-08-09')",
      [runId],
    );
    const items = await db.query<{ client_id: string; period_start: string }>(
      "select client_id, period_start from public.billing_automation_items order by period_start",
    );

    expect(seeded.rows[0].seed_billing_automation_items).toBe(1);
    expect(items.rows).toHaveLength(1);
    expect(new Set(items.rows.map((row) => row.client_id))).toEqual(
      new Set([CLIENT]),
    );
    expect(isoDate(items.rows[0].period_start)).toBe("2026-08-03");

    const preCutoverRun = await beginRun();
    const preCutoverSeeded = await db.query<{
      seed_billing_automation_items: number;
    }>(
      "select public.seed_billing_automation_items($1, date '2026-08-02')",
      [preCutoverRun],
    );
    expect(preCutoverSeeded.rows[0].seed_billing_automation_items).toBe(0);
  });

  it("preserves an account's final partial week after applying the cutover floor", async () => {
    await seedClient({ startDate: "2026-05-04" });
    await db.exec(
      "update public.manual_referral_billing_config set v3_cutover_monday = date '2026-08-03' where singleton",
    );
    await db.query(
      `insert into public.ad_account_billing_ends (
         ad_account_id,
         billing_start_id,
         google_local_date
       ) values ($1, $2, date '2026-08-12')`,
      [ACCOUNT, START],
    );

    const runId = await beginRun();
    await db.query(
      "select public.seed_billing_automation_items($1, date '2026-08-23')",
      [runId],
    );
    const items = await db.query<{
      period_start: string;
      period_end: string;
    }>(
      `select period_start, period_end
       from public.billing_automation_items
       order by period_start`,
    );

    expect(
      items.rows.map((row) => ({
        period_start: isoDate(row.period_start),
        period_end: isoDate(row.period_end),
      })),
    ).toEqual([
      { period_start: "2026-08-03", period_end: "2026-08-09" },
      { period_start: "2026-08-10", period_end: "2026-08-16" },
    ]);
  });

  it("fails closed when the immutable v3 cutover is unavailable", async () => {
    await seedClient({ startDate: "2026-08-03" });
    await db.exec("delete from public.manual_referral_billing_config");
    const runId = await beginRun();

    await expect(
      db.query(
        "select public.seed_billing_automation_items($1, date '2026-08-09')",
        [runId],
      ),
    ).rejects.toThrow(/cutover is missing or invalid/i);
  });

  it("claims oldest-first and fences a blocked item to one attempt per run", async () => {
    await seedClient({ startDate: "2026-07-06" });
    const firstRun = await beginRun();
    await db.query(
      "select public.seed_billing_automation_items($1, date '2026-07-26')",
      [firstRun],
    );
    const oldest = await db.query<ItemRow>(
      "select * from public.claim_billing_automation_items($1, 1)",
      [firstRun],
    );
    expect(isoDate(oldest.rows[0].period_start)).toBe("2026-07-20");

    await recordResult(oldest.rows[0], firstRun, {
      state: "blocked",
      stage: "preview",
      code: "recipient_invalid",
    });
    const restOfFirstRun = await db.query<ItemRow>(
      "select * from public.claim_billing_automation_items($1, 20)",
      [firstRun],
    );
    expect(
      restOfFirstRun.rows.some((row) => row.id === oldest.rows[0].id),
    ).toBe(false);

    const secondRun = await beginRun();
    const reclaimed = await db.query<ItemRow>(
      "select * from public.claim_billing_automation_items($1, 1)",
      [secondRun],
    );
    expect(reclaimed.rows[0].id).toBe(oldest.rows[0].id);
    expect(reclaimed.rows[0].claim_version).toBe(2);

    await expect(
      recordResult(oldest.rows[0], firstRun, {
        state: "blocked",
        stage: "preview",
        code: "recipient_invalid",
      }),
    ).rejects.toThrow(/claim was lost/i);
  });

  it("requires exact complete database proof before making zero charge terminal", async () => {
    const { runId, item } = await seedAndClaim();

    await expect(
      recordResult(item, runId, {
        state: "no_charge",
        stage: "complete",
        amount: 0,
        billableSpend: 0,
        evidenceAccounts: 1,
      }),
    ).rejects.toThrow(/exact complete post-close Google proof/i);

    await insertExactWindow();
    const result = await recordResult(item, runId, {
      state: "no_charge",
      stage: "complete",
      amount: 0,
      billableSpend: 0,
      evidenceAccounts: 1,
    });

    expect(result.rows[0]).toMatchObject({
      state: "no_charge",
      blocker_code: null,
      invoice_id: null,
    });
  });

  it("rejects a forged zero charge when the locked authoritative ledger contains spend", async () => {
    const { runId, item } = await seedAndClaim();
    await db.query(
      `insert into public.commissions
         (id, source_id, ad_account_id, occurred_on, gross_amount, currency, status)
       values ($1, $2, $3, date '2026-07-21', 1, 'EUR', 'confirmed')`,
      [COMMISSION, SOURCE, ACCOUNT],
    );
    await insertExactWindow([
      {
        id: COMMISSION,
        occurred_on: "2026-07-21",
        gross_amount: "1.000000",
        currency: "EUR",
        status: "confirmed",
      },
    ]);

    await expect(
      recordResult(item, runId, {
        state: "no_charge",
        stage: "complete",
        amount: 0,
        billableSpend: 0,
        evidenceAccounts: 1,
      }),
    ).rejects.toThrow(/positive billable Google spend/i);
  });

  it("accepts only a delivered admin invoice and verifies its exact amount", async () => {
    const { runId, item } = await seedAndClaim();
    await db.query(
      `insert into public.invoices
         (id, client_id, period_start, period_end, amount, status, issuer_kind, issued_at)
       values ($1, $2, date '2026-07-20', date '2026-07-26', 10,
               'open', 'admin', timestamptz '2026-07-27 10:00:00+00')`,
      [INVOICE, CLIENT],
    );

    await expect(
      recordResult(item, runId, {
        state: "issued",
        stage: "complete",
        invoiceId: INVOICE,
        amount: 9,
        billableSpend: 100,
        evidenceAccounts: 1,
      }),
    ).rejects.toThrow(/not an issued receipt/i);

    await expect(
      recordResult(item, runId, {
        state: "issued",
        stage: "complete",
        invoiceId: INVOICE,
        amount: 10,
        billableSpend: 100,
        evidenceAccounts: 1,
      }),
    ).rejects.toThrow(/not an issued receipt/i);

    await db.query(
      `update public.invoices
       set stripe_sent_at = timestamptz '2026-07-27 10:01:00+00',
           issued_at = null
       where id = $1`,
      [INVOICE],
    );

    const result = await recordResult(item, runId, {
      state: "issued",
      stage: "complete",
      invoiceId: INVOICE,
      amount: 10,
      billableSpend: 100,
      evidenceAccounts: 1,
    });
    expect(result.rows[0]).toMatchObject({
      state: "issued",
      invoice_id: INVOICE,
    });
  });

  it("requires durable local issuance evidence for a waived settlement", async () => {
    const { runId, item } = await seedAndClaim();
    await db.query(
      `insert into public.invoices
         (id, client_id, period_start, period_end, amount, status, issuer_kind)
       values ($1, $2, date '2026-07-20', date '2026-07-26', 0,
               'waived', 'automation')`,
      [WAIVED_INVOICE, CLIENT],
    );

    await expect(
      recordResult(item, runId, {
        state: "issued",
        stage: "complete",
        invoiceId: WAIVED_INVOICE,
        amount: 0,
        billableSpend: 100,
        evidenceAccounts: 1,
      }),
    ).rejects.toThrow(/not an issued receipt/i);

    await db.query(
      `update public.invoices
       set issued_at = timestamptz '2026-07-27 10:01:00+00'
       where id = $1`,
      [WAIVED_INVOICE],
    );
    const result = await recordResult(item, runId, {
      state: "issued",
      stage: "complete",
      invoiceId: WAIVED_INVOICE,
      amount: 0,
      billableSpend: 100,
      evidenceAccounts: 1,
    });

    expect(result.rows[0]).toMatchObject({
      state: "issued",
      invoice_id: WAIVED_INVOICE,
    });
  });

  it("allows only admins to read runs/items and derives safe blocker copy from its code", async () => {
    const { runId, item } = await seedAndClaim();
    await recordResult(item, runId, {
      state: "blocked",
      stage: "stripe_issue",
      code: "stripe_issue_failed",
    });
    await db.query("insert into public.profiles (id, role) values ($1, 'admin')", [
      ADMIN,
    ]);

    await actAs("authenticated", CLIENT);
    await db.exec("set role authenticated");
    const clientRows = await db.query(
      "select id from public.billing_automation_items",
    );
    const clientLatestRun = await db.query(
      "select id from public.latest_billing_automation_run()",
    );
    await db.exec("reset role");
    expect(clientRows.rows).toHaveLength(0);
    expect(clientLatestRun.rows).toHaveLength(0);

    await actAs("authenticated", ADMIN);
    await db.exec("set role authenticated");
    const adminRows = await db.query<ItemRow>(
      "select * from public.billing_automation_items",
    );
    const adminLatestRun = await db.query<{ id: string; status: string }>(
      "select id, status from public.latest_billing_automation_run()",
    );
    await db.exec("reset role");
    expect(adminRows.rows[0].safe_message).toBe(
      "Stripe invoice delivery needs retrying.",
    );
    expect(adminLatestRun.rows).toEqual([{ id: runId, status: "running" }]);
  });

  it("finishes a run exactly once and preserves its operational counters", async () => {
    const runId = await beginRun();
    const finished = await db.query<{
      status: string;
      historical_rollovers_checked: number;
      exact_refresh_requested: number;
      exact_refresh_completed: number;
      reconciliation_checked: number;
      reconciliation_updated: number;
      error_count: number;
    }>(
      `select * from public.finish_billing_automation_run(
         $1, 'partial', 2, 3, 1, 4, 2, 1
       )`,
      [runId],
    );

    expect(finished.rows[0]).toMatchObject({
      status: "partial",
      historical_rollovers_checked: 2,
      exact_refresh_requested: 3,
      exact_refresh_completed: 1,
      reconciliation_checked: 4,
      reconciliation_updated: 2,
      error_count: 1,
    });

    await expect(
      db.query(
        `select * from public.finish_billing_automation_run(
           $1, 'succeeded', 0, 0, 0, 0, 0, 0
         )`,
        [runId],
      ),
    ).rejects.toThrow(/already finished/i);
  });

  it("holds every mutable proof source in the invoice-RPC lock order", () => {
    const proof = MIGRATION.slice(
      MIGRATION.indexOf(
        "create or replace function public.billing_automation_exact_zero_account_count",
      ),
      MIGRATION.indexOf(
        "create or replace function public.claim_billing_automation_items",
      ),
    );
    const locks = [
      "lock table public.ad_accounts in share row exclusive mode;",
      "lock table public.ad_account_billing_starts in share row exclusive mode;",
      "lock table public.ad_account_billing_ends in share row exclusive mode;",
      "lock table public.revenue_sources in share row exclusive mode;",
      "lock table public.commissions in share row exclusive mode;",
      "lock table public.google_ledger_sync_windows in share row exclusive mode;",
    ];
    const positions = locks.map((lock) => proof.indexOf(lock));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(Math.max(...positions)).toBeLessThan(proof.indexOf("select\n    count(*)"));
    expect(proof).not.toMatch(/language plpgsql\s+stable/i);
  });
});
