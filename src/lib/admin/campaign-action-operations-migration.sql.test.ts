import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0059_campaign_action_operations.sql",
  "utf8",
);

const ADMIN = "59000000-0000-4000-8000-000000000001";
const MEMBER = "59000000-0000-4000-8000-000000000002";
const CLIENT = "59000000-0000-4000-8000-000000000003";
const GOOGLE = "59000000-0000-4000-8000-000000000010";
const SHOPIFY = "59000000-0000-4000-8000-000000000011";
const ANCHOR_ACCOUNT = "59000000-0000-4000-8000-000000000012";
const GOOGLE_ACCOUNT = "59000000-0000-4000-8000-000000000013";
const BILLING_START = "59000000-0000-4000-8000-000000000014";
const ANCHOR_BINDING = "59000000-0000-4000-8000-000000000015";
const GOOGLE_BINDING = "59000000-0000-4000-8000-000000000016";
const POLICY_1 = "59000000-0000-4000-8000-000000000020";
const POLICY_2 = "59000000-0000-4000-8000-000000000021";
const POLICY_3 = "59000000-0000-4000-8000-000000000022";
const POLICY_4 = "59000000-0000-4000-8000-000000000023";
const OPERATION_1 = "59000000-0000-4000-8000-000000000030";
const OPERATION_2 = "59000000-0000-4000-8000-000000000031";
const OPERATION_3 = "59000000-0000-4000-8000-000000000032";
const LEGACY_GOOGLE = "59000000-0000-4000-8000-000000000050";
const LEGACY_SHOPIFY = "59000000-0000-4000-8000-000000000051";
const LEGACY_ACCOUNT = "59000000-0000-4000-8000-000000000052";
const LEGACY_BILLING_START = "59000000-0000-4000-8000-000000000053";
const LEGACY_PRIOR_BINDING = "59000000-0000-4000-8000-000000000054";
const LEGACY_PAIR_BINDING = "59000000-0000-4000-8000-000000000055";
const LEGACY_POLICY = "59000000-0000-4000-8000-000000000056";

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
create function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);
create table public.portal_clients (
  id uuid primary key
);
create table public.client_rollout_states (
  client_id uuid primary key references public.portal_clients(id),
  operational_surface text not null,
  reporting_cutover_at timestamptz
);
create table public.client_google_ads_connections (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  status text not null,
  windsor_account_id text not null,
  currency text,
  time_zone text,
  last_verified_at timestamptz,
  last_error_code text
);
create table public.client_shopify_connections (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  status text not null
);
create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  google_ads_customer_id text,
  currency text not null,
  status text not null,
  reporting_role text not null
);
create table public.ad_account_billing_starts (
  id uuid primary key,
  ad_account_id uuid not null unique references public.ad_accounts(id),
  google_ads_customer_id text not null,
  google_time_zone text not null,
  currency text not null
);
create table public.ad_account_billing_ends (
  id uuid primary key,
  ad_account_id uuid not null unique references public.ad_accounts(id),
  billing_start_id uuid not null unique references public.ad_account_billing_starts(id)
);
create table public.client_reporting_bindings (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  ad_account_id uuid not null references public.ad_accounts(id),
  shopify_connection_id uuid references public.client_shopify_connections(id),
  google_ads_connection_id uuid references public.client_google_ads_connections(id),
  shopify_anchor_binding_id uuid references public.client_reporting_bindings(id),
  status text not null
);
create table public.client_reporting_anchor_events (
  id uuid primary key,
  binding_id uuid not null references public.client_reporting_bindings(id),
  prior_binding_id uuid references public.client_reporting_bindings(id),
  ad_account_id uuid not null references public.ad_accounts(id),
  event_type text not null,
  details jsonb not null default '{}'
);
create table public.client_asset_mappings (
  shopify_connection_id uuid not null references public.client_shopify_connections(id),
  google_ads_connection_id uuid not null unique references public.client_google_ads_connections(id)
);

create function public.normalize_google_ads_customer_id(p_value text)
returns text
language sql immutable strict
set search_path = public
as $$
  select nullif(regexp_replace(trim(p_value), '[^0-9]', '', 'g'), '')
$$;

create function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  )
$$;
`;

type PolicyRow = {
  id: string;
  supersedes_policy_id: string | null;
  revision: number;
  allowed_actions: string[];
  max_daily_budget_micros: number | string | null;
};

type OperationRow = {
  id: string;
  execution_claim_id: string;
  status: "requested" | "succeeded" | "failed" | "uncertain";
  client_reporting_binding_id: string;
  client_google_ads_connection_id: string;
  shopify_anchor_binding_id: string | null;
  shopify_anchor_ad_account_id: string | null;
  billing_start_id: string;
  campaign_action_policy_id: string;
  policy_revision: number;
  executor: string;
  google_ads_customer_id: string;
  google_time_zone: string;
  currency: string;
  provider_campaign_id: string;
  action: string;
  request_snapshot: Record<string, unknown>;
  request_hash: string;
  observed_status: string | null;
  observed_daily_budget_micros: number | string | null;
  result_details: Record<string, unknown> | null;
  completed_at: string | null;
};

let db: PGlite;

async function actAs(
  databaseRole: "postgres" | "authenticated" | "service_role",
  appRole = databaseRole,
  uid: string | null = null,
) {
  await db.exec("reset role");
  if (databaseRole !== "postgres") await db.exec(`set role ${databaseRole}`);
  await db.query("select set_config('test.role', $1, false)", [appRole]);
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

type PolicyOptions = {
  id?: string;
  key?: string;
  binding?: string;
  expectedPolicyId?: string | null;
  actions?: string[];
  max?: number | null;
  admin?: string;
  reason?: string;
};

async function setPolicy(options: PolicyOptions = {}) {
  const {
    id = POLICY_1,
    key = "policy:google:001",
    binding = GOOGLE_BINDING,
    expectedPolicyId = null,
    actions = ["campaign_paused", "budget_changed", "campaign_enabled"],
    max = 500_000_000,
    admin = ADMIN,
    reason = "Reviewed agency Google campaign controls",
  } = options;
  await actAs("service_role");
  const result = await db.query<{ policy: PolicyRow }>(
    `select to_jsonb(public.set_campaign_action_policy(
       $1, $2, $3, $4, $5::text[], $6, $7, $8
     )) as policy`,
    [id, key, binding, expectedPolicyId, actions, max, admin, reason],
  );
  return result.rows[0]!.policy;
}

type StartOptions = {
  id?: string;
  key?: string;
  claim?: string | null;
  client?: string;
  binding?: string;
  account?: string;
  googleConnection?: string;
  customer?: string;
  campaign?: string;
  name?: string;
  action?: "budget_changed" | "campaign_paused" | "campaign_enabled" | "campaign_launched";
  currency?: string;
  actor?: string;
  previousStatus?: string | null;
  nextStatus?: string | null;
  previousBudgetMicros?: number | null;
  nextBudgetMicros?: number | null;
  details?: Record<string, unknown>;
};

async function start(options: StartOptions = {}) {
  const operationId = options.id ?? OPERATION_1;
  const action = options.action ?? "budget_changed";
  const statusEvidence = action === "campaign_paused"
    ? ["active", "paused"]
    : action === "campaign_enabled"
      ? ["paused", "active"]
      : action === "campaign_launched"
        ? [null, "active"]
        : [null, null];
  const budgetEvidence = action === "budget_changed"
    ? [100_000_000, 150_000_000]
    : action === "campaign_launched"
      ? [null, 150_000_000]
      : [null, null];

  await actAs("service_role");
  const result = await db.query<{ operation: OperationRow }>(
    `select to_jsonb(public.start_campaign_action(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18::jsonb
     )) as operation`,
    [
      operationId,
      options.key ?? "action:google:001",
      options.claim === undefined ? operationId : options.claim,
      options.client ?? CLIENT,
      options.binding ?? GOOGLE_BINDING,
      options.account ?? GOOGLE_ACCOUNT,
      options.googleConnection ?? GOOGLE,
      options.customer ?? "1234567890",
      options.campaign ?? "987654321",
      options.name ?? "PMax - Best sellers",
      action,
      options.currency ?? "EUR",
      options.actor ?? ADMIN,
      options.previousStatus ?? statusEvidence[0],
      options.nextStatus ?? statusEvidence[1],
      options.previousBudgetMicros ?? budgetEvidence[0],
      options.nextBudgetMicros ?? budgetEvidence[1],
      JSON.stringify(options.details ?? { source: "admin_campaigns" }),
    ],
  );
  return result.rows[0]!.operation;
}

type CompleteOptions = {
  id?: string;
  key?: string;
  claim?: string | null;
  actor?: string;
  outcome?: "succeeded" | "failed" | "uncertain";
  observedStatus?: string | null;
  observedBudgetMicros?: number | null;
  details?: Record<string, unknown>;
};

async function complete(options: CompleteOptions = {}) {
  await actAs("service_role");
  const result = await db.query<{ operation: OperationRow }>(
    `select to_jsonb(public.complete_campaign_action(
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb
     )) as operation`,
    [
      options.id ?? OPERATION_1,
      options.key ?? "action:google:001",
      options.claim === undefined ? (options.id ?? OPERATION_1) : options.claim,
      options.actor ?? ADMIN,
      options.outcome ?? "succeeded",
      options.observedStatus ?? null,
      options.observedBudgetMicros ?? 150_000_000,
      JSON.stringify(options.details ?? { providerRequestId: "request-123" }),
    ],
  );
  return result.rows[0]!.operation;
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  await actAs("postgres");
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);

  await db.query(
    `insert into public.profiles(id, role) values ($1, 'admin'), ($2, 'member')`,
    [ADMIN, MEMBER],
  );
  await db.query("insert into public.portal_clients(id) values ($1)", [CLIENT]);
  await db.query(
    `insert into public.client_rollout_states(
       client_id, operational_surface, reporting_cutover_at
     ) values ($1, 'v2_active', clock_timestamp() - interval '1 day')`,
    [CLIENT],
  );
  await db.query(
    `insert into public.client_google_ads_connections(
       id, client_id, status, windsor_account_id, currency, time_zone,
       last_verified_at, last_error_code
     ) values ($1, $2, 'connected', '123-456-7890', 'EUR',
       'Europe/Lisbon', clock_timestamp(), null)`,
    [GOOGLE, CLIENT],
  );
  await db.query(
    `insert into public.client_shopify_connections(id, client_id, status)
     values ($1, $2, 'connected')`,
    [SHOPIFY, CLIENT],
  );
  await db.query(
    `insert into public.ad_accounts(
       id, client_id, google_ads_customer_id, currency, status, reporting_role
     ) values
       ($1, $3, null, 'EUR', 'active', 'shopify_anchor'),
       ($2, $3, '1234567890', 'EUR', 'active', 'google_spend')`,
    [ANCHOR_ACCOUNT, GOOGLE_ACCOUNT, CLIENT],
  );
  await db.query(
    `insert into public.ad_account_billing_starts(
       id, ad_account_id, google_ads_customer_id, google_time_zone, currency
     ) values ($1, $2, '1234567890', 'Europe/Lisbon', 'EUR')`,
    [BILLING_START, GOOGLE_ACCOUNT],
  );
  await db.query(
    `insert into public.client_reporting_bindings(
       id, client_id, ad_account_id, shopify_connection_id,
       google_ads_connection_id, shopify_anchor_binding_id, status
     ) values
       ($1, $3, $4, $5, null, null, 'active'),
       ($2, $3, $6, null, $7, $1, 'active')`,
    [
      ANCHOR_BINDING,
      GOOGLE_BINDING,
      CLIENT,
      ANCHOR_ACCOUNT,
      SHOPIFY,
      GOOGLE_ACCOUNT,
      GOOGLE,
    ],
  );
  await db.query(
    `insert into public.client_asset_mappings(
       shopify_connection_id, google_ads_connection_id
     ) values ($1, $2)`,
    [SHOPIFY, GOOGLE],
  );
});

describe("0059 campaign action operations", () => {
  it("indexes the two deterministic succeeded-history access paths", async () => {
    const result = await db.query<{ indexname: string }>(
      `select indexname
       from pg_indexes
       where schemaname = 'public'
         and indexname in (
           'campaign_action_operations_binding_budget_history_idx',
           'campaign_action_operations_client_activity_idx'
         )
       order by indexname`,
    );
    expect(result.rows.map((row) => row.indexname)).toEqual([
      "campaign_action_operations_binding_budget_history_idx",
      "campaign_action_operations_client_activity_idx",
    ]);
  });

  it("defaults to deny, then records the exact V2 binding and policy snapshot", async () => {
    await expectSqlState(start(), "42501");

    await actAs("postgres");
    await db.query(
      "update public.ad_account_billing_starts set google_time_zone = 'UTC' where id = $1",
      [BILLING_START],
    );
    await expectSqlState(setPolicy(), "23514");
    await actAs("postgres");
    await db.query(
      "update public.ad_account_billing_starts set google_time_zone = 'Europe/Lisbon' where id = $1",
      [BILLING_START],
    );

    const policy = await setPolicy();
    expect(policy).toMatchObject({
      revision: 1,
      supersedes_policy_id: null,
      allowed_actions: ["budget_changed", "campaign_enabled", "campaign_paused"],
    });

    const operation = await start();
    expect(operation).toMatchObject({
      id: OPERATION_1,
      execution_claim_id: OPERATION_1,
      status: "requested",
      client_reporting_binding_id: GOOGLE_BINDING,
      client_google_ads_connection_id: GOOGLE,
      shopify_anchor_binding_id: ANCHOR_BINDING,
      shopify_anchor_ad_account_id: ANCHOR_ACCOUNT,
      billing_start_id: BILLING_START,
      campaign_action_policy_id: POLICY_1,
      policy_revision: 1,
      executor: "agency_google",
      google_ads_customer_id: "1234567890",
      google_time_zone: "Europe/Lisbon",
      currency: "EUR",
      provider_campaign_id: "987654321",
      action: "budget_changed",
      completed_at: null,
    });
    expect(operation.request_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(operation.request_snapshot).toMatchObject({
      schema: "campaign-action-request-v1",
      executionClaimId: OPERATION_1,
      reportingCutoverAt: expect.any(String),
      policy: {
        id: POLICY_1,
        revision: 1,
        maxDailyBudgetMicros: 500_000_000,
      },
    });
    const hash = await db.query<{ exact: boolean }>(
      `select request_hash = md5(request_snapshot::text) as exact
       from public.campaign_action_operations where id = $1`,
      [OPERATION_1],
    );
    expect(hash.rows[0]?.exact).toBe(true);
  });

  it("allows a legacy_hybrid pair only with the exact immutable 0055 upgrade proof", async () => {
    await actAs("postgres");
    await db.query(
      `insert into public.client_google_ads_connections(
         id, client_id, status, windsor_account_id, currency, time_zone,
         last_verified_at, last_error_code
       ) values ($1, $2, 'connected', '222-222-2222', 'EUR',
         'Europe/Lisbon', clock_timestamp(), null)`,
      [LEGACY_GOOGLE, CLIENT],
    );
    await db.query(
      `insert into public.client_shopify_connections(id, client_id, status)
       values ($1, $2, 'connected')`,
      [LEGACY_SHOPIFY, CLIENT],
    );
    await db.query(
      `insert into public.ad_accounts(
         id, client_id, google_ads_customer_id, currency, status, reporting_role
       ) values ($1, $2, '2222222222', 'EUR', 'active', 'legacy_hybrid')`,
      [LEGACY_ACCOUNT, CLIENT],
    );
    await db.query(
      `insert into public.ad_account_billing_starts(
         id, ad_account_id, google_ads_customer_id, google_time_zone, currency
       ) values ($1, $2, '2222222222', 'Europe/Lisbon', 'EUR')`,
      [LEGACY_BILLING_START, LEGACY_ACCOUNT],
    );
    await db.query(
      `insert into public.client_reporting_bindings(
         id, client_id, ad_account_id, shopify_connection_id,
         google_ads_connection_id, shopify_anchor_binding_id, status
       ) values
         ($1, $3, $4, null, $5, null, 'revoked'),
         ($2, $3, $4, $6, $5, null, 'active')`,
      [
        LEGACY_PRIOR_BINDING,
        LEGACY_PAIR_BINDING,
        CLIENT,
        LEGACY_ACCOUNT,
        LEGACY_GOOGLE,
        LEGACY_SHOPIFY,
      ],
    );

    await expectSqlState(
      setPolicy({
        id: LEGACY_POLICY,
        key: "policy:legacy:001",
        binding: LEGACY_PAIR_BINDING,
      }),
      "23514",
    );

    await actAs("postgres");
    await db.query(
      `insert into public.client_reporting_anchor_events(
         id, binding_id, prior_binding_id, ad_account_id, event_type, details
       ) values (
         $1, $2, $3, $4, 'upgraded',
         jsonb_build_object(
           'shopifyConnectionId', $5::uuid,
           'googleAdsConnectionId', $6::uuid
         )
       )`,
      [
        "59000000-0000-4000-8000-000000000057",
        LEGACY_PAIR_BINDING,
        LEGACY_PRIOR_BINDING,
        LEGACY_ACCOUNT,
        LEGACY_SHOPIFY,
        LEGACY_GOOGLE,
      ],
    );
    await setPolicy({
      id: LEGACY_POLICY,
      key: "policy:legacy:001",
      binding: LEGACY_PAIR_BINDING,
    });
    const operation = await start({
      id: OPERATION_3,
      key: "action:legacy:001",
      binding: LEGACY_PAIR_BINDING,
      account: LEGACY_ACCOUNT,
      googleConnection: LEGACY_GOOGLE,
      customer: "2222222222",
      campaign: "333",
    });
    expect(operation).toMatchObject({
      client_reporting_binding_id: LEGACY_PAIR_BINDING,
      shopify_anchor_binding_id: LEGACY_PAIR_BINDING,
      shopify_anchor_ad_account_id: LEGACY_ACCOUNT,
      campaign_action_policy_id: LEGACY_POLICY,
    });
  });

  it("appends policies with an idempotent CAS and an empty revision disables writes", async () => {
    const first = await setPolicy();
    expect(await setPolicy()).toEqual(first);
    await expectSqlState(
      setPolicy({ id: POLICY_2, key: "policy:google:001" }),
      "23505",
    );
    await expectSqlState(
      setPolicy({
        id: POLICY_2,
        key: "policy:google:002",
        expectedPolicyId: null,
      }),
      "40001",
    );

    const disabled = await setPolicy({
      id: POLICY_2,
      key: "policy:google:002",
      expectedPolicyId: POLICY_1,
      actions: [],
      max: null,
      reason: "Disable campaign writes for this binding",
    });
    expect(disabled).toMatchObject({
      revision: 2,
      supersedes_policy_id: POLICY_1,
      allowed_actions: [],
      max_daily_budget_micros: null,
    });
    expect(await setPolicy({
      id: POLICY_2,
      key: "policy:google:002",
      expectedPolicyId: POLICY_1,
      actions: [],
      max: null,
      reason: "Disable campaign writes for this binding",
    })).toEqual(disabled);
    await expectSqlState(
      setPolicy({
        id: POLICY_2,
        key: "policy:google:002",
        expectedPolicyId: null,
        actions: [],
        max: null,
        reason: "Disable campaign writes for this binding",
      }),
      "23505",
    );
    await expectSqlState(start(), "42501");

    const reenabled = await setPolicy({
      id: POLICY_3,
      key: "policy:google:003",
      expectedPolicyId: POLICY_2,
      reason: "Re-enable reviewed campaign writes",
    });
    expect(reenabled).toMatchObject({
      revision: 3,
      supersedes_policy_id: POLICY_2,
    });
    await expectSqlState(
      setPolicy({
        id: POLICY_4,
        key: "policy:google:004",
        expectedPolicyId: POLICY_2,
        reason: "Concurrent stale campaign policy review",
      }),
      "40001",
    );
    expect(await setPolicy({
      id: POLICY_2,
      key: "policy:google:002",
      expectedPolicyId: POLICY_1,
      actions: [],
      max: null,
      reason: "Disable campaign writes for this binding",
    })).toEqual(disabled);

    await actAs("postgres", "service_role");
    await expectSqlState(
      db.query(
        "update public.campaign_action_policies set reason = 'Manufactured edit' where id = $1",
        [POLICY_1],
      ),
      "23514",
    );
    await expectSqlState(
      db.query("delete from public.campaign_action_policies where id = $1", [POLICY_1]),
      "23514",
    );
  });

  it("requires the exact marker, healthy source, active account and open billing start", async () => {
    await setPolicy();

    await actAs("postgres");
    await db.query(
      "update public.client_rollout_states set operational_surface = 'rollback_legacy' where client_id = $1",
      [CLIENT],
    );
    await expectSqlState(start(), "23514");
    await actAs("postgres");
    await db.query(
      "update public.client_rollout_states set operational_surface = 'v2_active' where client_id = $1",
      [CLIENT],
    );
    await db.query(
      "update public.client_google_ads_connections set last_error_code = 'provider_error' where id = $1",
      [GOOGLE],
    );
    await expectSqlState(start(), "23514");
    await actAs("postgres");
    await db.query(
      "update public.client_google_ads_connections set last_error_code = null where id = $1",
      [GOOGLE],
    );
    await db.query(
      "update public.ad_accounts set status = 'suspended' where id = $1",
      [GOOGLE_ACCOUNT],
    );
    await expectSqlState(start(), "23514");
    await actAs("postgres");
    await db.query("update public.ad_accounts set status = 'active' where id = $1", [GOOGLE_ACCOUNT]);
    await db.query(
      "update public.ad_account_billing_starts set google_time_zone = 'UTC' where id = $1",
      [BILLING_START],
    );
    await expectSqlState(start(), "23514");
    await actAs("postgres");
    await db.query(
      "update public.ad_account_billing_starts set google_time_zone = 'Europe/Lisbon' where id = $1",
      [BILLING_START],
    );
    await db.query(
      "insert into public.ad_account_billing_ends(id, ad_account_id, billing_start_id) values ($1, $2, $3)",
      ["59000000-0000-4000-8000-000000000040", GOOGLE_ACCOUNT, BILLING_START],
    );
    await expectSqlState(start(), "23514");
  });

  it("enforces service/admin authority, policy cap and current action shapes", async () => {
    await setPolicy({ max: 200_000_000 });

    await expectSqlState(
      start({ nextBudgetMicros: 250_000_000 }),
      "42501",
    );
    await expectSqlState(
      start({ nextBudgetMicros: 150_000_000.5 }),
      "22023",
    );
    await expectSqlState(start({ action: "campaign_launched" }), "22023");
    await expectSqlState(start({ actor: MEMBER }), "42501");

    await actAs("authenticated", "authenticated", ADMIN);
    await expectSqlState(
      db.query(
        `select public.start_campaign_action(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          null, null, $14, $15, '{}'::jsonb
        )`,
        [
          OPERATION_1,
          "action:google:001",
          OPERATION_1,
          CLIENT,
          GOOGLE_BINDING,
          GOOGLE_ACCOUNT,
          GOOGLE,
          "1234567890",
          "987654321",
          "PMax - Best sellers",
          "budget_changed",
          "EUR",
          ADMIN,
          100_000_000,
          150_000_000,
        ],
      ),
      "42501",
    );

    const paused = await start({
      action: "campaign_paused",
      campaign: "111",
      id: OPERATION_1,
      key: "action:google:pause",
    });
    expect(paused.action).toBe("campaign_paused");
    await complete({
      id: OPERATION_1,
      key: "action:google:pause",
      observedStatus: "paused",
      observedBudgetMicros: null,
    });
    const enabled = await start({
      action: "campaign_enabled",
      campaign: "222",
      id: OPERATION_2,
      key: "action:google:enable",
    });
    expect(enabled.action).toBe("campaign_enabled");
  });

  it("is idempotent, rejects key drift and permits the next request only after terminal", async () => {
    await setPolicy();
    await expectSqlState(start({ claim: null }), "22023");
    const first = await start();
    expect(await start()).toEqual(first);
    expect(await start({ claim: OPERATION_2 })).toEqual(first);
    expect(first.execution_claim_id).toBe(OPERATION_1);
    await expectSqlState(start({ key: "action:google:changed" }), "23505");
    await expectSqlState(
      start({ id: OPERATION_2, key: "action:google:002" }),
      "23505",
    );

    await expectSqlState(complete({ claim: null }), "22023");
    await expectSqlState(complete({ claim: OPERATION_2 }), "42501");
    await complete();
    await expectSqlState(
      start({ id: OPERATION_2, key: "action:google:002", claim: OPERATION_1 }),
      "23505",
    );
    const next = await start({ id: OPERATION_2, key: "action:google:002" });
    expect(next.status).toBe("requested");
  });

  it("seals exact terminal evidence after a billing-end race and never mutates it again", async () => {
    await setPolicy();
    await start();

    await actAs("postgres");
    await db.query(
      "insert into public.ad_account_billing_ends(id, ad_account_id, billing_start_id) values ($1, $2, $3)",
      ["59000000-0000-4000-8000-000000000040", GOOGLE_ACCOUNT, BILLING_START],
    );

    const sealed = await complete();
    expect(sealed).toMatchObject({
      status: "succeeded",
      observed_daily_budget_micros: 150_000_000,
      result_details: { providerRequestId: "request-123" },
      completed_at: expect.any(String),
    });
    expect(await complete()).toEqual(sealed);
    await expectSqlState(
      complete({ details: { providerRequestId: "different" } }),
      "23514",
    );

    await actAs("postgres", "service_role");
    await expectSqlState(
      db.query(
        "update public.campaign_action_operations set result_details = '{}' where id = $1",
        [OPERATION_1],
      ),
      "23514",
    );
    await expectSqlState(
      db.query("delete from public.campaign_action_operations where id = $1", [OPERATION_1]),
      "23514",
    );
  });

  it("records failed and uncertain as immutable terminal outcomes", async () => {
    await setPolicy();
    await start({ id: OPERATION_1, key: "action:google:failed", campaign: "111" });
    await start({ id: OPERATION_2, key: "action:google:uncertain", campaign: "222" });

    const failed = await complete({
      id: OPERATION_1,
      key: "action:google:failed",
      outcome: "failed",
      observedBudgetMicros: null,
      details: { errorCode: "provider_rejected" },
    });
    const uncertain = await complete({
      id: OPERATION_2,
      key: "action:google:uncertain",
      outcome: "uncertain",
      observedBudgetMicros: null,
      details: { errorCode: "verification_unavailable" },
    });
    expect(failed.status).toBe("failed");
    expect(uncertain.status).toBe("uncertain");
  });

  it("rejects nested secrets and oversized request or result details", async () => {
    await setPolicy();
    await expectSqlState(
      start({ details: { nested: [{ access_token: "never-store" }] } }),
      "22023",
    );
    await expectSqlState(
      start({ details: { note: "x".repeat(9_000) } }),
      "22023",
    );

    await start();
    await expectSqlState(
      complete({ details: { provider: { clientSecret: "never-store" } } }),
      "22023",
    );
  });

  it("allows authenticated admins to read operations but grants no browser writes or policy access", async () => {
    await setPolicy();
    await start();

    await actAs("authenticated", "authenticated", ADMIN);
    const adminRows = await db.query<{ id: string }>(
      "select id from public.campaign_action_operations",
    );
    expect(adminRows.rows.map((row) => row.id)).toEqual([OPERATION_1]);

    const privileges = await db.query<{
      operation_select: boolean;
      operation_insert: boolean;
      operation_update: boolean;
      operation_delete: boolean;
      policy_select: boolean;
      start_execute: boolean;
      complete_execute: boolean;
    }>(`select
      has_table_privilege('authenticated', 'public.campaign_action_operations', 'select') as operation_select,
      has_table_privilege('authenticated', 'public.campaign_action_operations', 'insert') as operation_insert,
      has_table_privilege('authenticated', 'public.campaign_action_operations', 'update') as operation_update,
      has_table_privilege('authenticated', 'public.campaign_action_operations', 'delete') as operation_delete,
      has_table_privilege('authenticated', 'public.campaign_action_policies', 'select') as policy_select,
      has_function_privilege(
        'authenticated',
        'public.start_campaign_action(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,text,text,numeric,numeric,jsonb)',
        'execute'
      ) as start_execute,
      has_function_privilege(
        'authenticated',
        'public.complete_campaign_action(uuid,text,uuid,uuid,text,text,numeric,jsonb)',
        'execute'
      ) as complete_execute`);
    expect(privileges.rows[0]).toEqual({
      operation_select: true,
      operation_insert: false,
      operation_update: false,
      operation_delete: false,
      policy_select: false,
      start_execute: false,
      complete_execute: false,
    });

    await actAs("authenticated", "authenticated", MEMBER);
    const memberRows = await db.query<{ id: string }>(
      "select id from public.campaign_action_operations",
    );
    expect(memberRows.rows).toEqual([]);

    await actAs("postgres");
    const foreignKeys = await db.query<{ non_restrict: number }>(`
      select count(*) filter (where entry.confdeltype <> 'r')::integer as non_restrict
      from pg_constraint entry
      where entry.contype = 'f'
        and entry.conrelid in (
          'public.campaign_action_policies'::regclass,
          'public.campaign_action_operations'::regclass
        )
    `);
    expect(foreignKeys.rows[0]?.non_restrict).toBe(0);
    await expectSqlState(
      db.query("delete from public.ad_account_billing_starts where id = $1", [BILLING_START]),
      "23001",
    );
  });
});
