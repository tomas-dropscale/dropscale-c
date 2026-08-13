import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0047_legacy_shopify_disconnect.sql",
  "utf8",
);

const ADMIN = "47000000-0000-4000-8000-000000000001";
const MEMBER = "47000000-0000-4000-8000-000000000002";
const ACCOUNT = "47000000-0000-4000-8000-000000000003";
const CLIENT = "47000000-0000-4000-8000-000000000004";
const METRIC = "2026-08-12";

const PRELUDE = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role noinherit bypassrls;
  end if;
end $$;

create schema auth;
create or replace function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);

create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null,
  store_name text not null,
  google_ads_customer_id text,
  status text not null,
  currency text not null,
  breakeven_roas numeric,
  lifetime_ads_budget_usd numeric,
  shopify_url text,
  shopify_connected boolean not null,
  shopify_client_id text,
  shopify_scopes text,
  color_dot text not null,
  google_ads_refresh_token text,
  google_ads_connected_email text,
  google_ads_connected boolean not null,
  commission_rate numeric not null,
  list_commission_rate numeric not null,
  shopify_admin_token text,
  shopify_token_last4 text,
  shopify_connected_at timestamptz,
  default_product_cost_pct numeric not null,
  payment_fee_pct numeric not null,
  payment_fee_fixed numeric not null,
  shipping_cost_per_order numeric not null,
  revenue_share_enabled boolean not null,
  created_at timestamptz not null
);

create table public.daily_metrics (
  ad_account_id uuid not null references public.ad_accounts(id) on delete cascade,
  day date not null,
  revenue numeric not null,
  orders_count integer not null,
  primary key (ad_account_id, day)
);

create table public.commissions (
  id uuid primary key,
  ad_account_id uuid not null references public.ad_accounts(id) on delete cascade,
  amount numeric not null,
  status text not null
);
`;

let db: PGlite;

async function actAs(role: string) {
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function disconnect(adminId = ADMIN) {
  return db.query(
    "select public.disconnect_legacy_shopify_connection($1, $2) as id",
    [ACCOUNT, adminId],
  );
}

async function seedAccount() {
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, google_ads_customer_id, status, currency,
       breakeven_roas, lifetime_ads_budget_usd, shopify_url,
       shopify_connected, shopify_client_id, shopify_scopes, color_dot,
       google_ads_refresh_token, google_ads_connected_email,
       google_ads_connected, commission_rate, list_commission_rate,
       shopify_admin_token, shopify_token_last4, shopify_connected_at,
       default_product_cost_pct, payment_fee_pct, payment_fee_fixed,
       shipping_cost_per_order, revenue_share_enabled, created_at
     ) values (
       $1, $2, 'Northwind', '1234567890', 'active', 'EUR',
       2.4, 75000, 'northwind.myshopify.com', true,
       'legacy-client-id', 'read_orders,read_reports', '#ccaa66',
       'encrypted-google-token', 'ads@northwind.example', true,
       12.5, 15, 'encrypted-shopify-token', 'z9x8',
       '2026-08-01T10:00:00Z', 35, 2.9, 0.30, 4.5, true,
       '2026-01-01T00:00:00Z'
     )`,
    [ACCOUNT, CLIENT],
  );
  await db.query(
    `insert into public.daily_metrics (ad_account_id, day, revenue, orders_count)
     values ($1, $2, 1234.56, 27)`,
    [ACCOUNT, METRIC],
  );
  await db.query(
    `insert into public.commissions (id, ad_account_id, amount, status)
     values ('47000000-0000-4000-8000-000000000005', $1, 148.15, 'pending')`,
    [ACCOUNT],
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
  await db.query(
    "insert into public.profiles (id, role) values ($1, 'admin'), ($2, 'member')",
    [ADMIN, MEMBER],
  );
  await actAs("service_role");
  await seedAccount();
});

describe("legacy Shopify disconnect migration", () => {
  it("clears only the Shopify credential and live connection state", async () => {
    const result = await disconnect();
    expect(result.rows).toEqual([{ id: ACCOUNT }]);

    const account = await db.query<Record<string, unknown>>(
      `select id, client_id, store_name, google_ads_customer_id, status, currency,
              breakeven_roas, lifetime_ads_budget_usd, shopify_url,
              shopify_connected, shopify_client_id, shopify_scopes, color_dot,
              google_ads_refresh_token, google_ads_connected_email,
              google_ads_connected, commission_rate, list_commission_rate,
              shopify_admin_token, shopify_token_last4, shopify_connected_at,
              default_product_cost_pct, payment_fee_pct, payment_fee_fixed,
              shipping_cost_per_order, revenue_share_enabled, created_at
       from public.ad_accounts where id = $1`,
      [ACCOUNT],
    );
    expect(account.rows).toHaveLength(1);
    expect(account.rows[0]).toMatchObject({
      id: ACCOUNT,
      client_id: CLIENT,
      store_name: "Northwind",
      google_ads_customer_id: "1234567890",
      status: "active",
      currency: "EUR",
      shopify_url: "northwind.myshopify.com",
      shopify_connected: false,
      shopify_client_id: "legacy-client-id",
      shopify_scopes: "read_orders,read_reports",
      google_ads_refresh_token: "encrypted-google-token",
      google_ads_connected_email: "ads@northwind.example",
      google_ads_connected: true,
      shopify_admin_token: null,
      shopify_token_last4: null,
      shopify_connected_at: null,
      revenue_share_enabled: true,
    });
    expect(Number(account.rows[0].commission_rate)).toBe(12.5);
    expect(Number(account.rows[0].list_commission_rate)).toBe(15);
    expect(Number(account.rows[0].default_product_cost_pct)).toBe(35);
    expect(Number(account.rows[0].payment_fee_pct)).toBe(2.9);
    expect(Number(account.rows[0].payment_fee_fixed)).toBe(0.3);
    expect(Number(account.rows[0].shipping_cost_per_order)).toBe(4.5);

    const metrics = await db.query<{ revenue: string; orders_count: number }>(
      "select revenue, orders_count from public.daily_metrics where ad_account_id = $1",
      [ACCOUNT],
    );
    expect(metrics.rows).toHaveLength(1);
    expect(Number(metrics.rows[0].revenue)).toBe(1234.56);
    expect(metrics.rows[0].orders_count).toBe(27);
    const commissions = await db.query<{ amount: string; status: string }>(
      "select amount, status from public.commissions where ad_account_id = $1",
      [ACCOUNT],
    );
    expect(commissions.rows).toHaveLength(1);
    expect(Number(commissions.rows[0].amount)).toBe(148.15);
    expect(commissions.rows[0].status).toBe("pending");
  });

  it("requires both the service role and a verified admin", async () => {
    await actAs("authenticated");
    await expect(disconnect()).rejects.toThrow(/only the server/i);

    await actAs("service_role");
    await expect(disconnect(MEMBER)).rejects.toThrow(/verified admin/i);

    const row = await db.query<{
      shopify_connected: boolean;
      shopify_admin_token: string;
    }>(
      "select shopify_connected, shopify_admin_token from public.ad_accounts where id = $1",
      [ACCOUNT],
    );
    expect(row.rows).toEqual([
      {
        shopify_connected: true,
        shopify_admin_token: "encrypted-shopify-token",
      },
    ]);
  });

  it("refuses any account that is not both active and connected", async () => {
    await db.query("update public.ad_accounts set status = 'suspended' where id = $1", [
      ACCOUNT,
    ]);
    await expect(disconnect()).rejects.toThrow(/not found/i);

    await db.query(
      "update public.ad_accounts set status = 'active', shopify_connected = false where id = $1",
      [ACCOUNT],
    );
    await expect(disconnect()).rejects.toThrow(/not found/i);
    const row = await db.query<{ shopify_admin_token: string }>(
      "select shopify_admin_token from public.ad_accounts where id = $1",
      [ACCOUNT],
    );
    expect(row.rows).toEqual([{ shopify_admin_token: "encrypted-shopify-token" }]);
  });

  it("grants execution only to the service role", async () => {
    const grants = await db.query<{
      anon: boolean;
      authenticated: boolean;
      service: boolean;
    }>(`select
      has_function_privilege('anon', 'public.disconnect_legacy_shopify_connection(uuid,uuid)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.disconnect_legacy_shopify_connection(uuid,uuid)', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.disconnect_legacy_shopify_connection(uuid,uuid)', 'EXECUTE') as service`);
    expect(grants.rows).toEqual([
      { anon: false, authenticated: false, service: true },
    ]);
  });
});
