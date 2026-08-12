import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0044_client_onboarding_v2.sql",
  "utf8",
);

const ADMIN = "44000000-0000-4000-8000-000000000001";
const USER = "44000000-0000-4000-8000-000000000002";
const SESSION = "44000000-0000-4000-8000-000000000003";
const SHOPIFY = "44000000-0000-4000-8000-000000000004";
const USER_2 = "44000000-0000-4000-8000-000000000005";
const SESSION_B = "44000000-0000-4000-8000-000000000006";
const SESSION_C = "44000000-0000-4000-8000-000000000007";
const SHOPIFY_B = "44000000-0000-4000-8000-000000000008";
const SHOPIFY_C = "44000000-0000-4000-8000-000000000009";
const TOKEN_HASH = "a".repeat(64);
const TOKEN_HASH_B = "b".repeat(64);
const TOKEN_HASH_C = "c".repeat(64);
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
  store_name text not null
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

async function createNewInvitation(assets = ["shopify", "google_ads"]) {
  return db.query(
    `select public.create_client_onboarding_invitation(
       $1, 'new_client', $2::text[], null, $3, now() + interval '1 day', $4
     ) as id`,
    [SESSION, assets, TOKEN_HASH, ADMIN],
  );
}

async function claim() {
  return db.query(
    `select public.claim_client_onboarding_identity(
       $1, $2, $3, 'Casey', 'Example', 'casey@example.com'
     ) as id`,
    [SESSION, TOKEN_HASH, USER],
  );
}

async function createAssetInvitation(
  sessionId: string,
  tokenHash: string,
  assets: string[],
  targetClientId = USER,
  mode: "add_assets" | "reconnect" = "add_assets",
) {
  return db.query(
    `select public.create_client_onboarding_invitation(
       $1, $2, $3::text[], $4, $5, now() + interval '1 day', $6
     ) as id`,
    [sessionId, mode, assets, targetClientId, tokenHash, ADMIN],
  );
}

async function claimSession(
  sessionId: string,
  tokenHash: string,
  userId = USER,
  email = "casey@example.com",
) {
  return db.query(
    `select public.claim_client_onboarding_identity(
       $1, $2, $3, 'Casey', 'Example', $4
     ) as id`,
    [sessionId, tokenHash, userId, email],
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
              ($2, 'casey@example.com', null),
              ($3, 'second@example.com', null)`,
    [ADMIN, USER, USER_2],
  );
  await db.query(
    `insert into public.profiles (id, role)
       values ($1, 'admin'), ($2, 'member'), ($3, 'member')`,
    [ADMIN, USER, USER_2],
  );
  await actAs(null, "service_role");
});

describe("client onboarding V2 migration", () => {
  it("creates a hashed invitation and rejects duplicate asset declarations", async () => {
    const created = await createNewInvitation();
    expect(created.rows[0]).toEqual({ id: SESSION });

    const row = await db.query<{
      status: string;
      invite_token_hash: string;
      requested_assets: string[];
    }>(
      `select status, invite_token_hash, requested_assets
       from public.client_onboarding_sessions where id = $1`,
      [SESSION],
    );
    expect(row.rows[0]).toEqual({
      status: "pending",
      invite_token_hash: TOKEN_HASH,
      requested_assets: ["google_ads", "shopify"],
    });
    expect(JSON.stringify(row.rows)).not.toContain("client_secret");

    await expect(
      db.query(
        `select public.create_client_onboarding_invitation(
           gen_random_uuid(), 'new_client', array['shopify', 'shopify'],
           null, $1, now() + interval '1 day', $2
         )`,
        ["b".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/invalid client onboarding invitation/i);
  });

  it("supports account-only onboarding for a new user and keeps asset links purposeful", async () => {
    await createNewInvitation([]);
    await claim();
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      SESSION,
      TOKEN_HASH,
    ]);

    const submitted = await db.query<{
      status: string;
      requested_assets: string[];
    }>(
      `select status, requested_assets
       from public.client_onboarding_sessions where id = $1`,
      [SESSION],
    );
    expect(submitted.rows[0]).toEqual({
      status: "submitted",
      requested_assets: [],
    });

    await db.query(
      "update auth.users set email_confirmed_at = now() where id = $1",
      [USER],
    );
    await db.query(
      "select public.review_client_onboarding_session($1, $2, true)",
      [SESSION, ADMIN],
    );
    const activated = await db.query<{ status: string }>(
      "select status from public.client_onboarding_sessions where id = $1",
      [SESSION],
    );
    expect(activated.rows[0]).toEqual({ status: "active" });

    const accountOnlyData = await db.query<{
      secrets: string;
      shopify: string;
      google: string;
      mappings: string;
    }>(
      `select
         (select count(*) from public.client_onboarding_secrets)::text as secrets,
         (select count(*) from public.client_shopify_connections)::text as shopify,
         (select count(*) from public.client_google_ads_connections)::text as google,
         (select count(*) from public.client_asset_mappings)::text as mappings`,
    );
    expect(accountOnlyData.rows[0]).toEqual({
      secrets: "0",
      shopify: "0",
      google: "0",
      mappings: "0",
    });

    await expect(
      db.query(
        `select public.create_client_onboarding_invitation(
           gen_random_uuid(), 'add_assets', '{}'::text[], $1,
           $2, now() + interval '1 day', $3
         )`,
        [USER, "b".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/invalid client onboarding invitation/i);

    await expect(
      db.query(
        `select public.create_client_onboarding_invitation(
           gen_random_uuid(), 'reconnect', '{}'::text[], $1,
           $2, now() + interval '1 day', $3
         )`,
        [USER, "c".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/invalid client onboarding invitation/i);

    await expect(
      db.query(
        `select public.create_client_onboarding_invitation(
           gen_random_uuid(), 'new_client', null, null,
           $1, now() + interval '1 day', $2
         )`,
        ["d".repeat(64), ADMIN],
      ),
    ).rejects.toThrow(/invalid client onboarding invitation/i);
  });

  it("prevents a new-client invitation from converting an existing portal workspace", async () => {
    await createNewInvitation([]);
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Existing Demo Client', 'casey@example.com')`,
      [USER],
    );

    await expect(claim()).rejects.toThrow(
      /already belongs to a portal client/i,
    );
    const state = await db.query<{
      status: string;
      claimed_user_id: string | null;
    }>(
      "select status, claimed_user_id from public.client_onboarding_sessions where id = $1",
      [SESSION],
    );
    expect(state.rows[0]).toEqual({ status: "pending", claimed_user_id: null });
  });

  it("binds only when the auth user email exactly matches the claimed identity", async () => {
    await createNewInvitation([]);
    await expect(
      db.query(
        `select public.claim_client_onboarding_identity(
           $1, $2, $3, 'Casey', 'Example', 'different@example.com'
         )`,
        [SESSION, TOKEN_HASH, USER],
      ),
    ).rejects.toThrow(/identity not found/i);
  });

  it("allows only one open asset invitation per existing client", async () => {
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com')`,
      [USER],
    );
    await createAssetInvitation(SESSION_B, TOKEN_HASH_B, ["shopify"]);

    await expect(
      createAssetInvitation(SESSION_C, TOKEN_HASH_C, ["google_ads"]),
    ).rejects.toThrow(/client_onboarding_one_open_target_idx/i);

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      SESSION_B,
      ADMIN,
    ]);
    const created = await createAssetInvitation(SESSION_C, TOKEN_HASH_C, [
      "google_ads",
    ]);
    expect(created.rows[0]).toEqual({ id: SESSION_C });
  });

  it.each(["add_assets", "reconnect"] as const)(
    "clears a cancelled %s rollout pointer when no V2 session survives",
    async (mode) => {
      await db.query(
        `insert into public.portal_clients (id, full_name, email)
         values ($1, 'Casey Example', 'casey@example.com')`,
        [USER],
      );
      await createAssetInvitation(
        SESSION_B,
        TOKEN_HASH_B,
        ["shopify"],
        USER,
        mode,
      );

      const before = await db.query<{
        operational_surface: string;
        onboarding_session_id: string | null;
      }>(
        `select operational_surface, onboarding_session_id
         from public.client_rollout_states where client_id = $1`,
        [USER],
      );
      expect(before.rows[0]).toEqual({
        operational_surface: "v2_onboarding",
        onboarding_session_id: SESSION_B,
      });

      await db.query("select public.revoke_client_onboarding_session($1, $2)", [
        SESSION_B,
        ADMIN,
      ]);
      const after = await db.query<{
        operational_surface: string;
        onboarding_session_id: string | null;
      }>(
        `select operational_surface, onboarding_session_id
         from public.client_rollout_states where client_id = $1`,
        [USER],
      );
      expect(after.rows[0]).toEqual({
        operational_surface: "legacy_only",
        onboarding_session_id: null,
      });
    },
  );

  it.each(["add_assets", "reconnect"] as const)(
    "keeps an active workspace live and restores its surviving session after cancelling %s",
    async (mode) => {
      await createNewInvitation([]);
      await claim();
      await db.query(
        "update auth.users set email_confirmed_at = now() where id = $1",
        [USER],
      );
      await db.query("select public.submit_client_onboarding_session($1, $2)", [
        SESSION,
        TOKEN_HASH,
      ]);
      await db.query(
        "select public.review_client_onboarding_session($1, $2, true)",
        [SESSION, ADMIN],
      );

      await createAssetInvitation(
        SESSION_B,
        TOKEN_HASH_B,
        ["google_ads"],
        USER,
        mode,
      );
      const during = await db.query<{
        operational_surface: string;
        onboarding_session_id: string | null;
      }>(
        `select operational_surface, onboarding_session_id
         from public.client_rollout_states where client_id = $1`,
        [USER],
      );
      expect(during.rows[0]).toEqual({
        operational_surface: "v2_active",
        onboarding_session_id: SESSION_B,
      });

      await db.query("select public.revoke_client_onboarding_session($1, $2)", [
        SESSION_B,
        ADMIN,
      ]);
      const after = await db.query<{
        operational_surface: string;
        onboarding_session_id: string | null;
        cancelled_status: string;
      }>(
        `select rollout.operational_surface, rollout.onboarding_session_id,
                cancelled.status as cancelled_status
         from public.client_rollout_states rollout
         join public.client_onboarding_sessions cancelled on cancelled.id = $2
         where rollout.client_id = $1`,
        [USER, SESSION_B],
      );
      expect(after.rows[0]).toEqual({
        operational_surface: "v2_active",
        onboarding_session_id: SESSION,
        cancelled_status: "revoked",
      });
    },
  );

  it("restores the latest reviewed session and ready surface after cancellation", async () => {
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com')`,
      [USER],
    );
    await createAssetInvitation(SESSION_B, TOKEN_HASH_B, ["shopify"]);
    await claimSession(SESSION_B, TOKEN_HASH_B);
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id',
         'cdef', $4::text[], 'encrypted-shopify-secret'
       )`,
      [SHOPIFY, SESSION_B, TOKEN_HASH_B, SHOPIFY_SCOPES],
    );
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      SESSION_B,
      TOKEN_HASH_B,
    ]);
    await db.query(
      "select public.review_client_onboarding_session($1, $2, false)",
      [SESSION_B, ADMIN],
    );

    await createAssetInvitation(
      SESSION_C,
      TOKEN_HASH_C,
      ["google_ads"],
      USER,
      "reconnect",
    );
    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      SESSION_C,
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
      operational_surface: "v2_ready_for_cutover",
      onboarding_session_id: SESSION_B,
    });
  });

  it("collects Shopify and Google assets, then submits without touching billing or legacy rows", async () => {
    await createNewInvitation();
    await claim();

    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', 'northwind.example', 'EUR',
         'shopify-client-id', 'cdef', $4::text[], 'encrypted-shopify-secret'
       )`,
      [SHOPIFY, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    await db.query(
      `select public.upsert_client_google_ads_connection(
         $1, $2, '1234567890', 'Northwind Demo Ads', 'EUR', 'Europe/Lisbon', 'source-1'
       )`,
      [SESSION, TOKEN_HASH],
    );
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      SESSION,
      TOKEN_HASH,
    ]);

    const session = await db.query<{
      status: string;
      invite_token_hash: string | null;
      claimed_user_id: string;
    }>(
      `select status, invite_token_hash, claimed_user_id
       from public.client_onboarding_sessions where id = $1`,
      [SESSION],
    );
    expect(session.rows[0]).toEqual({
      status: "submitted",
      invite_token_hash: null,
      claimed_user_id: USER,
    });
    const credential = await db.query<{ client_secret_ciphertext: string }>(
      "select client_secret_ciphertext from public.client_shopify_credentials",
    );
    expect(credential.rows).toEqual([
      { client_secret_ciphertext: "encrypted-shopify-secret" },
    ]);
    const legacy = await db.query<{ count: string }>(
      "select count(*) as count from public.ad_accounts",
    );
    expect(Number(legacy.rows[0].count)).toBe(0);
  });

  it("retries the same Shopify store idempotently for the same owner", async () => {
    await createNewInvitation(["shopify"]);
    await claim();
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id',
         'cdef', $4::text[], 'encrypted-first'
       )`,
      [SHOPIFY, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    const retryId = "44000000-0000-4000-8000-000000000099";
    const retried = await db.query<{ id: string }>(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id',
         'wxyz', $4::text[], 'encrypted-second'
       ) as id`,
      [retryId, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    expect(retried.rows[0]).toEqual({ id: SHOPIFY });
    const saved = await db.query<{
      count: string;
      client_secret_ciphertext: string;
    }>(
      `select count(*) over ()::text as count, credential.client_secret_ciphertext
       from public.client_shopify_connections connection
       join public.client_shopify_credentials credential on credential.connection_id = connection.id`,
    );
    expect(saved.rows).toEqual([
      { count: "1", client_secret_ciphertext: "encrypted-second" },
    ]);
  });

  it("never transfers a Shopify asset or credential to another session", async () => {
    await createNewInvitation(["shopify"]);
    await claim();
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id',
         'cdef', $4::text[], 'encrypted-first'
       )`,
      [SHOPIFY, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com')`,
      [USER],
    );
    await createAssetInvitation(SESSION_B, TOKEN_HASH_B, ["shopify"]);
    await claimSession(SESSION_B, TOKEN_HASH_B);

    await expect(
      db.query(
        `select public.complete_client_shopify_connection(
           gen_random_uuid(), $1, $2, 'gid://shopify/Shop/123', 'Renamed Store',
           'northwind-demo.myshopify.com', null, 'EUR', 'replacement-client-id',
           'wxyz', $3::text[], 'encrypted-replacement'
         )`,
        [SESSION_B, TOKEN_HASH_B, SHOPIFY_SCOPES],
      ),
    ).rejects.toThrow(/another onboarding session/i);

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      SESSION_B,
      ADMIN,
    ]);
    const preserved = await db.query<{
      session_id: string;
      status: string;
      client_secret_ciphertext: string;
    }>(
      `select connection.session_id, connection.status,
              credential.client_secret_ciphertext
       from public.client_shopify_connections connection
       join public.client_shopify_credentials credential
         on credential.connection_id = connection.id
       where connection.id = $1`,
      [SHOPIFY],
    );
    expect(preserved.rows).toEqual([
      {
        session_id: SESSION,
        status: "connected",
        client_secret_ciphertext: "encrypted-first",
      },
    ]);
  });

  it("stores Windsor authorization only while the locked Google Ads session is open", async () => {
    await createNewInvitation(["google_ads"]);
    await claim();

    const stored = await db.query<{ id: string }>(
      `select public.store_client_windsor_authorization($1, $2, $3) as id`,
      [SESSION, TOKEN_HASH, "encrypted-windsor-token"],
    );
    expect(stored.rows[0]).toEqual({ id: SESSION });
    await db.query(
      `select public.store_client_windsor_authorization($1, $2, $3)`,
      [SESSION, TOKEN_HASH, "encrypted-windsor-token-updated"],
    );
    const secret = await db.query<{
      windsor_access_token_ciphertext: string | null;
    }>(
      `select windsor_access_token_ciphertext
       from public.client_onboarding_secrets where session_id = $1`,
      [SESSION],
    );
    expect(secret.rows[0]).toEqual({
      windsor_access_token_ciphertext: "encrypted-windsor-token-updated",
    });

    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      SESSION,
      ADMIN,
    ]);
    await expect(
      db.query(`select public.store_client_windsor_authorization($1, $2, $3)`, [
        SESSION,
        TOKEN_HASH,
        "must-not-be-restored-after-cancel",
      ]),
    ).rejects.toThrow(/Google Ads onboarding is not available/i);
    const afterCancel = await db.query<{ count: string }>(
      `select count(*)::text as count
       from public.client_onboarding_secrets where session_id = $1`,
      [SESSION],
    );
    expect(afterCancel.rows[0]).toEqual({ count: "0" });
  });

  it("rejects Windsor authorization outside its purpose and from non-service callers", async () => {
    await createNewInvitation(["shopify"]);
    await claim();
    await expect(
      db.query(`select public.store_client_windsor_authorization($1, $2, $3)`, [
        SESSION,
        TOKEN_HASH,
        "encrypted-windsor-token",
      ]),
    ).rejects.toThrow(/Google Ads onboarding is not available/i);

    await actAs(USER, "authenticated");
    await expect(
      db.query(`select public.store_client_windsor_authorization($1, $2, $3)`, [
        SESSION,
        TOKEN_HASH,
        "encrypted-windsor-token",
      ]),
    ).rejects.toThrow(/only the server/i);

    const privileges = await db.query<{
      authenticated_can_execute: boolean;
      service_can_execute: boolean;
    }>(
      `select
         has_function_privilege(
           'authenticated',
           'public.store_client_windsor_authorization(uuid,text,text)',
           'EXECUTE'
         ) as authenticated_can_execute,
         has_function_privilege(
           'service_role',
           'public.store_client_windsor_authorization(uuid,text,text)',
           'EXECUTE'
         ) as service_can_execute`,
    );
    expect(privileges.rows[0]).toEqual({
      authenticated_can_execute: false,
      service_can_execute: true,
    });
  });

  it("persists a Google Ads batch atomically and rejects cross-session or cross-owner duplicates", async () => {
    await createNewInvitation(["google_ads"]);
    await claim();
    await db.query(
      `select public.upsert_client_google_ads_connection(
         $1, $2, 'existing-account', 'Existing Ads', 'EUR', 'Europe/Lisbon', null
       )`,
      [SESSION, TOKEN_HASH],
    );
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com'),
              ($2, 'Second Client', 'second@example.com')`,
      [USER, USER_2],
    );
    await createAssetInvitation(SESSION_B, TOKEN_HASH_B, ["google_ads"]);
    await claimSession(SESSION_B, TOKEN_HASH_B);

    const conflictingBatch = [
      {
        windsorAccountId: "new-account",
        accountName: "New Ads",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        dataSourceId: null,
      },
      {
        windsorAccountId: "existing-account",
        accountName: "Existing Ads",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        dataSourceId: null,
      },
    ];
    await expect(
      db.query(
        "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb)",
        [SESSION_B, TOKEN_HASH_B, JSON.stringify(conflictingBatch)],
      ),
    ).rejects.toThrow(/already active in another onboarding/i);

    const afterConflict = await db.query<{
      windsor_account_id: string;
      session_id: string;
    }>(
      `select windsor_account_id, session_id
       from public.client_google_ads_connections order by windsor_account_id`,
    );
    expect(afterConflict.rows).toEqual([
      { windsor_account_id: "existing-account", session_id: SESSION },
    ]);

    await createAssetInvitation(
      SESSION_C,
      TOKEN_HASH_C,
      ["google_ads"],
      USER_2,
    );
    await claimSession(SESSION_C, TOKEN_HASH_C, USER_2, "second@example.com");
    await expect(
      db.query(
        "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb)",
        [SESSION_C, TOKEN_HASH_C, JSON.stringify([conflictingBatch[1]])],
      ),
    ).rejects.toThrow(/already active in another onboarding/i);
  });

  it("retries a Google Ads batch idempotently within one session and returns input order", async () => {
    await createNewInvitation(["google_ads"]);
    await claim();
    const firstBatch = [
      {
        windsorAccountId: "account-one",
        accountName: "First Ads",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        dataSourceId: "source-one",
      },
      {
        windsorAccountId: "account-two",
        accountName: "Second Ads",
        currency: null,
        timeZone: null,
        dataSourceId: null,
      },
    ];
    const first = await db.query<{ ids: string[] }>(
      "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb) as ids",
      [SESSION, TOKEN_HASH, JSON.stringify(firstBatch)],
    );
    expect(first.rows[0].ids).toHaveLength(2);

    const retried = await db.query<{ ids: string[] }>(
      "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb) as ids",
      [
        SESSION,
        TOKEN_HASH,
        JSON.stringify([
          { ...firstBatch[1], accountName: "Second Ads Updated" },
          { ...firstBatch[0], accountName: "First Ads Updated" },
        ]),
      ],
    );
    expect(retried.rows[0].ids).toEqual([
      first.rows[0].ids[1],
      first.rows[0].ids[0],
    ]);
    const saved = await db.query<{
      windsor_account_id: string;
      account_name: string;
    }>(
      `select windsor_account_id, account_name
       from public.client_google_ads_connections order by windsor_account_id`,
    );
    expect(saved.rows).toEqual([
      { windsor_account_id: "account-one", account_name: "First Ads Updated" },
      { windsor_account_id: "account-two", account_name: "Second Ads Updated" },
    ]);
  });

  it("rejects malformed or duplicate Google Ads batches before writing", async () => {
    await createNewInvitation(["google_ads"]);
    await claim();
    const valid = {
      windsorAccountId: "account-one",
      accountName: "First Ads",
      currency: "EUR",
      timeZone: null,
      dataSourceId: null,
    };
    await expect(
      db.query(
        "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb)",
        [
          SESSION,
          TOKEN_HASH,
          JSON.stringify([valid, { ...valid, accountName: "Duplicate" }]),
        ],
      ),
    ).rejects.toThrow(/duplicate Google Ads account/i);
    await expect(
      db.query(
        "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb)",
        [
          SESSION,
          TOKEN_HASH,
          JSON.stringify([{ ...valid, unexpected: "field" }]),
        ],
      ),
    ).rejects.toThrow(/invalid Google Ads account metadata/i);
    await expect(
      db.query(
        "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb)",
        [
          SESSION,
          TOKEN_HASH,
          JSON.stringify([
            {
              windsorAccountId: "missing-data-source",
              accountName: "Missing key",
              currency: "EUR",
              timeZone: null,
            },
          ]),
        ],
      ),
    ).rejects.toThrow(/invalid Google Ads account metadata/i);
    const count = await db.query<{ count: string }>(
      "select count(*)::text as count from public.client_google_ads_connections",
    );
    expect(count.rows[0]).toEqual({ count: "0" });
  });

  it("maps same-client assets across sessions without satisfying current-session requirements", async () => {
    await createNewInvitation(["shopify"]);
    await claim();
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id',
         'cdef', $4::text[], 'encrypted-first'
       )`,
      [SHOPIFY, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com')`,
      [USER],
    );
    await createAssetInvitation(SESSION_B, TOKEN_HASH_B, [
      "shopify",
      "google_ads",
    ]);
    await claimSession(SESSION_B, TOKEN_HASH_B);
    const google = await db.query<{ id: string }>(
      `select public.upsert_client_google_ads_connection(
         $1, $2, 'new-google-account', 'New Google Ads', 'EUR', null, null
       ) as id`,
      [SESSION_B, TOKEN_HASH_B],
    );

    const mapped = await db.query<{ count: number }>(
      "select public.replace_client_asset_mappings($1, $2, $3::jsonb) as count",
      [
        SESSION_B,
        TOKEN_HASH_B,
        JSON.stringify([
          {
            shopifyConnectionId: SHOPIFY,
            googleAdsConnectionId: google.rows[0].id,
          },
        ]),
      ],
    );
    expect(mapped.rows[0]).toEqual({ count: 1 });

    const cleared = await db.query<{ count: number }>(
      "select public.replace_client_asset_mappings($1, $2, '[]'::jsonb) as count",
      [SESSION_B, TOKEN_HASH_B],
    );
    expect(cleared.rows[0]).toEqual({ count: 0 });
    const remaining = await db.query<{ count: string }>(
      "select count(*)::text as count from public.client_asset_mappings",
    );
    expect(remaining.rows[0]).toEqual({ count: "0" });

    await expect(
      db.query("select public.submit_client_onboarding_session($1, $2)", [
        SESSION_B,
        TOKEN_HASH_B,
      ]),
    ).rejects.toThrow(/at least one Shopify store is required/i);
  });

  it("replaces only editable cross-session mappings and preserves unrelated old pairs", async () => {
    await createNewInvitation();
    await claim();
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id-a',
         'cdef', $4::text[], 'encrypted-first'
       )`,
      [SHOPIFY, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/124', 'Southwind Demo Store',
         'southwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id-b',
         'efgh', $4::text[], 'encrypted-second'
       )`,
      [SHOPIFY_B, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    const googleA = await db.query<{ id: string }>(
      `select public.upsert_client_google_ads_connection(
         $1, $2, 'old-google-a', 'Old Google A', 'EUR', null, null
       ) as id`,
      [SESSION, TOKEN_HASH],
    );
    const googleB = await db.query<{ id: string }>(
      `select public.upsert_client_google_ads_connection(
         $1, $2, 'old-google-b', 'Old Google B', 'EUR', null, null
       ) as id`,
      [SESSION, TOKEN_HASH],
    );
    await db.query(
      "select public.replace_client_asset_mappings($1, $2, $3::jsonb)",
      [
        SESSION,
        TOKEN_HASH,
        JSON.stringify([
          {
            shopifyConnectionId: SHOPIFY,
            googleAdsConnectionId: googleA.rows[0].id,
          },
          {
            shopifyConnectionId: SHOPIFY_B,
            googleAdsConnectionId: googleB.rows[0].id,
          },
        ]),
      ],
    );

    await expect(
      db.query(
        `insert into public.client_asset_mappings (
           session_id, shopify_connection_id, google_ads_connection_id
         ) values ($1, $2, $3)`,
        [SESSION, SHOPIFY_B, googleA.rows[0].id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com')`,
      [USER],
    );
    await createAssetInvitation(SESSION_B, TOKEN_HASH_B, ["shopify"]);
    await claimSession(SESSION_B, TOKEN_HASH_B);
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/125', 'Current Demo Store',
         'current-demo.myshopify.com', null, 'EUR', 'shopify-client-id-c',
         'ijkl', $4::text[], 'encrypted-current'
       )`,
      [SHOPIFY_C, SESSION_B, TOKEN_HASH_B, SHOPIFY_SCOPES],
    );

    await expect(
      db.query(
        "select public.replace_client_asset_mappings($1, $2, $3::jsonb)",
        [
          SESSION_B,
          TOKEN_HASH_B,
          JSON.stringify([
            {
              shopifyConnectionId: SHOPIFY_C,
              googleAdsConnectionId: googleA.rows[0].id,
            },
            {
              shopifyConnectionId: SHOPIFY_B,
              googleAdsConnectionId: googleB.rows[0].id,
            },
          ]),
        ],
      ),
    ).rejects.toThrow(/at least one mapped asset must belong/i);

    const unchangedAfterRejectedBatch = await db.query<{
      shopify_connection_id: string;
      google_ads_connection_id: string;
    }>(
      `select shopify_connection_id, google_ads_connection_id
       from public.client_asset_mappings`,
    );
    expect(unchangedAfterRejectedBatch.rows).toEqual(
      expect.arrayContaining([
        {
          shopify_connection_id: SHOPIFY,
          google_ads_connection_id: googleA.rows[0].id,
        },
        {
          shopify_connection_id: SHOPIFY_B,
          google_ads_connection_id: googleB.rows[0].id,
        },
      ]),
    );
    expect(unchangedAfterRejectedBatch.rows).toHaveLength(2);

    const remapped = await db.query<{ count: number }>(
      "select public.replace_client_asset_mappings($1, $2, $3::jsonb) as count",
      [
        SESSION_B,
        TOKEN_HASH_B,
        JSON.stringify([
          {
            shopifyConnectionId: SHOPIFY_C,
            googleAdsConnectionId: googleA.rows[0].id,
          },
        ]),
      ],
    );
    expect(remapped.rows[0]).toEqual({ count: 1 });

    const afterRemap = await db.query<{
      shopify_connection_id: string;
      google_ads_connection_id: string;
    }>(
      `select shopify_connection_id, google_ads_connection_id
       from public.client_asset_mappings`,
    );
    expect(afterRemap.rows).toEqual(
      expect.arrayContaining([
        {
          shopify_connection_id: SHOPIFY_C,
          google_ads_connection_id: googleA.rows[0].id,
        },
        {
          shopify_connection_id: SHOPIFY_B,
          google_ads_connection_id: googleB.rows[0].id,
        },
      ]),
    );
    expect(afterRemap.rows).toHaveLength(2);

    const cleared = await db.query<{ count: number }>(
      "select public.replace_client_asset_mappings($1, $2, '[]'::jsonb) as count",
      [SESSION_B, TOKEN_HASH_B],
    );
    expect(cleared.rows[0]).toEqual({ count: 0 });
    const afterClear = await db.query<{
      shopify_connection_id: string;
      google_ads_connection_id: string;
    }>(
      `select shopify_connection_id, google_ads_connection_id
       from public.client_asset_mappings`,
    );
    expect(afterClear.rows).toEqual([
      {
        shopify_connection_id: SHOPIFY_B,
        google_ads_connection_id: googleB.rows[0].id,
      },
    ]);
  });

  it("requires email confirmation before explicit activation and never starts billing", async () => {
    await createNewInvitation();
    await claim();
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id',
         'cdef', $4::text[], 'encrypted-shopify-secret'
       )`,
      [SHOPIFY, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    await db.query(
      `select public.upsert_client_google_ads_connection(
         $1, $2, '1234567890', 'Northwind Demo Ads', 'EUR', 'Europe/Lisbon', null
       )`,
      [SESSION, TOKEN_HASH],
    );
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      SESSION,
      TOKEN_HASH,
    ]);

    await expect(
      db.query("select public.review_client_onboarding_session($1, $2, true)", [
        SESSION,
        ADMIN,
      ]),
    ).rejects.toThrow(/confirm their email/i);

    await db.query(
      "update auth.users set email_confirmed_at = now() where id = $1",
      [USER],
    );
    await db.query(
      "select public.review_client_onboarding_session($1, $2, false)",
      [SESSION, ADMIN],
    );
    const result = await db.query<{
      session_status: string;
      approval_status: string;
      operational_surface: string;
    }>(
      `select session.status as session_status,
              coalesce(client.approval_status, 'missing') as approval_status,
              coalesce(rollout.operational_surface, 'missing') as operational_surface
       from public.client_onboarding_sessions session
       left join public.portal_clients client on client.id = session.claimed_user_id
       left join public.client_rollout_states rollout on rollout.client_id = client.id
       where session.id = $1`,
      [SESSION],
    );
    expect(result.rows[0]).toEqual({
      session_status: "reviewed",
      approval_status: "missing",
      operational_surface: "missing",
    });
    await expect(
      db.query("select public.review_client_onboarding_session($1, $2, true)", [
        SESSION,
        ADMIN,
      ]),
    ).rejects.toThrow(/reporting activation is not available/i);
  });

  it("revokes V2 secrets and assets while preserving a legacy account", async () => {
    await createNewInvitation(["shopify"]);
    await claim();
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com')`,
      [USER],
    );
    await db.query(
      "insert into public.ad_accounts (client_id, store_name) values ($1, 'Legacy Demo Client')",
      [USER],
    );
    await db.query(
      `select public.complete_client_shopify_connection(
         $1, $2, $3, 'gid://shopify/Shop/123', 'Northwind Demo Store',
         'northwind-demo.myshopify.com', null, 'EUR', 'shopify-client-id',
         'cdef', $4::text[], 'encrypted-shopify-secret'
       )`,
      [SHOPIFY, SESSION, TOKEN_HASH, SHOPIFY_SCOPES],
    );
    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      SESSION,
      ADMIN,
    ]);

    const secrets = await db.query<{ count: string }>(
      "select count(*) as count from public.client_shopify_credentials",
    );
    const legacy = await db.query<{ count: string }>(
      "select count(*) as count from public.ad_accounts",
    );
    const state = await db.query<{ session: string; shopify: string }>(
      `select session.status as session, shop.status as shopify
       from public.client_onboarding_sessions session
       join public.client_shopify_connections shop on shop.session_id = session.id
       where session.id = $1`,
      [SESSION],
    );
    expect(Number(secrets.rows[0].count)).toBe(0);
    expect(Number(legacy.rows[0].count)).toBe(1);
    expect(state.rows[0]).toEqual({ session: "revoked", shopify: "revoked" });
  });

  it("retains a cancelled signup identity for immutable onboarding audit ownership", async () => {
    await createNewInvitation([]);
    await claim();
    await db.query("select public.revoke_client_onboarding_session($1, $2)", [
      SESSION,
      ADMIN,
    ]);

    const retained = await db.query<{
      status: string;
      claimed_user_id: string | null;
      auth_user_id: string | null;
      event_actor_id: string | null;
    }>(
      `select session.status, session.claimed_user_id,
              auth_user.id as auth_user_id, event.actor_id as event_actor_id
       from public.client_onboarding_sessions session
       left join auth.users auth_user on auth_user.id = session.claimed_user_id
       left join public.client_onboarding_events event
         on event.session_id = session.id
        and event.event_type = 'invitation_revoked'
       where session.id = $1`,
      [SESSION],
    );
    expect(retained.rows[0]).toEqual({
      status: "revoked",
      claimed_user_id: USER,
      auth_user_id: USER,
      event_actor_id: ADMIN,
    });
  });

  it("never treats a completed account-only session revoke as portal suspension", async () => {
    await createNewInvitation([]);
    await claim();
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      SESSION,
      TOKEN_HASH,
    ]);
    await expect(
      db.query("select public.revoke_client_onboarding_session($1, $2)", [
        SESSION,
        ADMIN,
      ]),
    ).rejects.toThrow(/only an open onboarding session can be revoked/i);
  });

  it("does not expose lifecycle RPCs to authenticated callers", async () => {
    const privileges = await db.query<{
      anon_can_execute: boolean;
      authenticated_can_execute: boolean;
      service_can_execute: boolean;
    }>(
      `select
         has_function_privilege('anon', 'public.legacy_asset_writes_allowed(uuid)', 'EXECUTE')
           as anon_can_execute,
         has_function_privilege('authenticated', 'public.legacy_asset_writes_allowed(uuid)', 'EXECUTE')
           as authenticated_can_execute,
         has_function_privilege('service_role', 'public.legacy_asset_writes_allowed(uuid)', 'EXECUTE')
           as service_can_execute`,
    );
    expect(privileges.rows[0]).toEqual({
      anon_can_execute: false,
      authenticated_can_execute: true,
      service_can_execute: true,
    });
    await actAs(USER, "authenticated");
    await expect(createNewInvitation()).rejects.toThrow(/only the server/i);
  });

  it("blocks legacy client writes after V2 activation while preserving admin access", async () => {
    await db.query(
      `insert into public.portal_clients (id, full_name, email)
       values ($1, 'Casey Example', 'casey@example.com')`,
      [USER],
    );
    await db.query(
      `insert into public.client_rollout_states (client_id, operational_surface, updated_by)
       values ($1, 'v2_active', $2)`,
      [USER, ADMIN],
    );
    await db.exec(
      `grant usage on schema public, auth to authenticated;
       grant execute on function auth.uid(), auth.role() to authenticated;
       grant select, insert, update on public.ad_accounts to authenticated;
       grant select, insert on public.account_requests to authenticated;`,
    );

    await actAs(USER, "authenticated");
    await db.exec("set role authenticated");
    await expect(
      db.query(
        "insert into public.ad_accounts (client_id, store_name) values ($1, 'Blocked store')",
        [USER],
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      db.query(
        "insert into public.account_requests (client_id, status) values ($1, 'pending')",
        [USER],
      ),
    ).rejects.toThrow(/row-level security/i);

    await db.exec("reset role");
    await actAs(ADMIN, "authenticated");
    await db.exec("set role authenticated");
    await db.query(
      "insert into public.ad_accounts (client_id, store_name) values ($1, 'Admin-managed store')",
      [USER],
    );
    await db.query(
      "insert into public.account_requests (client_id, status) values ($1, 'pending')",
      [USER],
    );
    await db.exec("reset role");

    const rows = await db.query<{ accounts: string; requests: string }>(
      `select
         (select count(*)::text from public.ad_accounts) as accounts,
         (select count(*)::text from public.account_requests) as requests`,
    );
    expect(rows.rows[0]).toEqual({ accounts: "1", requests: "1" });
  });
});
