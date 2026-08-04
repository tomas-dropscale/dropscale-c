import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const BILLING_MIGRATION = readFileSync(
  "supabase/migrations/0028_manual_agency_billing.sql",
  "utf8",
);
const CUTOVER_MIGRATION = readFileSync(
  "supabase/migrations/0029_legacy_billing_cutover.sql",
  "utf8",
);

const ADMIN = "30000000-0000-4000-8000-000000000001";
const CLIENT = "30000000-0000-4000-8000-000000000002";
const REFERRER = "30000000-0000-4000-8000-000000000003";
const ACCOUNT = "30000000-0000-4000-8000-000000000004";
const SOURCE = "30000000-0000-4000-8000-000000000005";
const COMMISSION = "30000000-0000-4000-8000-000000000006";
const INVOICE = "30000000-0000-4000-8000-000000000007";

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
    select 1 from public.profiles profile
    where profile.id = auth.uid() and profile.role = 'admin'
  )
$$;

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null,
  approval_status text not null,
  stripe_customer_id text,
  referral_code text unique,
  referred_by uuid references public.portal_clients(id),
  created_at timestamptz not null default now()
);

alter table public.portal_clients enable row level security;
create policy portal_clients_update_self on public.portal_clients
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

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
  p_client_id uuid,
  p_list numeric
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

grant usage on schema public to authenticated, anon, service_role;
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;
`;

async function legacyDatabase(options?: {
  referred?: boolean;
  googleCustomerId?: string | null;
  currency?: string;
  draftStripeId?: string | null;
  invoiceStatus?: string;
  invoiceIssuedAt?: string | null;
}) {
  const db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.query(
    `insert into public.profiles (id, role) values ($1, 'admin')`,
    [ADMIN],
  );
  await db.query(
    `insert into public.portal_clients (
       id, full_name, email, approval_status, referral_code, referred_by
     ) values
       ($1, 'Referrer', 'referrer@example.com', 'approved', 'REFERRER', null),
       ($2, 'Client', 'client@example.com', 'approved', 'CLIENT', $3::uuid)`,
    [REFERRER, CLIENT, options?.referred ? REFERRER : null],
  );
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, currency, google_ads_customer_id, status,
       commission_rate, list_commission_rate, revenue_share_enabled
     ) values ($1, $2, 'Client store', $3, $4, 'active', 0, 0, true)`,
    [
      ACCOUNT,
      CLIENT,
      options?.currency ?? "EUR",
      options?.googleCustomerId === undefined
        ? "1234567890"
        : options.googleCustomerId,
    ],
  );
  await db.query(
    `insert into public.revenue_sources (id, name)
     values ($1, 'Google Ads Management')`,
    [SOURCE],
  );
  await db.query(
    `insert into public.commissions (
       id, source_id, ad_account_id, occurred_on, gross_amount,
       rate, amount, currency, status
     ) values ($1, $2, $3, '2026-07-31', 100, 9.5, 9.5, 'EUR', 'confirmed')`,
    [COMMISSION, SOURCE, ACCOUNT],
  );
  await db.query(
    `insert into public.invoices (
       id, client_id, period_start, period_end, amount, currency, status,
       line_items, stripe_invoice_id, issued_at
     ) values (
       $1, $2, '2026-07-27', '2026-08-02', 110, 'EUR', $3,
       '[{"kind":"spend","amount":100},{"kind":"fee","amount":10}]',
       $4, $5::timestamptz
     )`,
    [
      INVOICE,
      CLIENT,
      options?.invoiceStatus ?? "draft",
      options?.draftStripeId ?? null,
      options?.invoiceIssuedAt ?? null,
    ],
  );
  await db.exec(BILLING_MIGRATION);
  return db;
}

describe("explicit legacy billing cutover", () => {
  it("preserves evidence, cancels unissued drafts and resets only live account terms", async () => {
    const db = await legacyDatabase();
    try {
      await db.exec(CUTOVER_MIGRATION);

      const invoice = await db.query<{
        status: string;
        calculation_version: string;
        issue_error: string | null;
        stripe_invoice_id: string | null;
      }>(
        `select status, calculation_version, issue_error, stripe_invoice_id
         from public.invoices where id = $1`,
        [INVOICE],
      );
      expect(invoice.rows[0]).toMatchObject({
        status: "void",
        calculation_version: "legacy",
        stripe_invoice_id: null,
      });
      expect(invoice.rows[0].issue_error).toMatch(/never issued to Stripe/i);

      const account = await db.query<{
        commission_rate: string;
        list_commission_rate: string;
        revenue_share_enabled: boolean;
      }>(
        `select commission_rate, list_commission_rate, revenue_share_enabled
         from public.ad_accounts where id = $1`,
        [ACCOUNT],
      );
      expect(account.rows[0]).toMatchObject({
        commission_rate: "10",
        list_commission_rate: "10",
        revenue_share_enabled: false,
      });

      const commission = await db.query<{ rate: string; amount: string }>(
        `select rate, amount from public.commissions where id = $1`,
        [COMMISSION],
      );
      expect(commission.rows[0]).toMatchObject({
        rate: "9.5",
        amount: "9.500000",
      });

      const audit = await db.query<{
        archived_draft_count: number;
        reset_account_count: number;
        acknowledged_legacy_google_row_count: number;
      }>(
        `select archived_draft_count, reset_account_count,
                acknowledged_legacy_google_row_count
         from public.manual_billing_cutovers`,
      );
      expect(audit.rows[0]).toMatchObject({
        archived_draft_count: 1,
        reset_account_count: 1,
        acknowledged_legacy_google_row_count: 1,
      });

      for (const table of [
        "manual_billing_cutover_invoice_snapshots",
        "manual_billing_cutover_account_snapshots",
        "manual_billing_cutover_commission_snapshots",
      ]) {
        const count = await db.query<{ count: number }>(
          `select count(*)::int as count from public.${table}`,
        );
        expect(count.rows[0].count).toBe(1);
      }

      await expect(
        db.query(
          `update public.manual_billing_cutovers
           set archived_draft_count = archived_draft_count + 1`,
        ),
      ).rejects.toThrow(/audit is immutable/i);
    } finally {
      await db.close();
    }
  });

  it("refuses to guess an existing referral relationship", async () => {
    const db = await legacyDatabase({ referred: true });
    try {
      await expect(db.exec(CUTOVER_MIGRATION)).rejects.toThrow(
        /existing referral attribution/i,
      );
    } finally {
      await db.close();
    }
  });

  it("refuses a draft carrying any Stripe or issue evidence", async () => {
    const db = await legacyDatabase({ draftStripeId: "in_ambiguous" });
    try {
      await expect(db.exec(CUTOVER_MIGRATION)).rejects.toThrow(
        /requires remote reconciliation/i,
      );
    } finally {
      await db.close();
    }
  });

  it.each([
    ["a missing customer id", { googleCustomerId: null }, /10-digit Google customer id/i],
    ["a foreign account", { currency: "USD" }, /must use EUR/i],
  ])("blocks %s before an irreversible baseline", async (_label, options, error) => {
    const db = await legacyDatabase(options);
    try {
      await expect(db.exec(CUTOVER_MIGRATION)).rejects.toThrow(error);
    } finally {
      await db.close();
    }
  });

  it("refuses a non-draft local state without Stripe issue evidence", async () => {
    const db = await legacyDatabase({ invoiceStatus: "void" });
    try {
      await expect(db.exec(CUTOVER_MIGRATION)).rejects.toThrow(
        /missing its issued or Stripe identity evidence/i,
      );
    } finally {
      await db.close();
    }
  });
});
