import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const BILLING_MIGRATION = readFileSync(
  "supabase/migrations/0028_manual_agency_billing.sql",
  "utf8",
);
const CUTOVER_MIGRATION = readFileSync(
  "supabase/migrations/0029_legacy_billing_cutover.sql",
  "utf8",
);
const REFERRAL_MIGRATION = readFileSync(
  "supabase/migrations/0030_manual_referral_discounts.sql",
  "utf8",
);
const ATTRIBUTION_MIGRATION = readFileSync(
  "supabase/migrations/0031_manual_referral_attribution.sql",
  "utf8",
);

const ADMIN = "10000000-0000-4000-8000-000000000001";
const CLIENT = "10000000-0000-4000-8000-000000000002";
const CLIENT_ACCOUNT = "10000000-0000-4000-8000-000000000003";
const REFERRED = "10000000-0000-4000-8000-000000000004";
const REFERRED_ACCOUNT = "10000000-0000-4000-8000-000000000005";
const SOURCE = "10000000-0000-4000-8000-000000000006";
const CLIENT_ROW_A = "10000000-0000-4000-8000-000000000007";
const CLIENT_ROW_B = "10000000-0000-4000-8000-000000000008";
const REFERRED_ROW = "10000000-0000-4000-8000-000000000009";
const CLIENT_START_CAPTURE = "10000000-0000-4000-8000-000000000010";
const REFERRED_START_CAPTURE = "10000000-0000-4000-8000-000000000011";
const CLIENT_ACCOUNT_TINY = "10000000-0000-4000-8000-000000000012";
const CLIENT_ROW_TINY = "10000000-0000-4000-8000-000000000013";
const CLIENT_TINY_CAPTURE = "10000000-0000-4000-8000-000000000014";
const CLIENT_END_CAPTURE = "10000000-0000-4000-8000-000000000015";
const PENDING_REFERRAL = "10000000-0000-4000-8000-000000000016";
const INACTIVE_REFERRAL = "10000000-0000-4000-8000-000000000017";
const SCHEDULED_REFERRAL = "10000000-0000-4000-8000-000000000018";
const MEMBER = "10000000-0000-4000-8000-000000000019";
const STRANGER = "10000000-0000-4000-8000-000000000020";
const STAFF = "10000000-0000-4000-8000-000000000021";
const SHARED_WORKSPACE = "10000000-0000-4000-8000-000000000022";
const START = "2026-07-20";
const END = "2026-07-26";
const VERSION = "agency-fee-eur-v3-manual-referrals-google-boundaries";

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

create table public.profiles (id uuid primary key, role text not null);
create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  )
$$;

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null,
  approval_status text not null,
  stripe_customer_id text,
  referral_code text unique,
  referred_by uuid references public.portal_clients(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.portal_clients enable row level security;
create policy portal_clients_update_self on public.portal_clients
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create table public.billing_profiles (
  client_id uuid primary key references public.portal_clients(id),
  billing_name text,
  tax_id text,
  address_line1 text,
  address_line2 text,
  address_city text,
  address_postal_code text,
  address_state text,
  address_country text
);

create table public.client_members (
  client_id uuid not null references public.portal_clients(id),
  member_id uuid not null references public.portal_clients(id),
  primary key (client_id, member_id)
);

create or replace function public.is_client_member(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_client_id = auth.uid()
    or exists (
      select 1
      from public.client_members member
      join public.portal_clients profile on profile.id = member.member_id
      where member.client_id = p_client_id
        and member.member_id = auth.uid()
        and profile.approval_status <> 'rejected'
    )
$$;

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
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
  client_id uuid not null references public.portal_clients(id),
  request_type text not null,
  google_ads_customer_id text,
  store_name text,
  shopify_collaborator_code text,
  myshopify_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create or replace function public.effective_commission_rate(
  p_client_id uuid, p_list numeric
) returns numeric language sql stable as $$ select p_list $$;

create table public.revenue_sources (id uuid primary key, name text not null);
create table public.commissions (
  id uuid primary key,
  source_id uuid not null references public.revenue_sources(id),
  ad_account_id uuid references public.ad_accounts(id),
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
  client_id uuid not null references public.portal_clients(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  amount numeric(12,2) not null,
  currency text not null default 'EUR',
  status text not null default 'draft'
    check (status in ('draft','open','paid','void','uncollectible')),
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
  p_client_id uuid, p_customer_id text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.portal_clients set stripe_customer_id = p_customer_id where id = p_client_id;
end
$$;
grant execute on function public.set_workspace_stripe_customer(uuid,text) to authenticated;

-- Objects from 0022-0025 that 0030 deliberately supersedes.
create or replace function public.referral_activity_days()
returns integer language sql immutable as $$ select 7 $$;
create or replace function public.active_referral_count(p_client_id uuid)
returns integer language sql security definer stable as $$ select 0 $$;
create or replace function public.refresh_referrer_rates(p_client_id uuid)
returns void language sql security definer as $$ select $$;
create or replace function public.refresh_all_referral_rates()
returns integer language sql security definer as $$ select 0 $$;

create or replace function public.guard_referral_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.referred_by is distinct from old.referred_by
     and coalesce(current_setting('dropscale.referral_claim', true), '') <> 'on' then
    raise exception 'Only the sign-up flow can set who referred you.';
  end if;
  return new;
end $$;
create trigger portal_clients_guard_referral before update on public.portal_clients
  for each row execute function public.guard_referral_fields();

create or replace function public.claim_referral_code(p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare v_referrer uuid;
begin
  select id into v_referrer from public.portal_clients
  where upper(referral_code) = upper(trim(p_code)) and approval_status = 'approved';
  if v_referrer is null then return 'unknown_code'; end if;
  perform set_config('dropscale.referral_claim', 'on', true);
  update public.portal_clients set referred_by = v_referrer where id = auth.uid();
  return 'ok';
end $$;
grant execute on function public.claim_referral_code(text) to authenticated;

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;
`;

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

async function effectiveMonday(): Promise<string> {
  const result = await db.query<{ day: string }>(
    `select public.manual_referral_effective_monday(
       (now() at time zone 'Europe/Lisbon')::date
     )::text as day`,
  );
  return result.rows[0].day;
}

async function currentMonday(): Promise<string> {
  const result = await db.query<{ day: string }>(
    `select public.manual_referral_current_monday(
       (now() at time zone 'Europe/Lisbon')::date
     )::text as day`,
  );
  return result.rows[0].day;
}

async function insertClient(
  id: string,
  name: string,
  referredBy: string | null = null,
  status = "approved",
) {
  await actAsService();
  await db.query("begin");
  try {
    if (referredBy) {
      // Existing-attribution fixtures represent an already reviewed admin
      // decision. Ordinary direct INSERTs are tested separately and blocked.
      await db.query(
        "select set_config('dropscale.manual_referral_attribution_rpc', 'on', true)",
      );
    }
    await db.query(
      `insert into public.portal_clients (
         id, full_name, email, approval_status, referral_code, referred_by
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        name,
        `${name.toLowerCase()}@example.com`,
        status,
        name.toUpperCase(),
        null,
      ],
    );
    if (referredBy) {
      await db.query(
        "update public.portal_clients set referred_by = $1 where id = $2",
        [referredBy, id],
      );
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

async function insertTrackedAccount(options: {
  clientId: string;
  accountId: string;
  customerId: string;
  captureId: string;
  startDate: string;
  baselineMicros?: string;
  store?: string;
}) {
  await actAsService();
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, google_ads_customer_id, status, currency
     ) values ($1, $2, $3, $4, 'pending', 'EUR')`,
    [
      options.accountId,
      options.clientId,
      options.store ?? "Store",
      options.customerId,
    ],
  );
  const capturedAt = `${options.startDate}T12:00:00.000Z`;
  await db.query(
    `select * from public.commit_google_ads_billing_start(
       $1, null, $2, $3, $4, 'UTC', 'EUR', $5::numeric,
       $6::timestamptz, $6::timestamptz, 'agency', $7
     )`,
    [
      options.accountId,
      options.captureId,
      options.customerId,
      options.startDate,
      options.baselineMicros ?? "0",
      capturedAt,
      ADMIN,
    ],
  );
}

async function insertSpend(options: {
  id: string;
  accountId: string;
  day: string;
  gross: string;
}) {
  await actAsService();
  await db.query(
    `insert into public.commissions (
       id, source_id, ad_account_id, occurred_on, gross_amount, rate, amount,
       currency, status
     ) values ($1, $2, $3, $4, $5::numeric, 10, $5::numeric * 0.1,
       'EUR', 'confirmed')`,
    [options.id, SOURCE, options.accountId, options.day, options.gross],
  );
}

async function schedule(options?: {
  referredId?: string;
  action?: "grant" | "revoke";
  expectedTermId?: string | null;
  decisionId?: string;
  effectiveFrom?: string;
  reviewer?: string;
  reason?: string;
  assumeRole?: boolean;
}) {
  if (options?.assumeRole !== false) await actAsService();
  return db.query<{
    id: string;
    referral_count: number;
    referral_discount_rate: string;
    fee_rate: string;
    revision: number;
  }>(
    `select * from public.schedule_manual_referral_discount(
       $1,$2,$3,$4,$5,$6,$7,$8
     )`,
    [
      CLIENT,
      options?.referredId ?? REFERRED,
      options?.action ?? "grant",
      options?.effectiveFrom ?? (await effectiveMonday()),
      options?.expectedTermId ?? null,
      options?.decisionId ?? crypto.randomUUID(),
      options?.reason ?? "Approved manually after service verification",
      options?.reviewer ?? ADMIN,
    ],
  );
}

async function seedReferralEligibility() {
  await db.query(
    "insert into public.profiles (id, role) values ($1, 'admin')",
    [ADMIN],
  );
  await insertClient(CLIENT, "Referrer");
  await insertClient(REFERRED, "Referred", CLIENT);
  await db.query(
    "insert into public.revenue_sources (id, name) values ($1, 'Google Ads Management')",
    [SOURCE],
  );
  const recent = await db.query<{ day: string }>(
    "select ((now() at time zone 'Europe/Lisbon')::date - 1)::text as day",
  );
  await insertTrackedAccount({
    clientId: REFERRED,
    accountId: REFERRED_ACCOUNT,
    customerId: "2222222222",
    captureId: REFERRED_START_CAPTURE,
    startDate: recent.rows[0].day,
    store: "Referred store",
  });
  await insertSpend({
    id: REFERRED_ROW,
    accountId: REFERRED_ACCOUNT,
    day: recent.rows[0].day,
    gross: "20.000000",
  });
  await actAs(ADMIN);
}

function addIsoDays(iso: string, days: number): string {
  const value = new Date(`${iso}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function recordSync(
  accountId = CLIENT_ACCOUNT,
  start = START,
  end = END,
) {
  await actAsService();
  await db.query(
    `insert into public.google_ledger_sync_windows (
       ad_account_id, billing_start_id, billing_end_id, period_start, period_end,
       status, synced_at, ledger_snapshot
     )
     select
       $1, billing_start.id, billing_end.id, $2, $3, 'complete', $4::timestamptz,
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
      and commission.source_id = $5
      and commission.occurred_on between
        greatest($2::date, billing_start.google_local_date)
        and least($3::date, coalesce(billing_end.google_local_date, $3::date))
     where billing_start.ad_account_id = $1
     group by billing_start.id, billing_end.id`,
    [accountId, start, end, `${addIsoDays(end, 1)}T12:00:00.000Z`, SOURCE],
  );
}

async function endClientBilling(endMicros: string) {
  await actAsService();
  const capturedAt = `${END}T12:00:00.000Z`;
  await db.query(
    `select * from public.commit_google_ads_billing_end(
       $1,$2,'1111111111',$3,'UTC','EUR',$4::numeric,
       $5::timestamptz,$5::timestamptz,'agency',$6
     )`,
    [CLIENT_ACCOUNT, CLIENT_END_CAPTURE, END, endMicros, capturedAt, ADMIN],
  );
}

async function seedInvoiceWeek(options?: {
  startDate?: string;
  baselineMicros?: string;
  rows?: { id: string; day: string; gross: string }[];
  sync?: boolean;
}) {
  await actAsService();
  await db.query(
    "insert into public.profiles (id, role) values ($1, 'admin') on conflict do nothing",
    [ADMIN],
  );
  await db.query(
    `insert into public.portal_clients (
       id, full_name, email, approval_status, referral_code
     ) values ($1, 'Referrer', 'referrer@example.com', 'approved', 'REFERRER')
     on conflict (id) do nothing`,
    [CLIENT],
  );
  await db.query(
    `insert into public.revenue_sources (id, name)
     values ($1, 'Google Ads Management') on conflict do nothing`,
    [SOURCE],
  );
  await insertTrackedAccount({
    clientId: CLIENT,
    accountId: CLIENT_ACCOUNT,
    customerId: "1111111111",
    captureId: CLIENT_START_CAPTURE,
    startDate: options?.startDate ?? "2026-07-01",
    baselineMicros: options?.baselineMicros,
    store: "Client store",
  });
  for (const row of options?.rows ?? [
    { id: CLIENT_ROW_A, day: START, gross: "100.000000" },
    { id: CLIENT_ROW_B, day: END, gross: "200.000000" },
  ]) {
    await insertSpend({
      id: row.id,
      accountId: CLIENT_ACCOUNT,
      day: row.day,
      gross: row.gross,
    });
  }
  if (options?.sync !== false) await recordSync();
  await actAs(ADMIN);
}

async function insertHistoricalTerm(
  referredIds: string[],
  effectiveFrom = START,
  revision = 1,
): Promise<string> {
  if (referredIds.length === 0)
    throw new Error("Historical fixture needs at least one grant.");
  const termId = crypto.randomUUID();
  const decisionId = crypto.randomUUID();
  const discount = Math.min(10, referredIds.length * 0.5);
  await actAsService();
  await db.query("begin");
  try {
    await db.query(
      "select set_config('dropscale.manual_referral_rpc', 'on', true)",
    );
    await db.query(
      `insert into public.referral_discount_terms (
         id, client_id, effective_from, revision, decision_id, decision_action,
         decision_referred_client_id, list_rate, referral_step_rate,
         referral_count, referral_discount_rate, fee_rate, reason, reviewed_by
       ) values (
         $1,$2,$3,$4,$5,'grant',$6,10,0.5,$7,$8,$9,
         'Historical test fixture', $10
       )`,
      [
        termId,
        CLIENT,
        effectiveFrom,
        revision,
        decisionId,
        referredIds[0],
        referredIds.length,
        discount,
        10 - discount,
        ADMIN,
      ],
    );
    for (const referredId of referredIds) {
      await db.query(
        `insert into public.referral_discount_term_items (
           term_id, referred_client_id, evidence_billing_start_id,
           evidence_commission_id, eligibility_checked_on,
           evidence_occurred_on, evidence_gross_amount,
           evidence_billable_amount
         )
         select $1,$2,billing_start.id,$3,current_date,commission.occurred_on,
                commission.gross_amount,commission.gross_amount
         from public.ad_account_billing_starts billing_start
         join public.commissions commission on commission.id = $3
         where billing_start.ad_account_id = $4`,
        [termId, referredId, REFERRED_ROW, REFERRED_ACCOUNT],
      );
    }
    await db.query(
      "update public.referral_discount_terms set sealed_at = now() where id = $1",
      [termId],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  return termId;
}

function rateText(value: number): string {
  return Number(value.toFixed(2)).toString();
}

async function issueV3(options?: {
  termId?: string | null;
  ledgerIds?: string[];
  linePatch?: Record<string, unknown>;
  amount?: number;
  recipientPatch?: Record<string, unknown>;
}) {
  const ledgerIds = options?.ledgerIds ?? [CLIENT_ROW_A, CLIENT_ROW_B];
  const aggregate = await db.query<{
    account_id: string;
    store_name: string;
    billing_start_id: string;
    billing_start_date: string;
    billing_started_at: Date | string;
    billing_time_zone: string;
    start_baseline: string;
    opening_baseline_applied: boolean;
    baseline_exact: string;
    baseline_rounded: string;
    billing_end_id: string | null;
    billing_end_date: string | null;
    billing_ended_at: Date | string | null;
    billing_end_time_zone: string | null;
    end_counter_exact: string | null;
    end_counter_rounded: string | null;
    ending_cap_applied: boolean;
    end_deduction_exact: string;
    end_deduction_rounded: string;
    source_exact: string;
    billable_exact: string;
    source_rounded: string;
    billable_rounded: string;
    fee_rate: string;
    list_rate: string;
    referral_count: number;
    referral_discount_rate: string;
    fee_amount: string;
  }>(
    `with requested as (
       select jsonb_array_elements_text($4::jsonb) as id
     ), term as (
       select * from public.resolve_manual_referral_term($1,$2)
     )
     select
       authoritative.account_id,
       authoritative.store_name,
       authoritative.billing_start_id,
       authoritative.billing_start_date::text,
       authoritative.billing_started_at,
       authoritative.billing_time_zone,
       round(max(authoritative.billing_start_baseline_micros) / 1000000, 2)
         as start_baseline,
       bool_or(authoritative.opening_baseline_applied) as opening_baseline_applied,
       sum(authoritative.baseline_deduction_amount) as baseline_exact,
       round(sum(authoritative.baseline_deduction_amount), 2) as baseline_rounded,
       authoritative.billing_end_id,
       authoritative.billing_end_date::text,
       authoritative.billing_ended_at,
       authoritative.billing_end_time_zone,
       authoritative.billing_end_counter_micros / 1000000 as end_counter_exact,
       round(authoritative.billing_end_counter_micros / 1000000, 2)
         as end_counter_rounded,
       bool_or(authoritative.ending_cap_applied) as ending_cap_applied,
       sum(authoritative.end_deduction_amount) as end_deduction_exact,
       round(sum(authoritative.end_deduction_amount), 2) as end_deduction_rounded,
       sum(authoritative.source_gross_amount) as source_exact,
       sum(authoritative.billable_gross_amount) as billable_exact,
       round(sum(authoritative.source_gross_amount), 2) as source_rounded,
       round(sum(authoritative.billable_gross_amount), 2) as billable_rounded,
       term.fee_rate,
       term.list_rate,
       term.referral_count,
       term.referral_discount_rate,
       round(sum(authoritative.billable_gross_amount) * term.fee_rate / 100, 2)
         as fee_amount
     from public.manual_invoice_authoritative_rows($1,$2,$3) authoritative
     join requested on requested.id = authoritative.commission_id::text
     cross join term
     group by authoritative.account_id, authoritative.store_name,
       authoritative.billing_start_id, authoritative.billing_start_date,
       authoritative.billing_started_at, authoritative.billing_time_zone,
       authoritative.billing_end_id, authoritative.billing_end_date,
       authoritative.billing_ended_at, authoritative.billing_end_time_zone,
       authoritative.billing_end_counter_micros,
       term.fee_rate, term.list_rate, term.referral_count,
       term.referral_discount_rate`,
    [CLIENT, START, END, JSON.stringify(ledgerIds)],
  );
  if (aggregate.rows.length === 0) throw new Error("Expected v3 test stores.");
  const calculatedAmount = aggregate.rows.reduce(
    (total, row) => total + Number(row.fee_amount),
    0,
  );
  const included = aggregate.rows.filter(
    (row) => Number(row.billable_exact) > 0,
  );
  const lines = included.map((row) => {
    const rate = Number(row.fee_rate);
    const discount = Number(row.referral_discount_rate);
    const billableExact = Number(row.billable_exact);
    const label =
      `${row.store_name} - Google Ads agency fee (` +
      `${rateText(rate)}% of captured Google-reported billable spend: EUR ${billableExact.toFixed(6)}` +
      `; manual referral term: approved referral count ${row.referral_count}` +
      `; 10% - ${rateText(discount)} percentage points = ${rateText(rate)}%` +
      (row.opening_baseline_applied && row.ending_cap_applied
        ? `; billing started ${new Date(row.billing_started_at).toISOString()}` +
          `; billing ended ${new Date(row.billing_ended_at!).toISOString()}` +
          ` at Google day counter EUR ${Number(row.end_counter_exact).toFixed(6)}` +
          `; billable period ${row.billing_start_date} to ${row.billing_end_date}` +
          ` in ${row.billing_end_time_zone}` +
          `; Google-reported spend EUR ${Number(row.source_exact).toFixed(6)}` +
          ` minus opening baseline EUR ${Number(row.baseline_exact).toFixed(6)}` +
          ` minus post-service spend EUR ${Number(row.end_deduction_exact).toFixed(6)}`
        : row.opening_baseline_applied
          ? `; billing started ${new Date(row.billing_started_at).toISOString()}` +
            `; first billable period ${row.billing_start_date} to ${END}` +
            ` in ${row.billing_time_zone}` +
            `; Google-reported spend EUR ${Number(row.source_exact).toFixed(6)}` +
            ` minus opening baseline EUR ${Number(row.baseline_exact).toFixed(6)}`
          : row.ending_cap_applied
            ? `; billing ended ${new Date(row.billing_ended_at!).toISOString()}` +
              ` at Google day counter EUR ${Number(row.end_counter_exact).toFixed(6)}` +
              `; final billable period ${START} to ${row.billing_end_date}` +
              ` in ${row.billing_end_time_zone}` +
              `; Google-reported spend EUR ${Number(row.source_exact).toFixed(6)}` +
              ` minus post-service spend EUR ${Number(row.end_deduction_exact).toFixed(6)}`
            : "") +
      `)`;
    return {
      accountId: row.account_id,
      kind: "fee",
      store: row.store_name,
      label,
      rate,
      amount: Number(row.fee_amount),
      listRate: Number(row.list_rate),
      referralDiscountRate: discount,
      referralCount: row.referral_count,
      baseAmount: Number(row.billable_rounded),
      sourceGrossAmount: Number(row.source_rounded),
      billingStartBaselineAmount: Number(row.start_baseline),
      billingStartId: row.billing_start_id,
      billingStartDate: row.billing_start_date,
      billingStartedAt: new Date(row.billing_started_at).toISOString(),
      billingTimeZone: row.billing_time_zone,
      ...(row.opening_baseline_applied
        ? { baselineDeductionAmount: Number(row.baseline_rounded) }
        : {}),
      ...(row.ending_cap_applied
        ? {
            billingEndId: row.billing_end_id,
            billingEndDate: row.billing_end_date,
            billingEndedAt: new Date(row.billing_ended_at!).toISOString(),
            billingEndTimeZone: row.billing_end_time_zone,
            billingEndCounterAmount: Number(row.end_counter_rounded),
            endingCapApplied: true,
            endDeductionAmount: Number(row.end_deduction_rounded),
          }
        : {}),
      ...options?.linePatch,
    };
  });
  const amount = options?.amount ?? calculatedAmount;
  const recipient = {
    email: "referrer@example.com",
    fallbackName: "Referrer",
    billingName: null,
    taxId: null,
    addressLine1: null,
    addressLine2: null,
    addressCity: null,
    addressPostalCode: null,
    addressState: null,
    addressCountry: null,
    ...options?.recipientPatch,
  };
  await actAsService();
  return db.query(
    `select * from public.create_manual_referral_invoice(
       $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10
     )`,
    [
      CLIENT,
      START,
      END,
      amount,
      JSON.stringify(lines),
      JSON.stringify(ledgerIds.map((commission_id) => ({ commission_id }))),
      JSON.stringify(recipient),
      options?.termId ?? null,
      ADMIN,
      VERSION,
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
  await db.exec(BILLING_MIGRATION);
  await db.exec(CUTOVER_MIGRATION);
  await db.exec(REFERRAL_MIGRATION);
  await db.exec(ATTRIBUTION_MIGRATION);
  // The fixture exercises a post-cutover week. A separate assertion below
  // proves that weeks before this immutable production boundary fail closed.
  await db.query(
    "update public.manual_referral_billing_config set v3_cutover_monday = $1",
    [START],
  );
  await actAs(null);
});

describe("manual referral attribution", () => {
  it("aborts installation when a legacy claim fills referred_by between migrations", async () => {
    const preflightDb = await PGlite.create();
    try {
      await preflightDb.exec(PRELUDE);
      await preflightDb.exec(BILLING_MIGRATION);
      await preflightDb.exec(CUTOVER_MIGRATION);
      await preflightDb.exec(REFERRAL_MIGRATION);
      await preflightDb.query(
        `insert into public.portal_clients (
           id, full_name, email, approval_status, referral_code, referred_by
         ) values
           ($1, 'Cycle A', 'cycle-a@example.com', 'approved', 'CYCLEA', null),
           ($2, 'Cycle B', 'cycle-b@example.com', 'approved', 'CYCLEB', $1)`,
        [CLIENT, REFERRED],
      );
      await preflightDb.query(
        "select set_config('test.uid', $1, false), set_config('test.role', 'authenticated', false)",
        [CLIENT],
      );
      const claim = await preflightDb.query<{ claim_referral_code: string }>(
        "select public.claim_referral_code('CYCLEB')",
      );
      expect(claim.rows[0].claim_referral_code).toBe("ok");

      await expect(preflightDb.exec(ATTRIBUTION_MIGRATION)).rejects.toThrow(
        /unreviewed permanent referral attribution/i,
      );
    } finally {
      await preflightDb.close();
    }
  });

  it("refuses every unreviewed permanent claim made between migrations", async () => {
    const cases: Array<{
      label: string;
      seed: (preflightDb: PGlite) => Promise<void>;
    }> = [
      {
        label: "staff attribution",
        seed: async (preflightDb) => {
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code, referred_by
             ) values
               ($1, 'Staff referrer', 'staff@example.com', 'approved', 'STAFF', null),
               ($2, 'Legacy child', 'child@example.com', 'approved', 'CHILD', $1)`,
            [STAFF, REFERRED],
          );
          await preflightDb.query(
            "insert into public.profiles (id, role) values ($1, 'admin')",
            [STAFF],
          );
        },
      },
      {
        label: "fellow workspace members",
        seed: async (preflightDb) => {
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code, referred_by
             ) values
               ($1, 'Legacy referrer', 'referrer@example.com', 'approved', 'REFERRER', null),
               ($2, 'Legacy child', 'child@example.com', 'approved', 'CHILD', $1),
               ($3, 'Workspace', 'workspace@example.com', 'approved', 'WORKSPACE', null)`,
            [CLIENT, REFERRED, SHARED_WORKSPACE],
          );
          await preflightDb.query(
            `insert into public.client_members (client_id, member_id)
             values ($1, $2), ($1, $3)`,
            [SHARED_WORKSPACE, CLIENT, REFERRED],
          );
        },
      },
    ];

    for (const scenario of cases) {
      const preflightDb = await PGlite.create();
      try {
        await preflightDb.exec(PRELUDE);
        await preflightDb.exec(BILLING_MIGRATION);
        await preflightDb.exec(CUTOVER_MIGRATION);
        await preflightDb.exec(REFERRAL_MIGRATION);
        await scenario.seed(preflightDb);
        await expect(
          preflightDb.exec(ATTRIBUTION_MIGRATION),
          scenario.label,
        ).rejects.toThrow(/unreviewed permanent referral attribution/i);
      } finally {
        await preflightDb.close();
      }
    }
  });

  it("lets a verified admin assign an empty attribution once without changing price", async () => {
    const decisionId = "30000000-0000-4000-8000-000000000001";
    await db.query(
      "insert into public.profiles (id, role) values ($1, 'admin')",
      [ADMIN],
    );
    await insertClient(CLIENT, "Referrer");
    await insertClient(STRANGER, "Other referrer");
    await insertClient(REFERRED, "Pending referred", null, "pending");

    await actAs(REFERRED);
    const claim = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code('  referrer  ')",
    );
    expect(claim.rows[0].claim_referral_code).toBe("ok");
    const exactRetry = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code('REFERRER')",
    );
    expect(exactRetry.rows[0].claim_referral_code).toBe("ok");
    const replacement = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code('OTHER REFERRER')",
    );
    expect(replacement.rows[0].claim_referral_code).toBe("claim_pending");

    await actAsService();
    const pending = await db.query<{
      id: string;
      referred_client_id: string;
      referrer_client_id: string;
      referral_code: string;
      claim_source: string;
    }>(
      "select id, referred_client_id, referrer_client_id, referral_code, claim_source from public.referral_claim_requests",
    );
    expect(pending.rows).toEqual([
      expect.objectContaining({
        referred_client_id: REFERRED,
        referrer_client_id: CLIENT,
        referral_code: "REFERRER",
        claim_source: "client",
      }),
    ]);
    const stillUnassigned = await db.query<{ referred_by: string | null }>(
      "select referred_by from public.portal_clients where id = $1",
      [REFERRED],
    );
    expect(stillUnassigned.rows[0].referred_by).toBeNull();

    const first = await db.query<{
      id: string;
      decision_id: string;
      referred_client_id: string;
      referrer_client_id: string;
      reason: string;
      reviewed_by: string;
      sealed_at: string;
    }>(
      `select * from public.assign_manual_referral_attribution(
         $1, $2, $3, $4, $5
       )`,
      [
        REFERRED,
        CLIENT,
        decisionId,
        "  Referral verified by the agency team  ",
        ADMIN,
      ],
    );

    expect(first.rows[0]).toMatchObject({
      decision_id: decisionId,
      referred_client_id: REFERRED,
      referrer_client_id: CLIENT,
      reason: "Referral verified by the agency team",
      reviewed_by: ADMIN,
    });
    expect(first.rows[0].sealed_at).toBeTruthy();

    const attributed = await db.query<{ referred_by: string | null }>(
      "select referred_by from public.portal_clients where id = $1",
      [REFERRED],
    );
    expect(attributed.rows[0].referred_by).toBe(CLIENT);
    const commercialTerms = await db.query<{ count: number }>(
      "select count(*)::int as count from public.referral_discount_terms",
    );
    expect(commercialTerms.rows[0].count).toBe(0);

    const replay = await db.query<{ id: string }>(
      `select id from public.assign_manual_referral_attribution(
         $1, $2, $3, $4, $5
       )`,
      [
        REFERRED,
        CLIENT,
        decisionId,
        "Referral verified by the agency team",
        ADMIN,
      ],
    );
    expect(replay.rows[0].id).toBe(first.rows[0].id);
    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [REFERRED, CLIENT, decisionId, "Different replay", ADMIN],
      ),
    ).rejects.toThrow(/cannot be replayed/i);

    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          REFERRED,
          CLIENT,
          "30000000-0000-4000-8000-000000000002",
          "Second assignment",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/already has a permanent/i);

    await expect(
      db.query(
        "update public.referral_attribution_events set reason = 'rewrite' where id = $1",
        [first.rows[0].id],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.query(
        "update public.referral_claim_requests set referral_code = 'REWRITE' where id = $1",
        [pending.rows[0].id],
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it("turns a confirmed signup code into pending evidence, never referred_by", async () => {
    await insertClient(CLIENT, "Signup referrer");
    await actAsService();
    await db.exec(`
      create table auth.users (
        id uuid primary key,
        email text not null,
        email_confirmed_at timestamptz,
        raw_user_meta_data jsonb not null default '{}'::jsonb
      );
      create trigger test_new_portal_client
        after insert on auth.users
        for each row execute function public.handle_new_portal_client();
    `);
    await db.query(
      `insert into auth.users (
         id, email, email_confirmed_at, raw_user_meta_data
       ) values ($1, 'signup@example.com', now(), $2::jsonb)`,
      [
        REFERRED,
        JSON.stringify({
          portal_signup: "true",
          full_name: "Signup claimant",
          referral_code: "signup referrer",
        }),
      ],
    );

    const client = await db.query<{
      full_name: string;
      approval_status: string;
      referred_by: string | null;
    }>(
      "select full_name, approval_status, referred_by from public.portal_clients where id = $1",
      [REFERRED],
    );
    expect(client.rows[0]).toEqual({
      full_name: "Signup claimant",
      approval_status: "pending",
      referred_by: null,
    });

    const request = await db.query<{
      referred_client_id: string;
      referrer_client_id: string;
      referral_code: string;
      claim_source: string;
    }>(
      "select referred_client_id, referrer_client_id, referral_code, claim_source from public.referral_claim_requests",
    );
    expect(request.rows).toEqual([
      {
        referred_client_id: REFERRED,
        referrer_client_id: CLIENT,
        referral_code: "SIGNUP REFERRER",
        claim_source: "signup",
      },
    ]);
    const events = await db.query<{ count: number }>(
      "select count(*)::int as count from public.referral_attribution_events",
    );
    expect(events.rows[0].count).toBe(0);
  });

  it("rejects browser callers, shared workspaces, rejected clients and referral cycles", async () => {
    await db.query(
      "insert into public.profiles (id, role) values ($1, 'admin')",
      [ADMIN],
    );
    await insertClient(CLIENT, "Ancestor");
    await insertClient(REFERRED, "Existing child", CLIENT);
    await insertClient(PENDING_REFERRAL, "Rejected target", null, "rejected");
    await insertClient(INACTIVE_REFERRAL, "Workspace target");

    await actAs(ADMIN);
    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          INACTIVE_REFERRAL,
          CLIENT,
          crypto.randomUUID(),
          "Browser attempt",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/only the referral service/i);

    await actAsService();
    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          PENDING_REFERRAL,
          CLIENT,
          crypto.randomUUID(),
          "Rejected target",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/rejected client/i);

    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [CLIENT, INACTIVE_REFERRAL],
    );
    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          INACTIVE_REFERRAL,
          CLIENT,
          crypto.randomUUID(),
          "Shared workspace",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/share a workspace/i);

    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          CLIENT,
          REFERRED,
          crypto.randomUUID(),
          "Would create a cycle",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/cycle/i);

    await expect(
      db.query(
        "update public.portal_clients set referred_by = $1 where id = $2",
        [REFERRED, INACTIVE_REFERRAL],
      ),
    ).rejects.toThrow(/cannot be rewritten/i);

    // The signup claim takes the same serialisation lock and applies the same
    // graph invariant as the admin RPC. An existing A -> B attribution means
    // A cannot subsequently claim B and close a reciprocal cycle.
    await actAs(CLIENT);
    const cyclicClaim = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code($1)",
      ["EXISTING CHILD"],
    );
    expect(cyclicClaim.rows[0].claim_referral_code).toBe("cycle");

    await insertClient(STRANGER, "Workspace claimant");
    await actAsService();
    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [CLIENT, STRANGER],
    );
    await actAs(STRANGER);
    const workspaceClaim = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code($1)",
      ["ANCESTOR"],
    );
    expect(workspaceClaim.rows[0].claim_referral_code).toBe(
      "shared_workspace",
    );
  });

  it("seals direct inserts, excludes staff, and detects fellow members of one workspace", async () => {
    await db.query(
      "insert into public.profiles (id, role) values ($1, 'admin')",
      [ADMIN],
    );
    await insertClient(CLIENT, "Ordinary referrer");

    await actAsService();
    await expect(
      db.query(
        `insert into public.portal_clients (
           id, full_name, email, approval_status, referral_code, referred_by
         ) values ($1, 'Forged target', 'forged@example.com', 'approved', 'FORGED', $2)`,
        [INACTIVE_REFERRAL, CLIENT],
      ),
    ).rejects.toThrow(/cannot be inserted directly/i);

    await insertClient(STAFF, "Staff identity");
    await db.query(
      "insert into public.profiles (id, role) values ($1, 'admin')",
      [STAFF],
    );
    await insertClient(REFERRED, "Ordinary target");

    await actAsService();
    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          REFERRED,
          STAFF,
          crypto.randomUUID(),
          "Staff cannot be a referrer",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/staff portal identities/i);
    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          STAFF,
          CLIENT,
          crypto.randomUUID(),
          "Staff cannot be referred",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/staff portal identities/i);

    await actAs(STAFF);
    const staffClaim = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code('ORDINARY REFERRER')",
    );
    expect(staffClaim.rows[0].claim_referral_code).toBe("staff_account");

    await insertClient(MEMBER, "Fellow member one");
    await insertClient(STRANGER, "Fellow member two");
    await insertClient(SHARED_WORKSPACE, "Shared workspace owner");
    await actAsService();
    await db.query(
      `insert into public.client_members (client_id, member_id)
       values ($1, $2), ($1, $3)`,
      [SHARED_WORKSPACE, MEMBER, STRANGER],
    );

    await expect(
      db.query(
        `select * from public.assign_manual_referral_attribution(
           $1, $2, $3, $4, $5
         )`,
        [
          MEMBER,
          STRANGER,
          crypto.randomUUID(),
          "Fellow members are not independent",
          ADMIN,
        ],
      ),
    ).rejects.toThrow(/share a workspace/i);

    await actAs(MEMBER);
    const fellowMemberClaim = await db.query<{
      claim_referral_code: string;
    }>("select public.claim_referral_code('FELLOW MEMBER TWO')");
    expect(fellowMemberClaim.rows[0].claim_referral_code).toBe(
      "shared_workspace",
    );
  });
});

describe("manual referral terms", () => {
  it("requires the explicit cutover before evaluating legacy referral pricing", async () => {
    const preflightDb = await PGlite.create();
    try {
      await preflightDb.exec(PRELUDE);
      await preflightDb.exec(BILLING_MIGRATION);
      await preflightDb.query(
        `insert into public.portal_clients (
           id, full_name, email, approval_status, referral_code
         ) values ($1, 'Legacy referrer', 'legacy@example.com', 'approved', 'LEGACY')`,
        [CLIENT],
      );
      await preflightDb.query(
        `insert into public.ad_accounts (
           id, client_id, store_name, currency, status,
           list_commission_rate, commission_rate
         ) values ($1, $2, 'Legacy store', 'EUR', 'pending', 10, 9.5)`,
        [CLIENT_ACCOUNT, CLIENT],
      );

      await expect(preflightDb.exec(REFERRAL_MIGRATION)).rejects.toThrow(
        /manual_billing_cutovers|explicit (?:legacy billing cutover|reviewed rollover)/i,
      );
      const terms = await preflightDb.query<{ exists: boolean }>(
        `select exists (
           select 1 from information_schema.tables
           where table_schema = 'public'
             and table_name = 'referral_discount_terms'
         ) as exists`,
      );
      expect(terms.rows[0].exists).toBe(false);
    } finally {
      await preflightDb.close();
    }
  });

  it("fails closed before evaluating incompatible states without a cutover", async () => {
    const cases: Array<{
      label: string;
      seed: (preflightDb: PGlite) => Promise<void>;
    }> = [
      {
        label: "a surviving referral attribution even when its cache is 10%",
        seed: async (preflightDb) => {
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code, referred_by
             ) values
               ($1, 'Legacy referrer', 'referrer@example.com', 'approved', 'REFERRER', null),
               ($2, 'Legacy referral', 'referral@example.com', 'approved', 'REFERRAL', $1)`,
            [CLIENT, REFERRED],
          );
        },
      },
      {
        label: "a custom list-rate account",
        seed: async (preflightDb) => {
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code
             ) values ($1, 'Custom client', 'custom@example.com', 'approved', 'CUSTOM')`,
            [CLIENT],
          );
          await preflightDb.query(
            `insert into public.ad_accounts (
               id, client_id, store_name, list_commission_rate,
               commission_rate, revenue_share_enabled, status
             ) values ($1, $2, 'Custom store', 12.5, 12.5, false, 'pending')`,
            [CLIENT_ACCOUNT, CLIENT],
          );
        },
      },
      {
        label: "a revenue-share account",
        seed: async (preflightDb) => {
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code
             ) values ($1, 'Share client', 'share@example.com', 'approved', 'SHARE')`,
            [CLIENT],
          );
          await preflightDb.query(
            `insert into public.ad_accounts (
               id, client_id, store_name, list_commission_rate,
               commission_rate, revenue_share_enabled, status
             ) values ($1, $2, 'Share store', 10, 10, true, 'pending')`,
            [CLIENT_ACCOUNT, CLIENT],
          );
        },
      },
      {
        label: "a historic non-10% Google commission",
        seed: async (preflightDb) => {
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code
             ) values ($1, 'Historic client', 'historic@example.com', 'approved', 'HISTORIC')`,
            [CLIENT],
          );
          await preflightDb.query(
            `insert into public.ad_accounts (
               id, client_id, store_name, list_commission_rate,
               commission_rate, revenue_share_enabled, status
             ) values ($1, $2, 'Historic store', 10, 10, false, 'pending')`,
            [CLIENT_ACCOUNT, CLIENT],
          );
          await preflightDb.query(
            "insert into public.revenue_sources (id, name) values ($1, 'Google Ads Management')",
            [SOURCE],
          );
          await preflightDb.query(
            `insert into public.commissions (
               id, source_id, ad_account_id, occurred_on, gross_amount,
               rate, amount, currency, status
             ) values ($1, $2, $3, $4, 100, 9.5, 9.5, 'EUR', 'confirmed')`,
            [CLIENT_ROW_A, SOURCE, CLIENT_ACCOUNT, START],
          );
        },
      },
      {
        label: "a billing start from a week before the v3 cutover",
        seed: async (preflightDb) => {
          await preflightDb.query(
            "insert into public.profiles (id, role) values ($1, 'admin')",
            [ADMIN],
          );
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code
             ) values ($1, 'Started client', 'started@example.com', 'approved', 'STARTED')`,
            [CLIENT],
          );
          await preflightDb.query(
            `insert into public.ad_accounts (
               id, client_id, store_name, google_ads_customer_id, status
             ) values ($1, $2, 'Started store', '1111111111', 'pending')`,
            [CLIENT_ACCOUNT, CLIENT],
          );
          await preflightDb.query(
            `insert into public.ad_account_billing_starts (
               id, ad_account_id, google_ads_customer_id, google_local_date,
               google_time_zone, currency, baseline_cost_micros,
               capture_started_at, captured_at, capture_id, source,
               reviewed_by
             ) values (
               $1, $2, '1111111111', $3, 'Europe/Lisbon', 'EUR', 0,
               $3::date + time '12:00', $3::date + time '12:00', $4,
               'agency', $5
             )`,
            [
              CLIENT_START_CAPTURE,
              CLIENT_ACCOUNT,
              START,
              crypto.randomUUID(),
              ADMIN,
            ],
          );
        },
      },
      {
        label: "an unissued legacy draft",
        seed: async (preflightDb) => {
          await preflightDb.query(
            `insert into public.portal_clients (
               id, full_name, email, approval_status, referral_code
             ) values ($1, 'Draft client', 'draft@example.com', 'approved', 'DRAFT')`,
            [CLIENT],
          );
          await preflightDb.query(
            `insert into public.invoices (
               client_id, period_start, period_end, amount, currency,
               status, line_items, issued_at
             ) values ($1, $2, $3, 10, 'EUR', 'draft', '[]', null)`,
            [CLIENT, START, END],
          );
        },
      },
    ];

    for (const scenario of cases) {
      const preflightDb = await PGlite.create();
      try {
        await preflightDb.exec(PRELUDE);
        await preflightDb.exec(BILLING_MIGRATION);
        await scenario.seed(preflightDb);
        await expect(
          preflightDb.exec(REFERRAL_MIGRATION),
          scenario.label,
        ).rejects.toThrow(
          /manual_billing_cutovers|explicit (?:legacy billing cutover|reviewed rollover)/i,
        );
      } finally {
        await preflightDb.close();
      }
    }
  }, 15_000);

  it("maps Monday to itself and every other day to the following Monday", async () => {
    const rows = await db.query<{ input: string; effective: string }>(
      `select input::text, public.manual_referral_effective_monday(input)::text as effective
       from unnest(array[
         '2026-08-03'::date, '2026-08-04'::date, '2026-08-05'::date,
         '2026-08-06'::date, '2026-08-07'::date, '2026-08-08'::date,
         '2026-08-09'::date
       ]) input`,
    );
    expect(rows.rows).toEqual([
      { input: "2026-08-03", effective: "2026-08-03" },
      { input: "2026-08-04", effective: "2026-08-10" },
      { input: "2026-08-05", effective: "2026-08-10" },
      { input: "2026-08-06", effective: "2026-08-10" },
      { input: "2026-08-07", effective: "2026-08-10" },
      { input: "2026-08-08", effective: "2026-08-10" },
      { input: "2026-08-09", effective: "2026-08-10" },
    ]);
    const current = await db.query<{ input: string; monday: string }>(
      `select input::text,
              public.manual_referral_current_monday(input)::text as monday
       from unnest(array['2026-08-03'::date,'2026-08-04'::date,'2026-08-09'::date]) input`,
    );
    expect(current.rows).toEqual([
      { input: "2026-08-03", monday: "2026-08-03" },
      { input: "2026-08-04", monday: "2026-08-03" },
      { input: "2026-08-09", monday: "2026-08-03" },
    ]);
  });

  it("does not activate a next-Monday cache term during the current week", async () => {
    await seedReferralEligibility();
    await insertHistoricalTerm([REFERRED], "2026-08-10");
    const rates = await db.query<{ tuesday: string; next_monday: string }>(
      `select
         public.manual_referral_rate_on_day($1,10,'2026-08-04') as tuesday,
         public.manual_referral_rate_on_day($1,10,'2026-08-10') as next_monday`,
      [CLIENT],
    );
    expect(rates.rows[0]).toEqual({ tuesday: "10", next_monday: "9.50" });
  });

  it("creates a sealed 9.5% snapshot with exact Google eligibility evidence", async () => {
    await seedReferralEligibility();
    const result = await schedule({
      decisionId: "20000000-0000-4000-8000-000000000001",
    });
    expect(result.rows[0]).toMatchObject({
      referral_count: 1,
      referral_discount_rate: "0.50",
      fee_rate: "9.50",
      revision: 1,
    });

    const items = await db.query<{
      referred_client_id: string;
      evidence_commission_id: string;
      evidence_billing_start_id: string;
      evidence_gross_amount: string;
      sealed: boolean;
    }>(
      `select item.referred_client_id, item.evidence_commission_id,
              item.evidence_billing_start_id, item.evidence_gross_amount,
              term.sealed_at is not null as sealed
       from public.referral_discount_term_items item
       join public.referral_discount_terms term on term.id = item.term_id`,
    );
    expect(items.rows).toMatchObject([
      {
        referred_client_id: REFERRED,
        evidence_commission_id: REFERRED_ROW,
        evidence_gross_amount: "20.000000",
        sealed: true,
      },
    ]);
  });

  it("uses CAS, exact decision idempotency and append-only revisions", async () => {
    await seedReferralEligibility();
    const decisionId = "20000000-0000-4000-8000-000000000002";
    const first = await schedule({ decisionId });
    const firstId = first.rows[0].id;

    await expect(schedule({ decisionId })).resolves.toMatchObject({
      rows: [{ id: firstId }],
    });
    await expect(
      schedule({ decisionId, reason: "Different replay" }),
    ).rejects.toThrow(/cannot be replayed/i);
    await expect(schedule({ expectedTermId: null })).rejects.toThrow(
      /changed while/i,
    );

    const revoked = await schedule({
      action: "revoke",
      expectedTermId: firstId,
      decisionId: "20000000-0000-4000-8000-000000000003",
      reason: "Referral benefit ended after admin review",
    });
    expect(revoked.rows[0]).toMatchObject({
      referral_count: 0,
      fee_rate: "10.00",
      revision: 2,
    });

    await actAsService();
    await expect(
      db.query(
        "update public.referral_discount_terms set fee_rate = 1 where id = $1",
        [firstId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.query(
        "delete from public.referral_discount_term_items where term_id = $1",
        [firstId],
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects non-service callers, wrong dates, missing service, and shared workspaces", async () => {
    await seedReferralEligibility();
    await actAs(ADMIN);
    await expect(schedule({ assumeRole: false })).rejects.toThrow(
      /only the billing service/i,
    );

    await actAsService();
    await expect(schedule({ effectiveFrom: "2020-01-06" })).rejects.toThrow(
      /may take effect only/i,
    );

    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [CLIENT, REFERRED],
    );
    await expect(schedule()).rejects.toThrow(/share a workspace/i);
    await db.query("delete from public.client_members");
    await db.query("delete from public.commissions where id = $1", [
      REFERRED_ROW,
    ]);
    await expect(schedule()).rejects.toThrow(/recent confirmed Google spend/i);
  });

  it("never grants discounts from staff identities or fellow workspace members", async () => {
    await seedReferralEligibility();

    await db.query(
      "insert into public.profiles (id, role) values ($1, 'admin')",
      [REFERRED],
    );
    await expect(schedule()).rejects.toThrow(/staff portal identities/i);
    await db.query("delete from public.profiles where id = $1", [REFERRED]);

    await db.query(
      "insert into public.profiles (id, role) values ($1, 'admin')",
      [CLIENT],
    );
    await expect(schedule()).rejects.toThrow(/staff portal identities/i);
    await db.query("delete from public.profiles where id = $1", [CLIENT]);

    await insertClient(SHARED_WORKSPACE, "Shared discount workspace");
    await actAsService();
    await db.query(
      `insert into public.client_members (client_id, member_id)
       values ($1, $2), ($1, $3)`,
      [SHARED_WORKSPACE, CLIENT, REFERRED],
    );
    await expect(schedule()).rejects.toThrow(/share a workspace/i);
  });

  it("keeps claims pending until admin review and refuses every attribution rewrite", async () => {
    await db.query(
      "insert into public.profiles (id, role) values ($1, 'admin')",
      [ADMIN],
    );
    await insertClient(CLIENT, "Owner");
    await insertClient(REFERRED, "Joiner");

    await actAs(REFERRED);
    const claimed = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code('OWNER')",
    );
    expect(claimed.rows[0].claim_referral_code).toBe("ok");

    await actAs(ADMIN);
    await expect(
      db.query(
        "update public.portal_clients set referred_by = $1 where id = $2",
        [CLIENT, REFERRED],
      ),
    ).rejects.toThrow(/cannot be rewritten/i);

    await actAsService();
    await db.query(
      `select * from public.assign_manual_referral_attribution(
         $1, $2, $3, $4, $5
       )`,
      [
        REFERRED,
        CLIENT,
        crypto.randomUUID(),
        "Pending code independently reviewed",
        ADMIN,
      ],
    );
    await expect(
      db.query(
        "update public.portal_clients set referred_by = null where id = $1",
        [REFERRED],
      ),
    ).rejects.toThrow(/cannot be rewritten/i);
    await expect(
      db.query("delete from public.portal_clients where id = $1", [CLIENT]),
    ).rejects.toThrow(/foreign key/i);
  });

  it("shows only safe manual-review states to the workspace owner and members", async () => {
    await seedReferralEligibility();
    await insertClient(PENDING_REFERRAL, "Pending referral", CLIENT, "pending");
    await insertClient(INACTIVE_REFERRAL, "Inactive referral", CLIENT);
    await insertClient(MEMBER, "Workspace member");
    await insertClient(STRANGER, "Stranger");
    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [CLIENT, MEMBER],
    );

    await actAs(CLIENT);
    const ownerView = await db.query<{ name: string; status: string }>(
      "select * from public.referral_summary($1)",
      [CLIENT],
    );
    expect(
      Object.fromEntries(ownerView.rows.map((row) => [row.name, row.status])),
    ).toEqual({
      Referred: "awaiting_review",
      "Pending referral": "pending",
      "Inactive referral": "pending",
    });
    expect(
      ownerView.rows.every(
        (row) => Object.keys(row).sort().join(",") === "name,status",
      ),
    ).toBe(true);

    await actAs(MEMBER);
    const memberView = await db.query<{ name: string; status: string }>(
      "select * from public.referral_summary($1)",
      [CLIENT],
    );
    expect(memberView.rows).toEqual(ownerView.rows);

    await actAs(STRANGER);
    const strangerView = await db.query(
      "select * from public.referral_summary($1)",
      [CLIENT],
    );
    expect(strangerView.rows).toEqual([]);
  });

  it("prefers current and next-Monday term membership over live eligibility", async () => {
    await seedReferralEligibility();
    await insertClient(SCHEDULED_REFERRAL, "Scheduled referral", CLIENT);
    const monday = await currentMonday();
    await insertHistoricalTerm([REFERRED], monday);
    await insertHistoricalTerm(
      [REFERRED, SCHEDULED_REFERRAL],
      addIsoDays(monday, 7),
    );

    await actAs(CLIENT);
    const summary = await db.query<{ name: string; status: string }>(
      "select * from public.referral_summary($1)",
      [CLIENT],
    );
    expect(
      Object.fromEntries(summary.rows.map((row) => [row.name, row.status])),
    ).toEqual({
      Referred: "approved",
      "Scheduled referral": "scheduled",
    });
  });

  it("exposes a sanitized latest-revision rate schedule only to workspace members", async () => {
    await seedReferralEligibility();
    await insertClient(SCHEDULED_REFERRAL, "Scheduled referral", CLIENT);
    await insertClient(MEMBER, "Workspace member");
    await insertClient(STRANGER, "Stranger");
    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [CLIENT, MEMBER],
    );
    const monday = await currentMonday();
    const previousMonday = addIsoDays(monday, -7);
    await insertHistoricalTerm([REFERRED], previousMonday);
    await insertHistoricalTerm([REFERRED], monday, 1);
    await insertHistoricalTerm([REFERRED, SCHEDULED_REFERRAL], monday, 2);

    const readSchedule = () =>
      db.query<{
        effective_from: string;
        revision: number;
        referral_count: number;
        referral_discount_rate: string;
        fee_rate: string;
      }>(
        `select effective_from::text, revision, referral_count,
                referral_discount_rate::text, fee_rate::text
         from public.manual_referral_rate_schedule($1)`,
        [CLIENT],
      );

    await actAs(CLIENT);
    const ownerView = await readSchedule();
    expect(ownerView.rows).toEqual([
      {
        effective_from: previousMonday,
        revision: 1,
        referral_count: 1,
        referral_discount_rate: "0.50",
        fee_rate: "9.50",
      },
      {
        effective_from: monday,
        revision: 2,
        referral_count: 2,
        referral_discount_rate: "1.00",
        fee_rate: "9.00",
      },
    ]);
    expect(
      ownerView.rows.every(
        (row) =>
          Object.keys(row).sort().join(",") ===
          "effective_from,fee_rate,referral_count,referral_discount_rate,revision",
      ),
    ).toBe(true);

    await actAs(MEMBER);
    await expect(readSchedule()).resolves.toMatchObject({
      rows: ownerView.rows,
    });
    await actAs(STRANGER);
    await expect(readSchedule()).rejects.toThrow(/not allowed/i);
  });

  it("exposes no authenticated write or scheduling privilege", async () => {
    const privileges = await db.query<{
      schedule: boolean;
      insert_term: boolean;
      effective_rate: boolean;
      effective_rate_anon: boolean;
      legacy_count: boolean;
      legacy_count_anon: boolean;
      rate_schedule: boolean;
      rate_schedule_anon: boolean;
    }>(
      `select
         has_function_privilege(
           'authenticated',
           'public.schedule_manual_referral_discount(uuid,uuid,text,date,uuid,uuid,text,uuid)',
           'EXECUTE'
         ) as schedule,
         has_table_privilege('authenticated','public.referral_discount_terms','INSERT')
           as insert_term,
         has_function_privilege(
           'authenticated',
           'public.effective_commission_rate(uuid,numeric)',
           'EXECUTE'
         ) as effective_rate,
         has_function_privilege(
           'authenticated',
           'public.active_referral_count(uuid)',
           'EXECUTE'
         ) as legacy_count,
         has_function_privilege(
           'anon',
           'public.effective_commission_rate(uuid,numeric)',
           'EXECUTE'
         ) as effective_rate_anon,
         has_function_privilege(
           'anon',
           'public.active_referral_count(uuid)',
           'EXECUTE'
         ) as legacy_count_anon,
         has_function_privilege(
           'authenticated',
           'public.manual_referral_rate_schedule(uuid)',
           'EXECUTE'
         ) as rate_schedule,
         has_function_privilege(
           'anon',
           'public.manual_referral_rate_schedule(uuid)',
           'EXECUTE'
         ) as rate_schedule_anon`,
    );
    expect(privileges.rows[0]).toEqual({
      schedule: false,
      insert_term: false,
      effective_rate: false,
      effective_rate_anon: false,
      legacy_count: false,
      legacy_count_anon: false,
      rate_schedule: true,
      rate_schedule_anon: false,
    });
  });
});

describe("v3 manual referral invoices", () => {
  it("validates recipient JSON without accepting scalar, array or extra-key shapes", async () => {
    const checked = await db.query<{
      scalar: boolean;
      array_value: boolean;
      exact_object: boolean;
    }>(
      `select
         public.is_valid_invoice_billing_recipient('"recipient"'::jsonb) as scalar,
         public.is_valid_invoice_billing_recipient('[]'::jsonb) as array_value,
         public.is_valid_invoice_billing_recipient(
           '{"email":"referrer@example.com","fallbackName":"Referrer","billingName":null,"taxId":null,"addressLine1":null,"addressLine2":null,"addressCity":null,"addressPostalCode":null,"addressState":null,"addressCountry":null}'::jsonb
         ) as exact_object`,
    );
    expect(checked.rows[0]).toEqual({
      scalar: false,
      array_value: false,
      exact_object: true,
    });
  });

  it("refuses to infer a 10% price before the immutable v3 cutover", async () => {
    await db.query(
      "update public.manual_referral_billing_config set v3_cutover_monday = date '2026-07-27'",
    );
    await seedInvoiceWeek();
    await expect(issueV3()).rejects.toThrow(/pre-cutover week/i);

    const privileges = await db.query<{
      authenticated_update: boolean;
      service_update: boolean;
    }>(
      `select
         has_table_privilege(
           'authenticated',
           'public.manual_referral_billing_config',
           'UPDATE'
         ) as authenticated_update,
         has_table_privilege(
           'service_role',
           'public.manual_referral_billing_config',
           'UPDATE'
         ) as service_update`,
    );
    expect(privileges.rows[0]).toEqual({
      authenticated_update: false,
      service_update: false,
    });
  });

  it("settles the default term at 10% and blocks every v2 creation bypass", async () => {
    await seedInvoiceWeek();
    const issued = await issueV3();
    expect(issued.rows).toMatchObject([
      {
        amount: "30.00",
        status: "draft",
        calculation_version: VERSION,
        referral_discount_term_id: null,
      },
    ]);
    const invoice = issued.rows[0] as {
      id: string;
      line_items: Record<string, unknown>[];
    };
    expect(invoice.line_items[0]).toMatchObject({
      rate: 10,
      listRate: 10,
      referralDiscountRate: 0,
      referralCount: 0,
      amount: 30,
      label:
        "Client store - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 300.000000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%)",
    });

    const privilege = await db.query<{ v2: boolean; v3: boolean }>(
      `select
         has_function_privilege(
           'service_role',
           'public.create_manual_invoice(uuid,date,date,numeric,jsonb,jsonb,uuid,text)',
           'EXECUTE'
         ) as v2,
         has_function_privilege(
           'service_role',
           'public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)',
           'EXECUTE'
         ) as v3`,
    );
    expect(privilege.rows[0]).toEqual({ v2: false, v3: true });

    await actAsService();
    await expect(
      db.query("delete from public.invoices where id = $1", [invoice.id]),
    ).rejects.toThrow(/cannot be deleted/i);
    await expect(
      db.query(
        "delete from public.invoice_commission_rows where invoice_id = $1",
        [invoice.id],
      ),
    ).rejects.toThrow(/ledger claim is immutable/i);
  });

  it("freezes the exact reviewed recipient and rejects later invoice rewrites", async () => {
    await seedInvoiceWeek();
    await actAsService();
    await db.query(
      `insert into public.billing_profiles (
         client_id, billing_name, tax_id, address_line1, address_line2,
         address_city, address_postal_code, address_state, address_country
       ) values ($1,'Referrer Commerce, Lda.','PT123456789','Rua Um, 10',null,
         'Lisboa','1000-001','Lisboa','PT')`,
      [CLIENT],
    );

    const recipient = {
      email: "referrer@example.com",
      fallbackName: "Referrer",
      billingName: "Referrer Commerce, Lda.",
      taxId: "PT123456789",
      addressLine1: "Rua Um, 10",
      addressLine2: null,
      addressCity: "Lisboa",
      addressPostalCode: "1000-001",
      addressState: "Lisboa",
      addressCountry: "PT",
    };
    const issued = await issueV3({ recipientPatch: recipient });
    expect(issued.rows[0]).toMatchObject({ billing_recipient: recipient });

    await actAsService();
    await db.query(
      "update public.billing_profiles set billing_name = 'New Entity' where client_id = $1",
      [CLIENT],
    );
    const persisted = await db.query<{ billing_recipient: typeof recipient }>(
      "select billing_recipient from public.invoices where client_id = $1",
      [CLIENT],
    );
    expect(persisted.rows[0].billing_recipient).toEqual(recipient);

    await expect(
      db.query(
        `update public.invoices
         set billing_recipient = jsonb_set(billing_recipient,'{billingName}','"Tampered"')
         where client_id = $1`,
        [CLIENT],
      ),
    ).rejects.toThrow(/commercial snapshot is immutable/i);
  });

  it("rejects a stale, malformed or overlong reviewed recipient", async () => {
    await seedInvoiceWeek();

    await expect(
      issueV3({ recipientPatch: { email: "different@example.com" } }),
    ).rejects.toThrow(/recipient changed/i);
    await expect(
      issueV3({ recipientPatch: { unexpected: "field" } }),
    ).rejects.toThrow(/invalid or incomplete shape/i);
    await expect(
      issueV3({ recipientPatch: { taxId: "X".repeat(31) } }),
    ).rejects.toThrow(/invalid or incomplete shape/i);
  });

  it("uses the historical 9.5% term, validates the line, and freezes its grant", async () => {
    await seedReferralEligibility();
    await seedInvoiceWeek();
    const termId = await insertHistoricalTerm([REFERRED]);
    const issued = await issueV3({ termId });
    expect(issued.rows).toMatchObject([
      {
        amount: "28.50",
        status: "draft",
        referral_discount_term_id: termId,
      },
    ]);
    const invoice = issued.rows[0] as { line_items: Record<string, unknown>[] };
    expect(invoice.line_items[0]).toMatchObject({
      rate: 9.5,
      listRate: 10,
      referralDiscountRate: 0.5,
      referralCount: 1,
      amount: 28.5,
      label:
        "Client store - Google Ads agency fee (9.5% of captured Google-reported billable spend: EUR 300.000000; manual referral term: approved referral count 1; 10% - 0.5 percentage points = 9.5%)",
    });
    const frozen = await db.query<{ count: string }>(
      "select count(*) from public.invoice_referral_events",
    );
    expect(Number(frozen.rows[0].count)).toBe(1);

    // A fresh database transaction is not available after the unique
    // client/week claim, so prove tamper rejection on an otherwise identical
    // second fixture below by rolling this one back at the RPC boundary.
  });

  it("composes the manual term clause with opening and closing Google boundaries", async () => {
    await seedInvoiceWeek({
      startDate: "2026-07-23",
      baselineMicros: "40000000",
      sync: false,
      rows: [
        { id: CLIENT_ROW_A, day: "2026-07-23", gross: "100.000000" },
        { id: CLIENT_ROW_B, day: END, gross: "200.000000" },
      ],
    });
    await endClientBilling("180000000");
    await recordSync();
    const issued = await issueV3();
    expect(issued.rows).toMatchObject([{ amount: "24.00", status: "draft" }]);
    const invoice = issued.rows[0] as { line_items: Record<string, unknown>[] };
    expect(invoice.line_items[0]).toMatchObject({
      baseAmount: 240,
      sourceGrossAmount: 300,
      baselineDeductionAmount: 40,
      billingEndCounterAmount: 180,
      endingCapApplied: true,
      endDeductionAmount: 20,
      label:
        "Client store - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 240.000000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%; billing started 2026-07-23T12:00:00.000Z; billing ended 2026-07-26T12:00:00.000Z at Google day counter EUR 180.000000; billable period 2026-07-23 to 2026-07-26 in UTC; Google-reported spend EUR 300.000000 minus opening baseline EUR 40.000000 minus post-service spend EUR 20.000000)",
    });
  });

  it("rejects a stale term id and line fields that do not match SQL", async () => {
    await seedReferralEligibility();
    await seedInvoiceWeek();
    const termId = await insertHistoricalTerm([REFERRED]);
    await expect(issueV3({ termId: null })).rejects.toThrow(
      /term changed|does not apply/i,
    );
    await expect(issueV3({ termId, linePatch: { rate: 10 } })).rejects.toThrow(
      /do not match the v3/i,
    );
  });

  it("keeps sub-cent store lines as local evidence while still claiming every row", async () => {
    await seedInvoiceWeek();
    await insertTrackedAccount({
      clientId: CLIENT,
      accountId: CLIENT_ACCOUNT_TINY,
      customerId: "3333333333",
      captureId: CLIENT_TINY_CAPTURE,
      startDate: "2026-07-01",
      store: "Tiny store",
    });
    await insertSpend({
      id: CLIENT_ROW_TINY,
      accountId: CLIENT_ACCOUNT_TINY,
      day: START,
      gross: "0.010000",
    });
    await recordSync(CLIENT_ACCOUNT_TINY);

    const issued = await issueV3({
      ledgerIds: [CLIENT_ROW_A, CLIENT_ROW_B, CLIENT_ROW_TINY],
    });
    const invoice = issued.rows[0] as {
      id: string;
      amount: string;
      line_items: Record<string, unknown>[];
    };
    expect(invoice.amount).toBe("30.00");
    expect(invoice.line_items).toHaveLength(2);
    expect(invoice.line_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ store: "Client store", amount: 30 }),
        expect.objectContaining({ store: "Tiny store", amount: 0 }),
      ]),
    );
    const claims = await db.query<{ count: number }>(
      "select count(*)::int as count from public.invoice_commission_rows where invoice_id = $1",
      [invoice.id],
    );
    expect(claims.rows[0].count).toBe(3);
  });

  it("records a 0% week as an immutable local waived settlement and consumes rows", async () => {
    await seedReferralEligibility();
    await seedInvoiceWeek();

    const referredIds = [REFERRED];
    for (let index = 1; index < 20; index += 1) {
      const id = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      await insertClient(id, `Referral${index}`, CLIENT);
      referredIds.push(id);
    }
    const termId = await insertHistoricalTerm(referredIds);
    const issued = await issueV3({ termId });
    expect(issued.rows).toMatchObject([
      {
        amount: "0.00",
        amount_remaining: "0.00",
        status: "waived",
        due_date: null,
        stripe_invoice_id: null,
        stripe_hosted_url: null,
        referral_discount_term_id: termId,
      },
    ]);
    const invoice = issued.rows[0] as {
      id: string;
      issued_at: string | Date;
      line_items: Record<string, unknown>[];
    };
    expect(invoice.issued_at).toBeTruthy();
    expect(invoice.line_items[0]).toMatchObject({
      rate: 0,
      referralDiscountRate: 10,
      referralCount: 20,
      amount: 0,
      label:
        "Client store - Google Ads agency fee (0% of captured Google-reported billable spend: EUR 300.000000; manual referral term: approved referral count 20; 10% - 10 percentage points = 0%)",
    });

    const evidence = await db.query<{ claims: number; referrals: number }>(
      `select
         (select count(*) from public.invoice_commission_rows where invoice_id = $1) as claims,
         (select count(*) from public.invoice_referral_events where invoice_id = $1) as referrals`,
      [invoice.id],
    );
    expect(evidence.rows[0]).toEqual({ claims: 2, referrals: 20 });

    await actAsService();
    await expect(
      db.query(
        "update public.invoices set status = 'draft', stripe_invoice_id = 'in_bad' where id = $1",
        [invoice.id],
      ),
    ).rejects.toThrow(/waived settlement is immutable/i);
    await expect(
      db.query("delete from public.invoices where id = $1", [invoice.id]),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it("does not manufacture a settlement when every Google row has zero billable spend", async () => {
    await seedInvoiceWeek({
      startDate: START,
      baselineMicros: "100000000",
      rows: [{ id: CLIENT_ROW_A, day: START, gross: "100.000000" }],
    });
    await actAsService();
    await expect(
      db.query(
        `select * from public.create_manual_referral_invoice(
           $1,$2,$3,0,
           '[{"accountId":"${CLIENT_ACCOUNT}","amount":0}]'::jsonb,
           '[{"commission_id":"${CLIENT_ROW_A}"}]'::jsonb,
           '{"email":"referrer@example.com","fallbackName":"Referrer","billingName":null,"taxId":null,"addressLine1":null,"addressLine2":null,"addressCity":null,"addressPostalCode":null,"addressState":null,"addressCountry":null}'::jsonb,
           null,$4,$5
         )`,
        [CLIENT, START, END, ADMIN, VERSION],
      ),
    ).rejects.toThrow(/without positive billable Google spend/i);
  });
});
