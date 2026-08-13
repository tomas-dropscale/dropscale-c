import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const BASE_MIGRATION = [
  "supabase/migrations/0044_client_onboarding_v2.sql",
  "supabase/migrations/0046_client_shopify_reconnect_targets.sql",
  "supabase/migrations/0047_legacy_shopify_disconnect.sql",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const PARALLEL_MIGRATION = readFileSync(
  "supabase/migrations/0048_parallel_client_asset_invitations.sql",
  "utf8",
);
const MIGRATION = `${BASE_MIGRATION}\n${PARALLEL_MIGRATION}`;

const ADMIN = "48000000-0000-4000-8000-000000000001";
const USER = "48000000-0000-4000-8000-000000000002";
const LEGACY = "48000000-0000-4000-8000-000000000003";
const RECONNECT = "48000000-0000-4000-8000-000000000004";
const GOOGLE_SESSION = "48000000-0000-4000-8000-000000000005";
const EXTRA_SESSION = "48000000-0000-4000-8000-000000000006";
const COMBINED_SESSION = "48000000-0000-4000-8000-000000000007";
const HISTORY_SESSION = "48000000-0000-4000-8000-000000000008";
const SHOPIFY_CONNECTION = "48000000-0000-4000-8000-000000000009";
const LEGACY_B = "48000000-0000-4000-8000-000000000010";
const RECONNECT_B = "48000000-0000-4000-8000-000000000011";
const SHOPIFY_CONNECTION_B = "48000000-0000-4000-8000-000000000012";
const GOOGLE_CONNECTION = "48000000-0000-4000-8000-000000000013";
const GOOGLE_CONNECTION_B = "48000000-0000-4000-8000-000000000014";
const RECONNECT_TOKEN = "a".repeat(64);
const GOOGLE_TOKEN = "b".repeat(64);
const EXTRA_TOKEN = "c".repeat(64);
const COMBINED_TOKEN = "d".repeat(64);
const ROTATED_TOKEN = "e".repeat(64);
const RECONNECT_TOKEN_B = "f".repeat(64);
const DOMAIN = "parallel-store.myshopify.com";
const DOMAIN_B = "second-parallel-store.myshopify.com";
const SHOP_ID = "gid://shopify/Shop/480";
const SHOPIFY_SCOPES = [
  "read_all_orders",
  "read_analytics",
  "read_inventory",
  "read_locations",
  "read_orders",
  "read_products",
  "read_reports",
  "read_returns",
  "read_shopify_payments_accounts",
  "read_shopify_payments_payouts",
];

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
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz
);
create table public.profiles (
  id uuid primary key references auth.users(id),
  role text not null
);
create table public.portal_clients (
  id uuid primary key references auth.users(id),
  full_name text not null,
  email text not null,
  approval_status text not null default 'pending',
  approved_at timestamptz,
  approved_by uuid references auth.users(id)
);
create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  store_name text not null,
  status text not null default 'active',
  currency text not null default 'EUR',
  shopify_url text,
  shopify_connected boolean not null default false,
  shopify_client_id text,
  shopify_scopes text,
  shopify_admin_token text,
  shopify_token_last4 text,
  shopify_connected_at timestamptz
);
create table public.account_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  status text not null default 'pending'
);
alter table public.ad_accounts enable row level security;
alter table public.account_requests enable row level security;
create or replace function public.is_admin() returns boolean
language sql stable as $$ select auth.uid() = '${ADMIN}'::uuid $$;
create or replace function public.can_open_workspace(p_client_id uuid) returns boolean
language sql stable as $$ select p_client_id = auth.uid() $$;
create or replace function public.is_client_member(p_client_id uuid) returns boolean
language sql stable as $$ select p_client_id = auth.uid() $$;
`;

let db: PGlite;

async function actAs(userId: string | null, role: string) {
  await db.query(
    "select set_config('test.uid', $1, false), set_config('test.role', $2, false)",
    [userId ?? "", role],
  );
}

async function createReconnect(
  sessionId = RECONNECT,
  tokenHash = RECONNECT_TOKEN,
  targetId = LEGACY,
) {
  return db.query(
    `select public.create_client_shopify_reconnect_invitation(
       $1, 'legacy', $2, $3, now() + interval '1 day', $4
     ) as id`,
    [sessionId, targetId, tokenHash, ADMIN],
  );
}

async function createOnboardingReconnect() {
  return db.query(
    `select public.create_client_shopify_reconnect_invitation(
       $1, 'onboarding', $2, $3, now() + interval '1 day', $4
     ) as id`,
    [RECONNECT, SHOPIFY_CONNECTION, RECONNECT_TOKEN, ADMIN],
  );
}

async function createAssets(
  sessionId: string,
  tokenHash: string,
  assets: string[],
) {
  return db.query(
    `select public.create_client_onboarding_invitation(
       $1, 'add_assets', $2::text[], $3, $4,
       now() + interval '1 day', $5
     ) as id`,
    [sessionId, assets, USER, tokenHash, ADMIN],
  );
}

async function claim(sessionId: string, tokenHash: string) {
  return db.query(
    `select public.claim_client_onboarding_identity(
       $1, $2, $3, 'Parallel', 'Client', 'parallel@example.com'
     ) as id`,
    [sessionId, tokenHash, USER],
  );
}

async function completeReconnect() {
  return db.query(
    `select public.complete_client_shopify_connection(
       $1, $2, $3, $4, 'Parallel Store', $5, null, 'EUR',
       'shopify-client-id', 'cdef', $6::text[], 'encrypted-shopify-secret'
     ) as id`,
    [
      SHOPIFY_CONNECTION,
      RECONNECT,
      RECONNECT_TOKEN,
      SHOP_ID,
      DOMAIN,
      SHOPIFY_SCOPES,
    ],
  );
}

async function connectGoogle() {
  return db.query<{ id: string }>(
    `select public.upsert_client_google_ads_connection(
       $1, $2, '4801234567', 'Parallel Ads', 'EUR',
       'Europe/Lisbon', 'source-480'
     ) as id`,
    [GOOGLE_SESSION, GOOGLE_TOKEN],
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
    `insert into auth.users (id, email, email_confirmed_at)
     values ($1, 'admin@example.com', now()),
            ($2, 'parallel@example.com', now())`,
    [ADMIN, USER],
  );
  await db.query(
    `insert into public.profiles (id, role)
     values ($1, 'admin'), ($2, 'member')`,
    [ADMIN, USER],
  );
  await db.query(
    `insert into public.portal_clients (id, full_name, email, approval_status)
     values ($1, 'Parallel Client', 'parallel@example.com', 'approved')`,
    [USER],
  );
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, shopify_url, shopify_connected,
       shopify_client_id, shopify_admin_token, shopify_token_last4,
       shopify_connected_at
     ) values (
       $1, $2, 'Parallel Store', $3, true,
       'legacy-client-id', 'legacy-secret', 'cdef', now()
     ), (
       $4, $2, 'Second Parallel Store', $5, true,
       'legacy-client-id-b', 'legacy-secret-b', 'abcd', now()
     )`,
    [LEGACY, USER, DOMAIN, LEGACY_B, DOMAIN_B],
  );
  await actAs(null, "service_role");
});

describe("parallel client asset invitations migration", () => {
  it("allows distinct reconnect targets and disjoint generic slots", async () => {
    await createReconnect();
    await createReconnect(RECONNECT_B, RECONNECT_TOKEN_B, LEGACY_B);
    await createAssets(GOOGLE_SESSION, GOOGLE_TOKEN, ["google_ads"]);
    await createAssets(EXTRA_SESSION, EXTRA_TOKEN, ["shopify"]);

    const open = await db.query<{
      id: string;
      mode: string;
      requested_assets: string[];
    }>(
      `select id, mode, requested_assets
       from public.client_onboarding_sessions
       where target_client_id = $1
       order by id`,
      [USER],
    );
    expect(open.rows).toEqual([
      { id: RECONNECT, mode: "reconnect", requested_assets: ["shopify"] },
      {
        id: GOOGLE_SESSION,
        mode: "add_assets",
        requested_assets: ["google_ads"],
      },
      {
        id: EXTRA_SESSION,
        mode: "add_assets",
        requested_assets: ["shopify"],
      },
      { id: RECONNECT_B, mode: "reconnect", requested_assets: ["shopify"] },
    ]);

    await expect(
      createReconnect(COMBINED_SESSION, COMBINED_TOKEN),
    ).rejects.toThrow(/unique constraint|duplicate key/i);
    await expect(
      createAssets(COMBINED_SESSION, COMBINED_TOKEN, ["shopify"]),
    ).rejects.toThrow(/unique constraint|duplicate key/i);
    await expect(
      createAssets(COMBINED_SESSION, COMBINED_TOKEN, ["google_ads"]),
    ).rejects.toThrow(/unique constraint|duplicate key/i);
    await expect(
      createAssets(COMBINED_SESSION, COMBINED_TOKEN, ["shopify", "google_ads"]),
    ).rejects.toThrow(/unique constraint|duplicate key/i);

    const indexes = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and indexname like 'client_onboarding_one_open_%'
       order by indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "client_onboarding_one_open_google_ads_slot_idx",
      "client_onboarding_one_open_new_identity_idx",
      "client_onboarding_one_open_reconnect_legacy_target_idx",
      "client_onboarding_one_open_reconnect_shopify_target_idx",
      "client_onboarding_one_open_shopify_add_slot_idx",
    ]);
  });

  it("lets a combined add-assets link coexist with exact reconnects only", async () => {
    await createAssets(COMBINED_SESSION, COMBINED_TOKEN, [
      "shopify",
      "google_ads",
    ]);
    await createReconnect();
    await createReconnect(RECONNECT_B, RECONNECT_TOKEN_B, LEGACY_B);

    await expect(
      createAssets(EXTRA_SESSION, EXTRA_TOKEN, ["shopify"]),
    ).rejects.toThrow(/unique constraint|duplicate key/i);
    await expect(
      createAssets(EXTRA_SESSION, EXTRA_TOKEN, ["google_ads"]),
    ).rejects.toThrow(/unique constraint|duplicate key/i);
    await expect(
      createAssets(EXTRA_SESSION, EXTRA_TOKEN, ["shopify", "google_ads"]),
    ).rejects.toThrow(/unique constraint|duplicate key/i);

    const open = await db.query<{ count: string }>(
      `select count(*)::text as count
       from public.client_onboarding_sessions
       where target_client_id = $1
         and status in ('pending', 'collecting')`,
      [USER],
    );
    expect(open.rows[0]).toEqual({ count: "3" });
  });

  it("rotates and revokes one link without changing its open sibling", async () => {
    await createReconnect();
    await createAssets(GOOGLE_SESSION, GOOGLE_TOKEN, ["google_ads"]);

    await db.query(
      `select public.rotate_client_onboarding_invitation(
         $1, $2, now() + interval '2 days', $3
       )`,
      [RECONNECT, ROTATED_TOKEN, ADMIN],
    );
    let sessions = await db.query<{
      id: string;
      status: string;
      invite_token_hash: string | null;
    }>(
      `select id, status, invite_token_hash
       from public.client_onboarding_sessions
       where id = any($1::uuid[])
       order by id`,
      [[RECONNECT, GOOGLE_SESSION]],
    );
    expect(sessions.rows).toEqual([
      { id: RECONNECT, status: "pending", invite_token_hash: ROTATED_TOKEN },
      { id: GOOGLE_SESSION, status: "pending", invite_token_hash: GOOGLE_TOKEN },
    ]);

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      RECONNECT,
      ADMIN,
    ]);
    sessions = await db.query(
      `select id, status, invite_token_hash
       from public.client_onboarding_sessions
       where id = any($1::uuid[])
       order by id`,
      [[RECONNECT, GOOGLE_SESSION]],
    );
    expect(sessions.rows).toEqual([
      { id: RECONNECT, status: "revoked", invite_token_hash: null },
      { id: GOOGLE_SESSION, status: "pending", invite_token_hash: GOOGLE_TOKEN },
    ]);
    const rollout = await db.query<{
      operational_surface: string;
      onboarding_session_id: string | null;
    }>(
      `select operational_surface, onboarding_session_id
       from public.client_rollout_states where client_id = $1`,
      [USER],
    );
    expect(rollout.rows[0]).toEqual({
      operational_surface: "v2_onboarding",
      onboarding_session_id: GOOGLE_SESSION,
    });
  });

  it("removes mappings by owned asset when an invitation is revoked", async () => {
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, mode, requested_assets, status, target_client_id, claimed_user_id,
         first_name, last_name, email, created_by, submitted_at,
         reviewed_at, reviewed_by
       ) values (
         $1, 'add_assets', array['shopify', 'google_ads'], 'reviewed', $2, $2,
         'Parallel', 'Client', 'parallel@example.com', $3, now(), now(), $3
       )`,
      [HISTORY_SESSION, USER, ADMIN],
    );
    await createAssets(COMBINED_SESSION, COMBINED_TOKEN, [
      "shopify",
      "google_ads",
    ]);
    await claim(COMBINED_SESSION, COMBINED_TOKEN);
    await db.query(
      `insert into public.client_shopify_connections (
         id, session_id, client_id, shopify_shop_id, shopify_name,
         shopify_domain, shopify_currency, credential_hint
       ) values
         ($1, $2, $3, $4, 'Current Store', $5, 'EUR', 'cdef'),
         ($6, $7, $3, $8, 'Older Store', $9, 'EUR', 'abcd')`,
      [
        SHOPIFY_CONNECTION,
        COMBINED_SESSION,
        USER,
        SHOP_ID,
        DOMAIN,
        SHOPIFY_CONNECTION_B,
        HISTORY_SESSION,
        "gid://shopify/Shop/481",
        DOMAIN_B,
      ],
    );
    await db.query(
      `insert into public.client_google_ads_connections (
         id, session_id, client_id, windsor_account_id, account_name, currency
       ) values
         ($1, $2, $3, '480-current', 'Current Ads', 'EUR'),
         ($4, $5, $3, '480-older', 'Older Ads', 'EUR')`,
      [
        GOOGLE_CONNECTION,
        COMBINED_SESSION,
        USER,
        GOOGLE_CONNECTION_B,
        HISTORY_SESSION,
      ],
    );
    await db.query(
      `insert into public.client_asset_mappings (
         session_id, shopify_connection_id, google_ads_connection_id
       ) values ($1, $2, $3), ($1, $4, $5)`,
      [
        COMBINED_SESSION,
        SHOPIFY_CONNECTION,
        GOOGLE_CONNECTION_B,
        SHOPIFY_CONNECTION_B,
        GOOGLE_CONNECTION,
      ],
    );

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      COMBINED_SESSION,
      ADMIN,
    ]);

    const mappings = await db.query<{ count: number }>(
      "select count(*)::int as count from public.client_asset_mappings",
    );
    const shopify = await db.query<{ id: string; status: string }>(
      `select id, status from public.client_shopify_connections
       where id = any($1::uuid[]) order by id`,
      [[SHOPIFY_CONNECTION, SHOPIFY_CONNECTION_B]],
    );
    const google = await db.query<{ id: string; status: string }>(
      `select id, status from public.client_google_ads_connections
       where id = any($1::uuid[]) order by id`,
      [[GOOGLE_CONNECTION, GOOGLE_CONNECTION_B]],
    );
    expect(mappings.rows[0]).toEqual({ count: 0 });
    expect(shopify.rows).toEqual([
      { id: SHOPIFY_CONNECTION, status: "revoked" },
      { id: SHOPIFY_CONNECTION_B, status: "connected" },
    ]);
    expect(google.rows).toEqual([
      { id: GOOGLE_CONNECTION, status: "revoked" },
      { id: GOOGLE_CONNECTION_B, status: "connected" },
    ]);
  });

  it("keeps the open sibling as rollout pointer and only maps its asset after submission", async () => {
    await createReconnect();
    await createAssets(GOOGLE_SESSION, GOOGLE_TOKEN, ["google_ads"]);
    await claim(RECONNECT, RECONNECT_TOKEN);
    await claim(GOOGLE_SESSION, GOOGLE_TOKEN);
    await completeReconnect();
    const google = await connectGoogle();
    const mappings = JSON.stringify([
      {
        shopifyConnectionId: SHOPIFY_CONNECTION,
        googleAdsConnectionId: google.rows[0].id,
      },
    ]);

    await expect(
      db.query(
        "select public.replace_client_asset_mappings($1, $2, $3::jsonb)",
        [GOOGLE_SESSION, GOOGLE_TOKEN, mappings],
      ),
    ).rejects.toThrow(/another open onboarding session/i);

    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      RECONNECT,
      RECONNECT_TOKEN,
    ]);
    const state = await db.query<{
      reconnect_status: string;
      google_status: string;
      google_token: string | null;
      operational_surface: string;
      onboarding_session_id: string | null;
    }>(
      `select reconnect.status as reconnect_status,
              google.status as google_status,
              google.invite_token_hash as google_token,
              rollout.operational_surface,
              rollout.onboarding_session_id
       from public.client_onboarding_sessions reconnect
       join public.client_onboarding_sessions google on google.id = $2
       join public.client_rollout_states rollout on rollout.client_id = $3
       where reconnect.id = $1`,
      [RECONNECT, GOOGLE_SESSION, USER],
    );
    expect(state.rows[0]).toEqual({
      reconnect_status: "submitted",
      google_status: "collecting",
      google_token: GOOGLE_TOKEN,
      operational_surface: "v2_onboarding",
      onboarding_session_id: GOOGLE_SESSION,
    });

    const mapped = await db.query<{ count: number }>(
      "select public.replace_client_asset_mappings($1, $2, $3::jsonb) as count",
      [GOOGLE_SESSION, GOOGLE_TOKEN, mappings],
    );
    expect(mapped.rows[0]).toEqual({ count: 1 });
  });

  it("prefers an older open sibling over newer completed history after cancellation", async () => {
    await createAssets(GOOGLE_SESSION, GOOGLE_TOKEN, ["google_ads"]);
    await createReconnect();
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, mode, requested_assets, status, target_client_id, claimed_user_id,
         first_name, last_name, email, created_by, created_at, updated_at,
         submitted_at, reviewed_at, reviewed_by
       ) values (
         $1, 'add_assets', array['shopify'], 'reviewed', $2, $2,
         'Parallel', 'Client', 'parallel@example.com', $3,
         now() + interval '1 day', now(), now(), now(), $3
       )`,
      [HISTORY_SESSION, USER, ADMIN],
    );

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      RECONNECT,
      ADMIN,
    ]);
    const rollout = await db.query<{
      operational_surface: string;
      onboarding_session_id: string | null;
    }>(
      `select operational_surface, onboarding_session_id
       from public.client_rollout_states where client_id = $1`,
      [USER],
    );
    expect(rollout.rows[0]).toEqual({
      operational_surface: "v2_onboarding",
      onboarding_session_id: GOOGLE_SESSION,
    });
  });

  it("preserves an already-issued reconnect invitation byte-for-byte", async () => {
    await db.exec("drop schema if exists public cascade; create schema public;");
    await db.exec("drop schema if exists auth cascade;");
    await db.exec(PRELUDE);
    await db.exec(BASE_MIGRATION);
    await db.query(
      `insert into auth.users (id, email, email_confirmed_at)
       values ($1, 'admin@example.com', now()),
              ($2, 'parallel@example.com', now())`,
      [ADMIN, USER],
    );
    await db.query(
      `insert into public.profiles (id, role)
       values ($1, 'admin'), ($2, 'member')`,
      [ADMIN, USER],
    );
    await db.query(
      `insert into public.portal_clients (id, full_name, email, approval_status)
       values ($1, 'Parallel Client', 'parallel@example.com', 'approved')`,
      [USER],
    );
    await db.query(
      `insert into public.ad_accounts (
         id, client_id, store_name, shopify_url, shopify_connected
       ) values ($1, $2, 'Parallel Store', $3, true)`,
      [LEGACY, USER, DOMAIN],
    );
    await actAs(null, "service_role");
    await createReconnect();

    const selectExisting = `
      select id, mode, requested_assets, status, invite_token_hash,
             invite_expires_at, target_client_id,
             reconnect_legacy_ad_account_id,
             reconnect_shopify_connection_id, reconnect_completed_at,
             created_at, updated_at
      from public.client_onboarding_sessions
      where id = $1
    `;
    const before = await db.query(selectExisting, [RECONNECT]);

    await db.exec(PARALLEL_MIGRATION);

    const after = await db.query(selectExisting, [RECONNECT]);
    expect(before.rows).toHaveLength(1);
    expect(after.rows).toEqual(before.rows);
  });

  it("keeps an issued legacy reconnect and its Shopify asset intact when removal is attempted", async () => {
    await createReconnect();
    const sessionQuery = `
      select id, status, invite_token_hash, invite_expires_at,
             target_client_id, reconnect_legacy_ad_account_id,
             reconnect_shopify_connection_id, reconnect_completed_at
      from public.client_onboarding_sessions
      where id = $1
    `;
    const assetQuery = `
      select id, status, shopify_connected, shopify_admin_token,
             shopify_token_last4, shopify_connected_at
      from public.ad_accounts
      where id = $1
    `;
    const sessionBefore = await db.query(sessionQuery, [RECONNECT]);
    const assetBefore = await db.query(assetQuery, [LEGACY]);

    await expect(
      db.query(
        "select public.disconnect_legacy_shopify_connection($1, $2)",
        [LEGACY, ADMIN],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const sessionAfter = await db.query(sessionQuery, [RECONNECT]);
    const assetAfter = await db.query(assetQuery, [LEGACY]);
    expect(sessionAfter.rows).toEqual(sessionBefore.rows);
    expect(assetAfter.rows).toEqual(assetBefore.rows);
    expect(assetAfter.rows[0]).toMatchObject({
      status: "active",
      shopify_connected: true,
    });

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      RECONNECT,
      ADMIN,
    ]);
    await db.query(
      "select public.disconnect_legacy_shopify_connection($1, $2)",
      [LEGACY, ADMIN],
    );
    const assetAfterCancel = await db.query(assetQuery, [LEGACY]);
    expect(assetAfterCancel.rows[0]).toMatchObject({
      status: "active",
      shopify_connected: false,
      shopify_admin_token: null,
      shopify_token_last4: null,
      shopify_connected_at: null,
    });
  });

  it("keeps an issued V2 reconnect and its Shopify asset intact when removal is attempted", async () => {
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, mode, requested_assets, status, target_client_id, claimed_user_id,
         first_name, last_name, email, created_by, submitted_at,
         reviewed_at, reviewed_by
       ) values (
         $1, 'add_assets', array['shopify'], 'reviewed', $2, $2,
         'Parallel', 'Client', 'parallel@example.com', $3, now(), now(), $3
       )`,
      [HISTORY_SESSION, USER, ADMIN],
    );
    await db.query(
      `insert into public.client_shopify_connections (
         id, session_id, client_id, shopify_shop_id, shopify_name,
         shopify_domain, shopify_currency, credential_hint, granted_scopes,
         last_verified_at
       ) values ($1, $2, $3, $4, 'Parallel Store', $5, 'EUR', 'cdef', $6, now())`,
      [
        SHOPIFY_CONNECTION,
        HISTORY_SESSION,
        USER,
        SHOP_ID,
        DOMAIN,
        SHOPIFY_SCOPES,
      ],
    );
    await db.query(
      `insert into public.client_google_ads_connections (
         id, session_id, client_id, windsor_account_id, account_name, currency
       ) values ($1, $2, $3, '480-existing', 'Existing Ads', 'EUR')`,
      [GOOGLE_CONNECTION_B, HISTORY_SESSION, USER],
    );
    await db.query(
      `insert into public.client_asset_mappings (
         session_id, shopify_connection_id, google_ads_connection_id
       ) values ($1, $2, $3)`,
      [HISTORY_SESSION, SHOPIFY_CONNECTION, GOOGLE_CONNECTION_B],
    );
    await createOnboardingReconnect();
    await claim(RECONNECT, RECONNECT_TOKEN);

    const sessionQuery = `
      select id, status, invite_token_hash, invite_expires_at,
             target_client_id, reconnect_legacy_ad_account_id,
             reconnect_shopify_connection_id, reconnect_completed_at
      from public.client_onboarding_sessions
      where id = $1
    `;
    const assetQuery = `
      select id, session_id, client_id, status, credential_hint,
             granted_scopes, revoked_at
      from public.client_shopify_connections
      where id = $1
    `;
    const sessionBefore = await db.query(sessionQuery, [RECONNECT]);
    const assetBefore = await db.query(assetQuery, [SHOPIFY_CONNECTION]);

    await expect(
      db.query("select public.revoke_client_shopify_connection($1, $2)", [
        SHOPIFY_CONNECTION,
        ADMIN,
      ]),
    ).rejects.toMatchObject({ code: "23514" });

    const sessionAfter = await db.query(sessionQuery, [RECONNECT]);
    const assetAfter = await db.query(assetQuery, [SHOPIFY_CONNECTION]);
    expect(sessionAfter.rows).toEqual(sessionBefore.rows);
    expect(assetAfter.rows).toEqual(assetBefore.rows);
    expect(assetAfter.rows[0]).toMatchObject({
      status: "connected",
      credential_hint: "cdef",
      revoked_at: null,
    });

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      RECONNECT,
      ADMIN,
    ]);
    const assetAfterCancel = await db.query(assetQuery, [SHOPIFY_CONNECTION]);
    const mappingAfterCancel = await db.query<{ count: number }>(
      `select count(*)::int as count
       from public.client_asset_mappings
       where shopify_connection_id = $1 and google_ads_connection_id = $2`,
      [SHOPIFY_CONNECTION, GOOGLE_CONNECTION_B],
    );
    expect(assetAfterCancel.rows).toEqual(assetBefore.rows);
    expect(mappingAfterCancel.rows[0]).toEqual({ count: 1 });

    await db.query("select public.revoke_client_shopify_connection($1, $2)", [
      SHOPIFY_CONNECTION,
      ADMIN,
    ]);
    const removedAsset = await db.query(assetQuery, [SHOPIFY_CONNECTION]);
    const removedMapping = await db.query<{ count: number }>(
      `select count(*)::int as count
       from public.client_asset_mappings
       where shopify_connection_id = $1`,
      [SHOPIFY_CONNECTION],
    );
    expect(removedAsset.rows[0]).toMatchObject({
      status: "revoked",
      credential_hint: null,
    });
    expect(removedMapping.rows[0]).toEqual({ count: 0 });
  });
});
