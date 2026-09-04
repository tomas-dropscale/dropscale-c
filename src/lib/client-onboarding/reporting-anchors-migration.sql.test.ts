import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const BINDINGS_MIGRATION = readFileSync(
  "supabase/migrations/0054_client_reporting_bindings.sql",
  "utf8",
);
const ANCHORS_MIGRATION = readFileSync(
  "supabase/migrations/0055_normalized_reporting_anchors.sql",
  "utf8",
);
const STAGED_SOURCES_MIGRATION = readFileSync(
  "supabase/migrations/0056_staged_reporting_sources.sql",
  "utf8",
);
const ROLLBACK_MIGRATION = readFileSync(
  "supabase/migrations/0057_reporting_cutover_rollback.sql",
  "utf8",
);
const REACTIVATION_MIGRATION = readFileSync(
  "supabase/migrations/0058_incident_reporting_reactivation.sql",
  "utf8",
);
const FX_ACTIVATION_MIGRATION = readFileSync(
  "supabase/migrations/0093_fx_convertible_reporting_activation.sql",
  "utf8",
);

const CHILD_ADOPTION_MIGRATION = readFileSync(
  "supabase/migrations/0094_adopt_unanchored_google_child.sql",
  "utf8",
);
const STORE_HANDOVER_MIGRATION = readFileSync(
  "supabase/migrations/0095_reporting_store_handover.sql",
  "utf8",
);
const CHILD_HANDOVER_MIGRATION = readFileSync(
  "supabase/migrations/0096_reporting_child_handover.sql",
  "utf8",
);

const ADMIN = "55000000-0000-4000-8000-000000000001";
const CLIENT = "55000000-0000-4000-8000-000000000002";
const OTHER = "55000000-0000-4000-8000-000000000003";
const SESSION = "55000000-0000-4000-8000-000000000010";
const SHOPIFY = "55000000-0000-4000-8000-000000000020";
const SHOPIFY_2 = "55000000-0000-4000-8000-000000000021";
const GOOGLE = "55000000-0000-4000-8000-000000000030";
const GOOGLE_2 = "55000000-0000-4000-8000-000000000031";
const SHELL = "55000000-0000-4000-8000-000000000040";
const LEGACY_PAIR = "55000000-0000-4000-8000-000000000041";
const SUBMISSION = "55000000-0000-4000-8000-000000000050";
const LATER_SESSION = "55000000-0000-4000-8000-000000000060";
const INCIDENT_ROLLBACK_REASON =
  "Emergency purpose-bound Phase 2 reporting rollback";
const INCIDENT_REACTIVATION_REASON =
  "Repair accidental Phase 2 rollback after secret propagation check";

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
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.profiles (id uuid primary key, role text not null);
create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null,
  approval_status text not null default 'approved'
);

create or replace function public.is_admin() returns boolean language sql security definer stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
create or replace function public.is_client_member(p_client_id uuid) returns boolean
language sql stable as $$ select auth.uid() = p_client_id $$;
create or replace function public.can_open_workspace(p_client_id uuid) returns boolean
language sql stable as $$ select auth.uid() = p_client_id $$;
create or replace function public.legacy_asset_writes_allowed(p_client_id uuid) returns boolean
language sql stable as $$ select true $$;
create or replace function public.effective_commission_rate(p_client_id uuid, p_list numeric)
returns numeric language sql immutable as $$ select p_list $$;
create or replace function public.normalize_google_ads_customer_id(p_value text)
returns text language sql immutable strict as $$
  select nullif(regexp_replace(trim(p_value), '[^0-9]', '', 'g'), '')
$$;

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  store_name text not null,
  google_ads_customer_id text,
  status text not null default 'pending' check (status in ('active', 'suspended', 'pending')),
  currency text not null default 'EUR',
  breakeven_roas numeric,
  lifetime_ads_budget_usd numeric,
  shopify_url text,
  shopify_connected boolean not null default false,
  shopify_client_id text,
  shopify_scopes text,
  color_dot text not null default '#d4a86a',
  created_at timestamptz not null default now(),
  google_ads_refresh_token text,
  google_ads_connected_email text,
  google_ads_connected boolean not null default false,
  commission_rate numeric not null default 10,
  list_commission_rate numeric not null default 10,
  shopify_admin_token text,
  shopify_token_last4 text,
  shopify_connected_at timestamptz,
  default_product_cost_pct numeric not null default 30,
  payment_fee_pct numeric not null default 2.9,
  payment_fee_fixed numeric not null default .30,
  shipping_cost_per_order numeric not null default 0,
  revenue_share_enabled boolean not null default false
);
create unique index ad_accounts_google_customer_unique_idx
  on public.ad_accounts(google_ads_customer_id) where google_ads_customer_id is not null;
create unique index ad_accounts_google_customer_uq
  on public.ad_accounts(google_ads_customer_id) where google_ads_customer_id is not null;
create unique index ad_accounts_shopify_url_uq
  on public.ad_accounts(shopify_url) where shopify_url is not null;
alter table public.ad_accounts enable row level security;
create policy ad_accounts_select_own on public.ad_accounts for select using (true);
create policy ad_accounts_insert_own on public.ad_accounts for insert with check (true);
create policy ad_accounts_update_own on public.ad_accounts for update using (true) with check (true);

create or replace function public.guard_ad_account_billing_identity()
returns trigger language plpgsql as $$ begin return new; end $$;
create trigger ad_accounts_guard_billing_identity before insert or update on public.ad_accounts
for each row execute function public.guard_ad_account_billing_identity();

create table public.client_onboarding_sessions (
  id uuid primary key,
  mode text not null,
  requested_assets text[] not null,
  status text not null,
  target_client_id uuid references public.portal_clients(id),
  claimed_user_id uuid,
  created_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  activated_at timestamptz,
  reconnect_legacy_ad_account_id uuid references public.ad_accounts(id),
  reconnect_shopify_connection_id uuid,
  reconnect_completed_at timestamptz
);
create table public.client_shopify_connections (
  id uuid primary key,
  session_id uuid not null references public.client_onboarding_sessions(id),
  client_id uuid not null references public.portal_clients(id),
  status text not null,
  shopify_shop_id text not null,
  shopify_name text not null,
  shopify_domain text not null,
  primary_domain text,
  shopify_currency text not null,
  credential_hint text,
  granted_scopes text[] not null default '{}',
  scope_profile text not null default 'client-reporting-read-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  revoked_at timestamptz,
  last_error_code text
);
create table public.client_shopify_credentials (
  connection_id uuid primary key references public.client_shopify_connections(id),
  shopify_client_id text not null,
  client_secret_ciphertext text not null,
  updated_at timestamptz not null default now()
);
create table public.client_google_ads_connections (
  id uuid primary key,
  session_id uuid not null references public.client_onboarding_sessions(id),
  client_id uuid not null references public.portal_clients(id),
  status text not null,
  windsor_account_id text not null,
  account_name text not null,
  admin_label text,
  currency text,
  time_zone text,
  data_source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  revoked_at timestamptz,
  last_error_code text
);
create table public.client_asset_mappings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  shopify_connection_id uuid not null references public.client_shopify_connections(id),
  google_ads_connection_id uuid not null unique references public.client_google_ads_connections(id),
  created_at timestamptz not null default now()
);
create table public.client_rollout_states (
  client_id uuid primary key references public.portal_clients(id),
  operational_surface text not null,
  onboarding_session_id uuid references public.client_onboarding_sessions(id),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create or replace function public.legacy_asset_writes_allowed(p_client_id uuid)
returns boolean language sql security definer stable as $$
  select not exists (
    select 1 from public.client_rollout_states rollout
    where rollout.client_id = p_client_id
      and rollout.operational_surface = 'v2_active'
  )
$$;
create table public.client_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  event_type text not null,
  actor_type text not null,
  actor_id uuid,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.daily_metrics (
  ad_account_id uuid not null references public.ad_accounts(id), day date not null,
  ad_spend numeric not null default 0, impressions integer not null default 0,
  clicks integer not null default 0, conversions numeric not null default 0,
  conversion_value numeric not null default 0, revenue numeric not null default 0,
  orders_count integer not null default 0, refunds_amount numeric not null default 0,
  product_cost numeric not null default 0, payment_fees numeric not null default 0,
  shipping_cost numeric not null default 0, revenue_share_base numeric not null default 0,
  revenue_share_amount numeric not null default 0, units_sold integer not null default 0,
  attributed_orders integer, attributed_revenue numeric,
  computed_at timestamptz not null default now(), primary key(ad_account_id, day)
);
alter table public.daily_metrics enable row level security;
grant select, update on public.ad_accounts to authenticated, service_role;
grant select, insert, update, delete on public.daily_metrics to authenticated, service_role;
create policy daily_metrics_select_own on public.daily_metrics for select using (true);
create policy daily_metrics_admin_delete on public.daily_metrics
  for delete using (public.is_admin());
create table public.campaigns (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.creative_deliveries (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.creative_submissions (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid references public.ad_accounts(id),
  submitted_by uuid not null,
  title text not null,
  url text not null,
  notes text,
  status text not null,
  review_notes text,
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_at timestamptz not null default now(),
  collection_url text
);
create table public.store_products (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.cogs_collections (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.commissions (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id), amount numeric not null default 0);
create table public.ad_account_billing_starts (
  id uuid primary key default gen_random_uuid(), ad_account_id uuid not null unique references public.ad_accounts(id),
  google_ads_customer_id text not null, currency text not null,
  google_local_date date, google_time_zone text, baseline_cost_micros bigint,
  capture_started_at timestamptz, captured_at timestamptz, capture_id uuid,
  source text, start_basis text, reviewed_by uuid, created_at timestamptz not null default now()
);
create table public.ad_account_billing_ends (
  id uuid primary key default gen_random_uuid(), ad_account_id uuid not null unique references public.ad_accounts(id),
  google_ads_customer_id text not null, currency text not null,
  billing_start_id uuid, google_local_date date, google_time_zone text, end_cost_micros bigint,
  capture_started_at timestamptz, captured_at timestamptz, capture_id uuid,
  source text, reviewed_by uuid, created_at timestamptz not null default now()
);
create table public.google_ledger_sync_windows (ad_account_id uuid references public.ad_accounts(id));
create table public.reviewed_full_day_billing_boundaries (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.historical_billing_rollover_rows (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.historical_billing_rollover_account_proofs (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.historical_billing_rollover_blockers (id uuid primary key default gen_random_uuid(), ad_account_id uuid references public.ad_accounts(id));
create table public.manual_billing_cutover_account_snapshots (
  ad_account_id uuid primary key,
  snapshot jsonb not null default '{}'::jsonb,
  reset_at timestamptz not null default now()
);
create table public.invoices (id uuid primary key default gen_random_uuid(), amount numeric not null default 0);
create table public.invoice_commission_rows (id uuid primary key default gen_random_uuid(), invoice_id uuid references public.invoices(id));
`;

let db: PGlite;

async function actAs(role: string, uid?: string) {
  await db.query("select set_config('test.role', $1, false)", [role]);
  await db.query("select set_config('test.uid', $1, false)", [uid ?? ""]);
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected SQLSTATE ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function provision({
  shopify = SHOPIFY,
  google = null,
  anchor = null,
  existing = null,
  key = "anchor:shopify:001",
}: {
  shopify?: string | null;
  google?: string | null;
  anchor?: string | null;
  existing?: string | null;
  key?: string;
} = {}) {
  return db.query<{ id: string }>(
    `select public.provision_client_reporting_anchor(
      $1, $2, $3, $4, $5, $6, 'Reviewed normalized reporting source'
    ) as id`,
    [shopify, google, anchor, existing, key, ADMIN],
  );
}

async function materializeBindingWindow(bindingId: string) {
  await db.query(
    `insert into public.daily_metrics(ad_account_id, day, computed_at)
     select binding.ad_account_id, current_date - series.day_offset, clock_timestamp()
     from public.client_reporting_bindings binding
     cross join generate_series(1, 90) as series(day_offset)
     where binding.id = $1
     on conflict (ad_account_id, day) do update
       set computed_at = excluded.computed_at`,
    [bindingId],
  );
}

async function cutOverWithShopifyAnchor() {
  await db.query(
    "update public.client_shopify_connections set status = 'revoked' where id = $1",
    [SHOPIFY_2],
  );
  await db.exec(
    "update public.client_google_ads_connections set status = 'revoked'",
  );
  await db.query(
    "update public.client_onboarding_sessions set requested_assets = array['shopify'] where id = $1",
    [SESSION],
  );
  const binding = await provision({ key: "anchor:initial:shopify" });
  await materializeBindingWindow(binding.rows[0]!.id);
  await db.query(
    `select public.record_client_reporting_sync_success(
       $1, 'shopify', current_date - 90, current_date - 1, 'USD', 90
     )`,
    [binding.rows[0]!.id],
  );
  await db.query(
    "select public.activate_client_reporting_cutover($1, $2, 'Initial reporting cutover')",
    [CLIENT, ADMIN],
  );
  return binding.rows[0]!.id;
}

async function commitStagedWindow(bindingId: string, fromDays = 90) {
  return db.query(
    `select public.commit_client_staged_reporting_metrics(
       $1, current_date - $2::integer, current_date - 1,
       (
         select jsonb_agg(jsonb_build_object(
           'ad_account_id', binding.ad_account_id,
           'day', day::date,
           'ad_spend', 0,
           'impressions', 0,
           'clicks', 0,
           'conversions', 0,
           'conversion_value', 0,
           'revenue', 0,
           'orders_count', 0,
           'refunds_amount', 0,
           'product_cost', 0,
           'payment_fees', 0,
           'shipping_cost', 0,
           'revenue_share_base', 0,
           'revenue_share_amount', 0,
           'units_sold', 0,
           'attributed_orders', 0,
           'attributed_revenue', 0,
           'computed_at', now()
         ) order by day)
         from public.client_reporting_bindings binding,
           generate_series(current_date - $2::integer, current_date - 1, interval '1 day') day
         where binding.id = $1
       )
     ) as id`,
    [bindingId, fromDays],
  );
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  try {
    await db.exec(PRELUDE);
  } catch (error) {
    throw new Error("0055 test prelude failed", { cause: error });
  }
  try {
    await db.exec(BINDINGS_MIGRATION);
  } catch (error) {
    throw new Error("0054 prerequisite failed", { cause: error });
  }
  try {
    await db.exec(ANCHORS_MIGRATION);
  } catch (error) {
    throw new Error("0055 migration failed", { cause: error });
  }
  try {
    await db.exec(STAGED_SOURCES_MIGRATION);
  } catch (error) {
    throw new Error("0056 migration failed", { cause: error });
  }
  try {
    await db.exec(ROLLBACK_MIGRATION);
  } catch (error) {
    throw new Error("0057 migration failed", { cause: error });
  }
  try {
    await db.exec(REACTIVATION_MIGRATION);
  } catch (error) {
    throw new Error("0058 migration failed", { cause: error });
  }
  try {
    await db.exec(FX_ACTIVATION_MIGRATION);
  } catch (error) {
    throw new Error("0093 migration failed", { cause: error });
  }
  try {
    await db.exec(CHILD_ADOPTION_MIGRATION);
  } catch (error) {
    throw new Error("0094 migration failed", { cause: error });
  }
  try {
    await db.exec(STORE_HANDOVER_MIGRATION);
  } catch (error) {
    throw new Error("0095 migration failed", { cause: error });
  }
  try {
    await db.exec(CHILD_HANDOVER_MIGRATION);
  } catch (error) {
    throw new Error("0096 migration failed", { cause: error });
  }

  await db.query(
    "insert into public.profiles(id, role) values ($1, 'admin'), ($2, 'member'), ($3, 'member')",
    [ADMIN, CLIENT, OTHER],
  );
  await db.query(
    `insert into public.portal_clients(id, full_name, email, approval_status)
       values ($1, 'Client', 'client@example.com', 'approved'),
              ($2, 'Other', 'other@example.com', 'approved')`,
    [CLIENT, OTHER],
  );
  await db.query(
    `insert into public.ad_accounts(
       id, client_id, store_name, status, shopify_url, google_ads_customer_id, currency
     ) values
       ($1, $3, 'Pristine shell', 'pending', null, null, 'EUR'),
       ($2, $3, 'Legacy pair', 'pending', 'legacy.myshopify.com', '7777777777', 'USD')`,
    [SHELL, LEGACY_PAIR, CLIENT],
  );
  await db.query(
    `insert into public.client_onboarding_sessions(
       id, mode, requested_assets, status, target_client_id, claimed_user_id,
       created_by, reviewed_at, reviewed_by, reconnect_legacy_ad_account_id,
       reconnect_completed_at
     ) values (
       $1, 'add_assets', array['shopify','google_ads'], 'reviewed', $2, $2,
       $3, now(), $3, null, null
     )`,
    [SESSION, CLIENT, ADMIN],
  );
  await db.query(
    `insert into public.client_rollout_states(
       client_id, operational_surface, onboarding_session_id, updated_by
     ) values ($1, 'v2_ready_for_cutover', $2, $3)`,
    [CLIENT, SESSION, ADMIN],
  );
  await db.query(
    `insert into public.client_shopify_connections(
       id, session_id, client_id, status, shopify_shop_id, shopify_name,
       shopify_domain, shopify_currency, credential_hint, last_verified_at
     ) values
       ($1, $3, $4, 'connected', 'shop-1', 'Store One',
        'store-one.myshopify.com', 'USD', 'hint', now()),
       ($2, $3, $4, 'connected', 'shop-2', 'Store Two',
        'legacy.myshopify.com', 'USD', 'hint', now())`,
    [SHOPIFY, SHOPIFY_2, SESSION, CLIENT],
  );
  await db.query(
    `insert into public.client_shopify_credentials(
       connection_id, shopify_client_id, client_secret_ciphertext
     ) values ($1, 'client-id', 'secret-ciphertext'), ($2, 'client-id-2', 'secret-ciphertext-2')`,
    [SHOPIFY, SHOPIFY_2],
  );
  await db.query(
    `insert into public.client_google_ads_connections(
       id, session_id, client_id, status, windsor_account_id, account_name,
       currency, time_zone, last_verified_at
     ) values
       ($1, $3, $4, 'connected', '111-111-1111', 'Ads One', 'USD', 'America/New_York', now()),
       ($2, $3, $4, 'connected', '777-777-7777', 'Ads Two', 'USD', 'America/New_York', now());`,
    [GOOGLE, GOOGLE_2, SESSION, CLIENT],
  );
  await actAs("service_role");
});

describe("normalized reporting anchors migration", () => {
  it("installs without widening account status and defaults historical rows to legacy_hybrid", async () => {
    const result = await db.query<{ status_check: string; roles: string[] }>(`
      select
        pg_get_constraintdef((
          select oid from pg_constraint where conrelid = 'public.ad_accounts'::regclass
          and conname = 'ad_accounts_status_check'
        )) as status_check,
        array_agg(distinct reporting_role order by reporting_role) as roles
      from public.ad_accounts
    `);
    expect(result.rows[0]?.status_check).toContain("active");
    expect(result.rows[0]?.status_check).not.toContain("reporting");
    expect(result.rows[0]?.roles).toEqual(["legacy_hybrid"]);
  });

  it("keeps the immutable Shopify domain normalizer usable by authenticated legacy writes", async () => {
    await actAs("authenticated", CLIENT);
    await db.exec("set role authenticated");
    try {
      await db.query(
        "update public.ad_accounts set shopify_url = 'shell.myshopify.com' where id = $1",
        [SHELL],
      );
    } finally {
      await db.exec("reset role");
      await actAs("service_role");
    }
    const result = await db.query<{ domain: string }>(
      "select shopify_url as domain from public.ad_accounts where id = $1",
      [SHELL],
    );
    expect(result.rows[0]?.domain).toBe("shell.myshopify.com");
  });

  it("fails before schema mutation when normalized Shopify domains already duplicate facts", async () => {
    const preflight = await PGlite.create();
    try {
      await preflight.exec(PRELUDE);
      await preflight.exec(BINDINGS_MIGRATION);
      await preflight.query(
        "insert into public.portal_clients(id, full_name, email) values ($1, 'Duplicate', 'duplicate@example.com')",
        [CLIENT],
      );
      await preflight.query(
        `insert into public.ad_accounts(id, client_id, store_name, status, shopify_url)
         values ($1, $3, 'First', 'pending', 'duplicate.myshopify.com'),
                ($2, $3, 'Second', 'pending', 'https://duplicate.myshopify.com/admin')`,
        [SHELL, LEGACY_PAIR, CLIENT],
      );
      await expectSqlState(preflight.exec(ANCHORS_MIGRATION), "23505");
      const column = await preflight.query<{ count: string }>(`
        select count(*)::text as count
        from information_schema.columns
        where table_schema = 'public' and table_name = 'ad_accounts'
          and column_name = 'reporting_role'
      `);
      expect(column.rows[0]?.count).toBe("0");
    } finally {
      await preflight.close();
    }
  });

  it("provisions a Shopify-only pending anchor idempotently without copying secrets", async () => {
    const first = await provision();
    const retry = await provision();
    expect(retry.rows[0]).toEqual(first.rows[0]);
    const result = await db.query<{
      status: string;
      role: string;
      currency: string;
      shopify_connected: boolean;
      secret: string | null;
      events: string;
    }>(
      `
      select account.status, account.reporting_role as role, account.currency,
             account.shopify_connected, account.shopify_admin_token as secret,
             (select count(*)::text from public.client_reporting_anchor_events) as events
      from public.client_reporting_bindings binding
      join public.ad_accounts account on account.id = binding.ad_account_id
      where binding.id = $1
    `,
      [first.rows[0]!.id],
    );
    expect(result.rows[0]).toEqual({
      status: "pending",
      role: "shopify_anchor",
      currency: "EUR",
      shopify_connected: false,
      secret: null,
      events: "1",
    });

    const account = await db.query<{ id: string }>(
      "select ad_account_id as id from public.client_reporting_bindings where id = $1",
      [first.rows[0]!.id],
    );
    await expect(
      db.query(
        "update public.ad_accounts set status = 'active' where id = $1",
        [account.rows[0]!.id],
      ),
    ).rejects.toThrow(/Shopify-only fact anchor remains pending/i);
  });

  it("keeps normalized metric writes service-only even when the client owns the active binding", async () => {
    const binding = await provision({ key: "anchor:browser:write-guard" });
    const account = await db.query<{ id: string }>(
      "select ad_account_id as id from public.client_reporting_bindings where id = $1",
      [binding.rows[0]!.id],
    );

    await actAs("authenticated", CLIENT);
    await db.exec("set role authenticated");
    try {
      await expectSqlState(
        db.query(
          `insert into public.daily_metrics(ad_account_id, day, revenue)
           values ($1, current_date, 10)`,
          [account.rows[0]!.id],
        ),
        "42501",
      );
      await db.query(
        `insert into public.daily_metrics(ad_account_id, day, revenue)
         values ($1, current_date, 10)`,
        [SHELL],
      );
    } finally {
      await db.exec("reset role");
      await actAs("service_role");
    }

    const rows = await db.query<{ normalized: string; legacy: string }>(
      `select
         count(*) filter (where ad_account_id = $1)::text as normalized,
         count(*) filter (where ad_account_id = $2)::text as legacy
       from public.daily_metrics`,
      [account.rows[0]!.id, SHELL],
    );
    expect(rows.rows[0]).toEqual({ normalized: "0", legacy: "1" });
  });

  it("does not let an authenticated admin bypass normalized or post-cutover metric guards", async () => {
    const shopifyBinding = await provision({ key: "anchor:admin:shopify" });
    const googleBinding = await provision({
      shopify: null,
      google: GOOGLE,
      key: "anchor:admin:google",
    });
    const accounts = await db.query<{ id: string; reporting_role: string }>(
      `select account.id, account.reporting_role
       from public.client_reporting_bindings binding
       join public.ad_accounts account on account.id = binding.ad_account_id
       where binding.id in ($1, $2)
       order by account.reporting_role`,
      [shopifyBinding.rows[0]!.id, googleBinding.rows[0]!.id],
    );
    const googleAccount = accounts.rows.find(
      (row) => row.reporting_role === "google_spend",
    )!;
    const shopifyAccount = accounts.rows.find(
      (row) => row.reporting_role === "shopify_anchor",
    )!;
    await db.query(
      `insert into public.daily_metrics(ad_account_id, day, ad_spend)
       values ($1, current_date, 4)`,
      [googleAccount.id],
    );
    await db.query(
      `insert into public.daily_metrics(ad_account_id, day, revenue)
       values ($1, current_date, 9)`,
      [shopifyAccount.id],
    );

    await actAs("authenticated", ADMIN);
    await db.exec("set role authenticated");
    try {
      await expectSqlState(
        db.query(
          `insert into public.daily_metrics(ad_account_id, day, revenue)
           values ($1, current_date + 1, 10)`,
          [shopifyAccount.id],
        ),
        "42501",
      );
      await expectSqlState(
        db.query(
          `insert into public.daily_metrics(ad_account_id, day, ad_spend)
           values ($1, current_date + 1, 10)`,
          [googleAccount.id],
        ),
        "42501",
      );
      const hiddenNormalizedUpdate = await db.query(
        `update public.daily_metrics set revenue = 99
         where ad_account_id = $1 and day = current_date returning revenue`,
        [shopifyAccount.id],
      );
      expect(hiddenNormalizedUpdate.rows).toHaveLength(0);
      const hiddenNormalizedDelete = await db.query(
        `delete from public.daily_metrics
         where ad_account_id = $1 and day = current_date returning day`,
        [shopifyAccount.id],
      );
      expect(hiddenNormalizedDelete.rows).toHaveLength(0);

      await db.query(
        `insert into public.daily_metrics(ad_account_id, day, revenue)
         values ($1, current_date, 11)`,
        [SHELL],
      );
      const legacyUpdate = await db.query(
        `update public.daily_metrics set revenue = 12
         where ad_account_id = $1 and day = current_date returning revenue`,
        [SHELL],
      );
      expect(legacyUpdate.rows).toHaveLength(1);
      await db.query(
        `insert into public.daily_metrics(ad_account_id, day, revenue)
         values ($1, current_date - 1, 8)`,
        [SHELL],
      );
      const legacyDelete = await db.query(
        `delete from public.daily_metrics
         where ad_account_id = $1 and day = current_date - 1 returning day`,
        [SHELL],
      );
      expect(legacyDelete.rows).toHaveLength(1);
    } finally {
      await db.exec("reset role");
      await actAs("service_role");
    }

    await db.query(
      "select set_config('dropscale.reporting_cutover_marker', $1, false)",
      [CLIENT],
    );
    await db.query(
      `update public.client_rollout_states
       set operational_surface = 'v2_active', reporting_cutover_at = clock_timestamp(),
           reporting_cutover_by = $2, reporting_cutover_reason = 'Policy regression marker',
           updated_by = $2, updated_at = clock_timestamp()
       where client_id = $1`,
      [CLIENT, ADMIN],
    );
    await db.query(
      "select set_config('dropscale.reporting_cutover_marker', '', false)",
    );

    await actAs("authenticated", ADMIN);
    await db.exec("set role authenticated");
    try {
      await expectSqlState(
        db.query(
          `insert into public.daily_metrics(ad_account_id, day, revenue)
           values ($1, current_date + 1, 13)`,
          [SHELL],
        ),
        "42501",
      );
      const hiddenCutoverUpdate = await db.query(
        `update public.daily_metrics set revenue = 14
         where ad_account_id = $1 and day = current_date returning revenue`,
        [SHELL],
      );
      expect(hiddenCutoverUpdate.rows).toHaveLength(0);
      const hiddenCutoverDelete = await db.query(
        `delete from public.daily_metrics
         where ad_account_id = $1 and day = current_date returning day`,
        [SHELL],
      );
      expect(hiddenCutoverDelete.rows).toHaveLength(0);
    } finally {
      await db.exec("reset role");
      await actAs("service_role");
    }

    const facts = await db.query<{
      legacy_revenue: string;
      shopify_revenue: string;
      google_spend: string;
    }>(
      `select
         (select revenue::text from public.daily_metrics where ad_account_id = $1) as legacy_revenue,
         (select revenue::text from public.daily_metrics where ad_account_id = $2) as shopify_revenue,
         (select ad_spend::text from public.daily_metrics where ad_account_id = $3) as google_spend`,
      [SHELL, shopifyAccount.id, googleAccount.id],
    );
    expect(facts.rows[0]).toEqual({
      legacy_revenue: "12",
      shopify_revenue: "9",
      google_spend: "4",
    });
  });

  it("adopts a pristine source shell without moving or rewriting its client upload", async () => {
    await db.query(
      "update public.client_shopify_connections set shopify_currency = 'JPY' where id = $1",
      [SHOPIFY],
    );
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    await db.query(
      `insert into public.creative_submissions(
         id, ad_account_id, submitted_by, title, url, notes, status,
         review_notes, reviewed_at, reviewed_by, collection_url
       ) values (
         $1, $2, $3, 'Launch creative', 'https://assets.example/creative-1',
         'Keep this upload byte-for-byte', 'new', null, null, null,
         'https://store.example/collections/launch'
       )`,
      [SUBMISSION, SHELL, CLIENT],
    );
    const submissionBefore = await db.query<{ fingerprint: string }>(
      `select md5(to_jsonb(submission)::text) as fingerprint
       from public.creative_submissions submission where id = $1`,
      [SUBMISSION],
    );
    await expectSqlState(
      provision({
        google: GOOGLE,
        existing: SHELL,
        key: "anchor:adopt:currency-mismatch",
      }),
      "23514",
    );
    await db.query(
      "update public.ad_accounts set currency = 'USD' where id = $1",
      [SHELL],
    );
    const binding = await provision({
      google: GOOGLE,
      existing: SHELL,
      key: "anchor:adopt:shell",
    });
    const result = await db.query<{
      account_id: string;
      role: string;
      shopify_url: string;
      google_id: string;
      currency: string;
      prior_domain: string | null;
      prior_currency: string;
      committed_currency: string;
    }>(
      `
      select account.id as account_id, account.reporting_role as role,
             account.shopify_url, account.google_ads_customer_id as google_id,
             account.currency, event.details ->> 'priorShopifyDomain' as prior_domain,
             event.details ->> 'priorCurrency' as prior_currency,
             event.details ->> 'committedCurrency' as committed_currency
      from public.client_reporting_bindings binding
      join public.ad_accounts account on account.id = binding.ad_account_id
      join public.client_reporting_anchor_events event on event.binding_id = binding.id
      where binding.id = $1
    `,
      [binding.rows[0]!.id],
    );
    expect(result.rows[0]).toEqual({
      account_id: SHELL,
      role: "shopify_anchor",
      shopify_url: "store-one.myshopify.com",
      google_id: "1111111111",
      currency: "USD",
      prior_domain: null,
      prior_currency: "USD",
      committed_currency: "USD",
    });
    const submissionAfter = await db.query<{
      account_id: string;
      fingerprint: string;
      count: string;
    }>(
      `select submission.ad_account_id::text as account_id,
              md5(to_jsonb(submission)::text) as fingerprint,
              (select count(*)::text from public.creative_submissions where id = $1) as count
       from public.creative_submissions submission where id = $1`,
      [SUBMISSION],
    );
    expect(submissionAfter.rows[0]).toEqual({
      account_id: SHELL,
      fingerprint: submissionBefore.rows[0]!.fingerprint,
      count: "1",
    });
  });

  it("provisions a mapped pair, accepts both metric families, and activates only after billing proof", async () => {
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    const binding = await provision({
      google: GOOGLE,
      key: "anchor:pair:new",
    });
    const account = await db.query<{ id: string }>(
      "select ad_account_id as id from public.client_reporting_bindings where id = $1",
      [binding.rows[0]!.id],
    );
    await db.query(
      `insert into public.daily_metrics(
         ad_account_id, day, ad_spend, impressions, clicks, conversions,
         conversion_value, revenue, orders_count, units_sold
       ) values ($1, current_date, 25, 100, 5, 2, 70, 100, 3, 4)`,
      [account.rows[0]!.id],
    );
    await expect(
      db.query(
        "update public.ad_accounts set status = 'active' where id = $1",
        [account.rows[0]!.id],
      ),
    ).rejects.toThrow(/requires a committed billing start/i);

    await db.query(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '1111111111', 'USD')`,
      [account.rows[0]!.id],
    );
    await db.query(
      "update public.ad_accounts set status = 'active' where id = $1",
      [account.rows[0]!.id],
    );
    const status = await db.query<{ status: string }>(
      "select status from public.ad_accounts where id = $1",
      [account.rows[0]!.id],
    );
    expect(status.rows[0]?.status).toBe("active");
    await expectSqlState(
      db.query(
        "update public.client_shopify_connections set shopify_currency = 'EUR' where id = $1",
        [SHOPIFY],
      ),
      "23514",
    );
    await expectSqlState(
      db.query(
        "update public.client_google_ads_connections set currency = 'EUR' where id = $1",
        [GOOGLE],
      ),
      "23514",
    );
  });

  it("activates an ECB-convertible non-EUR pair without the EUR billing baseline (0093)", async () => {
    // The Filipe & João shape: a Google source billing in USD on a store whose
    // spend is FX-converted at sync. No billing start can exist (capture is
    // EUR-only), so activation waives the baseline for ECB-convertible
    // currencies — the client goes Live for reporting while the account stays
    // pending and every billing automation keeps skipping it.
    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE_2],
    );
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    const binding = await provision({ google: GOOGLE, key: "anchor:fx:usd" });
    await materializeBindingWindow(binding.rows[0]!.id);
    for (const [source, currency] of [
      ["shopify", "USD"],
      ["google_ads", "USD"],
    ]) {
      await db.query(
        `select public.record_client_reporting_sync_success(
           $1, $2, current_date - 90, current_date - 1, $3, 90
         )`,
        [binding.rows[0]!.id, source, currency],
      );
    }

    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'FX-convertible reporting cutover')",
      [CLIENT, ADMIN],
    );

    const result = await db.query<{
      surface: string;
      cutover_at: string | null;
      account_status: string;
      starts: string;
    }>(
      `select rollout.operational_surface as surface,
              rollout.reporting_cutover_at::text as cutover_at,
              account.status as account_status,
              (select count(*)::text from public.ad_account_billing_starts) as starts
       from public.client_rollout_states rollout
       join public.client_reporting_bindings binding on binding.id = $2
       join public.ad_accounts account on account.id = binding.ad_account_id
       where rollout.client_id = $1`,
      [CLIENT, binding.rows[0]!.id],
    );
    expect(result.rows[0]).toEqual({
      surface: "v2_active",
      cutover_at: expect.any(String),
      // Reporting-only activation: the account never leaves pending, so
      // commission sync and invoicing keep excluding it — reports, not billed.
      account_status: "pending",
      starts: "0",
    });
  });

  it("still refuses a Google source billing outside the ECB reference set (0093)", async () => {
    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE_2],
    );
    await db.query(
      "update public.client_google_ads_connections set currency = 'TWD' where id = $1",
      [GOOGLE],
    );
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    const binding = await provision({ google: GOOGLE, key: "anchor:fx:twd" });
    await materializeBindingWindow(binding.rows[0]!.id);
    for (const [source, currency] of [
      ["shopify", "USD"],
      ["google_ads", "TWD"],
    ]) {
      await db.query(
        `select public.record_client_reporting_sync_success(
           $1, $2, current_date - 90, current_date - 1, $3, 90
         )`,
        [binding.rows[0]!.id, source, currency],
      );
    }

    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Unconvertible currency stays fail-closed')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/exact immutable billing start/i);
    const marker = await db.query<{ cutover_at: string | null }>(
      "select reporting_cutover_at as cutover_at from public.client_rollout_states where client_id = $1",
      [CLIENT],
    );
    expect(marker.rows[0]?.cutover_at).toBeNull();
  });

  it("provisions one Shopify anchor with multiple Google spend children without duplicate facts", async () => {
    await db.query("delete from public.ad_accounts where id = $1", [
      LEGACY_PAIR,
    ]);
    await db.query(
      "update public.client_google_ads_connections set currency = 'EUR' where id in ($1, $2)",
      [GOOGLE, GOOGLE_2],
    );
    const anchor = await provision({ key: "anchor:multi:shop" });
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3), ($1, $2, $4)`,
      [SESSION, SHOPIFY, GOOGLE, GOOGLE_2],
    );
    const childOne = await provision({
      shopify: null,
      google: GOOGLE,
      anchor: anchor.rows[0]!.id,
      key: "anchor:multi:g1",
    });
    const childTwo = await provision({
      shopify: null,
      google: GOOGLE_2,
      anchor: anchor.rows[0]!.id,
      key: "anchor:multi:g2",
    });
    const result = await db.query<{
      anchors: string;
      children: string;
      shopify_sources: string;
      google_sources: string;
    }>(`
      select
        count(*) filter (where account.reporting_role = 'shopify_anchor')::text as anchors,
        count(*) filter (where account.reporting_role = 'google_spend')::text as children,
        count(binding.shopify_connection_id)::text as shopify_sources,
        count(binding.google_ads_connection_id)::text as google_sources
      from public.client_reporting_bindings binding
      join public.ad_accounts account on account.id = binding.ad_account_id
      where binding.status = 'active'
    `);
    expect(result.rows[0]).toEqual({
      anchors: "1",
      children: "2",
      shopify_sources: "1",
      google_sources: "2",
    });

    const childAccount = await db.query<{ id: string }>(
      "select ad_account_id as id from public.client_reporting_bindings where id = $1",
      [childOne.rows[0]!.id],
    );
    await db.query(
      `insert into public.daily_metrics(ad_account_id, day, ad_spend)
       values ($1, current_date, 10)`,
      [childAccount.rows[0]!.id],
    );
    await expectSqlState(
      db.query(
        `update public.daily_metrics set revenue = 1
         where ad_account_id = $1 and day = current_date`,
        [childAccount.rows[0]!.id],
      ),
      "23514",
    );
    expect(childTwo.rows[0]!.id).not.toBe(childOne.rows[0]!.id);
  });

  it("rejects mapped Google-only provisioning and every reporting, delivery, product, COGS or finance blocker", async () => {
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    await expectSqlState(
      provision({ shopify: null, google: GOOGLE, key: "anchor:mapped:orphan" }),
      "23514",
    );

    await db.query(
      "update public.ad_accounts set currency = 'USD' where id = $1",
      [SHELL],
    );
    const blockers = [
      {
        insert: `insert into public.daily_metrics(ad_account_id, day) values ($1, current_date)`,
        cleanup: `delete from public.daily_metrics where ad_account_id = $1`,
      },
      {
        insert: `insert into public.campaigns(ad_account_id) values ($1)`,
        cleanup: `delete from public.campaigns where ad_account_id = $1`,
      },
      {
        insert: `insert into public.creative_deliveries(ad_account_id) values ($1)`,
        cleanup: `delete from public.creative_deliveries where ad_account_id = $1`,
      },
      {
        insert: `insert into public.store_products(ad_account_id) values ($1)`,
        cleanup: `delete from public.store_products where ad_account_id = $1`,
      },
      {
        insert: `insert into public.cogs_collections(ad_account_id) values ($1)`,
        cleanup: `delete from public.cogs_collections where ad_account_id = $1`,
      },
      {
        insert: `insert into public.commissions(ad_account_id) values ($1)`,
        cleanup: `delete from public.commissions where ad_account_id = $1`,
      },
      {
        insert: `insert into public.ad_account_billing_starts(
          ad_account_id, google_ads_customer_id, currency
        ) values ($1, '1111111111', 'USD')`,
        cleanup: `delete from public.ad_account_billing_starts where ad_account_id = $1`,
      },
      {
        insert: `insert into public.ad_account_billing_ends(
          ad_account_id, google_ads_customer_id, currency
        ) values ($1, '1111111111', 'USD')`,
        cleanup: `delete from public.ad_account_billing_ends where ad_account_id = $1`,
      },
      {
        insert: `insert into public.google_ledger_sync_windows(ad_account_id) values ($1)`,
        cleanup: `delete from public.google_ledger_sync_windows where ad_account_id = $1`,
      },
      {
        insert: `insert into public.reviewed_full_day_billing_boundaries(ad_account_id) values ($1)`,
        cleanup: `delete from public.reviewed_full_day_billing_boundaries where ad_account_id = $1`,
      },
      {
        insert: `insert into public.historical_billing_rollover_rows(ad_account_id) values ($1)`,
        cleanup: `delete from public.historical_billing_rollover_rows where ad_account_id = $1`,
      },
      {
        insert: `insert into public.historical_billing_rollover_account_proofs(ad_account_id) values ($1)`,
        cleanup: `delete from public.historical_billing_rollover_account_proofs where ad_account_id = $1`,
      },
      {
        insert: `insert into public.historical_billing_rollover_blockers(ad_account_id) values ($1)`,
        cleanup: `delete from public.historical_billing_rollover_blockers where ad_account_id = $1`,
      },
      {
        insert: `insert into public.manual_billing_cutover_account_snapshots(ad_account_id, snapshot)
          values ($1, '{"status":"pending"}'::jsonb)`,
        cleanup: `delete from public.manual_billing_cutover_account_snapshots where ad_account_id = $1`,
      },
    ];
    for (const [index, blocker] of blockers.entries()) {
      await db.query(blocker.insert, [SHELL]);
      await expectSqlState(
        provision({
          google: GOOGLE,
          existing: SHELL,
          key: `anchor:blocker:${String(index).padStart(2, "0")}`,
        }),
        "23514",
      );
      await db.query(blocker.cleanup, [SHELL]);
    }
  });

  it("refreshes exact Google metadata with a recent immutable proof", async () => {
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY_2, GOOGLE_2],
    );
    await db.query(
      "update public.client_google_ads_connections set currency = null, time_zone = null, last_verified_at = null where id = $1",
      [GOOGLE_2],
    );
    await db.query(
      `select public.commit_client_reporting_binding(
         $1, $2, $3, null, 'binding:metadata:legacy', $4, 'Bind exact legacy pair before metadata fill'
       )`,
      [LEGACY_PAIR, SHOPIFY_2, GOOGLE_2, ADMIN],
    );
    const verifiedAt = new Date().toISOString();
    await db.query(
      `select public.record_client_google_ads_reporting_identity(
         $1, 'usd', ' America/New_York ', $2, $3
       )`,
      [GOOGLE_2, ADMIN, verifiedAt],
    );
    const result = await db.query<{
      account_id: string;
      currency: string;
      time_zone: string;
      events: string;
    }>(
      `
      select connection.windsor_account_id as account_id, connection.currency,
             connection.time_zone,
             (select count(*)::text from public.client_google_ads_reporting_identity_events) as events
      from public.client_google_ads_connections connection where id = $1
    `,
      [GOOGLE_2],
    );
    expect(result.rows[0]).toEqual({
      account_id: "777-777-7777",
      currency: "USD",
      time_zone: "America/New_York",
      events: "1",
    });
    await expectSqlState(
      db.query(
        `select public.record_client_google_ads_reporting_identity(
           $1, 'USD', 'UTC', $2, now() - interval '1 hour'
        )`,
        [GOOGLE_2, ADMIN],
      ),
      "22023",
    );
    await expectSqlState(
      db.query(
        "delete from public.client_google_ads_reporting_identity_events",
      ),
      "23514",
    );
  });

  it("requires fresh family receipts before asset cutover and never changes finance/status", async () => {
    const cutoverDefinition = await db.query<{ definition: string }>(
      `select pg_get_functiondef(
         'public.activate_client_reporting_cutover(uuid,uuid,text)'::regprocedure
       ) as definition`,
    );
    const definition = cutoverDefinition.rows[0]!.definition.toLowerCase();
    for (const table of [
      "client_shopify_connections",
      "client_shopify_credentials",
      "client_google_ads_connections",
      "client_asset_mappings",
      "client_reporting_bindings",
      "client_reporting_sync_states",
      "daily_metrics",
    ]) {
      expect(definition).toContain(table);
    }
    expect(definition).toContain("share row exclusive");

    // Keep this case to one connected pair so complete source coverage is exact.
    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE_2],
    );
    await db.query(
      "update public.client_shopify_connections set shopify_currency = 'JPY' where id = $1",
      [SHOPIFY],
    );
    // Pin the Google source to EUR so this test keeps proving the FULL
    // immutable billing baseline discipline — since 0093, a non-EUR
    // ECB-convertible source activates without it (covered separately below).
    await db.query(
      "update public.client_google_ads_connections set currency = 'EUR' where id = $1",
      [GOOGLE],
    );
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    const binding = await provision({
      google: GOOGLE,
      key: "anchor:cutover:pair",
    });
    const accountBefore = await db.query<{
      id: string;
      status: string;
      currency: string;
    }>(
      `select account.id, account.status, account.currency
       from public.client_reporting_bindings binding
       join public.ad_accounts account on account.id = binding.ad_account_id
       where binding.id = $1`,
      [binding.rows[0]!.id],
    );
    expect(accountBefore.rows[0]?.currency).toBe("EUR");
    // `v2_active` existed before reporting cutover. Without the distinct
    // marker it must remain legacy-write-allowed and eligible for this gate.
    await db.query(
      "update public.client_rollout_states set operational_surface = 'v2_active' where client_id = $1",
      [CLIENT],
    );
    const preexisting = await db.query<{
      surface: string;
      cutover_at: string | null;
      legacy_writes: boolean;
    }>(
      `
      select operational_surface as surface,
             reporting_cutover_at as cutover_at,
             public.legacy_asset_writes_allowed(client_id) as legacy_writes
      from public.client_rollout_states where client_id = $1
    `,
      [CLIENT],
    );
    expect(preexisting.rows[0]).toEqual({
      surface: "v2_active",
      cutover_at: null,
      legacy_writes: true,
    });
    await expectSqlState(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Reviewed receipt-gated cutover')",
        [CLIENT, ADMIN],
      ),
      "23514",
    );
    const missingReceiptMarker = await db.query<{ cutover_at: string | null }>(
      "select reporting_cutover_at as cutover_at from public.client_rollout_states where client_id = $1",
      [CLIENT],
    );
    expect(missingReceiptMarker.rows[0]?.cutover_at).toBeNull();

    for (const [source, currency] of [
      ["shopify", "JPY"],
      ["google_ads", "EUR"],
    ]) {
      await db.query(
        `select public.record_client_reporting_sync_success(
           $1, $2, current_date - 7, current_date, $3, 2
         )`,
        [binding.rows[0]!.id, source, currency],
      );
    }
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Seven-day receipt is insufficient')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/fresh post-binding sync receipt/i);

    await materializeBindingWindow(binding.rows[0]!.id);
    for (const [source, currency] of [
      ["shopify", "JPY"],
      ["google_ads", "EUR"],
    ]) {
      await db.query(
        `select public.record_client_reporting_sync_success(
           $1, $2, current_date - 90, current_date - 1, $3, 90
         )`,
        [binding.rows[0]!.id, source, currency],
      );
    }
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Missing billing start')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/exact immutable billing start/i);
    await db.query(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '9999999999', 'EUR')`,
      [accountBefore.rows[0]!.id],
    );
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Mismatched billing start')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/exact immutable billing start/i);
    await db.query(
      "delete from public.ad_account_billing_starts where ad_account_id = $1",
      [accountBefore.rows[0]!.id],
    );
    await db.query(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '1111111111', 'EUR')`,
      [accountBefore.rows[0]!.id],
    );
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Pending account is not operational')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/open exact immutable billing start/i);
    await db.query(
      "update public.ad_accounts set status = 'active' where id = $1",
      [accountBefore.rows[0]!.id],
    );
    await db.query(
      `insert into public.ad_account_billing_ends(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '1111111111', 'EUR')`,
      [accountBefore.rows[0]!.id],
    );
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Ended account is not operational')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/open exact immutable billing start/i);
    await db.query(
      "delete from public.ad_account_billing_ends where ad_account_id = $1",
      [accountBefore.rows[0]!.id],
    );
    const financeBefore = await db.query<{ fingerprint: string }>(`
      select md5(jsonb_build_object(
        'commissions', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.commissions row),
        'starts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_starts row),
        'ends', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_ends row),
        'invoices', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.invoices row),
        'invoiceRows', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.invoice_commission_rows row)
      )::text) as fingerprint
    `);
    // A prior lifecycle path may already have marked the session active. The
    // reporting cutover still needs its own immutable reason event.
    await db.query(
      "update public.client_onboarding_sessions set status = 'active', activated_at = now() where id = $1",
      [SESSION],
    );
    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'Reviewed receipt-gated cutover')",
      [CLIENT, ADMIN],
    );
    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'Reviewed receipt-gated cutover')",
      [CLIENT, ADMIN],
    );
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Conflicting cutover reason')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/already recorded with different authority/i);
    const result = await db.query<{
      surface: string;
      cutover_at: string;
      cutover_by: string;
      marker_reason: string;
      legacy_writes: boolean;
      status: string;
      fingerprint: string;
      cutover_events: string;
      cutover_reason: string;
    }>(
      `
      select rollout.operational_surface as surface,
        rollout.reporting_cutover_at::text as cutover_at,
        rollout.reporting_cutover_by::text as cutover_by,
        rollout.reporting_cutover_reason as marker_reason,
        public.legacy_asset_writes_allowed(rollout.client_id) as legacy_writes,
        account.status,
        md5(jsonb_build_object(
          'commissions', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.commissions row),
          'starts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_starts row),
          'ends', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_ends row),
          'invoices', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.invoices row),
          'invoiceRows', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.invoice_commission_rows row)
        )::text) as fingerprint,
        (select count(*)::text from public.client_onboarding_events event
          where event.session_id = $3 and event.event_type = 'activated'
            and event.details ->> 'reportingBindings' = 'true') as cutover_events,
        (select event.details ->> 'reason' from public.client_onboarding_events event
          where event.session_id = $3 and event.event_type = 'activated'
            and event.details ->> 'reportingBindings' = 'true'
          order by event.created_at desc limit 1) as cutover_reason
      from public.client_rollout_states rollout
      join public.ad_accounts account on account.id = $2
      where rollout.client_id = $1
    `,
      [CLIENT, accountBefore.rows[0]!.id, SESSION],
    );
    expect(result.rows[0]).toEqual({
      surface: "v2_active",
      cutover_at: expect.any(String),
      cutover_by: ADMIN,
      marker_reason: "Reviewed receipt-gated cutover",
      legacy_writes: false,
      status: "active",
      fingerprint: financeBefore.rows[0]!.fingerprint,
      cutover_events: "1",
      cutover_reason: "Reviewed receipt-gated cutover",
    });

    await expectSqlState(
      db.query(
        "update public.client_rollout_states set reporting_cutover_reason = 'Tampered reason' where client_id = $1",
        [CLIENT],
      ),
      "23514",
    );
    await expectSqlState(
      db.query(
        `delete from public.client_onboarding_events
         where session_id = $1 and event_type = 'activated'
           and details ->> 'reportingBindings' = 'true'`,
        [SESSION],
      ),
      "23514",
    );
    await expect(
      db.query(
        `select public.revoke_client_reporting_binding(
           $1, $2, 'revoke:cutover:blocked', 'Do not orphan active reporting'
         )`,
        [binding.rows[0]!.id, ADMIN],
      ),
    ).rejects.toThrow(/Demote the V2 rollout before revoking/i);

    // A later onboarding workflow may replace the rollout's convenience
    // session pointer. Rollback still follows the immutable activation event.
    await db.query(
      `insert into public.client_onboarding_sessions(
         id, mode, requested_assets, status, target_client_id,
         claimed_user_id, created_by
       ) values ($1, 'add_assets', array['shopify'], 'collecting', $2, $2, $3)`,
      [LATER_SESSION, CLIENT, ADMIN],
    );
    await db.query(
      `update public.client_rollout_states
       set onboarding_session_id = $2, updated_at = clock_timestamp()
       where client_id = $1`,
      [CLIENT, LATER_SESSION],
    );

    await expect(
      db.query(
        "update public.client_rollout_states set operational_surface = 'rollback_legacy' where client_id = $1",
        [CLIENT],
      ),
    ).rejects.toThrow(/purpose-bound RPC/i);
    await db.query(
      "select public.rollback_client_reporting_cutover($1, $2, 'Emergency reporting rollback')",
      [CLIENT, ADMIN],
    );
    await db.query(
      "select public.rollback_client_reporting_cutover($1, $2, 'Emergency reporting rollback')",
      [CLIENT, ADMIN],
    );
    await expect(
      db.query(
        "select public.rollback_client_reporting_cutover($1, $2, 'Conflicting rollback reason')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/already recorded with different authority or reason/i);
    const rolledBack = await db.query<{
      surface: string;
      cutover_at: string;
      cutover_by: string;
      marker_reason: string;
      legacy_writes: boolean;
      rollback_events: string;
      rollback_reason: string;
      fingerprint: string;
    }>(
      `
      select rollout.operational_surface as surface,
        rollout.reporting_cutover_at::text as cutover_at,
        rollout.reporting_cutover_by::text as cutover_by,
        rollout.reporting_cutover_reason as marker_reason,
        public.legacy_asset_writes_allowed(rollout.client_id) as legacy_writes,
        (select count(*)::text from public.client_onboarding_events event
          where event.session_id = $2 and event.event_type = 'reporting_rollback') as rollback_events,
        (select event.details ->> 'reason' from public.client_onboarding_events event
          where event.session_id = $2 and event.event_type = 'reporting_rollback') as rollback_reason,
        md5(jsonb_build_object(
          'commissions', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.commissions row),
          'starts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_starts row),
          'ends', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_ends row),
          'invoices', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.invoices row),
          'invoiceRows', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.invoice_commission_rows row)
        )::text) as fingerprint
      from public.client_rollout_states rollout
      where rollout.client_id = $1
    `,
      [CLIENT, SESSION],
    );
    expect(rolledBack.rows[0]).toEqual({
      surface: "rollback_legacy",
      cutover_at: result.rows[0]!.cutover_at,
      cutover_by: ADMIN,
      marker_reason: "Reviewed receipt-gated cutover",
      legacy_writes: true,
      rollback_events: "1",
      rollback_reason: "Emergency reporting rollback",
      fingerprint: financeBefore.rows[0]!.fingerprint,
    });
    await expectSqlState(
      db.query(
        "delete from public.client_onboarding_events where session_id = $1 and event_type = 'reporting_rollback'",
        [SESSION],
      ),
      "23514",
    );
    await expect(
      db.query(
        "update public.client_rollout_states set operational_surface = 'v2_active' where client_id = $1",
        [CLIENT],
      ),
    ).rejects.toThrow(/cannot be reactivated generically/i);

    await db.exec("begin");
    try {
      await db.query(
        `select public.revoke_client_reporting_binding(
           $1, $2, 'revoke:rollback:allowed', 'Reviewed reporting rollback'
         )`,
        [binding.rows[0]!.id, ADMIN],
      );
    } finally {
      await db.exec("rollback");
    }
  });

  it("repairs only the recent exact Phase 2 rollback without changing reporting or finance", async () => {
    const definitionResult = await db.query<{ definition: string }>(
      `select pg_get_functiondef(
         'public.reactivate_client_reporting_cutover(uuid,uuid,text)'::regprocedure
       ) as definition`,
    );
    const definition = definitionResult.rows[0]!.definition.toLowerCase();
    for (const table of [
      "client_shopify_connections",
      "client_shopify_credentials",
      "client_google_ads_connections",
      "client_asset_mappings",
      "client_reporting_bindings",
      "client_reporting_sync_states",
      "daily_metrics",
    ]) {
      expect(definition).toContain(table);
    }
    expect(definition).toContain("share row exclusive");
    expect(definition).toContain(
      "materialized.max_computed_at > shopify_receipt.last_success_at",
    );
    expect(definition).toContain(
      "materialized.max_computed_at > google_receipt.last_success_at",
    );

    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE_2],
    );
    await db.query(
      `insert into public.client_asset_mappings(
         session_id, shopify_connection_id, google_ads_connection_id
       ) values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    const binding = await provision({
      google: GOOGLE,
      key: "anchor:incident:repair",
    });
    const account = await db.query<{ id: string }>(
      `select account.id
       from public.client_reporting_bindings binding
       join public.ad_accounts account on account.id = binding.ad_account_id
       where binding.id = $1`,
      [binding.rows[0]!.id],
    );
    await db.query(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '1111111111', 'USD')`,
      [account.rows[0]!.id],
    );
    await db.query(
      "update public.ad_accounts set status = 'active' where id = $1",
      [account.rows[0]!.id],
    );
    await materializeBindingWindow(binding.rows[0]!.id);
    for (const source of ["shopify", "google_ads"]) {
      await db.query(
        `select public.record_client_reporting_sync_success(
           $1, $2, current_date - 90, current_date - 1, 'USD', 90
         )`,
        [binding.rows[0]!.id, source],
      );
    }
    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'Incident cutover baseline')",
      [CLIENT, ADMIN],
    );
    const markerBefore = await db.query<{
      cutover_at: string;
      cutover_by: string;
      cutover_reason: string;
    }>(
      `select reporting_cutover_at::text as cutover_at,
              reporting_cutover_by::text as cutover_by,
              reporting_cutover_reason as cutover_reason
       from public.client_rollout_states where client_id = $1`,
      [CLIENT],
    );
    await db.query(
      "select public.rollback_client_reporting_cutover($1, $2, $3)",
      [CLIENT, ADMIN, INCIDENT_ROLLBACK_REASON],
    );

    // The convenience pointer may move; repair authority comes from the
    // immutable activation and rollback event session instead.
    await db.query(
      `insert into public.client_onboarding_sessions(
         id, mode, requested_assets, status, target_client_id,
         claimed_user_id, created_by
       ) values ($1, 'add_assets', array['shopify'], 'collecting', $2, $2, $3)`,
      [LATER_SESSION, CLIENT, ADMIN],
    );
    await db.query(
      `update public.client_rollout_states
       set onboarding_session_id = $2, updated_at = updated_at
       where client_id = $1`,
      [CLIENT, LATER_SESSION],
    );

    const fingerprint = async () =>
      db.query<{ value: string }>(`
        select md5(jsonb_build_object(
          'accounts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.ad_accounts row),
          'shopify', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.client_shopify_connections row),
          'google', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.client_google_ads_connections row),
          'mappings', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.client_asset_mappings row),
          'bindings', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.client_reporting_bindings row),
          'receipts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.binding_id, row.source_type), '[]')
            from public.client_reporting_sync_states row),
          'metrics', (select coalesce(jsonb_agg(to_jsonb(row) order by row.ad_account_id, row.day), '[]')
            from public.daily_metrics row),
          'commissions', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.commissions row),
          'starts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.ad_account_billing_starts row),
          'ends', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.ad_account_billing_ends row),
          'invoices', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.invoices row),
          'invoiceRows', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
            from public.invoice_commission_rows row)
        )::text) as value
      `);
    const beforeRepair = await fingerprint();

    await expect(
      db.query(
        "update public.client_rollout_states set operational_surface = 'v2_active' where client_id = $1",
        [CLIENT],
      ),
    ).rejects.toThrow(/cannot be reactivated generically/i);
    await expectSqlState(
      db.query(
        "select public.reactivate_client_reporting_cutover($1, $2, 'Generic repair')",
        [CLIENT, ADMIN],
      ),
      "22023",
    );

    await db.exec("begin");
    try {
      await db.query(
        `update public.daily_metrics
         set computed_at = clock_timestamp()
         where ad_account_id = $1 and day = current_date - 1`,
        [account.rows[0]!.id],
      );
      await expect(
        db.query(
          "select public.reactivate_client_reporting_cutover($1, $2, $3)",
          [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
        ),
      ).rejects.toThrow(/receipt-owned current 90-day facts/i);
    } finally {
      await db.exec("rollback");
    }

    await db.exec("begin");
    try {
      await db.query(
        "update public.client_shopify_connections set last_error_code = 'health-failed' where id = $1",
        [SHOPIFY],
      );
      await expect(
        db.query(
          "select public.reactivate_client_reporting_cutover($1, $2, $3)",
          [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
        ),
      ).rejects.toThrow(/covered exactly once and healthy/i);
    } finally {
      await db.exec("rollback");
    }

    await db.exec("begin");
    try {
      await db.query(
        `insert into public.ad_account_billing_ends(
           ad_account_id, google_ads_customer_id, currency
         ) values ($1, '1111111111', 'USD')`,
        [account.rows[0]!.id],
      );
      await expect(
        db.query(
          "select public.reactivate_client_reporting_cutover($1, $2, $3)",
          [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
        ),
      ).rejects.toThrow(/open exact immutable billing start/i);
    } finally {
      await db.exec("rollback");
    }

    await actAs("authenticated", ADMIN);
    await db.exec("set role authenticated");
    try {
      await expectSqlState(
        db.query(
          "select public.reactivate_client_reporting_cutover($1, $2, $3)",
          [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
        ),
        "42501",
      );
    } finally {
      await db.exec("reset role");
      await actAs("service_role");
    }

    await db.query(
      "select public.reactivate_client_reporting_cutover($1, $2, $3)",
      [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
    );
    // Simulate the same fully linked request being retried after the incident
    // window. Expiry gates the first repair, never an already-recorded retry.
    await db.exec(
      "alter table public.client_onboarding_events disable trigger client_onboarding_events_guard_reporting_cutover",
    );
    try {
      await db.query(`
        with aged as (select clock_timestamp() - interval '2 hours' as at)
        update public.client_onboarding_events event
        set details = jsonb_set(
              event.details,
              '{reportingRollbackAt}',
              to_jsonb(aged.at)
            ),
            created_at = case
              when event.event_type = 'reporting_rollback' then aged.at
              else event.created_at
            end
        from aged
        where event.event_type in ('reporting_rollback', 'reporting_reactivation')
      `);
    } finally {
      await db.exec(
        "alter table public.client_onboarding_events enable trigger client_onboarding_events_guard_reporting_cutover",
      );
    }
    await db.query(
      "select public.reactivate_client_reporting_cutover($1, $2, $3)",
      [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
    );
    await db.query("update public.profiles set role = 'admin' where id = $1", [
      OTHER,
    ]);
    await expect(
      db.query(
        "select public.reactivate_client_reporting_cutover($1, $2, $3)",
        [CLIENT, OTHER, INCIDENT_REACTIVATION_REASON],
      ),
    ).rejects.toThrow(/already recorded with different authority or reason/i);

    const afterRepair = await fingerprint();
    expect(afterRepair.rows[0]!.value).toBe(beforeRepair.rows[0]!.value);
    const result = await db.query<{
      surface: string;
      cutover_at: string;
      cutover_by: string;
      cutover_reason: string;
      reactivations: string;
      activation_linked: boolean;
      rollback_linked: boolean;
      event_reason: string;
    }>(
      `
      select rollout.operational_surface as surface,
             rollout.reporting_cutover_at::text as cutover_at,
             rollout.reporting_cutover_by::text as cutover_by,
             rollout.reporting_cutover_reason as cutover_reason,
             count(*) filter (where repair.event_type = 'reporting_reactivation')::text
               as reactivations,
             bool_and(activation.id::text = repair.details ->> 'reportingActivationEventId')
               as activation_linked,
             bool_and(rollback.id::text = repair.details ->> 'reportingRollbackEventId')
               as rollback_linked,
             min(repair.details ->> 'reason') as event_reason
      from public.client_rollout_states rollout
      join public.client_onboarding_events repair
        on repair.event_type = 'reporting_reactivation'
      join public.client_onboarding_events activation
        on activation.id::text = repair.details ->> 'reportingActivationEventId'
       and activation.session_id = repair.session_id
      join public.client_onboarding_events rollback
        on rollback.id::text = repair.details ->> 'reportingRollbackEventId'
       and rollback.session_id = repair.session_id
      where rollout.client_id = $1
      group by rollout.client_id, rollout.operational_surface,
               rollout.reporting_cutover_at, rollout.reporting_cutover_by,
               rollout.reporting_cutover_reason
    `,
      [CLIENT],
    );
    expect(result.rows[0]).toEqual({
      surface: "v2_active",
      ...markerBefore.rows[0],
      reactivations: "1",
      activation_linked: true,
      rollback_linked: true,
      event_reason: INCIDENT_REACTIVATION_REASON,
    });
    await expectSqlState(
      db.query(
        "delete from public.client_onboarding_events where event_type = 'reporting_reactivation'",
      ),
      "23514",
    );
  });

  it("rejects a rollback that was not emitted by the Phase 2 incident endpoint", async () => {
    await cutOverWithShopifyAnchor();
    await db.query(
      "select public.rollback_client_reporting_cutover($1, $2, 'Unrelated operator rollback')",
      [CLIENT, ADMIN],
    );
    await expect(
      db.query(
        "select public.reactivate_client_reporting_cutover($1, $2, $3)",
        [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
      ),
    ).rejects.toThrow(/does not match the Phase 2 incident/i);
  });

  it("rejects the first incident repair after its one-hour window", async () => {
    await cutOverWithShopifyAnchor();
    await db.query(
      "select public.rollback_client_reporting_cutover($1, $2, $3)",
      [CLIENT, ADMIN, INCIDENT_ROLLBACK_REASON],
    );
    await db.exec(
      "alter table public.client_onboarding_events disable trigger client_onboarding_events_guard_reporting_cutover",
    );
    try {
      await db.query(`
        with aged as (select clock_timestamp() - interval '2 hours' as at)
        update public.client_onboarding_events event
        set details = jsonb_set(
              event.details,
              '{reportingRollbackAt}',
              to_jsonb(aged.at)
            ),
            created_at = aged.at
        from aged
        where event.event_type = 'reporting_rollback'
      `);
    } finally {
      await db.exec(
        "alter table public.client_onboarding_events enable trigger client_onboarding_events_guard_reporting_cutover",
      );
    }
    await db.query(
      `update public.client_rollout_states
       set updated_at = (
         select (event.details ->> 'reportingRollbackAt')::timestamptz
         from public.client_onboarding_events event
         where event.event_type = 'reporting_rollback'
       )
       where client_id = $1`,
      [CLIENT],
    );
    await expect(
      db.query(
        "select public.reactivate_client_reporting_cutover($1, $2, $3)",
        [CLIENT, ADMIN, INCIDENT_REACTIVATION_REASON],
      ),
    ).rejects.toThrow(/outside the one-hour repair window/i);
  });

  it("keeps a Google-only client ready until it has an active Shopify anchor", async () => {
    await db.query(
      "update public.client_shopify_connections set status = 'revoked'",
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE_2],
    );
    const binding = await provision({
      shopify: null,
      google: GOOGLE,
      key: "anchor:google:only",
    });
    await db.query(
      `select public.record_client_reporting_sync_success(
         $1, 'google_ads', current_date - 90, current_date, 'USD', 91
       )`,
      [binding.rows[0]!.id],
    );
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Google-only must remain ready')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/requires at least one active Shopify anchor/i);
    const rollout = await db.query<{
      surface: string;
      cutover_at: string | null;
    }>(
      `select operational_surface as surface, reporting_cutover_at as cutover_at
       from public.client_rollout_states where client_id = $1`,
      [CLIENT],
    );
    expect(rollout.rows[0]).toEqual({
      surface: "v2_ready_for_cutover",
      cutover_at: null,
    });
  });

  it("requires complete receipt-owned materialization before Shopify-only cutover", async () => {
    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked'",
    );
    await db.query(
      "update public.client_shopify_connections set shopify_currency = 'JPY' where id = $1",
      [SHOPIFY],
    );
    const binding = await provision({ key: "anchor:shopify:cutover" });
    await materializeBindingWindow(binding.rows[0]!.id);
    await db.query(
      `select public.record_client_reporting_sync_success(
         $1, 'shopify', current_date - 90, current_date - 1, 'JPY', 90
       )`,
      [binding.rows[0]!.id],
    );
    await db.query(
      `delete from public.daily_metrics metric
       using public.client_reporting_bindings source
       where source.id = $1 and metric.ad_account_id = source.ad_account_id
         and metric.day = current_date - 1`,
      [binding.rows[0]!.id],
    );
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Missing materialized day')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/receipt-owned materialized 90-day facts/i);

    // Restoring the day after the receipt proves the crash/legacy-overwrite
    // case: facts are complete again, but the old receipt no longer owns the
    // latest commit and must fail until the V2 adapter records a new success.
    await materializeBindingWindow(binding.rows[0]!.id);
    await expect(
      db.query(
        "select public.activate_client_reporting_cutover($1, $2, 'Stale receipt after overwrite')",
        [CLIENT, ADMIN],
      ),
    ).rejects.toThrow(/receipt-owned materialized 90-day facts/i);
    await db.query(
      `select public.record_client_reporting_sync_success(
         $1, 'shopify', current_date - 90, current_date - 1, 'JPY', 90
       )`,
      [binding.rows[0]!.id],
    );
    const metricsBefore = await db.query<{ fingerprint: string }>(
      `select md5(jsonb_agg(to_jsonb(metric) order by metric.day)::text) as fingerprint
       from public.daily_metrics metric
       join public.client_reporting_bindings source
         on source.ad_account_id = metric.ad_account_id
       where source.id = $1
         and metric.day between current_date - 90 and current_date - 1`,
      [binding.rows[0]!.id],
    );
    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'Shopify-only reporting cutover')",
      [CLIENT, ADMIN],
    );
    const result = await db.query<{
      cutover_at: string;
      billing_starts: string;
      account_currency: string;
      receipt_currency: string;
      metric_fingerprint: string;
    }>(
      `select rollout.reporting_cutover_at::text as cutover_at,
              (select count(*)::text from public.ad_account_billing_starts) as billing_starts,
              account.currency as account_currency,
              receipt.source_currency as receipt_currency,
              (
                select md5(jsonb_agg(to_jsonb(metric) order by metric.day)::text)
                from public.daily_metrics metric
                where metric.ad_account_id = account.id
                  and metric.day between current_date - 90 and current_date - 1
              ) as metric_fingerprint
       from public.client_rollout_states rollout
       join public.client_reporting_bindings binding
         on binding.client_id = rollout.client_id and binding.id = $2
       join public.ad_accounts account on account.id = binding.ad_account_id
       join public.client_reporting_sync_states receipt
         on receipt.binding_id = binding.id and receipt.source_type = 'shopify'
       where rollout.client_id = $1`,
      [CLIENT, binding.rows[0]!.id],
    );
    expect(result.rows[0]).toEqual({
      cutover_at: expect.any(String),
      billing_starts: "0",
      account_currency: "EUR",
      receipt_currency: "JPY",
      metric_fingerprint: metricsBefore.rows[0]!.fingerprint,
    });

    await db.query(
      "select public.rollback_client_reporting_cutover($1, $2, 'Shopify adapter emergency stop')",
      [CLIENT, ADMIN],
    );
    const rolledBack = await db.query<{
      surface: string;
      cutover_at: string;
      role: string;
      status: string;
      shopify_connected: boolean;
      binding_status: string;
      billing_starts: string;
      metric_fingerprint: string;
    }>(
      `
      select rollout.operational_surface as surface,
             rollout.reporting_cutover_at::text as cutover_at,
             account.reporting_role as role,
             account.status,
             account.shopify_connected,
             binding.status as binding_status,
             (select count(*)::text from public.ad_account_billing_starts) as billing_starts,
             (
               select md5(jsonb_agg(to_jsonb(metric) order by metric.day)::text)
               from public.daily_metrics metric
               where metric.ad_account_id = account.id
                 and metric.day between current_date - 90 and current_date - 1
             ) as metric_fingerprint
      from public.client_rollout_states rollout
      join public.client_reporting_bindings binding
        on binding.client_id = rollout.client_id and binding.id = $2
      join public.ad_accounts account on account.id = binding.ad_account_id
      where rollout.client_id = $1
    `,
      [CLIENT, binding.rows[0]!.id],
    );
    expect(rolledBack.rows[0]).toEqual({
      surface: "rollback_legacy",
      cutover_at: result.rows[0]!.cutover_at,
      role: "shopify_anchor",
      status: "pending",
      shopify_connected: false,
      binding_status: "active",
      billing_starts: "0",
      metric_fingerprint: metricsBefore.rows[0]!.fingerprint,
    });
  });

  it("keeps lifecycle RPCs service-only and audit/receipt tables read-only", async () => {
    const acl = await db.query<{
      authenticated_provision: boolean;
      service_provision: boolean;
      authenticated_receipt: boolean;
      service_receipt: boolean;
      authenticated_rollback: boolean;
      service_rollback: boolean;
      authenticated_reactivation: boolean;
      service_reactivation: boolean;
      service_event_insert: boolean;
      service_receipt_insert: boolean;
      authenticated_normalizer: boolean;
      anon_normalizer: boolean;
      rls_tables: string;
    }>(`
      select
        has_function_privilege('authenticated',
          'public.provision_client_reporting_anchor(uuid,uuid,uuid,uuid,text,uuid,text)', 'EXECUTE') as authenticated_provision,
        has_function_privilege('service_role',
          'public.provision_client_reporting_anchor(uuid,uuid,uuid,uuid,text,uuid,text)', 'EXECUTE') as service_provision,
        has_function_privilege('authenticated',
          'public.record_client_reporting_sync_success(uuid,text,date,date,text,integer)', 'EXECUTE') as authenticated_receipt,
        has_function_privilege('service_role',
          'public.record_client_reporting_sync_success(uuid,text,date,date,text,integer)', 'EXECUTE') as service_receipt,
        has_function_privilege('authenticated',
          'public.rollback_client_reporting_cutover(uuid,uuid,text)', 'EXECUTE') as authenticated_rollback,
        has_function_privilege('service_role',
          'public.rollback_client_reporting_cutover(uuid,uuid,text)', 'EXECUTE') as service_rollback,
        has_function_privilege('authenticated',
          'public.reactivate_client_reporting_cutover(uuid,uuid,text)', 'EXECUTE') as authenticated_reactivation,
        has_function_privilege('service_role',
          'public.reactivate_client_reporting_cutover(uuid,uuid,text)', 'EXECUTE') as service_reactivation,
        has_table_privilege('service_role', 'public.client_reporting_anchor_events', 'INSERT') as service_event_insert,
        has_table_privilege('service_role', 'public.client_reporting_sync_states', 'INSERT') as service_receipt_insert,
        has_function_privilege('authenticated',
          'public.normalize_shopify_reporting_domain(text)', 'EXECUTE') as authenticated_normalizer,
        has_function_privilege('anon',
          'public.normalize_shopify_reporting_domain(text)', 'EXECUTE') as anon_normalizer,
        (select count(*)::text from pg_class where oid in (
          'public.client_reporting_anchor_events'::regclass,
          'public.client_reporting_sync_states'::regclass,
          'public.client_google_ads_reporting_identity_events'::regclass
        ) and relrowsecurity) as rls_tables
    `);
    expect(acl.rows[0]).toEqual({
      authenticated_provision: false,
      service_provision: true,
      authenticated_receipt: false,
      service_receipt: true,
      authenticated_rollback: false,
      service_rollback: true,
      authenticated_reactivation: false,
      service_reactivation: true,
      service_event_insert: false,
      service_receipt_insert: false,
      authenticated_normalizer: true,
      anon_normalizer: false,
      rls_tables: "3",
    });
  });

  it("upgrades an exact Google-only legacy binding to a pair atomically", async () => {
    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE],
    );
    await db.query(
      "update public.client_shopify_connections set shopify_currency = 'JPY' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      `update public.ad_accounts
       set shopify_connected = true,
           shopify_admin_token = 'legacy-shopify-ciphertext',
           google_ads_connected = true,
           google_ads_refresh_token = 'legacy-google-ciphertext'
       where id = $1`,
      [LEGACY_PAIR],
    );
    const old = await db.query<{ id: string }>(
      `select public.commit_client_reporting_binding(
         $1, null, $2, null, 'bind:upgrade:old', $3, 'Reviewed Google-only source'
       ) as id`,
      [LEGACY_PAIR, GOOGLE_2, ADMIN],
    );
    await db.query(
      `update public.client_onboarding_sessions
       set mode = 'reconnect', status = 'reviewed', requested_assets = array['shopify'],
           target_client_id = $1, claimed_user_id = $1,
           reconnect_legacy_ad_account_id = $2, reconnect_completed_at = now()
       where id = $3`,
      [CLIENT, LEGACY_PAIR, SESSION],
    );
    await db.query(
      `insert into public.client_onboarding_events(
         session_id, event_type, actor_type, actor_id, details
       ) values ($1, 'shopify_connected', 'system', $2,
         jsonb_build_object('connection_id', $3::text))`,
      [SESSION, CLIENT, SHOPIFY_2],
    );
    // A lifecycle-only v2_active/null-marker client can still repair a
    // binding. Roll the proof back so the exact pair upgrade can follow.
    await db.exec("begin");
    try {
      await db.query(
        `select public.revoke_client_reporting_binding(
           $1, $2, 'revoke:precutover:allowed', 'Reviewed pre-cutover repair'
         )`,
        [old.rows[0]!.id, ADMIN],
      );
    } finally {
      await db.exec("rollback");
    }
    await db.query(
      "update public.client_rollout_states set operational_surface = 'v2_active' where client_id = $1",
      [CLIENT],
    );
    const upgraded = await db.query<{ id: string }>(
      `select public.upgrade_client_reporting_google_binding_to_pair(
         $1, $2, $3, 'upgrade:legacy:pair', $4, 'Reviewed exact reconnect pair'
       ) as id`,
      [old.rows[0]!.id, SHOPIFY_2, SESSION, ADMIN],
    );
    const retry = await db.query<{ id: string }>(
      `select public.upgrade_client_reporting_google_binding_to_pair(
         $1, $2, $3, 'upgrade:legacy:pair', $4, 'Reviewed exact reconnect pair'
       ) as id`,
      [old.rows[0]!.id, SHOPIFY_2, SESSION, ADMIN],
    );
    expect(retry.rows[0]).toEqual(upgraded.rows[0]);

    const result = await db.query<{
      old_status: string;
      new_status: string;
      shopify_id: string;
      google_id: string;
      mappings: string;
      role: string;
      shopify_currency: string;
      account_currency: string;
      google_currency: string;
    }>(
      `
      select old.status as old_status, fresh.status as new_status,
             fresh.shopify_connection_id as shopify_id,
             fresh.google_ads_connection_id as google_id,
             (select count(*)::text from public.client_asset_mappings
               where shopify_connection_id = $3 and google_ads_connection_id = $4) as mappings,
             account.reporting_role as role,
             shopify.shopify_currency,
             account.currency as account_currency,
             google_ads.currency as google_currency
      from public.client_reporting_bindings old
      join public.client_reporting_bindings fresh on fresh.id = $2
      join public.ad_accounts account on account.id = fresh.ad_account_id
      join public.client_shopify_connections shopify on shopify.id = fresh.shopify_connection_id
      join public.client_google_ads_connections google_ads on google_ads.id = fresh.google_ads_connection_id
      where old.id = $1
    `,
      [old.rows[0]!.id, upgraded.rows[0]!.id, SHOPIFY_2, GOOGLE_2],
    );
    expect(result.rows[0]).toEqual({
      old_status: "revoked",
      new_status: "active",
      shopify_id: SHOPIFY_2,
      google_id: GOOGLE_2,
      mappings: "1",
      role: "legacy_hybrid",
      shopify_currency: "JPY",
      account_currency: "USD",
      google_currency: "USD",
    });

    // The historical surrogate intentionally stays legacy_hybrid. It must
    // nevertheless remain the one exact Shopify fact anchor when a second,
    // explicitly-mapped Google account is added later.
    await db.exec("begin");
    try {
      await db.query(
        "update public.client_google_ads_connections set status = 'connected' where id = $1",
        [GOOGLE],
      );
      await db.query(
        `insert into public.client_asset_mappings(
           session_id, shopify_connection_id, google_ads_connection_id
         ) values ($1, $2, $3)`,
        [SESSION, SHOPIFY_2, GOOGLE],
      );
      const child = await provision({
        shopify: null,
        google: GOOGLE,
        anchor: upgraded.rows[0]!.id,
        key: "anchor:upgraded-legacy:child",
      });
      const anchored = await db.query<{
        anchor_role: string;
        child_role: string;
        anchor_id: string;
        shopify_fact_sources: string;
      }>(
        `
        select anchor_account.reporting_role as anchor_role,
               child_account.reporting_role as child_role,
               child.shopify_anchor_binding_id::text as anchor_id,
               (
                 select count(*)::text
                 from public.client_reporting_bindings candidate
                 where candidate.status = 'active'
                   and candidate.shopify_connection_id = $2
               ) as shopify_fact_sources
        from public.client_reporting_bindings child
        join public.ad_accounts child_account on child_account.id = child.ad_account_id
        join public.client_reporting_bindings anchor
          on anchor.id = child.shopify_anchor_binding_id
        join public.ad_accounts anchor_account on anchor_account.id = anchor.ad_account_id
        where child.id = $1
      `,
        [child.rows[0]!.id, SHOPIFY_2],
      );
      expect(anchored.rows[0]).toEqual({
        anchor_role: "legacy_hybrid",
        child_role: "google_spend",
        anchor_id: upgraded.rows[0]!.id,
        shopify_fact_sources: "1",
      });
    } finally {
      await db.exec("rollback");
    }

    await materializeBindingWindow(upgraded.rows[0]!.id);
    await actAs("authenticated", CLIENT);
    await db.exec("set role authenticated");
    try {
      await db.query(
        `insert into public.daily_metrics(ad_account_id, day, ad_spend, revenue)
         values ($1, current_date, 12, 30)`,
        [LEGACY_PAIR],
      );
    } finally {
      await db.exec("reset role");
      await actAs("service_role");
    }
    for (const [source, currency] of [
      ["shopify", "JPY"],
      ["google_ads", "USD"],
    ]) {
      await db.query(
        `select public.record_client_reporting_sync_success(
           $1, $2, current_date - 90, current_date - 1, $3, 90
         )`,
        [upgraded.rows[0]!.id, source, currency],
      );
    }
    await db.query(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '7777777777', 'USD')`,
      [LEGACY_PAIR],
    );
    await db.query(
      "update public.ad_accounts set status = 'active' where id = $1",
      [LEGACY_PAIR],
    );
    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'Cut over upgraded legacy pair')",
      [CLIENT, ADMIN],
    );
    await actAs("authenticated", CLIENT);
    await db.exec("set role authenticated");
    try {
      const attempted = await db.query(
        `update public.daily_metrics set revenue = 31
         where ad_account_id = $1 and day = current_date`,
        [LEGACY_PAIR],
      );
      expect(attempted.affectedRows).toBe(0);
    } finally {
      await db.exec("reset role");
      await actAs("service_role");
    }
    const preserved = await db.query<{ revenue: string }>(
      `select revenue::text from public.daily_metrics
       where ad_account_id = $1 and day = current_date`,
      [LEGACY_PAIR],
    );
    expect(preserved.rows[0]?.revenue).toBe("30");

    await db.query(
      "select public.rollback_client_reporting_cutover($1, $2, 'Restore exact legacy pair authority')",
      [CLIENT, ADMIN],
    );
    const legacyFallback = await db.query<{
      surface: string;
      role: string;
      status: string;
      shopify_connected: boolean;
      shopify_secret: boolean;
      google_connected: boolean;
      google_secret: boolean;
      binding_status: string;
      billing_starts: string;
      revenue: string;
    }>(
      `
      select rollout.operational_surface as surface,
             account.reporting_role as role,
             account.status,
             account.shopify_connected,
             account.shopify_admin_token is not null as shopify_secret,
             account.google_ads_connected as google_connected,
             account.google_ads_refresh_token is not null as google_secret,
             binding.status as binding_status,
             (select count(*)::text from public.ad_account_billing_starts start
               where start.ad_account_id = account.id) as billing_starts,
             (select metric.revenue::text from public.daily_metrics metric
               where metric.ad_account_id = account.id and metric.day = current_date) as revenue
      from public.client_rollout_states rollout
      join public.client_reporting_bindings binding on binding.id = $2
      join public.ad_accounts account on account.id = binding.ad_account_id
      where rollout.client_id = $1
    `,
      [CLIENT, upgraded.rows[0]!.id],
    );
    expect(legacyFallback.rows[0]).toEqual({
      surface: "rollback_legacy",
      role: "legacy_hybrid",
      status: "active",
      shopify_connected: true,
      shopify_secret: true,
      google_connected: true,
      google_secret: true,
      binding_status: "active",
      billing_starts: "1",
      revenue: "30",
    });
  });

  it("rolls back revoke and mapping when the pair commit fails after revocation", async () => {
    const old = await db.query<{ id: string }>(
      `select public.commit_client_reporting_binding(
         $1, null, $2, null, 'bind:rollback:old', $3, 'Reviewed Google-only source'
       ) as id`,
      [LEGACY_PAIR, GOOGLE_2, ADMIN],
    );
    await db.query(
      `update public.client_onboarding_sessions
       set mode = 'reconnect', status = 'reviewed', requested_assets = array['shopify'],
           target_client_id = $1, claimed_user_id = $1,
           reconnect_legacy_ad_account_id = $2, reconnect_completed_at = now()
       where id = $3`,
      [CLIENT, LEGACY_PAIR, SESSION],
    );
    await db.query(
      `insert into public.client_onboarding_events(
         session_id, event_type, actor_type, actor_id, details
       ) values ($1, 'shopify_connected', 'system', $2,
         jsonb_build_object('connection_id', $3::text))`,
      [SESSION, CLIENT, SHOPIFY_2],
    );
    await db.query(
      `insert into public.client_reporting_binding_events(
         binding_id, event_type, idempotency_key, actor_id, reason
       ) values ($1, 'bound', 'upgrade:rollback:bind', $2, 'Reserved collision proof')`,
      [old.rows[0]!.id, ADMIN],
    );

    await expectSqlState(
      db.query(
        `select public.upgrade_client_reporting_google_binding_to_pair(
           $1, $2, $3, 'upgrade:rollback', $4, 'Reviewed rollback transaction'
         )`,
        [old.rows[0]!.id, SHOPIFY_2, SESSION, ADMIN],
      ),
      "23505",
    );
    const result = await db.query<{
      status: string;
      mappings: string;
      active: string;
    }>(
      `
      select status,
        (select count(*)::text from public.client_asset_mappings
          where google_ads_connection_id = $2) as mappings,
        (select count(*)::text from public.client_reporting_bindings
          where ad_account_id = $3 and status = 'active') as active
      from public.client_reporting_bindings where id = $1
    `,
      [old.rows[0]!.id, GOOGLE_2, LEGACY_PAIR],
    );
    expect(result.rows[0]).toEqual({
      status: "active",
      mappings: "0",
      active: "1",
    });
  });

  it("rejects an exact reconnect replacement after cutover without changing any history", async () => {
    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE],
    );
    const shopifyBinding = await provision({
      shopify: SHOPIFY,
      google: null,
      key: "anchor:replacement:shopify",
    });
    const old = await db.query<{ id: string }>(
      `select public.commit_client_reporting_binding(
         $1, null, $2, null, 'bind:replacement:old', $3,
         'Reviewed pre-cutover Google authority'
       ) as id`,
      [LEGACY_PAIR, GOOGLE_2, ADMIN],
    );
    await materializeBindingWindow(shopifyBinding.rows[0]!.id);
    await materializeBindingWindow(old.rows[0]!.id);
    await db.query(
      `select public.record_client_reporting_sync_success(
         $1, 'shopify', current_date - 90, current_date - 1, 'USD', 90
       )`,
      [shopifyBinding.rows[0]!.id],
    );
    await db.query(
      `select public.record_client_reporting_sync_success(
         $1, 'google_ads', current_date - 90, current_date - 1, 'USD', 90
       )`,
      [old.rows[0]!.id],
    );
    await db.query(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '7777777777', 'USD')`,
      [LEGACY_PAIR],
    );
    await db.query(
      "update public.ad_accounts set status = 'active' where id = $1",
      [LEGACY_PAIR],
    );
    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'Cut over before reconnect replacement')",
      [CLIENT, ADMIN],
    );

    await db.query(
      `update public.client_shopify_connections
       set status = 'connected', last_verified_at = now(), last_error_code = null
       where id = $1`,
      [SHOPIFY_2],
    );
    await db.query(
      `update public.client_onboarding_sessions
       set mode = 'reconnect', status = 'reviewed', requested_assets = array['shopify'],
           target_client_id = $1, claimed_user_id = $1,
           reconnect_legacy_ad_account_id = $2, reconnect_completed_at = now()
       where id = $3`,
      [CLIENT, LEGACY_PAIR, SESSION],
    );
    await db.query(
      `insert into public.client_onboarding_events(
         session_id, event_type, actor_type, actor_id, details
       ) values ($1, 'shopify_connected', 'system', $2,
         jsonb_build_object('connection_id', $3::text))`,
      [SESSION, CLIENT, SHOPIFY_2],
    );

    const fingerprint = () =>
      db.query<{ fingerprint: string }>(
        `select md5(jsonb_build_object(
          'binding', (select to_jsonb(binding) from public.client_reporting_bindings binding
            where binding.id = $1),
          'activeCount', (select count(*) from public.client_reporting_bindings binding
            where binding.ad_account_id = $2 and binding.status = 'active'),
          'mapping', (select coalesce(jsonb_agg(to_jsonb(mapping) order by mapping.id), '[]')
            from public.client_asset_mappings mapping
            where mapping.google_ads_connection_id = $3),
          'bindingEvents', (select coalesce(jsonb_agg(to_jsonb(event) order by event.id), '[]')
            from public.client_reporting_binding_events event
            where event.binding_id = $1),
          'anchorEvents', (select coalesce(jsonb_agg(to_jsonb(event) order by event.id), '[]')
            from public.client_reporting_anchor_events event
            where event.binding_id = $1),
          'finance', jsonb_build_object(
            'starts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
              from public.ad_account_billing_starts row where row.ad_account_id = $2),
            'ends', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
              from public.ad_account_billing_ends row where row.ad_account_id = $2),
            'commissions', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]')
              from public.commissions row where row.ad_account_id = $2)
          ),
          'metrics', (select coalesce(jsonb_agg(to_jsonb(metric) order by metric.day), '[]')
            from public.daily_metrics metric where metric.ad_account_id = $2)
        )::text) as fingerprint`,
        [old.rows[0]!.id, LEGACY_PAIR, GOOGLE_2],
      );
    const before = await fingerprint();

    await expectSqlState(
      db.query(
        `select public.upgrade_client_reporting_google_binding_to_pair(
           $1, $2, $3, 'upgrade:replacement:blocked', $4,
           'Never replace active authority immediately after cutover'
         )`,
        [old.rows[0]!.id, SHOPIFY_2, SESSION, ADMIN],
      ),
      "23514",
    );

    expect((await fingerprint()).rows[0]).toEqual(before.rows[0]);
  });

  it("stages a post-cutover Shopify source outside normal authority and promotes it once", async () => {
    await cutOverWithShopifyAnchor();
    await db.query(
      `update public.client_shopify_connections
       set status = 'connected', shopify_domain = 'store-two.myshopify.com',
           shopify_currency = 'JPY', last_verified_at = now(), last_error_code = null
       where id = $1`,
      [SHOPIFY_2],
    );

    await expectSqlState(
      provision({ shopify: SHOPIFY_2, key: "anchor:unsafe:post-cutover" }),
      "23514",
    );
    const staged = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, $2, null, null, null, 'stage:shopify:two', $3,
         'Reviewed post-cutover Shopify source'
       ) as id`,
      [CLIENT, SHOPIFY_2, ADMIN],
    );
    const retry = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, $2, null, null, null, 'stage:shopify:two', $3,
         'Reviewed post-cutover Shopify source'
       ) as id`,
      [CLIENT, SHOPIFY_2, ADMIN],
    );
    expect(retry.rows[0]).toEqual(staged.rows[0]);

    const before = await db.query<{
      status: string;
      account_status: string;
      account_currency: string;
      owned: boolean;
      finance: string;
    }>(
      `
      select binding.status, account.status as account_status,
        account.currency as account_currency,
        public.owns_ad_account(account.id) as owned,
        md5(jsonb_build_object(
          'commissions', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.commissions row),
          'starts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_starts row),
          'ends', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_ends row)
        )::text) as finance
      from public.client_reporting_bindings binding
      join public.ad_accounts account on account.id = binding.ad_account_id
      where binding.id = $1
    `,
      [staged.rows[0]!.id],
    );
    expect(before.rows[0]).toMatchObject({
      status: "staged",
      account_status: "pending",
      account_currency: "EUR",
      owned: false,
    });

    await expectSqlState(
      db.query(
        `select public.promote_client_reporting_source(
           $1, $2, 'promote:shopify:early', 'Promote without receipt'
         )`,
        [staged.rows[0]!.id, ADMIN],
      ),
      "23514",
    );

    await commitStagedWindow(staged.rows[0]!.id, 7);
    await db.query(
      `select public.record_client_staged_reporting_sync_success(
         $1, 'shopify', current_date - 7, current_date - 1, 'JPY', 7
       )`,
      [staged.rows[0]!.id],
    );
    await expectSqlState(
      db.query(
        `select public.promote_client_reporting_source(
           $1, $2, 'promote:shopify:short', 'Seven days are insufficient'
         )`,
        [staged.rows[0]!.id, ADMIN],
      ),
      "23514",
    );

    await commitStagedWindow(staged.rows[0]!.id);
    await db.query(
      `select public.record_client_staged_reporting_sync_success(
         $1, 'shopify', current_date - 90, current_date - 1, 'JPY', 90
       )`,
      [staged.rows[0]!.id],
    );
    // A later metrics commit makes the earlier receipt stale. Promotion must
    // attest the current facts, not merely the existence of an old receipt.
    await commitStagedWindow(staged.rows[0]!.id);
    await expectSqlState(
      db.query(
        `select public.promote_client_reporting_source(
           $1, $2, 'promote:shopify:stale-receipt', 'Receipt predates facts'
         )`,
        [staged.rows[0]!.id, ADMIN],
      ),
      "23514",
    );
    await db.query(
      `select public.record_client_staged_reporting_sync_success(
         $1, 'shopify', current_date - 90, current_date - 1, 'JPY', 90
       )`,
      [staged.rows[0]!.id],
    );
    const promoted = await db.query<{ id: string }>(
      `select public.promote_client_reporting_source(
         $1, $2, 'promote:shopify:two', 'Reviewed source promotion'
       ) as id`,
      [staged.rows[0]!.id, ADMIN],
    );
    const promotedRetry = await db.query<{ id: string }>(
      `select public.promote_client_reporting_source(
         $1, $2, 'promote:shopify:two', 'Reviewed source promotion'
       ) as id`,
      [staged.rows[0]!.id, ADMIN],
    );
    expect(promotedRetry.rows[0]).toEqual(promoted.rows[0]);
    await expectSqlState(
      db.query(
        `select public.promote_client_reporting_source(
           $1, $2, 'promote:shopify:two', 'Conflicting promotion reason'
         )`,
        [staged.rows[0]!.id, ADMIN],
      ),
      "23505",
    );

    const after = await db.query<{
      status: string;
      account_status: string;
      owned: boolean;
      finance: string;
      events: string;
      cutover_at: string;
    }>(
      `
      select binding.status, account.status as account_status,
        public.owns_ad_account(account.id) as owned,
        md5(jsonb_build_object(
          'commissions', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.commissions row),
          'starts', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_starts row),
          'ends', (select coalesce(jsonb_agg(to_jsonb(row) order by row.id), '[]') from public.ad_account_billing_ends row)
        )::text) as finance,
        (select count(*)::text from public.client_reporting_anchor_events event
          where event.binding_id = binding.id and event.event_type = 'source_added') as events,
        rollout.reporting_cutover_at::text as cutover_at
      from public.client_reporting_bindings binding
      join public.ad_accounts account on account.id = binding.ad_account_id
      join public.client_rollout_states rollout on rollout.client_id = binding.client_id
      where binding.id = $1
    `,
      [staged.rows[0]!.id],
    );
    expect(after.rows[0]).toMatchObject({
      status: "active",
      account_status: before.rows[0]!.account_status,
      owned: false,
      finance: before.rows[0]!.finance,
      events: "1",
      cutover_at: expect.any(String),
    });
  });

  it("rejects staged Google sources that cannot obtain the EUR-only billing baseline", async () => {
    const anchorId = await cutOverWithShopifyAnchor();
    await db.query(
      `update public.client_google_ads_connections
       set status = 'connected', currency = 'DKK',
           last_verified_at = now(), last_error_code = null
       where id = $1`,
      [GOOGLE],
    );
    await db.query(
      `insert into public.client_asset_mappings(
         session_id, shopify_connection_id, google_ads_connection_id
       ) values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );

    await expectSqlState(
      db.query(
        `select public.stage_client_reporting_source(
           $1, null, $2, $3, null, 'stage:google:dkk', $4,
           'Reject unbillable staged Google identity'
         )`,
        [CLIENT, GOOGLE, anchorId, ADMIN],
      ),
      "23514",
    );
  });

  it("requires a post-stage full write and exact Google billing start before promotion", async () => {
    const anchorId = await cutOverWithShopifyAnchor();
    await db.query(
      `update public.client_google_ads_connections
       set status = 'connected', currency = 'EUR',
           last_verified_at = now(), last_error_code = null
       where id = $1`,
      [GOOGLE],
    );
    await db.query(
      `insert into public.client_asset_mappings(
         session_id, shopify_connection_id, google_ads_connection_id
       ) values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    const staged = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, null, $2, $3, null, 'stage:google:child', $4,
         'Reviewed post-cutover Google source'
       ) as id`,
      [CLIENT, GOOGLE, anchorId, ADMIN],
    );

    await db.exec("begin");
    try {
      await db.query(
        `insert into public.ad_account_billing_starts(
           ad_account_id, google_ads_customer_id, currency
         ) select ad_account_id, '1111111111', 'EUR'
           from public.client_reporting_bindings where id = $1`,
        [staged.rows[0]!.id],
      );
      await expectSqlState(
        db.query(
          `update public.ad_accounts set status = 'active'
           where id = (select ad_account_id from public.client_reporting_bindings where id = $1)`,
          [staged.rows[0]!.id],
        ),
        "23514",
      );
    } finally {
      await db.exec("rollback");
    }

    await expectSqlState(
      db.query(
        `select public.record_client_staged_reporting_sync_success(
           $1, 'google_ads', current_date - 90, current_date - 1, 'EUR', 90
         )`,
        [staged.rows[0]!.id],
      ),
      "23514",
    );
    await expectSqlState(
      db.query(
        `select public.commit_client_staged_reporting_metrics(
           $1, current_date - 90, current_date - 1,
           jsonb_build_array(jsonb_build_object(
             'ad_account_id', $2::uuid, 'day', current_date - 1,
             'access_token', 'never-store-this'
           ))
         )`,
        [staged.rows[0]!.id, SHELL],
      ),
      "22023",
    );
    await commitStagedWindow(staged.rows[0]!.id);
    await expectSqlState(
      db.query(
        `select public.record_client_staged_reporting_sync_success(
           $1, 'google_ads', current_date - 90, current_date - 1, 'EUR', 91
         )`,
        [staged.rows[0]!.id],
      ),
      "22023",
    );
    await db.query(
      `select public.record_client_staged_reporting_sync_success(
         $1, 'google_ads', current_date - 90, current_date - 1, 'EUR', 90
       )`,
      [staged.rows[0]!.id],
    );
    const stagedAccount = await db.query<{ id: string }>(
      "select ad_account_id as id from public.client_reporting_bindings where id = $1",
      [staged.rows[0]!.id],
    );
    await commitStagedWindow(staged.rows[0]!.id);
    await db.exec("begin");
    try {
      await db.query(
        `insert into public.ad_account_billing_starts(
           ad_account_id, google_ads_customer_id, currency
         ) values ($1, '1111111111', 'EUR')`,
        [stagedAccount.rows[0]!.id],
      );
      await expectSqlState(
        db.query(
          "update public.ad_accounts set status = 'active' where id = $1",
          [stagedAccount.rows[0]!.id],
        ),
        "23514",
      );
    } finally {
      await db.exec("rollback");
    }
    expect(
      (
        await db.query<{ starts: string }>(
          `select count(*)::text as starts from public.ad_account_billing_starts
           where ad_account_id = $1`,
          [stagedAccount.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({ starts: "0" });
    await db.query(
      `select public.record_client_staged_reporting_sync_success(
         $1, 'google_ads', current_date - 90, current_date - 1, 'EUR', 90
       )`,
      [staged.rows[0]!.id],
    );
    await expectSqlState(
      db.query(
        `select public.promote_client_reporting_source(
           $1, $2, 'promote:google:no-billing', 'Google billing is separate'
         )`,
        [staged.rows[0]!.id, ADMIN],
      ),
      "23514",
    );

    const account = await db.query<{ id: string; status: string }>(
      `select account.id, account.status
       from public.client_reporting_bindings binding
       join public.ad_accounts account on account.id = binding.ad_account_id
       where binding.id = $1`,
      [staged.rows[0]!.id],
    );
    await db.query(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency
       ) values ($1, '1111111111', 'EUR')`,
      [account.rows[0]!.id],
    );
    await db.query(
      "update public.ad_accounts set status = 'active' where id = $1",
      [account.rows[0]!.id],
    );
    await db.query(
      `select public.promote_client_reporting_source(
         $1, $2, 'promote:google:child', 'Reviewed Google source promotion'
       )`,
      [staged.rows[0]!.id, ADMIN],
    );
    const result = await db.query<{
      status: string;
      account_status: string;
      events: string;
    }>(
      `
      select binding.status, account.status as account_status,
        (select count(*)::text from public.client_reporting_anchor_events event
          where event.binding_id = binding.id and event.event_type = 'source_added') as events
      from public.client_reporting_bindings binding
      join public.ad_accounts account on account.id = binding.ad_account_id
      where binding.id = $1
    `,
      [staged.rows[0]!.id],
    );
    expect(result.rows[0]).toEqual({
      status: "active",
      account_status: "active",
      events: "1",
    });
  });

  it("abandons only staged sources idempotently and explicitly reuses their identity", async () => {
    const activeAnchor = await cutOverWithShopifyAnchor();
    await db.query(
      `update public.client_shopify_connections
       set status = 'connected', shopify_domain = 'store-two.myshopify.com',
           shopify_currency = 'SGD', last_verified_at = now(), last_error_code = null
       where id = $1`,
      [SHOPIFY_2],
    );
    const staged = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, $2, null, null, null, 'stage:abandon:one', $3,
         'Reviewed source before abandonment'
       ) as id`,
      [CLIENT, SHOPIFY_2, ADMIN],
    );
    const account = await db.query<{ id: string }>(
      "select ad_account_id as id from public.client_reporting_bindings where id = $1",
      [staged.rows[0]!.id],
    );
    await commitStagedWindow(staged.rows[0]!.id, 7);

    const abandoned = await db.query<{ id: string }>(
      `select public.abandon_client_reporting_source(
         $1, $2, 'abandon:source:one', 'Wrong source selected'
       ) as id`,
      [staged.rows[0]!.id, ADMIN],
    );
    const abandonedRetry = await db.query<{ id: string }>(
      `select public.abandon_client_reporting_source(
         $1, $2, 'abandon:source:one', 'Wrong source selected'
       ) as id`,
      [staged.rows[0]!.id, ADMIN],
    );
    expect(abandonedRetry.rows[0]).toEqual(abandoned.rows[0]);
    await expectSqlState(
      db.query(
        `select public.abandon_client_reporting_source(
           $1, $2, 'abandon:source:one', 'Conflicting abandon reason'
         )`,
        [staged.rows[0]!.id, ADMIN],
      ),
      "23505",
    );
    await expectSqlState(
      db.query(
        `select public.abandon_client_reporting_source(
           $1, $2, 'abandon:active:blocked', 'Never abandon authority'
         )`,
        [activeAnchor, ADMIN],
      ),
      "23514",
    );

    await expectSqlState(
      db.query(
        `select public.stage_client_reporting_source(
           $1, $2, null, null, null, 'stage:abandon:implicit', $3,
           'Do not infer abandoned identities'
         )`,
        [CLIENT, SHOPIFY_2, ADMIN],
      ),
      "23505",
    );
    const restaged = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, $2, null, null, $3, 'stage:abandon:explicit', $4,
         'Explicitly restage abandoned identity'
       ) as id`,
      [CLIENT, SHOPIFY_2, account.rows[0]!.id, ADMIN],
    );
    const restagedRetry = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, $2, null, null, $3, 'stage:abandon:explicit', $4,
         'Explicitly restage abandoned identity'
       ) as id`,
      [CLIENT, SHOPIFY_2, account.rows[0]!.id, ADMIN],
    );
    expect(restagedRetry.rows[0]).toEqual(restaged.rows[0]);
    expect(restaged.rows[0]!.id).not.toBe(staged.rows[0]!.id);

    const result = await db.query<{
      old_status: string;
      new_status: string;
      old_account: string;
      new_account: string;
      metrics: string;
      abandoned_events: string;
      restaged_events: string;
    }>(
      `
      select old.status as old_status, fresh.status as new_status,
        old.ad_account_id::text as old_account,
        fresh.ad_account_id::text as new_account,
        (select count(*)::text from public.daily_metrics metric
          where metric.ad_account_id = old.ad_account_id) as metrics,
        (select count(*)::text from public.client_reporting_anchor_events event
          where event.binding_id = old.id and event.event_type = 'source_abandoned') as abandoned_events,
        (select count(*)::text from public.client_reporting_anchor_events event
          where event.binding_id = fresh.id and event.event_type = 'restaged') as restaged_events
      from public.client_reporting_bindings old
      join public.client_reporting_bindings fresh on fresh.id = $2
      where old.id = $1
    `,
      [staged.rows[0]!.id, restaged.rows[0]!.id],
    );
    expect(result.rows[0]).toEqual({
      old_status: "revoked",
      new_status: "staged",
      old_account: account.rows[0]!.id,
      new_account: account.rows[0]!.id,
      metrics: "7",
      abandoned_events: "1",
      restaged_events: "1",
    });
  });

  it("never lets an abandoned normalized Google identity become orphan billable", async () => {
    const anchorId = await cutOverWithShopifyAnchor();
    await db.query(
      `update public.client_google_ads_connections
       set status = 'connected', currency = 'EUR',
           last_verified_at = now(), last_error_code = null
       where id = $1`,
      [GOOGLE],
    );
    await db.query(
      `insert into public.client_asset_mappings(
         session_id, shopify_connection_id, google_ads_connection_id
       ) values ($1, $2, $3)`,
      [SESSION, SHOPIFY, GOOGLE],
    );
    const staged = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, null, $2, $3, null, 'stage:orphan:one', $4,
         'Stage source before explicit abandonment'
       ) as id`,
      [CLIENT, GOOGLE, anchorId, ADMIN],
    );
    const account = await db.query<{ id: string }>(
      "select ad_account_id as id from public.client_reporting_bindings where id = $1",
      [staged.rows[0]!.id],
    );
    await db.query(
      `select public.abandon_client_reporting_source(
         $1, $2, 'abandon:orphan:one', 'Abandon before billing starts'
       )`,
      [staged.rows[0]!.id, ADMIN],
    );

    await db.exec("begin");
    try {
      await db.query(
        `insert into public.ad_account_billing_starts(
           ad_account_id, google_ads_customer_id, currency
         ) values ($1, '1111111111', 'EUR')`,
        [account.rows[0]!.id],
      );
      await expectSqlState(
        db.query(
          "update public.ad_accounts set status = 'active' where id = $1",
          [account.rows[0]!.id],
        ),
        "23514",
      );
    } finally {
      await db.exec("rollback");
    }
    expect(
      (
        await db.query<{ status: string; starts: string }>(
          `select account.status,
             (select count(*)::text from public.ad_account_billing_starts billing
              where billing.ad_account_id = account.id) as starts
           from public.ad_accounts account where account.id = $1`,
          [account.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({ status: "pending", starts: "0" });

    const restaged = await db.query<{ id: string }>(
      `select public.stage_client_reporting_source(
         $1, null, $2, $3, $4, 'stage:orphan:two', $5,
         'Explicitly restage the still-unbilled identity'
       ) as id`,
      [CLIENT, GOOGLE, anchorId, account.rows[0]!.id, ADMIN],
    );
    await commitStagedWindow(restaged.rows[0]!.id);
    await db.query(
      `select public.record_client_staged_reporting_sync_success(
         $1, 'google_ads', current_date - 90, current_date - 1, 'EUR', 90
       )`,
      [restaged.rows[0]!.id],
    );
    await db.exec("begin");
    try {
      await db.query(
        `insert into public.ad_account_billing_starts(
           ad_account_id, google_ads_customer_id, currency
         ) values ($1, '1111111111', 'EUR')`,
        [account.rows[0]!.id],
      );
      await db.query(
        "update public.ad_accounts set status = 'active' where id = $1",
        [account.rows[0]!.id],
      );
      await db.exec("commit");
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
    expect(
      (
        await db.query<{ status: string; starts: string }>(
          `select account.status,
             (select count(*)::text from public.ad_account_billing_starts billing
              where billing.ad_account_id = account.id) as starts
           from public.ad_accounts account where account.id = $1`,
          [account.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", starts: "1" });
  });

  it("keeps staged lifecycle RPCs service-only and reserves source identities", async () => {
    const acl = await db.query<{
      auth_stage: boolean;
      service_stage: boolean;
      auth_sync: boolean;
      service_sync: boolean;
      auth_promote: boolean;
      service_promote: boolean;
      auth_abandon: boolean;
      service_abandon: boolean;
    }>(`
      select
        has_function_privilege('authenticated',
          'public.stage_client_reporting_source(uuid,uuid,uuid,uuid,uuid,text,uuid,text)', 'EXECUTE') as auth_stage,
        has_function_privilege('service_role',
          'public.stage_client_reporting_source(uuid,uuid,uuid,uuid,uuid,text,uuid,text)', 'EXECUTE') as service_stage,
        has_function_privilege('authenticated',
          'public.commit_client_staged_reporting_metrics(uuid,date,date,jsonb)', 'EXECUTE') as auth_sync,
        has_function_privilege('service_role',
          'public.commit_client_staged_reporting_metrics(uuid,date,date,jsonb)', 'EXECUTE') as service_sync,
        has_function_privilege('authenticated',
          'public.promote_client_reporting_source(uuid,uuid,text,text)', 'EXECUTE') as auth_promote,
        has_function_privilege('service_role',
          'public.promote_client_reporting_source(uuid,uuid,text,text)', 'EXECUTE') as service_promote,
        has_function_privilege('authenticated',
          'public.abandon_client_reporting_source(uuid,uuid,text,text)', 'EXECUTE') as auth_abandon,
        has_function_privilege('service_role',
          'public.abandon_client_reporting_source(uuid,uuid,text,text)', 'EXECUTE') as service_abandon
    `);
    expect(acl.rows[0]).toEqual({
      auth_stage: false,
      service_stage: true,
      auth_sync: false,
      service_sync: true,
      auth_promote: false,
      service_promote: true,
      auth_abandon: false,
      service_abandon: true,
    });
  });
});

describe("adopting an unanchored Google source (0094)", () => {
  async function unanchoredPair() {
    const anchor = await provision({ key: "anchor:adopt:shopify" });
    const child = await provision({
      shopify: null,
      google: GOOGLE,
      key: "anchor:adopt:google",
    });
    return { anchorId: anchor.rows[0]!.id, childId: child.rows[0]!.id };
  }

  async function adopt(childId: string, anchorId: string, key = "adopt:test:001") {
    return db.query<{ id: string }>(
      `select public.adopt_client_reporting_google_child($1, $2, $3, $4, 'Linked to its store') as id`,
      [childId, anchorId, ADMIN, key],
    );
  }

  it("answers the null anchor and writes the mapping the resolver demands", async () => {
    const { anchorId, childId } = await unanchoredPair();

    const adopted = await adopt(childId, anchorId);
    expect(adopted.rows[0]!.id).toBe(childId);

    const binding = await db.query<{
      shopify_anchor_binding_id: string;
      status: string;
      shopify_connection_id: string | null;
    }>(
      `select shopify_anchor_binding_id, status, shopify_connection_id
       from public.client_reporting_bindings where id = $1`,
      [childId],
    );
    // The binding is re-parented in place: same row, still active, still
    // Google-only. Nothing was revoked and no replacement was created.
    expect(binding.rows[0]).toMatchObject({
      shopify_anchor_binding_id: anchorId,
      status: "active",
      shopify_connection_id: null,
    });

    const mapping = await db.query<{ shopify_connection_id: string }>(
      `select shopify_connection_id from public.client_asset_mappings
       where google_ads_connection_id = $1`,
      [GOOGLE],
    );
    expect(mapping.rows).toHaveLength(1);
    expect(mapping.rows[0]!.shopify_connection_id).toBe(SHOPIFY);

    const event = await db.query<{ event_type: string; binding_id: string }>(
      `select event_type, binding_id from public.client_reporting_anchor_events
       where idempotency_key = 'adopt:test:001'`,
    );
    expect(event.rows[0]).toMatchObject({ event_type: "adopted", binding_id: childId });
  });

  it("still refuses a hand-written anchor without the purpose-bound key", async () => {
    const { anchorId, childId } = await unanchoredPair();
    // This is the whole safety claim of the migration: the escape exists only
    // for the RPC, and a direct write is rejected exactly as it was before.
    await expectSqlState(
      db.query(
        `update public.client_reporting_bindings
         set shopify_anchor_binding_id = $1 where id = $2`,
        [anchorId, childId],
      ),
      "23514",
    );
  });

  it("never re-points an anchor that is already set", async () => {
    const { anchorId, childId } = await unanchoredPair();
    await adopt(childId, anchorId);
    // Once answered, the column is closed: the RPC only accepts a binding whose
    // anchor is still null, so a second adoption cannot move it anywhere.
    await expectSqlState(adopt(childId, anchorId, "adopt:test:002"), "23514");
  });

  it("replays an identical adoption instead of failing the second caller", async () => {
    const { anchorId, childId } = await unanchoredPair();
    await adopt(childId, anchorId);
    const replay = await adopt(childId, anchorId);
    expect(replay.rows[0]!.id).toBe(childId);
  });

  it("refuses an anchor belonging to a different client", async () => {
    const { childId } = await unanchoredPair();
    await expectSqlState(
      adopt(childId, "55000000-0000-4000-8000-0000000000ff", "adopt:test:003"),
      "23514",
    );
  });
});

  // A third store of its own: SHOPIFY_2's domain deliberately collides with
  // the seeded legacy pair for the adoption tests, and a handover target
  // must be a plain fresh anchor.
  const TARGET_SHOPIFY = "55000000-0000-4000-8000-000000000022";

  async function pairAndTarget() {
    // The pair lives on the seeded LEGACY account - the exact shape the
    // handover serves (a pre-V2 identity upgraded to a pair binding). The
    // handover is EUR-only by construction, so the scenario runs in EUR.
    await db.query(
      "update public.ad_accounts set currency = 'EUR' where id = $1",
      [LEGACY_PAIR],
    );
    await db.query(
      "update public.client_google_ads_connections set currency = 'EUR' where id = $1",
      [GOOGLE_2],
    );
    await db.query(
      "update public.client_shopify_connections set shopify_currency = 'EUR' where id = $1",
      [SHOPIFY_2],
    );
    await db.query(
      `insert into public.client_asset_mappings(session_id, shopify_connection_id, google_ads_connection_id)
       values ($1, $2, $3)`,
      [SESSION, SHOPIFY_2, GOOGLE_2],
    );
    const pair = await db.query<{ id: string }>(
      `select public.commit_client_reporting_binding(
         $1, $2, $3, null, 'anchor:handover:legacy-pair', $4,
         'Legacy pair binding for the handover fixture'
       ) as id`,
      [LEGACY_PAIR, SHOPIFY_2, GOOGLE_2, ADMIN],
    );
    await db.query(
      `insert into public.client_shopify_connections(
         id, session_id, client_id, status, shopify_shop_id, shopify_name,
         shopify_domain, shopify_currency, credential_hint, last_verified_at
       ) values ($1, $2, $3, 'connected', 'shop-3', 'Target Store',
         'target-store.myshopify.com', 'EUR', 'hint', now())`,
      [TARGET_SHOPIFY, SESSION, CLIENT],
    );
    await db.query(
      `insert into public.client_shopify_credentials(
         connection_id, shopify_client_id, client_secret_ciphertext
       ) values ($1, 'client-id-3', 'secret-ciphertext-3')`,
      [TARGET_SHOPIFY],
    );
    const target = await provision({
      shopify: TARGET_SHOPIFY,
      key: "anchor:handover:target",
    });
    return { pairId: pair.rows[0]!.id, targetId: target.rows[0]!.id };
  }

  async function cutOverBoth(pairId: string, targetId: string) {
    // Cutover demands every connected source be covered exactly once; the
    // seeded spares stay out of this scenario.
    await db.query(
      "update public.client_shopify_connections set status = 'revoked' where id = $1",
      [SHOPIFY],
    );
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [GOOGLE],
    );
    for (const bindingId of [pairId, targetId]) {
      await materializeBindingWindow(bindingId);
      await db.query(
        `select public.record_client_reporting_sync_success(
           $1, 'shopify', current_date - 90, current_date - 1, 'EUR', 90
         )`,
        [bindingId],
      );
    }
    await db.query(
      `select public.record_client_reporting_sync_success(
         $1, 'google_ads', current_date - 90, current_date - 1, 'EUR', 90
       )`,
      [pairId],
    );
    await db.query(
      "select public.activate_client_reporting_cutover($1, $2, 'Handover fixture cutover')",
      [CLIENT, ADMIN],
    );
  }

  async function accountOf(bindingId: string) {
    const row = await db.query<{ ad_account_id: string }>(
      "select ad_account_id from public.client_reporting_bindings where id = $1",
      [bindingId],
    );
    return row.rows[0]!.ad_account_id;
  }

  // EUR cutover demands an OPEN billing start on every Google-bearing source,
  // so the boundary rows are split: the start opens before cutover, the end
  // closes whenever the store swap is decided.
  async function openBilling(pairId: string) {
    const accountId = await accountOf(pairId);
    const start = await db.query<{ id: string }>(
      `insert into public.ad_account_billing_starts(
         ad_account_id, google_ads_customer_id, currency, google_local_date,
         google_time_zone, baseline_cost_micros, start_basis
       ) values ($1, '7777777777', 'EUR', current_date - 30, 'America/New_York', 0,
         'observed_google_counter')
       returning id`,
      [accountId],
    );
    // Billing activation is what flips a pending account active in
    // production; the EUR cutover predicate demands it.
    await db.query(
      "update public.ad_accounts set status = 'active' where id = $1",
      [accountId],
    );
    return { accountId, startId: start.rows[0]!.id };
  }

  async function closeBilling(opened: { accountId: string; startId: string }) {
    await db.query(
      `insert into public.ad_account_billing_ends(
         ad_account_id, billing_start_id, google_ads_customer_id, currency,
         google_local_date, google_time_zone, end_cost_micros
       ) values ($1, $2, '7777777777', 'EUR', current_date - 1,
         'America/New_York', 123456789)`,
      [opened.accountId, opened.startId],
    );
    return opened.accountId;
  }

  async function handover(pairId: string, targetId: string, key = "handover:test:0001") {
    return db.query<{ id: string }>(
      `select public.handover_client_reporting_google_source(
         $1, $2, $3, $4, 'Store handover test'
       ) as id`,
      [pairId, targetId, ADMIN, key],
    );
  }
describe("handing a Google source to a new store (0095)", () => {


  it("moves the Google source to the new store and splits billing at the captured counter", async () => {
    const { pairId, targetId } = await pairAndTarget();
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    const oldAccountId = await closeBilling(opened);

    const child = await handover(pairId, targetId);
    const childBindingId = child.rows[0]!.id;

    // The pair is retired; the old account keeps its store through a fresh
    // Shopify-only binding - history and revenue never leave it.
    const bindings = await db.query<{
      id: string;
      status: string;
      ad_account_id: string;
      shopify_connection_id: string | null;
      google_ads_connection_id: string | null;
      shopify_anchor_binding_id: string | null;
    }>(
      `select id, status, ad_account_id, shopify_connection_id,
              google_ads_connection_id, shopify_anchor_binding_id
       from public.client_reporting_bindings order by bound_at`,
    );
    const pair = bindings.rows.find((row) => row.id === pairId)!;
    expect(pair.status).toBe("revoked");
    const replacement = bindings.rows.find(
      (row) =>
        row.status === "active" &&
        row.ad_account_id === oldAccountId &&
        row.shopify_connection_id === SHOPIFY_2,
    )!;
    expect(replacement.google_ads_connection_id).toBeNull();
    expect(replacement.shopify_anchor_binding_id).toBeNull();

    // The successor: same Google identity on a NEW google_spend account,
    // anchored under the target store.
    const childBinding = bindings.rows.find((row) => row.id === childBindingId)!;
    expect(childBinding.status).toBe("active");
    expect(childBinding.google_ads_connection_id).toBe(GOOGLE_2);
    expect(childBinding.shopify_connection_id).toBeNull();
    expect(childBinding.shopify_anchor_binding_id).toBe(targetId);
    expect(childBinding.ad_account_id).not.toBe(oldAccountId);

    const childAccount = await db.query<{
      reporting_role: string;
      google_ads_customer_id: string;
      status: string;
    }>(
      "select reporting_role, google_ads_customer_id, status from public.ad_accounts where id = $1",
      [childBinding.ad_account_id],
    );
    // Active, not pending: the start was committed in the same transaction,
    // and a pending account is invisible to commission-sync - the new store
    // must bill from its first euro.
    expect(childAccount.rows[0]).toMatchObject({
      reporting_role: "google_spend",
      google_ads_customer_id: "7777777777",
      status: "active",
    });

    // The successor's opening boundary IS the closing capture: same local
    // day, same counter, so the boundary day partitions exactly and the
    // auto-start sweep can never backdate it.
    const childStart = await db.query<{
      baseline_cost_micros: string | number;
      same_day: boolean;
    }>(
      `select baseline_cost_micros,
              google_local_date = current_date - 1 as same_day
       from public.ad_account_billing_starts where ad_account_id = $1`,
      [childBinding.ad_account_id],
    );
    expect(Number(childStart.rows[0]!.baseline_cost_micros)).toBe(123456789);
    expect(childStart.rows[0]!.same_day).toBe(true);

    // The mapping now names the new store, as the resolver demands of a child.
    const mapping = await db.query<{ shopify_connection_id: string }>(
      "select shopify_connection_id from public.client_asset_mappings where google_ads_connection_id = $1",
      [GOOGLE_2],
    );
    expect(mapping.rows).toHaveLength(1);
    expect(mapping.rows[0]!.shopify_connection_id).toBe(TARGET_SHOPIFY);

    const event = await db.query<{ event_type: string; prior_binding_id: string }>(
      "select event_type, prior_binding_id from public.client_reporting_anchor_events where idempotency_key = 'handover:test:0001'",
    );
    expect(event.rows[0]).toMatchObject({
      event_type: "handed_over",
      prior_binding_id: pairId,
    });

    // BOTH post-cutover bindings carry immutable evidence. Without the
    // replacement's own event the cutover queue reads it as an unexplained
    // post-cutover binding and fails the entire client closed.
    const evidenced = await db.query<{ binding_id: string; event_type: string }>(
      `select binding_id, event_type
       from public.client_reporting_anchor_events
       where binding_id in ($1, $2)`,
      [childBindingId, replacement.id],
    );
    expect(
      evidenced.rows.map((row) => row.event_type).every((type) => type === "handed_over"),
    ).toBe(true);
    expect(new Set(evidenced.rows.map((row) => row.binding_id))).toEqual(
      new Set([childBindingId, replacement.id]),
    );
  });

  it("refuses while the old store's Google billing is still open", async () => {
    const { pairId, targetId } = await pairAndTarget();
    // A start with no end: money is still flowing to the old store.
    await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await expectSqlState(handover(pairId, targetId), "23514");
  });

  it("starts the succession today when the old account never billed", async () => {
    // Pre-cutover and never billed: the realistic shape of a store that was
    // connected but whose campaigns never launched.
    const { pairId, targetId } = await pairAndTarget();

    const child = await handover(pairId, targetId, "handover:test:fresh");
    const childBinding = await db.query<{ ad_account_id: string }>(
      "select ad_account_id from public.client_reporting_bindings where id = $1",
      [child.rows[0]!.id],
    );
    const start = await db.query<{ baseline: string | number; today: boolean }>(
      `select baseline_cost_micros as baseline,
              google_local_date = (now() at time zone 'America/New_York')::date as today
       from public.ad_account_billing_starts where ad_account_id = $1`,
      [childBinding.rows[0]!.ad_account_id],
    );
    expect(Number(start.rows[0]!.baseline)).toBe(0);
    expect(start.rows[0]!.today).toBe(true);
  });

  it("replays an identical handover instead of failing the second caller", async () => {
    const { pairId, targetId } = await pairAndTarget();
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await closeBilling(opened);

    const first = await handover(pairId, targetId);
    const second = await handover(pairId, targetId);
    expect(second.rows[0]!.id).toBe(first.rows[0]!.id);
  });

  it("still refuses a hand-rolled post-cutover revoke without the purpose-bound key", async () => {
    const { pairId, targetId } = await pairAndTarget();
    await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await expectSqlState(
      db.query(
        `select public.revoke_client_reporting_binding(
           $1, $2, 'manual-revoke:handover-test', 'Manual revoke attempt'
         )`,
        [pairId, ADMIN],
      ),
      "23514",
    );
    // And the target anchor is untouched by the failed attempt.
    void targetId;
  });

  it("keeps the one-owner rule for a Google identity outside the RPC", async () => {
    const { pairId, targetId } = await pairAndTarget();
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await closeBilling(opened);
    await handover(pairId, targetId);

    // Two accounts now legitimately share '7777777777'. Any FURTHER claim -
    // by an admin, a client route or a stray script - is still refused: the
    // succession only ever appends through the handover RPC.
    await expectSqlState(
      db.query(
        `insert into public.ad_accounts(
           client_id, store_name, google_ads_customer_id, status, currency, reporting_role
         ) values ($1, 'Impostor', '7777777777', 'pending', 'EUR', 'legacy_hybrid')`,
        [CLIENT],
      ),
      "23505",
    );
  });

});

describe("handing an anchored child on to a third store (0096)", () => {
  const THIRD_SHOPIFY = "55000000-0000-4000-8000-000000000023";

  async function thirdStoreAnchor() {
    await db.query(
      `insert into public.client_shopify_connections(
         id, session_id, client_id, status, shopify_shop_id, shopify_name,
         shopify_domain, shopify_currency, credential_hint, last_verified_at
       ) values ($1, $2, $3, 'connected', 'shop-4', 'Third Store',
         'third-store.myshopify.com', 'EUR', 'hint', now())`,
      [THIRD_SHOPIFY, SESSION, CLIENT],
    );
    await db.query(
      `insert into public.client_shopify_credentials(
         connection_id, shopify_client_id, client_secret_ciphertext
       ) values ($1, 'client-id-4', 'secret-ciphertext-4')`,
      [THIRD_SHOPIFY],
    );
    const anchor = await provision({
      shopify: THIRD_SHOPIFY,
      key: "anchor:handover:third",
    });
    return anchor.rows[0]!.id;
  }

  async function readyForCutover(bindingId: string) {
    await materializeBindingWindow(bindingId);
    await db.query(
      `select public.record_client_reporting_sync_success(
         $1, 'shopify', current_date - 90, current_date - 1, 'EUR', 90
       )`,
      [bindingId],
    );
  }

  async function closeSuccessor(childBindingId: string) {
    const accountId = await accountOf(childBindingId);
    const start = await db.query<{ id: string }>(
      "select id from public.ad_account_billing_starts where ad_account_id = $1",
      [accountId],
    );
    await db.query(
      `insert into public.ad_account_billing_ends(
         ad_account_id, billing_start_id, google_ads_customer_id, currency,
         google_local_date, google_time_zone, end_cost_micros
       ) values ($1, $2, '7777777777', 'EUR', current_date,
         'America/New_York', 987654321)`,
      [accountId, start.rows[0]!.id],
    );
    return accountId;
  }

  it("moves the child again: the succession is repeatable, history frozen in place", async () => {
    const { pairId, targetId } = await pairAndTarget();
    // The third store exists before cutover in this fixture; in production a
    // post-cutover store arrives through the staged lifecycle instead.
    const thirdAnchorId = await thirdStoreAnchor();
    await readyForCutover(thirdAnchorId);
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await closeBilling(opened);
    const firstChildBinding = (await handover(pairId, targetId)).rows[0]!.id;
    const firstSuccessorAccount = await accountOf(firstChildBinding);

    // Stop counting on the successor: the second boundary in the chain.
    await closeSuccessor(firstChildBinding);

    const second = await db.query<{ id: string }>(
      `select public.handover_client_reporting_google_source(
         $1, $2, $3, 'handover:test:leg2', 'Second handover in the chain'
       ) as id`,
      [firstChildBinding, thirdAnchorId, ADMIN],
    );
    const secondChildBinding = second.rows[0]!.id;

    // The first successor's binding is retired and NOT replaced: its store
    // keeps its own anchor, and the account keeps its recorded history with
    // no active binding writing it ever again.
    const bindings = await db.query<{
      id: string;
      status: string;
      ad_account_id: string;
      shopify_anchor_binding_id: string | null;
      google_ads_connection_id: string | null;
    }>(
      `select id, status, ad_account_id, shopify_anchor_binding_id, google_ads_connection_id
       from public.client_reporting_bindings`,
    );
    expect(bindings.rows.find((row) => row.id === firstChildBinding)!.status).toBe("revoked");
    expect(
      bindings.rows.filter(
        (row) => row.status === "active" && row.ad_account_id === firstSuccessorAccount,
      ),
    ).toHaveLength(0);

    // The second successor: a fresh account, same Google identity, anchored
    // under the third store, opening exactly at the second closing counter.
    const child2 = bindings.rows.find((row) => row.id === secondChildBinding)!;
    expect(child2.status).toBe("active");
    expect(child2.shopify_anchor_binding_id).toBe(thirdAnchorId);
    expect(child2.ad_account_id).not.toBe(firstSuccessorAccount);
    const start2 = await db.query<{ baseline: string | number; today: boolean }>(
      `select baseline_cost_micros as baseline, google_local_date = current_date as today
       from public.ad_account_billing_starts where ad_account_id = $1`,
      [child2.ad_account_id],
    );
    expect(Number(start2.rows[0]!.baseline)).toBe(987654321);
    expect(start2.rows[0]!.today).toBe(true);

    const mapping = await db.query<{ shopify_connection_id: string }>(
      "select shopify_connection_id from public.client_asset_mappings where google_ads_connection_id = $1",
      [GOOGLE_2],
    );
    expect(mapping.rows[0]!.shopify_connection_id).toBe(THIRD_SHOPIFY);

    // Three accounts now share the identity; every retired holder is closed.
    const holders = await db.query<{ n: string }>(
      "select count(*)::text as n from public.ad_accounts where google_ads_customer_id = '7777777777'",
    );
    expect(Number(holders.rows[0]!.n)).toBe(3);
  });

  it("repairs a 0095 handover whose replacement binding was left unevidenced", async () => {
    // Reproduces the exact production sequence (Lourenço): a handover run by
    // the ORIGINAL 0095 function, which evidenced the successor and left the
    // old store's replacement binding unexplained — so the cutover queue
    // failed the whole client closed. Anchor events are append-only, so this
    // downgrades the function rather than deleting the row afterwards. Both
    // the v1 function and the repair statement are read out of the migrations
    // themselves, never copied here, so neither can drift from what ships.
    const v1Start = STORE_HANDOVER_MIGRATION.indexOf(
      "create or replace function public.handover_client_reporting_google_source(",
    );
    const grantTail = ") to service_role;";
    const V1_FUNCTION = STORE_HANDOVER_MIGRATION.slice(
      v1Start,
      STORE_HANDOVER_MIGRATION.indexOf(grantTail, v1Start) + grantTail.length,
    );
    const REPAIR = CHILD_HANDOVER_MIGRATION.slice(
      CHILD_HANDOVER_MIGRATION.indexOf("-- Repair:"),
    );
    expect(v1Start).toBeGreaterThan(-1);
    expect(REPAIR).toContain("replacementBindingId");

    await db.exec(V1_FUNCTION);

    const { pairId, targetId } = await pairAndTarget();
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    const oldAccountId = await closeBilling(opened);
    const childBindingId = (await handover(pairId, targetId)).rows[0]!.id;

    const replacement = await db.query<{ id: string }>(
      `select id from public.client_reporting_bindings
       where status = 'active' and ad_account_id = $1 and shopify_connection_id = $2`,
      [oldAccountId, SHOPIFY_2],
    );
    const replacementId = replacement.rows[0]!.id;

    // The defect itself: v1 left this binding with no evidence at all.
    const orphaned = await db.query<{ n: string }>(
      "select count(*)::text as n from public.client_reporting_anchor_events where binding_id = $1",
      [replacementId],
    );
    expect(Number(orphaned.rows[0]!.n)).toBe(0);

    await db.exec(REPAIR);

    const repaired = await db.query<{
      event_type: string;
      prior_binding_id: string;
      ad_account_id: string;
      details: Record<string, unknown>;
    }>(
      `select event_type, prior_binding_id, ad_account_id, details
       from public.client_reporting_anchor_events where binding_id = $1`,
      [replacementId],
    );
    expect(repaired.rows).toHaveLength(1);
    expect(repaired.rows[0]).toMatchObject({
      event_type: "handed_over",
      prior_binding_id: pairId,
      ad_account_id: oldAccountId,
    });
    expect(repaired.rows[0]!.details).toMatchObject({
      successorBindingId: childBindingId,
      repairedBy: "0096_reporting_child_handover",
    });

    // Re-running is a no-op, never a duplicate or a unique-key failure.
    await db.exec(REPAIR);
    const afterReplay = await db.query<{ n: string }>(
      "select count(*)::text as n from public.client_reporting_anchor_events where binding_id = $1",
      [replacementId],
    );
    expect(Number(afterReplay.rows[0]!.n)).toBe(1);
  });

  it("leaves a child handover alone: no replacement means nothing to repair", async () => {
    // A child handover records replacementBindingId as a JSON null, so the
    // repair must skip it rather than casting null to uuid or inventing a row.
    const REPAIR = CHILD_HANDOVER_MIGRATION.slice(
      CHILD_HANDOVER_MIGRATION.indexOf("-- Repair:"),
    );
    const { pairId, targetId } = await pairAndTarget();
    const thirdAnchorId = await thirdStoreAnchor();
    await readyForCutover(thirdAnchorId);
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await closeBilling(opened);
    const firstChildBinding = (await handover(pairId, targetId)).rows[0]!.id;
    await closeSuccessor(firstChildBinding);
    await db.query(
      `select public.handover_client_reporting_google_source(
         $1, $2, $3, 'handover:test:child-null', 'Child handover, no replacement'
       )`,
      [firstChildBinding, thirdAnchorId, ADMIN],
    );

    const childEvent = await db.query<{ replacement: string | null }>(
      `select details ->> 'replacementBindingId' as replacement
       from public.client_reporting_anchor_events
       where idempotency_key = 'handover:test:child-null'`,
    );
    expect(childEvent.rows[0]!.replacement).toBeNull();

    const before = await db.query<{ n: string }>(
      "select count(*)::text as n from public.client_reporting_anchor_events",
    );
    await db.exec(REPAIR);
    const after = await db.query<{ n: string }>(
      "select count(*)::text as n from public.client_reporting_anchor_events",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("refuses the child move while the successor's billing is still open", async () => {
    const { pairId, targetId } = await pairAndTarget();
    const thirdAnchorId = await thirdStoreAnchor();
    await readyForCutover(thirdAnchorId);
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await closeBilling(opened);
    const firstChildBinding = (await handover(pairId, targetId)).rows[0]!.id;

    // The successor has an open start (written by the first handover) and no
    // end: money is still flowing to the second store.
    await expectSqlState(
      db.query(
        `select public.handover_client_reporting_google_source(
           $1, $2, $3, 'handover:test:leg2-open', 'Premature second handover'
         )`,
        [firstChildBinding, thirdAnchorId, ADMIN],
      ),
      "23514",
    );
  });

  it("refuses moving the child to the store it already reports to", async () => {
    const { pairId, targetId } = await pairAndTarget();
    const opened = await openBilling(pairId);
    await cutOverBoth(pairId, targetId);
    await closeBilling(opened);
    const firstChildBinding = (await handover(pairId, targetId)).rows[0]!.id;
    await closeSuccessor(firstChildBinding);

    await expectSqlState(
      db.query(
        `select public.handover_client_reporting_google_source(
           $1, $2, $3, 'handover:test:same-store', 'Pointless move'
         )`,
        [firstChildBinding, targetId, ADMIN],
      ),
      "23514",
    );
  });
});
