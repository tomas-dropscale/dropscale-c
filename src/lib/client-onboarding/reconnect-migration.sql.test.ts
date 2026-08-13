import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const BASE_MIGRATION = readFileSync(
  "supabase/migrations/0044_client_onboarding_v2.sql",
  "utf8",
);
const RECONNECT_MIGRATION = readFileSync(
  "supabase/migrations/0046_client_shopify_reconnect_targets.sql",
  "utf8",
);

const ADMIN = "46000000-0000-4000-8000-000000000001";
const USER = "46000000-0000-4000-8000-000000000002";
const USER_2 = "46000000-0000-4000-8000-000000000003";
const ORIGIN_SESSION = "46000000-0000-4000-8000-000000000004";
const RECONNECT_SESSION = "46000000-0000-4000-8000-000000000005";
const SHOPIFY = "46000000-0000-4000-8000-000000000006";
const LEGACY = "46000000-0000-4000-8000-000000000007";
const GOOGLE = "46000000-0000-4000-8000-000000000008";
const MAPPING = "46000000-0000-4000-8000-000000000009";
const PROPOSED_CONNECTION = "46000000-0000-4000-8000-000000000010";
const LEGACY_WITHOUT_DOMAIN = "46000000-0000-4000-8000-000000000011";
const ORIGIN_TOKEN = "a".repeat(64);
const RECONNECT_TOKEN = "b".repeat(64);
const SHOP_ID = "gid://shopify/Shop/460";
const DOMAIN = "exact-store.myshopify.com";
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

async function seedClient(userId = USER, name = "Casey Example") {
  await db.query(
    `insert into public.portal_clients (id, full_name, email)
     values ($1, $2, $3)`,
    [userId, name, userId === USER ? "casey@example.com" : "other@example.com"],
  );
}

async function claim(sessionId: string, tokenHash: string, userId = USER) {
  return db.query(
    `select public.claim_client_onboarding_identity(
       $1, $2, $3, 'Casey', 'Example', $4
     )`,
    [
      sessionId,
      tokenHash,
      userId,
      userId === USER ? "casey@example.com" : "other@example.com",
    ],
  );
}

async function completeShopify(input: {
  sessionId?: string;
  tokenHash?: string;
  connectionId?: string;
  shopId?: string;
  domain?: string;
  secret?: string;
  name?: string;
} = {}) {
  return db.query<{ id: string }>(
    `select public.complete_client_shopify_connection(
       $1, $2, $3, $4, $5, $6, null, 'EUR', 'shopify-client-id',
       'cdef', $7::text[], $8
     ) as id`,
    [
      input.connectionId ?? PROPOSED_CONNECTION,
      input.sessionId ?? RECONNECT_SESSION,
      input.tokenHash ?? RECONNECT_TOKEN,
      input.shopId ?? SHOP_ID,
      input.name ?? "Exact Store",
      input.domain ?? DOMAIN,
      SHOPIFY_SCOPES,
      input.secret ?? "encrypted-reconnected-secret",
    ],
  );
}

async function seedV2Target() {
  await seedClient();
  await db.query(
    `select public.create_client_onboarding_invitation(
       $1, 'add_assets', array['shopify']::text[], $2, $3,
       now() + interval '1 day', $4
     )`,
    [ORIGIN_SESSION, USER, ORIGIN_TOKEN, ADMIN],
  );
  await claim(ORIGIN_SESSION, ORIGIN_TOKEN);
  await completeShopify({
    sessionId: ORIGIN_SESSION,
    tokenHash: ORIGIN_TOKEN,
    connectionId: SHOPIFY,
    secret: "encrypted-original-secret",
  });
  await db.query("select public.submit_client_onboarding_session($1, $2)", [
    ORIGIN_SESSION,
    ORIGIN_TOKEN,
  ]);
  await db.query(
    `insert into public.client_google_ads_connections (
       id, session_id, client_id, windsor_account_id, account_name
     ) values ($1, $2, $3, 'windsor-460', 'Exact Ads')`,
    [GOOGLE, ORIGIN_SESSION, USER],
  );
  await db.query(
    `insert into public.client_asset_mappings (
       id, session_id, shopify_connection_id, google_ads_connection_id
     ) values ($1, $2, $3, $4)`,
    [MAPPING, ORIGIN_SESSION, SHOPIFY, GOOGLE],
  );
}

async function createReconnect(source: "legacy" | "onboarding", targetId: string) {
  await db.query(
    `select public.create_client_shopify_reconnect_invitation(
       $1, $2, $3, $4, now() + interval '1 day', $5
     )`,
    [RECONNECT_SESSION, source, targetId, RECONNECT_TOKEN, ADMIN],
  );
  await claim(RECONNECT_SESSION, RECONNECT_TOKEN);
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("Expected the query to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  await db.exec(PRELUDE);
  await db.exec(BASE_MIGRATION);
  await db.exec(RECONNECT_MIGRATION);
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at)
     values ($1, 'admin@example.com', now()),
            ($2, 'casey@example.com', now()),
            ($3, 'other@example.com', now())`,
    [ADMIN, USER, USER_2],
  );
  await db.query(
    `insert into public.profiles (id, role)
     values ($1, 'admin'), ($2, 'member'), ($3, 'member')`,
    [ADMIN, USER, USER_2],
  );
  await actAs(null, "service_role");
});

describe("exact Shopify reconnect migration", () => {
  it("derives and locks the owner through the dedicated service/admin RPC", async () => {
    await seedClient(USER_2, "Other Client");
    await db.query(
      `insert into public.ad_accounts (
         id, client_id, store_name, shopify_url, shopify_connected
       ) values ($1, $2, 'Legacy Store', 'https://exact-store.myshopify.com/admin', true),
                ($3, $2, 'Missing-domain Store', null, true)`,
      [LEGACY, USER_2, LEGACY_WITHOUT_DOMAIN],
    );

    await expectSqlState(
      db.query(
        `select public.create_client_shopify_reconnect_invitation(
           gen_random_uuid(), 'legacy', $1, $2, now() + interval '1 day', $3
         )`,
        [LEGACY_WITHOUT_DOMAIN, "2".repeat(64), ADMIN],
      ),
      "P0002",
    );
    const afterMissingDomain = await db.query<{ count: string }>(
      "select count(*)::text as count from public.client_onboarding_sessions",
    );
    expect(afterMissingDomain.rows[0]).toEqual({ count: "0" });
    await expect(
      db.query(
        `select public.create_client_shopify_reconnect_invitation(
           gen_random_uuid(), null::text, $1, $2, null::timestamptz, $3
         )`,
        [LEGACY, "3".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/invalid Shopify reconnect invitation/i);

    await expect(
      db.query(
        `select public.create_client_onboarding_invitation(
           $1, 'reconnect', array['shopify']::text[], $2, $3,
           now() + interval '1 day', $4
         )`,
        [RECONNECT_SESSION, USER_2, RECONNECT_TOKEN, ADMIN],
      ),
    ).rejects.toThrow(/invalid client onboarding invitation/i);

    await expect(
      db.query(
        `select public.create_client_onboarding_invitation(
           gen_random_uuid(), 'new_client', array['shopify']::text[], null, $1,
           now() + interval '1 day', $2
         )`,
        ["e".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/invalid client onboarding invitation/i);

    await db.query(
      `select public.create_client_shopify_reconnect_invitation(
         $1, 'legacy', $2, $3, now() + interval '1 day', $4
       )`,
      [RECONNECT_SESSION, LEGACY, RECONNECT_TOKEN, ADMIN],
    );
    const saved = await db.query<{
      mode: string;
      requested_assets: string[];
      target_client_id: string;
      reconnect_legacy_ad_account_id: string | null;
      reconnect_shopify_connection_id: string | null;
    }>(
      `select mode, requested_assets, target_client_id,
              reconnect_legacy_ad_account_id, reconnect_shopify_connection_id
       from public.client_onboarding_sessions where id = $1`,
      [RECONNECT_SESSION],
    );
    expect(saved.rows[0]).toEqual({
      mode: "reconnect",
      requested_assets: ["shopify"],
      target_client_id: USER_2,
      reconnect_legacy_ad_account_id: LEGACY,
      reconnect_shopify_connection_id: null,
    });

    await db.query("update public.ad_accounts set shopify_url = null where id = $1", [
      LEGACY,
    ]);
    await expectSqlState(
      db.query(
        `select public.create_client_shopify_reconnect_invitation(
           gen_random_uuid(), 'legacy', $1, $2, now() + interval '1 day', $3
         )`,
        [LEGACY, "f".repeat(64), ADMIN],
      ),
      "P0002",
    );

    await expect(
      db.query(
        `insert into public.client_onboarding_sessions (
           id, mode, requested_assets, target_client_id,
           reconnect_legacy_ad_account_id, reconnect_shopify_connection_id,
           invite_token_hash, invite_expires_at, created_by
         ) values (
           gen_random_uuid(), 'reconnect', array['google_ads'], $1,
           $2, $3, $4, now() + interval '1 day', $5
         )`,
        [USER_2, LEGACY, SHOPIFY, "c".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/client_onboarding_requested_assets_shape|check constraint/i);

    await expect(
      db.query(
        `insert into public.client_onboarding_sessions (
           id, mode, requested_assets, target_client_id,
           reconnect_legacy_ad_account_id, reconnect_shopify_connection_id,
           invite_token_hash, invite_expires_at, created_by
         ) values (
           gen_random_uuid(), 'reconnect', array['shopify'], $1,
           $2, $3, $4, now() + interval '1 day', $5
         )`,
        [USER_2, LEGACY, SHOPIFY, "f".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/client_onboarding_mode_target_shape|check constraint/i);

    await expect(
      db.query(
        `select public.create_client_shopify_reconnect_invitation(
           gen_random_uuid(), 'legacy', $1, $2, now() + interval '1 day', $3
         )`,
        [LEGACY, "1".repeat(64), USER_2],
      ),
    ).rejects.toThrow(/verified admin/i);

    await actAs(USER_2, "authenticated");
    await expect(
      db.query(
        `select public.create_client_shopify_reconnect_invitation(
           gen_random_uuid(), 'legacy', $1, $2, now() + interval '1 day', $3
         )`,
        [LEGACY, "d".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/only the server/i);
  });

  it("rotates an exact V2 connection in place and submits through its completion marker", async () => {
    await seedV2Target();
    await createReconnect("onboarding", SHOPIFY);

    await expect(
      db.query("select public.submit_client_onboarding_session($1, $2)", [
        RECONNECT_SESSION,
        RECONNECT_TOKEN,
      ]),
    ).rejects.toThrow(/selected Shopify store must be reconnected/i);
    await expectSqlState(
      completeShopify({ shopId: "gid://shopify/Shop/999" }),
      "P4409",
    );
    await expectSqlState(
      completeShopify({ domain: "different-store.myshopify.com" }),
      "P4409",
    );
    const completed = await completeShopify({
      name: "Exact Store Renamed",
      secret: "encrypted-rotated-secret",
    });
    expect(completed.rows[0]).toEqual({ id: SHOPIFY });

    const rotated = await db.query<{
      id: string;
      session_id: string;
      shopify_name: string;
      client_secret_ciphertext: string;
      mappings: string;
      reconnect_completed: boolean;
    }>(
      `select connection.id, connection.session_id, connection.shopify_name,
              credential.client_secret_ciphertext,
              (select count(*)::text from public.client_asset_mappings
               where shopify_connection_id = connection.id) as mappings,
              session.reconnect_completed_at is not null as reconnect_completed
       from public.client_shopify_connections connection
       join public.client_shopify_credentials credential
         on credential.connection_id = connection.id
       join public.client_onboarding_sessions session on session.id = $2
       where connection.id = $1`,
      [SHOPIFY, RECONNECT_SESSION],
    );
    expect(rotated.rows[0]).toEqual({
      id: SHOPIFY,
      session_id: ORIGIN_SESSION,
      shopify_name: "Exact Store Renamed",
      client_secret_ciphertext: "encrypted-rotated-secret",
      mappings: "1",
      reconnect_completed: true,
    });

    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      RECONNECT_SESSION,
      RECONNECT_TOKEN,
    ]);
    const submitted = await db.query<{ status: string; current_assets: string }>(
      `select status,
              (select count(*)::text from public.client_shopify_connections
               where session_id = $1 and status = 'connected') as current_assets
       from public.client_onboarding_sessions where id = $1`,
      [RECONNECT_SESSION],
    );
    expect(submitted.rows[0]).toEqual({ status: "submitted", current_assets: "0" });
  });

  it("cancels a V2 reconnect without revoking its target, credential or mappings", async () => {
    await seedV2Target();
    await createReconnect("onboarding", SHOPIFY);
    await completeShopify({ secret: "encrypted-preserved-secret" });

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      RECONNECT_SESSION,
      ADMIN,
    ]);
    const preserved = await db.query<{
      reconnect_status: string;
      connection_status: string;
      client_secret_ciphertext: string;
      mappings: string;
    }>(
      `select reconnect.status as reconnect_status,
              connection.status as connection_status,
              credential.client_secret_ciphertext,
              (select count(*)::text from public.client_asset_mappings
               where shopify_connection_id = connection.id) as mappings
       from public.client_onboarding_sessions reconnect
       join public.client_shopify_connections connection on connection.id = $2
       join public.client_shopify_credentials credential
         on credential.connection_id = connection.id
       where reconnect.id = $1`,
      [RECONNECT_SESSION, SHOPIFY],
    );
    expect(preserved.rows[0]).toEqual({
      reconnect_status: "revoked",
      connection_status: "connected",
      client_secret_ciphertext: "encrypted-preserved-secret",
      mappings: "1",
    });
  });

  it("creates an exact V2 replacement for legacy and leaves the legacy row untouched", async () => {
    await seedClient();
    await db.query(
      `insert into public.ad_accounts (
         id, client_id, store_name, shopify_url, shopify_connected,
         shopify_client_id, shopify_admin_token, shopify_token_last4,
         shopify_connected_at
       ) values (
         $1, $2, 'Legacy Exact Store', $3, true,
         'legacy-client-id', 'legacy-ciphertext', 'abcd', now()
       )`,
      [LEGACY, USER, DOMAIN],
    );
    await createReconnect("legacy", LEGACY);

    await expectSqlState(
      completeShopify({ domain: "different-store.myshopify.com" }),
      "P4409",
    );
    const connected = await completeShopify();
    expect(connected.rows[0]).toEqual({ id: PROPOSED_CONNECTION });

    const state = await db.query<{
      shopify_connected: boolean;
      shopify_admin_token: string | null;
      shopify_client_id: string | null;
      shopify_url: string | null;
      replacement_status: string;
      replacement_session_id: string;
    }>(
      `select legacy.shopify_connected, legacy.shopify_admin_token,
              legacy.shopify_client_id, legacy.shopify_url,
              replacement.status as replacement_status,
              replacement.session_id as replacement_session_id
       from public.ad_accounts legacy
       join public.client_shopify_connections replacement on replacement.id = $2
       where legacy.id = $1`,
      [LEGACY, PROPOSED_CONNECTION],
    );
    expect(state.rows[0]).toEqual({
      shopify_connected: true,
      shopify_admin_token: "legacy-ciphertext",
      shopify_client_id: "legacy-client-id",
      shopify_url: DOMAIN,
      replacement_status: "connected",
      replacement_session_id: RECONNECT_SESSION,
    });

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      RECONNECT_SESSION,
      ADMIN,
    ]);
    const cancelled = await db.query<{
      legacy_connected: boolean;
      legacy_secret: string | null;
      replacement_status: string;
      replacement_credentials: string;
    }>(
      `select legacy.shopify_connected as legacy_connected,
              legacy.shopify_admin_token as legacy_secret,
              replacement.status as replacement_status,
              (select count(*)::text from public.client_shopify_credentials
               where connection_id = replacement.id) as replacement_credentials
       from public.ad_accounts legacy
       join public.client_shopify_connections replacement on replacement.id = $2
       where legacy.id = $1`,
      [LEGACY, PROPOSED_CONNECTION],
    );
    expect(cancelled.rows[0]).toEqual({
      legacy_connected: true,
      legacy_secret: "legacy-ciphertext",
      replacement_status: "revoked",
      replacement_credentials: "0",
    });
  });

  it("reuses a same-owner V2 replacement selected through an exact legacy target", async () => {
    await seedV2Target();
    await db.query(
      `insert into public.ad_accounts (
         id, client_id, store_name, shopify_url, shopify_connected,
         shopify_admin_token
       ) values ($1, $2, 'Legacy Projection', $3, true, 'legacy-ciphertext')`,
      [LEGACY, USER, DOMAIN],
    );
    await createReconnect("legacy", LEGACY);

    const completed = await completeShopify({
      connectionId: PROPOSED_CONNECTION,
      secret: "encrypted-reused-secret",
    });
    expect(completed.rows[0]).toEqual({ id: SHOPIFY });
    const result = await db.query<{
      connections: string;
      session_id: string;
      mappings: string;
      legacy_secret: string | null;
      v2_secret: string;
    }>(
      `select count(*) over ()::text as connections,
              connection.session_id,
              (select count(*)::text from public.client_asset_mappings
               where shopify_connection_id = connection.id) as mappings,
              legacy.shopify_admin_token as legacy_secret,
              credential.client_secret_ciphertext as v2_secret
       from public.client_shopify_connections connection
       join public.client_shopify_credentials credential
         on credential.connection_id = connection.id
       join public.ad_accounts legacy on legacy.id = $2
       where connection.id = $1 and connection.status = 'connected'`,
      [SHOPIFY, LEGACY],
    );
    expect(result.rows).toEqual([
      {
        connections: "1",
        session_id: ORIGIN_SESSION,
        mappings: "1",
        legacy_secret: "legacy-ciphertext",
        v2_secret: "encrypted-reused-secret",
      },
    ]);

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      RECONNECT_SESSION,
      ADMIN,
    ]);
    const preserved = await db.query<{
      status: string;
      client_secret_ciphertext: string;
      mappings: string;
    }>(
      `select connection.status, credential.client_secret_ciphertext,
              (select count(*)::text from public.client_asset_mappings
               where shopify_connection_id = connection.id) as mappings
       from public.client_shopify_connections connection
       join public.client_shopify_credentials credential
         on credential.connection_id = connection.id
       where connection.id = $1`,
      [SHOPIFY],
    );
    expect(preserved.rows[0]).toEqual({
      status: "connected",
      client_secret_ciphertext: "encrypted-reused-secret",
      mappings: "1",
    });
  });
});
