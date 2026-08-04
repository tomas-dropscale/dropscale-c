import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0035_historical_full_day_rollover.sql",
  "utf8",
);

const ADMIN = "34000000-0000-4000-8000-000000000001";
const MEMBER = "34000000-0000-4000-8000-000000000002";
const CLIENT = "34000000-0000-4000-8000-000000000003";
const OTHER_CLIENT = "34000000-0000-4000-8000-000000000004";
const ACCOUNT_A = "34000000-0000-4000-8000-000000000005";
const ACCOUNT_B = "34000000-0000-4000-8000-000000000006";
const SOURCE = "34000000-0000-4000-8000-000000000007";
const LEGACY_INVOICE = "34000000-0000-4000-8000-000000000008";
const PRE_ENTRY = "34000000-0000-4000-8000-000000000009";
const ENTRY_DAY = "34000000-0000-4000-8000-000000000010";
const SUNDAY_A = "34000000-0000-4000-8000-000000000011";
const SUNDAY_B = "34000000-0000-4000-8000-000000000012";
const AFTER_WEEK = "34000000-0000-4000-8000-000000000013";
const OLD_LEASE = "34000000-0000-4000-8000-000000000014";
const AUTO_LEASE = "34000000-0000-4000-8000-000000000015";
const ADMIN_LEASE = "34000000-0000-4000-8000-000000000016";
const START_A = "34000000-0000-4000-8000-000000000017";
const START_B = "34000000-0000-4000-8000-000000000018";
const BOUNDARY_A = "34000000-0000-4000-8000-000000000019";
const BOUNDARY_B = "34000000-0000-4000-8000-000000000020";
const METADATA_A = "34000000-0000-4000-8000-000000000021";
const METADATA_B = "34000000-0000-4000-8000-000000000022";
const SYNC_A = "34000000-0000-4000-8000-000000000023";
const SYNC_B = "34000000-0000-4000-8000-000000000024";

const VERSION = "agency-fee-eur-10-historical-rollover-2026-07-27";
const V3_VERSION = "agency-fee-eur-v3-manual-referrals-google-boundaries";

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
  approval_status text not null,
  created_at timestamptz not null default now()
);

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

create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  store_name text not null,
  google_ads_customer_id text unique,
  google_ads_connected boolean not null default false,
  currency text not null default 'EUR',
  status text not null default 'active',
  commission_rate numeric not null default 10,
  list_commission_rate numeric not null default 10,
  revenue_share_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.reviewed_full_day_billing_boundaries (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique references public.ad_accounts(id),
  client_id uuid not null references public.portal_clients(id),
  google_ads_customer_id text not null,
  account_created_at timestamptz not null,
  entry_day date not null,
  entry_time_zone text not null,
  google_local_date date not null,
  google_time_zone text not null,
  entry_day_treatment text not null,
  currency text not null,
  cutover_monday date not null,
  policy_version text not null,
  metadata_capture_id uuid not null unique,
  metadata_capture_started_at timestamptz not null,
  metadata_captured_at timestamptz not null,
  metadata_authority text not null,
  metadata_contract text not null,
  source_snapshot jsonb not null,
  source_fingerprint text not null,
  sealed_at timestamptz not null default clock_timestamp(),
  sealed_by text not null default current_user,
  unique (
    id, ad_account_id, google_ads_customer_id, google_local_date,
    google_time_zone, currency
  )
);

create table public.ad_account_billing_starts (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique references public.ad_accounts(id),
  google_ads_customer_id text not null,
  google_local_date date not null,
  google_time_zone text not null,
  currency text not null,
  baseline_cost_micros numeric,
  capture_started_at timestamptz,
  captured_at timestamptz,
  capture_id uuid,
  source text,
  reviewed_by uuid references public.profiles(id),
  start_basis text not null,
  reviewed_full_day_boundary_id uuid unique,
  created_at timestamptz not null default now(),
  foreign key (
    reviewed_full_day_boundary_id, ad_account_id, google_ads_customer_id,
    google_local_date, google_time_zone, currency
  ) references public.reviewed_full_day_billing_boundaries (
    id, ad_account_id, google_ads_customer_id, google_local_date,
    google_time_zone, currency
  )
);

create table public.ad_account_billing_ends (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null unique references public.ad_accounts(id),
  billing_start_id uuid not null unique references public.ad_account_billing_starts(id),
  google_ads_customer_id text not null,
  google_local_date date not null,
  google_time_zone text not null,
  currency text not null,
  end_cost_micros numeric not null,
  capture_started_at timestamptz not null,
  captured_at timestamptz not null,
  capture_id uuid not null,
  source text not null,
  reviewed_by uuid not null references public.profiles(id)
);

create table public.google_ledger_sync_windows (
  ad_account_id uuid not null references public.ad_accounts(id),
  billing_start_id uuid not null references public.ad_account_billing_starts(id),
  billing_end_id uuid references public.ad_account_billing_ends(id),
  period_start date not null,
  period_end date not null,
  run_id uuid not null,
  status text not null,
  started_at timestamptz not null,
  synced_at timestamptz not null,
  ledger_snapshot jsonb not null,
  primary key (ad_account_id, period_start, period_end)
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
  revenue_share_base numeric not null default 0,
  revenue_share_amount numeric not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.is_valid_invoice_billing_recipient(
  p_recipient jsonb
)
returns boolean
language sql immutable
as $$
  select coalesce(
    jsonb_typeof(p_recipient) = 'object'
    and btrim(p_recipient->>'email') <> ''
    and btrim(p_recipient->>'fallbackName') <> ''
    and p_recipient->>'addressCountry' ~ '^[A-Z]{2}$',
    false
  )
$$;

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'EUR',
  status text not null default 'draft'
    check (status in ('draft','open','paid','void','uncollectible','waived')),
  due_date date,
  line_items jsonb not null default '[]',
  stripe_invoice_id text unique,
  stripe_hosted_url text,
  stripe_invoice_number text,
  stripe_invoice_pdf text,
  amount_remaining numeric(12,2),
  issue_error text,
  issue_attempted_at timestamptz,
  issued_by uuid references public.profiles(id) on delete set null,
  calculation_version text not null default 'legacy',
  referral_discount_term_id uuid,
  billing_recipient jsonb,
  issued_at timestamptz,
  paid_at timestamptz,
  payment_failed_at timestamptz,
  stripe_sent_at timestamptz,
  stripe_delivery_assumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, period_start)
);

create or replace function public.guard_invoice_commercial_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'An invoice commercial snapshot cannot be deleted.';
  end if;
  if new.client_id is distinct from old.client_id
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.line_items is distinct from old.line_items
     or new.issued_by is distinct from old.issued_by
     or new.calculation_version is distinct from old.calculation_version
     or new.referral_discount_term_id is distinct from old.referral_discount_term_id
     or new.billing_recipient is distinct from old.billing_recipient then
    raise exception 'An invoice commercial snapshot is immutable.';
  end if;
  return new;
end
$$;
create trigger invoices_guard_commercial_snapshot
  before update or delete on public.invoices
  for each row execute function public.guard_invoice_commercial_snapshot();

create table public.manual_billing_cutover_invoice_snapshots (
  invoice_id uuid primary key,
  snapshot jsonb not null,
  archived_at timestamptz not null default now()
);

create table public.invoice_commission_rows (
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  commission_id uuid not null unique references public.commissions(id) on delete restrict,
  gross_amount numeric(18,6) not null check (gross_amount >= 0),
  billing_start_id uuid,
  baseline_deduction_amount numeric(18,6),
  billing_end_id uuid,
  end_deduction_amount numeric(18,6),
  billable_gross_amount numeric(18,6),
  currency text not null check (upper(currency) = 'EUR'),
  created_at timestamptz not null default now(),
  primary key (invoice_id, commission_id),
  check (
    (
      billing_start_id is null
      and baseline_deduction_amount is null
      and billing_end_id is null
      and end_deduction_amount is null
      and billable_gross_amount is null
    )
    or
    (
      billing_start_id is not null
      and baseline_deduction_amount is not null
      and baseline_deduction_amount >= 0
      and billable_gross_amount is not null
      and billable_gross_amount = gross_amount - baseline_deduction_amount
      and billing_end_id is null
      and end_deduction_amount is null
    )
  )
);

create table public.billing_issue_leases (
  lease_token uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  fencing_token bigint not null check (fencing_token > 0),
  period_start date not null,
  issued_by uuid not null references public.profiles(id),
  acquired_at timestamptz not null,
  renewed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  released_at timestamptz,
  unique (client_id, fencing_token)
);

create or replace function public.create_manual_referral_invoice(
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
language plpgsql
security definer
set search_path = public
as $$
declare
  created_invoice public.invoices;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can create a manual referral invoice.';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_issued_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin reviewer is required to create a manual referral invoice.';
  end if;

  insert into public.invoices (
    client_id, period_start, period_end, amount, currency, status, due_date,
    line_items, issued_by, calculation_version, referral_discount_term_id,
    billing_recipient
  ) values (
    p_client_id, p_period_start, p_period_end, p_amount, 'EUR', 'draft',
    p_period_end + 8, p_line_items, p_issued_by, p_calculation_version,
    p_referral_term_id, p_billing_recipient
  ) returning * into created_invoice;
  return next created_invoice;
end
$$;

grant usage on schema public to authenticated, anon, service_role;
grant select on all tables in schema public to authenticated, service_role;
revoke insert on public.invoices from public, anon, authenticated, service_role;
revoke all on function public.create_manual_referral_invoice(
  uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text
) from public, anon, authenticated;
grant execute on function public.create_manual_referral_invoice(
  uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text
) to service_role;
`;

type DatabaseOptions = {
  invalidCurrency?: boolean;
  unsafeLegacy?: boolean;
  subCentFee?: boolean;
  perAccountRounding?: boolean;
  noLegacy?: boolean;
};

async function actAs(db: PGlite, role: string, uid: string | null = null) {
  await db.query(
    "select set_config('test.role', $1, false), set_config('test.uid', $2, false)",
    [role, uid ?? ""],
  );
}

async function seedDatabase(options: DatabaseOptions = {}) {
  const db = new PGlite();
  await db.exec(PRELUDE);
  await db.query(
    `insert into public.profiles (id, role)
     values ($1, 'admin'), ($2, 'member')`,
    [ADMIN, MEMBER],
  );
  await db.query(
    `insert into public.portal_clients (
       id, full_name, email, approval_status
     ) values
       ($1, 'Rollover Client', 'billing@example.com', 'approved'),
       ($2, 'Other Client', 'other@example.com', 'approved')`,
    [CLIENT, OTHER_CLIENT],
  );
  await db.query(
    `insert into public.billing_profiles (
       client_id, billing_name, tax_id, address_line1, address_city,
       address_postal_code, address_country
     ) values
       ($1, 'Rollover Company', 'PT123456789', 'Rua Um', 'Lisboa',
        '1000-001', 'PT'),
       ($2, 'Other Company', null, 'Rua Dois', 'Porto', '4000-001', 'PT')`,
    [CLIENT, OTHER_CLIENT],
  );
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, google_ads_customer_id,
       google_ads_connected, currency, commission_rate,
       list_commission_rate, revenue_share_enabled, created_at
     ) values
       ($1, $2, 'Late Store', '1111111111', true, 'EUR', 10, 10, false,
        '2026-07-29T23:30:00Z'),
       ($3, $2, 'Sunday Store', '2222222222', true, 'EUR', 10, 10, false,
        '2026-08-02T00:30:00Z')`,
    [ACCOUNT_A, CLIENT, ACCOUNT_B],
  );
  await db.query(
    `insert into public.revenue_sources (id, name)
     values ($1, 'Google Ads Management')`,
    [SOURCE],
  );
  await db.query(
    `with evidence (
       id, account_id, client_id, customer_id, account_created_at, entry_day,
       google_local_date, metadata_capture_id
     ) as (
       values
         ($1::uuid, $2::uuid, $3::uuid, '1111111111',
          '2026-07-29T23:30:00Z'::timestamptz, '2026-07-30'::date,
          '2026-07-30'::date, $4::uuid),
         ($5::uuid, $6::uuid, $3::uuid, '2222222222',
          '2026-08-02T00:30:00Z'::timestamptz, '2026-08-02'::date,
          '2026-08-02'::date, $7::uuid)
     ), snapshots as (
       select
         evidence.*,
         jsonb_build_object(
           'accountId', evidence.account_id::text,
           'clientId', evidence.client_id::text,
           'googleAdsCustomerId', evidence.customer_id,
           'googleAdsConnected', true,
           'entryDay', evidence.entry_day::text,
           'entryTimeZone', 'Europe/Lisbon',
           'googleLocalDate', evidence.google_local_date::text,
           'googleTimeZone', 'Europe/Lisbon',
           'metadataCaptureId', evidence.metadata_capture_id::text
         ) as source_snapshot
       from evidence
     )
     insert into public.reviewed_full_day_billing_boundaries (
       id, ad_account_id, client_id, google_ads_customer_id,
       account_created_at, entry_day, entry_time_zone, google_local_date,
       google_time_zone, entry_day_treatment, currency, cutover_monday,
       policy_version, metadata_capture_id, metadata_capture_started_at,
       metadata_captured_at, metadata_authority, metadata_contract,
       source_snapshot, source_fingerprint, sealed_at
     )
     select
       snapshot.id, snapshot.account_id, snapshot.client_id,
       snapshot.customer_id, snapshot.account_created_at, snapshot.entry_day,
       'Europe/Lisbon', snapshot.google_local_date, 'Europe/Lisbon',
       'full-day-inclusive', 'EUR', '2026-08-03',
       'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2',
       snapshot.metadata_capture_id, '2026-08-03T09:00:00Z',
       '2026-08-03T09:00:01Z', 'client_oauth',
       'google-customer-metadata-v1', snapshot.source_snapshot,
       md5(jsonb_build_object(
         'policyVersion',
           'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2',
         'cutoverMonday', '2026-08-03',
         'entryDayTreatment', 'full-day-inclusive',
         'sourceSnapshot', snapshot.source_snapshot
       )::text),
       '2026-08-03T09:00:02Z'
     from snapshots snapshot`,
    [
      BOUNDARY_A,
      ACCOUNT_A,
      CLIENT,
      METADATA_A,
      BOUNDARY_B,
      ACCOUNT_B,
      METADATA_B,
    ],
  );
  await db.query(
    `insert into public.ad_account_billing_starts (
       id, ad_account_id, google_ads_customer_id, google_local_date,
       google_time_zone, currency, baseline_cost_micros, capture_started_at,
       captured_at, capture_id, source, reviewed_by, start_basis,
       reviewed_full_day_boundary_id
     ) values
       ($1, $2, '1111111111', '2026-07-30', 'Europe/Lisbon', 'EUR',
        null, null, null, null, null, null, 'reviewed_full_day', $3),
       ($4, $5, '2222222222', '2026-08-02', 'Europe/Lisbon', 'EUR',
        null, null, null, null, null, null, 'reviewed_full_day', $6)`,
    [START_A, ACCOUNT_A, BOUNDARY_A, START_B, ACCOUNT_B, BOUNDARY_B],
  );
  await db.query(
    `insert into public.commissions (
       id, source_id, ad_account_id, occurred_on, gross_amount, rate, amount,
       currency, status, revenue_share_base, revenue_share_amount
     ) values
       ($1, $6, $7, '2026-07-29', 999, 4, 39.96, 'EUR', 'confirmed', 500, 25),
       ($2, $6, $7, '2026-07-30', 100.123456, 9.5, 9.511728, 'EUR', 'confirmed', 500, 25),
       ($3, $6, $7, '2026-08-02', 200, 8, 16, 'EUR', 'confirmed', 500, 25),
       ($4, $6, $8, '2026-08-02', 50, 7, 3.5, $9, 'confirmed', 500, 25),
       ($5, $6, $7, '2026-08-03', 700, 10, 70, 'EUR', 'confirmed', 0, 0)`,
    [
      PRE_ENTRY,
      ENTRY_DAY,
      SUNDAY_A,
      SUNDAY_B,
      AFTER_WEEK,
      SOURCE,
      ACCOUNT_A,
      ACCOUNT_B,
      options.invalidCurrency ? "USD" : "EUR",
    ],
  );
  if (options.subCentFee) {
    await db.query(
      `update public.commissions
       set gross_amount = 0.01, amount = 0.001
       where id = any($1::uuid[])`,
      [[ENTRY_DAY, SUNDAY_A, SUNDAY_B]],
    );
  }
  if (options.perAccountRounding) {
    await db.query(
      `update public.commissions
       set gross_amount = case
             when id = $1 then 0.05
             when id = $2 then 0
             when id = $3 then 0.05
           end,
           amount = case
             when id in ($1, $3) then 0.005
             else 0
           end
       where id in ($1, $2, $3)`,
      [ENTRY_DAY, SUNDAY_A, SUNDAY_B],
    );
  }
  await db.query(
    `insert into public.google_ledger_sync_windows (
       ad_account_id, billing_start_id, billing_end_id, period_start,
       period_end, run_id, status, started_at, synced_at, ledger_snapshot
     )
     select
       account.id,
       billing_start.id,
       null,
       '2026-07-27',
       '2026-08-02',
       case when account.id = $1 then $2::uuid else $3::uuid end,
       'complete',
       '2026-08-03T09:10:00Z',
       '2026-08-03T09:10:01Z',
       (
         select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', commission.id::text,
               'occurred_on', commission.occurred_on::text,
               'gross_amount', to_char(
                 commission.gross_amount,
                 'FM999999999999999990.000000'
               ),
               'currency', upper(commission.currency),
               'status', commission.status
             ) order by commission.id
           ),
           '[]'::jsonb
         )
         from public.commissions commission
         where commission.ad_account_id = account.id
           and commission.status = 'confirmed'
           and commission.occurred_on between
             greatest('2026-07-27'::date, billing_start.google_local_date)
             and '2026-08-02'::date
       )
     from public.ad_accounts account
     join public.ad_account_billing_starts billing_start
       on billing_start.ad_account_id = account.id
     where account.id in ($1, $4)`,
    [ACCOUNT_A, SYNC_A, SYNC_B, ACCOUNT_B],
  );
  if (!options.noLegacy) {
    await db.query(
      `insert into public.invoices (
         id, client_id, period_start, period_end, amount, currency, status,
         line_items, calculation_version
       ) values (
         $1, $2, '2026-07-27', '2026-08-02', 385.14, 'EUR', 'draft',
         '[{"kind":"spend","amount":350.12},{"kind":"fee","amount":35.02}]',
         'legacy'
       )`,
      [LEGACY_INVOICE, CLIENT],
    );
    await db.query(
      `insert into public.manual_billing_cutover_invoice_snapshots (
         invoice_id, snapshot
       ) select id, to_jsonb(invoice)
         from public.invoices invoice where id = $1`,
      [LEGACY_INVOICE],
    );
    await db.query(
      `update public.invoices
       set status = $2,
           stripe_invoice_id = $3,
           issued_at = $4::timestamptz,
           updated_at = now()
       where id = $1`,
      [
        LEGACY_INVOICE,
        options.unsafeLegacy ? "open" : "void",
        options.unsafeLegacy ? "in_unsafe" : null,
        options.unsafeLegacy ? "2026-08-03T10:00:00Z" : null,
      ],
    );
  }
  await db.query(
    `insert into public.billing_issue_leases (
       lease_token, client_id, fencing_token, period_start, issued_by,
       acquired_at, renewed_at, lease_expires_at, released_at
     ) values (
       $1, $2, 1, '2026-07-20', $3,
       '2026-07-21T10:00:00Z', '2026-07-21T10:00:00Z',
       '2026-07-21T10:05:00Z', '2026-07-21T10:01:00Z'
     )`,
    [OLD_LEASE, OTHER_CLIENT, ADMIN],
  );
  return db;
}

async function migratedDatabase() {
  const db = await seedDatabase();
  await db.exec(MIGRATION);
  return db;
}

async function addDisconnectedSibling(
  db: PGlite,
  grossAmount = 0,
  clientId = CLIENT,
) {
  const accountId = "34000000-0000-4000-8000-000000000030";
  const commissionId = "34000000-0000-4000-8000-000000000031";
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, google_ads_customer_id,
       google_ads_connected, currency, commission_rate,
       list_commission_rate, revenue_share_enabled, created_at
     ) values (
       $1, $2, 'Disconnected Sibling', '3333333333', false, 'EUR',
       10, 10, false, '2026-07-31T12:00:00Z'
     )`,
    [accountId, clientId],
  );
  if (grossAmount > 0) {
    await db.query(
      `insert into public.commissions (
         id, source_id, ad_account_id, occurred_on, gross_amount, rate,
         amount, currency, status
       ) values ($1, $2, $3, '2026-07-31', $4, 10, $4 * 0.10,
                 'EUR', 'confirmed')`,
      [commissionId, SOURCE, accountId, grossAmount],
    );
  }
  return { accountId, commissionId };
}

async function replaceAccountAWithNewYorkReviewedStart(db: PGlite) {
  await db.query(
    `delete from public.google_ledger_sync_windows where ad_account_id = $1`,
    [ACCOUNT_A],
  );
  await db.query(
    `delete from public.ad_account_billing_starts where ad_account_id = $1`,
    [ACCOUNT_A],
  );
  await db.query(
    `delete from public.reviewed_full_day_billing_boundaries
     where ad_account_id = $1`,
    [ACCOUNT_A],
  );
  await db.query(
    `with snapshot as (
       select jsonb_build_object(
         'accountId', $1::uuid::text,
         'clientId', $2::uuid::text,
         'googleAdsCustomerId', '1111111111',
         'googleAdsConnected', true,
         'entryDay', '2026-07-30',
         'entryTimeZone', 'Europe/Lisbon',
         'googleLocalDate', '2026-07-29',
         'googleTimeZone', 'America/New_York',
         'metadataCaptureId', $3::uuid::text
       ) as source_snapshot
     )
     insert into public.reviewed_full_day_billing_boundaries (
       id, ad_account_id, client_id, google_ads_customer_id,
       account_created_at, entry_day, entry_time_zone, google_local_date,
       google_time_zone, entry_day_treatment, currency, cutover_monday,
       policy_version, metadata_capture_id, metadata_capture_started_at,
       metadata_captured_at, metadata_authority, metadata_contract,
       source_snapshot, source_fingerprint, sealed_at
     )
     select
       $4::uuid, $1::uuid, $2::uuid, '1111111111',
       '2026-07-29T23:30:00Z',
       '2026-07-30', 'Europe/Lisbon', '2026-07-29', 'America/New_York',
       'full-day-inclusive', 'EUR', '2026-08-03',
       'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2',
       $3::uuid, '2026-08-03T09:00:00Z', '2026-08-03T09:00:01Z',
       'client_oauth', 'google-customer-metadata-v1', source_snapshot,
       md5(jsonb_build_object(
         'policyVersion',
           'agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2',
         'cutoverMonday', '2026-08-03',
         'entryDayTreatment', 'full-day-inclusive',
         'sourceSnapshot', source_snapshot
       )::text),
       '2026-08-03T09:00:02Z'
     from snapshot`,
    [ACCOUNT_A, CLIENT, METADATA_A, BOUNDARY_A],
  );
  await db.query(
    `insert into public.ad_account_billing_starts (
       id, ad_account_id, google_ads_customer_id, google_local_date,
       google_time_zone, currency, start_basis,
       reviewed_full_day_boundary_id
     ) values (
       $1, $2, '1111111111', '2026-07-29', 'America/New_York', 'EUR',
       'reviewed_full_day', $3
     )`,
    [START_A, ACCOUNT_A, BOUNDARY_A],
  );
  await db.query(
    `insert into public.google_ledger_sync_windows (
       ad_account_id, billing_start_id, billing_end_id, period_start,
       period_end, run_id, status, started_at, synced_at, ledger_snapshot
     )
     select
       $1, $2, null, '2026-07-27', '2026-08-02', $3, 'complete',
       '2026-08-03T09:10:00Z', '2026-08-03T09:10:01Z',
       coalesce(
         jsonb_agg(
           jsonb_build_object(
             'id', commission.id::text,
             'occurred_on', commission.occurred_on::text,
             'gross_amount', to_char(
               commission.gross_amount,
               'FM999999999999999990.000000'
             ),
             'currency', upper(commission.currency),
             'status', commission.status
           ) order by commission.id
         ),
         '[]'::jsonb
       )
     from public.commissions commission
     where commission.ad_account_id = $1
       and commission.status = 'confirmed'
       and commission.occurred_on between '2026-07-29' and '2026-08-02'`,
    [ACCOUNT_A, START_A, SYNC_A],
  );
}

const recipient = {
  email: "other@example.com",
  fallbackName: "Other Client",
  billingName: "Other Company",
  taxId: null,
  addressLine1: "Rua Dois",
  addressLine2: null,
  addressCity: "Porto",
  addressPostalCode: "4000-001",
  addressState: null,
  addressCountry: "PT",
};

describe("automatic historical full-entry-day rollover", () => {
  it("seals the policy without issuing, then creates exactly one fee-only automation draft", async () => {
    const db = await migratedDatabase();
    try {
      const header = await db.query<{
        id: string;
        period_start: string;
        period_end: string;
        calculation_version: string;
        source_gross_amount: string;
        amount: string;
        source_row_count: number;
        account_count: number;
        legacy_invoice_ids: string[];
        line_items: Record<string, unknown>[];
      }>(
        `select id, period_start::text, period_end::text, calculation_version,
                source_gross_amount, amount, source_row_count, account_count,
                legacy_invoice_ids, line_items
         from public.historical_billing_rollovers`,
      );
      expect(header.rows).toHaveLength(1);
      expect(header.rows[0]).toMatchObject({
        period_start: "2026-07-27",
        period_end: "2026-08-02",
        calculation_version: VERSION,
        source_gross_amount: "350.123456",
        amount: "35.01",
        source_row_count: 3,
        account_count: 2,
        legacy_invoice_ids: [LEGACY_INVOICE],
      });
      expect(header.rows[0].line_items).toHaveLength(2);
      expect(header.rows[0].line_items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "fee",
            accountId: ACCOUNT_A,
            store: "Late Store",
            rate: 10,
            sourceGrossAmount: 300.123456,
            baseAmount: 300.12,
            amount: 30.01,
            entryDate: "2026-07-30",
            entryTimeZone: "Europe/Lisbon",
            entryDayTreatment: "full-day-inclusive",
            adSpendPassThroughAmount: 0,
            revenueShareAmount: 0,
            referralDiscountAmount: 0,
          }),
          expect.objectContaining({
            kind: "fee",
            accountId: ACCOUNT_B,
            store: "Sunday Store",
            amount: 5,
            entryDate: "2026-08-02",
          }),
        ]),
      );
      expect(
        header.rows[0].line_items.every((line) => line.kind === "fee"),
      ).toBe(true);

      const evidence = await db.query<{
        commission_id: string;
        ad_account_id: string;
        entry_day: string;
        occurred_on: string;
        source_gross_amount: string;
        billable_gross_amount: string;
        legacy_rate: string;
        legacy_revenue_share: string;
      }>(
        `select row.commission_id, row.ad_account_id, row.entry_day::text,
                row.occurred_on::text, row.source_gross_amount,
                row.billable_gross_amount,
                row.source_snapshot->>'rate' as legacy_rate,
                row.source_snapshot->>'revenue_share_amount' as legacy_revenue_share
         from public.historical_billing_rollover_rows row
         order by row.occurred_on, row.commission_id`,
      );
      expect(evidence.rows.map((row) => row.commission_id)).toEqual([
        ENTRY_DAY,
        SUNDAY_A,
        SUNDAY_B,
      ]);
      expect(evidence.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ad_account_id: ACCOUNT_A,
            entry_day: "2026-07-30",
            occurred_on: "2026-07-30",
            source_gross_amount: "100.123456",
            billable_gross_amount: "100.123456",
            legacy_rate: "9.5",
            legacy_revenue_share: "25",
          }),
          expect.objectContaining({
            ad_account_id: ACCOUNT_B,
            entry_day: "2026-08-02",
            occurred_on: "2026-08-02",
          }),
        ]),
      );

      const accountProofs = await db.query<{
        ad_account_id: string;
        billing_start_id: string;
        reviewed_full_day_boundary_id: string;
        google_local_date: string;
        google_time_zone: string;
        metadata_capture_id: string;
        sync_run_id: string;
        source_row_count: number;
        source_gross_amount: string;
        fee_amount: string;
        snapshot_row_count: number;
      }>(
        `select
           ad_account_id,
           billing_start_id,
           reviewed_full_day_boundary_id,
           google_local_date::text,
           google_time_zone,
           metadata_capture_id,
           sync_run_id,
           source_row_count,
           source_gross_amount,
           fee_amount,
           jsonb_array_length(sync_ledger_snapshot) as snapshot_row_count
         from public.historical_billing_rollover_account_proofs
         order by ad_account_id`,
      );
      expect(accountProofs.rows).toEqual([
        {
          ad_account_id: ACCOUNT_A,
          billing_start_id: START_A,
          reviewed_full_day_boundary_id: BOUNDARY_A,
          google_local_date: "2026-07-30",
          google_time_zone: "Europe/Lisbon",
          metadata_capture_id: METADATA_A,
          sync_run_id: SYNC_A,
          source_row_count: 2,
          source_gross_amount: "300.123456",
          fee_amount: "30.01",
          snapshot_row_count: 2,
        },
        {
          ad_account_id: ACCOUNT_B,
          billing_start_id: START_B,
          reviewed_full_day_boundary_id: BOUNDARY_B,
          google_local_date: "2026-08-02",
          google_time_zone: "Europe/Lisbon",
          metadata_capture_id: METADATA_B,
          sync_run_id: SYNC_B,
          source_row_count: 1,
          source_gross_amount: "50.000000",
          fee_amount: "5.00",
          snapshot_row_count: 1,
        },
      ]);

      await expect(
        db.query(
          `update public.historical_billing_rollover_account_proofs
           set fee_amount = fee_amount`,
        ),
      ).rejects.toThrow(/immutable/i);

      const beforeIssue = await db.query<{
        invoice_count: number;
        legacy_status: string;
        receipt_count: number;
      }>(
        `select
           (select count(*)::int from public.invoices) as invoice_count,
           (select status from public.invoices where id = $1) as legacy_status,
           (select count(*)::int from public.historical_billing_rollover_issuances)
             as receipt_count`,
        [LEGACY_INVOICE],
      );
      expect(beforeIssue.rows[0]).toEqual({
        invoice_count: 1,
        legacy_status: "void",
        receipt_count: 0,
      });

      await expect(
        db.query("update public.historical_billing_rollovers set amount = 1"),
      ).rejects.toThrow(/immutable/i);

      const privileges = await db.query<{
        authenticated_execute: boolean;
        service_execute: boolean;
        service_select_rows: boolean;
        service_insert_rows: boolean;
        service_select_account_proofs: boolean;
        service_insert_account_proofs: boolean;
        service_select_blockers: boolean;
        service_insert_blockers: boolean;
      }>(`
        select
          has_function_privilege(
            'authenticated',
            'public.create_historical_rollover_invoice(uuid)',
            'EXECUTE'
          ) as authenticated_execute,
          has_function_privilege(
            'service_role',
            'public.create_historical_rollover_invoice(uuid)',
            'EXECUTE'
          ) as service_execute,
          has_table_privilege(
            'service_role', 'public.historical_billing_rollover_rows', 'SELECT'
          ) as service_select_rows,
          has_table_privilege(
            'service_role', 'public.historical_billing_rollover_rows', 'INSERT'
          ) as service_insert_rows,
          has_table_privilege(
            'service_role',
            'public.historical_billing_rollover_account_proofs',
            'SELECT'
          ) as service_select_account_proofs,
          has_table_privilege(
            'service_role',
            'public.historical_billing_rollover_account_proofs',
            'INSERT'
          ) as service_insert_account_proofs,
          has_table_privilege(
            'service_role',
            'public.historical_billing_rollover_blockers',
            'SELECT'
          ) as service_select_blockers,
          has_table_privilege(
            'service_role',
            'public.historical_billing_rollover_blockers',
            'INSERT'
          ) as service_insert_blockers
      `);
      expect(privileges.rows[0]).toEqual({
        authenticated_execute: false,
        service_execute: true,
        service_select_rows: true,
        service_insert_rows: false,
        service_select_account_proofs: true,
        service_insert_account_proofs: false,
        service_select_blockers: true,
        service_insert_blockers: false,
      });

      await actAs(db, "authenticated", ADMIN);
      await expect(
        db.query(
          "select * from public.create_historical_rollover_invoice($1::uuid)",
          [header.rows[0].id],
        ),
      ).rejects.toThrow(/only the billing automation service/i);

      await actAs(db, "service_role");
      const created = await db.query<{
        id: string;
        status: string;
        amount: string;
        issued_by: string | null;
        issuer_kind: string;
        issue_attempted_at: Date | null;
        issued_at: Date | null;
        stripe_invoice_id: string | null;
        line_items: Record<string, unknown>[];
      }>("select * from public.create_historical_rollover_invoice($1::uuid)", [
        header.rows[0].id,
      ]);
      expect(created.rows).toHaveLength(1);
      expect(created.rows[0]).toMatchObject({
        status: "draft",
        amount: "35.01",
        issued_by: null,
        issuer_kind: "automation",
        issue_attempted_at: null,
        issued_at: null,
        stripe_invoice_id: null,
      });
      expect(
        created.rows[0].line_items.every((line) => line.kind === "fee"),
      ).toBe(true);

      const retry = await db.query<{ id: string }>(
        "select id from public.create_historical_rollover_invoice($1::uuid)",
        [header.rows[0].id],
      );
      expect(retry.rows).toEqual([{ id: created.rows[0].id }]);

      const afterIssue = await db.query<{
        invoice_count: number;
        claim_count: number;
        receipt_count: number;
        legacy_status: string;
      }>(
        `select
           (select count(*)::int from public.invoices) as invoice_count,
           (select count(*)::int from public.invoice_commission_rows
             where invoice_id = $1) as claim_count,
           (select count(*)::int from public.historical_billing_rollover_issuances)
             as receipt_count,
           (select status from public.invoices where id = $2) as legacy_status`,
        [created.rows[0].id, LEGACY_INVOICE],
      );
      expect(afterIssue.rows[0]).toEqual({
        invoice_count: 2,
        claim_count: 3,
        receipt_count: 1,
        legacy_status: "void",
      });

      const invoiceEvidence = await db.query<{
        commission_id: string;
        billing_start_id: string;
        baseline_deduction_amount: string;
        gross_amount: string;
        billable_gross_amount: string;
      }>(
        `select commission_id, billing_start_id,
                baseline_deduction_amount, gross_amount,
                billable_gross_amount
         from public.invoice_commission_rows
         where invoice_id = $1
         order by commission_id`,
        [created.rows[0].id],
      );
      expect(invoiceEvidence.rows).toEqual([
        {
          commission_id: ENTRY_DAY,
          billing_start_id: START_A,
          baseline_deduction_amount: "0.000000",
          gross_amount: "100.123456",
          billable_gross_amount: "100.123456",
        },
        {
          commission_id: SUNDAY_A,
          billing_start_id: START_A,
          baseline_deduction_amount: "0.000000",
          gross_amount: "200.000000",
          billable_gross_amount: "200.000000",
        },
        {
          commission_id: SUNDAY_B,
          billing_start_id: START_B,
          baseline_deduction_amount: "0.000000",
          gross_amount: "50.000000",
          billable_gross_amount: "50.000000",
        },
      ]);

      await expect(
        db.query(
          `insert into public.invoices (
             client_id, period_start, period_end, amount, calculation_version
           ) values ($1, '2026-07-27', '2026-08-02', 1, 'another-nonlegacy')`,
          [CLIENT],
        ),
      ).rejects.toThrow(/unique|duplicate/i);

      await expect(
        db.query(
          `insert into public.invoices (
             client_id, period_start, period_end, amount, calculation_version
           ) values ($1, '2026-07-27', '2026-08-02', 1, 'legacy')`,
          [CLIENT],
        ),
      ).rejects.toThrow(/unique|duplicate/i);

      const review = await db.query<{
        rollover_id: string;
        client_id: string;
        period_start: string;
        period_end: string;
        amount: string;
        currency: string;
        calculation_version: string;
        invoice_id: string;
        invoice_status: string;
        invoice_issued_at: Date | null;
        invoice_issue_error: string | null;
      }>(
        `select rollover_id, client_id, period_start::text, period_end::text,
                amount, currency, calculation_version, invoice_id,
                invoice_status, invoice_issued_at, invoice_issue_error
         from public.historical_billing_rollover_review`,
      );
      expect(review.rows[0]).toEqual({
        rollover_id: header.rows[0].id,
        client_id: CLIENT,
        period_start: "2026-07-27",
        period_end: "2026-08-02",
        amount: "35.01",
        currency: "EUR",
        calculation_version: VERSION,
        invoice_id: created.rows[0].id,
        invoice_status: "draft",
        invoice_issued_at: null,
        invoice_issue_error: null,
      });

      const oldLease = await db.query<{
        issued_by: string;
        issuer_kind: string;
      }>(
        `select issued_by, issuer_kind
         from public.billing_issue_leases where lease_token = $1`,
        [OLD_LEASE],
      );
      expect(oldLease.rows[0]).toEqual({
        issued_by: ADMIN,
        issuer_kind: "admin",
      });

      const automaticLease = await db.query<{
        issued_by: string | null;
        issuer_kind: string;
        fencing_token: number;
      }>(
        `select issued_by, issuer_kind, fencing_token
         from public.acquire_billing_issue_lease(
           $1::uuid, $2::uuid, '2026-08-03', null
         )`,
        [OTHER_CLIENT, AUTO_LEASE],
      );
      expect(automaticLease.rows).toEqual([
        { issued_by: null, issuer_kind: "automation", fencing_token: 2 },
      ]);
      await expect(
        db.query(
          `select * from public.acquire_billing_issue_lease(
             $1::uuid, $2::uuid, '2026-08-03', $3::uuid
           )`,
          [OTHER_CLIENT, AUTO_LEASE, ADMIN],
        ),
      ).rejects.toThrow(/different evidence/i);

      const adminLease = await db.query<{
        issued_by: string;
        issuer_kind: string;
      }>(
        `select issued_by, issuer_kind
         from public.acquire_billing_issue_lease(
           $1::uuid, $2::uuid, '2026-08-03', $3::uuid
         )`,
        [CLIENT, ADMIN_LEASE, ADMIN],
      );
      expect(adminLease.rows).toEqual([
        { issued_by: ADMIN, issuer_kind: "admin" },
      ]);

      const automaticV3 = await db.query<{
        issued_by: string | null;
        issuer_kind: string;
      }>(
        `select issued_by, issuer_kind
         from public.create_manual_referral_invoice(
           $1::uuid, '2026-08-03', '2026-08-09', 10,
           '[{"kind":"fee","amount":10}]'::jsonb,
           '[]'::jsonb, $2::jsonb, null, null, $3
         )`,
        [OTHER_CLIENT, JSON.stringify(recipient), V3_VERSION],
      );
      expect(automaticV3.rows).toEqual([
        { issued_by: null, issuer_kind: "automation" },
      ]);

      await expect(
        db.query(
          `select * from public.create_manual_referral_invoice(
             $1::uuid, '2026-08-10', '2026-08-16', 10,
             '[{"kind":"fee","amount":10}]'::jsonb,
             '[]'::jsonb, $2::jsonb, null, $3::uuid, $4
           )`,
          [OTHER_CLIENT, JSON.stringify(recipient), MEMBER, V3_VERSION],
        ),
      ).rejects.toThrow(/verified admin/i);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("omits a positive-spend client whose per-account fees all round below one cent", async () => {
    const db = await seedDatabase({ subCentFee: true });
    try {
      await db.exec(MIGRATION);
      const rows = await db.query<{ count: number }>(
        "select count(*)::int as count from public.historical_billing_rollovers",
      );
      expect(rows.rows).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it("rounds the 10% fee per account before summing the client total", async () => {
    const db = await seedDatabase({ perAccountRounding: true });
    try {
      await db.exec(MIGRATION);
      const header = await db.query<{
        source_gross_amount: string;
        amount: string;
        source_row_count: number;
        account_count: number;
      }>(
        `select source_gross_amount, amount, source_row_count, account_count
         from public.historical_billing_rollovers`,
      );
      expect(header.rows).toEqual([
        {
          source_gross_amount: "0.100000",
          amount: "0.02",
          source_row_count: 3,
          account_count: 2,
        },
      ]);

      const proofs = await db.query<{
        ad_account_id: string;
        source_gross_amount: string;
        fee_amount: string;
      }>(
        `select ad_account_id, source_gross_amount, fee_amount
         from public.historical_billing_rollover_account_proofs
         order by ad_account_id`,
      );
      expect(proofs.rows).toEqual([
        {
          ad_account_id: ACCOUNT_A,
          source_gross_amount: "0.050000",
          fee_amount: "0.01",
        },
        {
          ad_account_id: ACCOUNT_B,
          source_gross_amount: "0.050000",
          fee_amount: "0.01",
        },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("requires the completed sync snapshot to equal the canonical Google ledger rows", async () => {
    const db = await seedDatabase();
    try {
      await db.query(
        `update public.google_ledger_sync_windows
         set ledger_snapshot = '[]'::jsonb
         where ad_account_id = $1`,
        [ACCOUNT_A],
      );
      await db.exec(MIGRATION);

      const result = await db.query<{
        rollover_count: number;
        proof_count: number;
        ad_account_id: string;
        blocker_code: string;
        blocks_client_week: boolean;
      }>(
        `select
           (select count(*)::int
            from public.historical_billing_rollovers) as rollover_count,
           (select count(*)::int
            from public.historical_billing_rollover_account_proofs)
              as proof_count,
           ad_account_id,
           blocker_code,
           blocks_client_week
         from public.historical_billing_rollover_blockers
         where blocker_code = 'closed_sync_snapshot_mismatch'`,
      );
      expect(result.rows).toEqual([
        {
          rollover_count: 0,
          proof_count: 0,
          ad_account_id: ACCOUNT_A,
          blocker_code: "closed_sync_snapshot_mismatch",
          blocks_client_week: true,
        },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("journals an invalid persisted Google timezone instead of aborting other work", async () => {
    const db = await seedDatabase();
    try {
      await db.exec("set session_replication_role = replica");
      await db.query(
        `update public.reviewed_full_day_billing_boundaries
         set google_time_zone = 'Mars/Olympus'
         where ad_account_id = $1`,
        [ACCOUNT_A],
      );
      await db.query(
        `update public.ad_account_billing_starts
         set google_time_zone = 'Mars/Olympus'
         where ad_account_id = $1`,
        [ACCOUNT_A],
      );
      await db.exec("set session_replication_role = origin");

      await db.exec(MIGRATION);
      const result = await db.query<{
        rollover_count: number;
        ad_account_id: string;
        blocker_code: string;
        blocks_client_week: boolean;
      }>(
        `select
           (select count(*)::int
            from public.historical_billing_rollovers) as rollover_count,
           ad_account_id,
           blocker_code,
           blocks_client_week
         from public.historical_billing_rollover_blockers
         where ad_account_id = $1`,
        [ACCOUNT_A],
      );
      expect(result.rows).toEqual([
        {
          rollover_count: 0,
          ad_account_id: ACCOUNT_A,
          blocker_code: "reviewed_boundary_invalid",
          blocks_client_week: true,
        },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("keeps a disconnected zero-spend sibling as an informational account blocker", async () => {
    const db = await seedDatabase();
    try {
      const sibling = await addDisconnectedSibling(db);
      await db.exec(MIGRATION);

      const header = await db.query<{ amount: string }>(
        "select amount from public.historical_billing_rollovers",
      );
      expect(header.rows).toEqual([{ amount: "35.01" }]);

      const blocker = await db.query<{
        ad_account_id: string;
        blocker_code: string;
        blocks_client_week: boolean;
        confirmed_row_count: number;
        confirmed_gross_amount: string;
      }>(
        `select ad_account_id, blocker_code, blocks_client_week,
                confirmed_row_count, confirmed_gross_amount
         from public.historical_billing_rollover_blockers`,
      );
      expect(blocker.rows).toEqual([
        {
          ad_account_id: sibling.accountId,
          blocker_code: "google_disconnected",
          blocks_client_week: false,
          confirmed_row_count: 0,
          confirmed_gross_amount: "0.000000",
        },
      ]);

      await expect(
        db.query(
          `delete from public.historical_billing_rollover_blockers
           where ad_account_id = $1`,
          [sibling.accountId],
        ),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("blocks the whole client-week when an unresolved sibling has positive spend", async () => {
    const db = await seedDatabase();
    try {
      const sibling = await addDisconnectedSibling(db, 20);
      await db.exec(MIGRATION);

      const result = await db.query<{
        rollover_count: number;
        ad_account_id: string;
        blocker_code: string;
        blocks_client_week: boolean;
        confirmed_gross_amount: string;
      }>(
        `select
           (select count(*)::int
            from public.historical_billing_rollovers) as rollover_count,
           ad_account_id,
           blocker_code,
           blocks_client_week,
           confirmed_gross_amount
         from public.historical_billing_rollover_blockers
         where ad_account_id = $1`,
        [sibling.accountId],
      );
      expect(result.rows).toEqual([
        {
          rollover_count: 0,
          ad_account_id: sibling.accountId,
          blocker_code: "google_disconnected",
          blocks_client_week: true,
          confirmed_gross_amount: "20.000000",
        },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("does not let one client's positive unresolved account stop another client", async () => {
    const db = await seedDatabase();
    try {
      const blocked = await addDisconnectedSibling(db, 20, OTHER_CLIENT);
      await db.exec(MIGRATION);

      const rollovers = await db.query<{ client_id: string; amount: string }>(
        `select client_id, amount
         from public.historical_billing_rollovers
         order by client_id`,
      );
      expect(rollovers.rows).toEqual([{ client_id: CLIENT, amount: "35.01" }]);

      const blocker = await db.query<{
        client_id: string;
        ad_account_id: string;
        blocker_code: string;
        blocks_client_week: boolean;
      }>(
        `select client_id, ad_account_id, blocker_code, blocks_client_week
         from public.historical_billing_rollover_blockers
         where ad_account_id = $1`,
        [blocked.accountId],
      );
      expect(blocker.rows).toEqual([
        {
          client_id: OTHER_CLIENT,
          ad_account_id: blocked.accountId,
          blocker_code: "google_disconnected",
          blocks_client_week: true,
        },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("uses the reviewed Google-local start date while preserving Lisbon entry evidence", async () => {
    const db = await seedDatabase();
    try {
      await replaceAccountAWithNewYorkReviewedStart(db);
      await db.exec(MIGRATION);

      const header = await db.query<{
        source_gross_amount: string;
        amount: string;
        source_row_count: number;
      }>(
        `select source_gross_amount, amount, source_row_count
         from public.historical_billing_rollovers`,
      );
      expect(header.rows).toEqual([
        {
          source_gross_amount: "1349.123456",
          amount: "134.91",
          source_row_count: 4,
        },
      ]);

      const proof = await db.query<{
        entry_day: string;
        entry_time_zone: string;
        google_local_date: string;
        google_time_zone: string;
        source_gross_amount: string;
        fee_amount: string;
        included_pre_lisbon_entry: boolean;
      }>(
        `select
           proof.entry_day::text,
           proof.entry_time_zone,
           proof.google_local_date::text,
           proof.google_time_zone,
           proof.source_gross_amount,
           proof.fee_amount,
           exists (
             select 1
             from public.historical_billing_rollover_rows row
             where row.rollover_id = proof.rollover_id
               and row.commission_id = $2
               and row.occurred_on = proof.google_local_date
           ) as included_pre_lisbon_entry
         from public.historical_billing_rollover_account_proofs proof
         where proof.ad_account_id = $1`,
        [ACCOUNT_A, PRE_ENTRY],
      );
      expect(proof.rows).toEqual([
        {
          entry_day: "2026-07-30",
          entry_time_zone: "Europe/Lisbon",
          google_local_date: "2026-07-29",
          google_time_zone: "America/New_York",
          source_gross_amount: "1299.123456",
          fee_amount: "129.91",
          included_pre_lisbon_entry: true,
        },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("refuses issue if an in-week billing end appears after the rollover was sealed", async () => {
    const db = await migratedDatabase();
    const billingEnd = "34000000-0000-4000-8000-000000000032";
    const capture = "34000000-0000-4000-8000-000000000033";
    try {
      const rollover = await db.query<{ id: string }>(
        "select id from public.historical_billing_rollovers",
      );
      await db.query(
        `insert into public.ad_account_billing_ends (
           id, ad_account_id, billing_start_id, google_ads_customer_id,
           google_local_date, google_time_zone, currency, end_cost_micros,
           capture_started_at, captured_at, capture_id, source, reviewed_by
         ) values (
           $1, $2, $3, '1111111111', '2026-08-01', 'Europe/Lisbon',
           'EUR', 123000000, '2026-08-04T09:00:00Z',
           '2026-08-04T09:00:01Z', $4, 'client_oauth', $5
         )`,
        [billingEnd, ACCOUNT_A, START_A, capture, ADMIN],
      );

      await actAs(db, "service_role");
      await expect(
        db.query(
          "select * from public.create_historical_rollover_invoice($1::uuid)",
          [rollover.rows[0].id],
        ),
      ).rejects.toThrow(/exact reviewed Google proof/i);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("refuses issue if the canonical Google ledger changes after sealing", async () => {
    const db = await migratedDatabase();
    try {
      const rollover = await db.query<{ id: string }>(
        "select id from public.historical_billing_rollovers",
      );
      await db.query(
        `update public.commissions
         set gross_amount = gross_amount + 1
         where id = $1`,
        [ENTRY_DAY],
      );

      await actAs(db, "service_role");
      await expect(
        db.query(
          "select * from public.create_historical_rollover_invoice($1::uuid)",
          [rollover.rows[0].id],
        ),
      ).rejects.toThrow(/exact reviewed Google proof/i);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("excludes pending and internal clients even when they have positive Google spend", async () => {
    const db = await seedDatabase();
    const pendingClient = "34000000-0000-4000-8000-000000000020";
    const pendingAccount = "34000000-0000-4000-8000-000000000021";
    const pendingCommission = "34000000-0000-4000-8000-000000000022";
    const adminAccount = "34000000-0000-4000-8000-000000000023";
    const adminCommission = "34000000-0000-4000-8000-000000000024";
    const inactiveAccount = "34000000-0000-4000-8000-000000000025";
    const inactiveCommission = "34000000-0000-4000-8000-000000000026";
    try {
      await db.query(
        `insert into public.portal_clients (id, full_name, email, approval_status)
         values
           ($1, 'Pending Client', 'pending@example.com', 'pending'),
           ($2, 'Internal Admin', 'admin@example.com', 'approved')`,
        [pendingClient, ADMIN],
      );
      await db.query(
        `insert into public.ad_accounts (
           id, client_id, store_name, currency, status, created_at
         ) values
           ($1, $2, 'Pending Store', 'EUR', 'active', '2026-07-27T10:00:00Z'),
           ($3, $4, 'Internal Store', 'EUR', 'active', '2026-07-27T10:00:00Z'),
           ($5, $6, 'Inactive Store', 'EUR', 'pending', '2026-07-27T10:00:00Z')`,
        [
          pendingAccount,
          pendingClient,
          adminAccount,
          ADMIN,
          inactiveAccount,
          CLIENT,
        ],
      );
      await db.query(
        `insert into public.commissions (
           id, source_id, ad_account_id, occurred_on, gross_amount, rate,
           amount, currency, status
         ) values
           ($1, $2, $3, '2026-07-28', 100, 10, 10, 'EUR', 'confirmed'),
           ($4, $2, $5, '2026-07-28', 100, 10, 10, 'EUR', 'confirmed'),
           ($6, $2, $7, '2026-07-28', 100, 10, 10, 'EUR', 'confirmed')`,
        [
          pendingCommission,
          SOURCE,
          pendingAccount,
          adminCommission,
          adminAccount,
          inactiveCommission,
          inactiveAccount,
        ],
      );

      await db.exec(MIGRATION);
      const clients = await db.query<{ client_id: string }>(
        "select client_id from public.historical_billing_rollovers order by client_id",
      );
      expect(clients.rows).toEqual([{ client_id: CLIENT }]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("rechecks client eligibility before creating the historical draft", async () => {
    const db = await migratedDatabase();
    try {
      const rollover = await db.query<{ id: string }>(
        "select id from public.historical_billing_rollovers",
      );
      await actAs(db, "service_role");
      await db.query(
        "update public.portal_clients set approval_status = 'pending' where id = $1",
        [CLIENT],
      );
      await expect(
        db.query(
          "select * from public.create_historical_rollover_invoice($1::uuid)",
          [rollover.rows[0].id],
        ),
      ).rejects.toThrow(/ineligible/i);

      await db.query(
        "update public.portal_clients set approval_status = 'approved' where id = $1",
        [CLIENT],
      );
      await db.query(
        "insert into public.profiles (id, role) values ($1, 'admin')",
        [CLIENT],
      );
      await expect(
        db.query(
          "select * from public.create_historical_rollover_invoice($1::uuid)",
          [rollover.rows[0].id],
        ),
      ).rejects.toThrow(/ineligible/i);
    } finally {
      await db.close();
    }
  }, 15_000);

  it("blocks only the affected client when its preserved legacy void is missing", async () => {
    const db = await seedDatabase({ noLegacy: true });
    try {
      await db.exec(MIGRATION);
      const result = await db.query<{
        rollover_count: number;
        blocker_code: string;
        blocks_client_week: boolean;
        confirmed_row_count: number;
        confirmed_gross_amount: string;
      }>(
        `select
           (select count(*)::int
            from public.historical_billing_rollovers) as rollover_count,
           blocker_code,
           blocks_client_week,
           confirmed_row_count,
           confirmed_gross_amount
         from public.historical_billing_rollover_blockers
         where client_id = $1 and ad_account_id is null`,
        [CLIENT],
      );
      expect(result.rows).toEqual([
        {
          rollover_count: 0,
          blocker_code: "legacy_void_missing",
          blocks_client_week: true,
          confirmed_row_count: 3,
          confirmed_gross_amount: "350.123456",
        },
      ]);
    } finally {
      await db.close();
    }
  }, 15_000);

  it.each([
    {
      label: "a non-EUR confirmed source row",
      options: { invalidCurrency: true },
      blockerCode: "invalid_google_ledger_rows",
      accountId: ACCOUNT_B,
    },
    {
      label: "an already issued legacy invoice",
      options: { unsafeLegacy: true },
      blockerCode: "legacy_void_unsafe",
      accountId: null,
    },
  ])(
    "records a client-scoped blocker for $label without aborting the migration",
    async ({ options, blockerCode, accountId }) => {
      const db = await seedDatabase(options);
      try {
        await db.exec(MIGRATION);
        const rollover = await db.query<{ count: number }>(
          "select count(*)::int as count from public.historical_billing_rollovers",
        );
        expect(rollover.rows).toEqual([{ count: 0 }]);

        const blocker = await db.query<{
          ad_account_id: string | null;
          blocker_code: string;
          blocks_client_week: boolean;
        }>(
          `select ad_account_id, blocker_code, blocks_client_week
         from public.historical_billing_rollover_blockers
         where client_id = $1 and blocker_code = $2`,
          [CLIENT, blockerCode],
        );
        expect(blocker.rows).toEqual([
          {
            ad_account_id: accountId,
            blocker_code: blockerCode,
            blocks_client_week: true,
          },
        ]);
      } finally {
        await db.close();
      }
    },
  );
});
