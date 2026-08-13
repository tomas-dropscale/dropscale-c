import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = [
  "supabase/migrations/0044_client_onboarding_v2.sql",
  "supabase/migrations/0046_client_shopify_reconnect_targets.sql",
  "supabase/migrations/0048_parallel_client_asset_invitations.sql",
  "supabase/migrations/0049_incremental_google_ads_accounts.sql",
  "supabase/migrations/0050_new_client_shopify_setup.sql",
  "supabase/migrations/0051_client_identity_admin.sql",
  "supabase/migrations/0052_block_archived_client_review_replay.sql",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const ADMIN = "51000000-0000-4000-8000-000000000001";
const CLIENT = "51000000-0000-4000-8000-000000000002";
const NEW_CLIENT = "51000000-0000-4000-8000-000000000003";
const REFERRER = "51000000-0000-4000-8000-000000000004";
const NEW_SESSION = "51000000-0000-4000-8000-000000000005";
const OPEN_SESSION = "51000000-0000-4000-8000-000000000006";
const HISTORICAL_SESSION = "51000000-0000-4000-8000-000000000007";
const SHOPIFY = "51000000-0000-4000-8000-000000000008";
const GOOGLE = "51000000-0000-4000-8000-000000000009";
const MAPPING = "51000000-0000-4000-8000-000000000010";
const NEW_TOKEN = "a".repeat(64);
const OPEN_TOKEN = "b".repeat(64);

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
  approved_by uuid references auth.users(id),
  referral_code text,
  referred_by uuid references public.portal_clients(id)
);
create table public.client_members (
  client_id uuid not null references public.portal_clients(id),
  member_id uuid not null references public.portal_clients(id),
  primary key (client_id, member_id)
);
alter table public.portal_clients enable row level security;
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
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  amount numeric not null
);
alter table public.ad_accounts enable row level security;
alter table public.account_requests enable row level security;
create or replace function public.is_admin() returns boolean
language sql stable as $$ select auth.uid() = '${ADMIN}'::uuid $$;
create or replace function public.is_client_member(p_client_id uuid) returns boolean
language sql stable as $$ select p_client_id = auth.uid() $$;
create or replace function public.can_open_workspace(p_client_id uuid) returns boolean
language sql stable as $$
  select public.is_client_member(p_client_id)
    and exists (
      select 1 from public.portal_clients
      where id = p_client_id and approval_status = 'approved'
    )
$$;
create policy portal_clients_update_self on public.portal_clients
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
`;

let db: PGlite;

async function actAs(userId: string | null, role: string) {
  await db.query(
    "select set_config('test.uid', $1, false), set_config('test.role', $2, false)",
    [userId ?? "", role],
  );
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected SQLSTATE ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function createInvitation(
  sessionId: string,
  mode: "new_client" | "add_assets",
  targetClientId: string | null,
  token: string,
  assets: string[],
) {
  return db.query(
    `select public.create_client_onboarding_invitation(
       $1, $2, $3::text[], $4, $5, now() + interval '1 day', $6
     )`,
    [sessionId, mode, assets, targetClientId, token, ADMIN],
  );
}

async function claim(
  sessionId: string,
  token: string,
  userId: string,
  email: string,
  discord: string | null,
) {
  return db.query(
    `select public.claim_client_onboarding_identity(
       $1, $2, $3, 'Casey', 'Example', $4, $5
     )`,
    [sessionId, token, userId, email, discord],
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
            ($2, 'client@example.com', now()),
            ($3, 'new-client@example.com', now()),
            ($4, 'referrer@example.com', now())`,
    [ADMIN, CLIENT, NEW_CLIENT, REFERRER],
  );
  await db.query(
    `insert into public.profiles (id, role)
     values ($1, 'admin'), ($2, 'member'), ($3, 'member'), ($4, 'member')`,
    [ADMIN, CLIENT, NEW_CLIENT, REFERRER],
  );
  await actAs(null, "service_role");
});

describe("client identity admin migration", () => {
  it("claims Discord and materializes an approved new client when assets are reviewed", async () => {
    await createInvitation(
      NEW_SESSION,
      "new_client",
      null,
      NEW_TOKEN,
      ["shopify"],
    );
    await claim(
      NEW_SESSION,
      NEW_TOKEN,
      NEW_CLIENT,
      "new-client@example.com",
      "@casey.old#1234",
    );
    await db.query(
      `insert into public.client_shopify_connections (
         id, session_id, client_id, shopify_shop_id, shopify_name,
         shopify_domain, shopify_currency, credential_hint
       ) values (
         $1, $2, $3, 'gid://shopify/Shop/51', 'New Store',
         'new-store-51.myshopify.com', 'EUR', 'cdef'
       )`,
      [SHOPIFY, NEW_SESSION, NEW_CLIENT],
    );
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      NEW_SESSION,
      NEW_TOKEN,
    ]);
    await db.query(
      "select public.review_client_onboarding_session($1, $2, false)",
      [NEW_SESSION, ADMIN],
    );

    const result = await db.query<{
      session_status: string;
      session_discord: string | null;
      full_name: string;
      email: string;
      client_discord: string | null;
      approval_status: string;
      operational_surface: string;
    }>(
      `select session.status as session_status,
              session.discord_handle as session_discord,
              client.full_name, client.email,
              client.discord_handle as client_discord,
              client.approval_status, rollout.operational_surface
       from public.client_onboarding_sessions session
       join public.portal_clients client on client.id = session.claimed_user_id
       join public.client_rollout_states rollout on rollout.client_id = client.id
       where session.id = $1`,
      [NEW_SESSION],
    );
    expect(result.rows[0]).toEqual({
      session_status: "reviewed",
      session_discord: "casey.old#1234",
      full_name: "Casey Example",
      email: "new-client@example.com",
      client_discord: "casey.old#1234",
      approval_status: "approved",
      operational_surface: "v2_ready_for_cutover",
    });

    const oldOverload = await db.query<{
      old_claim_exists: boolean;
      anon_can_claim: boolean;
      authenticated_can_claim: boolean;
      service_can_claim: boolean;
    }>(
      `select to_regprocedure(
         'public.claim_client_onboarding_identity(uuid,text,uuid,text,text,text)'
       ) is not null as old_claim_exists,
       has_function_privilege(
         'anon',
         'public.claim_client_onboarding_identity(uuid,text,uuid,text,text,text)',
         'EXECUTE'
       ) as anon_can_claim,
       has_function_privilege(
         'authenticated',
         'public.claim_client_onboarding_identity(uuid,text,uuid,text,text,text)',
         'EXECUTE'
       ) as authenticated_can_claim,
       has_function_privilege(
         'service_role',
         'public.claim_client_onboarding_identity(uuid,text,uuid,text,text,text)',
         'EXECUTE'
       ) as service_can_claim`,
    );
    expect(oldOverload.rows[0]).toEqual({
      old_claim_exists: true,
      anon_can_claim: false,
      authenticated_can_claim: false,
      service_can_claim: true,
    });
  });

  it("requires a valid non-URL Discord username for new client claims", async () => {
    await createInvitation(NEW_SESSION, "new_client", null, NEW_TOKEN, []);
    await expectSqlState(
      claim(
        NEW_SESSION,
        NEW_TOKEN,
        NEW_CLIENT,
        "new-client@example.com",
        null,
      ),
      "22023",
    );
    await expectSqlState(
      claim(
        NEW_SESSION,
        NEW_TOKEN,
        NEW_CLIENT,
        "new-client@example.com",
        "https://discord.com/users/casey",
      ),
      "22023",
    );
  });

  it("keeps the previous app's service-only identity claim working during rollout", async () => {
    await createInvitation(NEW_SESSION, "new_client", null, NEW_TOKEN, []);
    await db.query(
      `select public.claim_client_onboarding_identity(
         $1, $2, $3, 'Legacy', 'Bundle', $4
       )`,
      [NEW_SESSION, NEW_TOKEN, NEW_CLIENT, "new-client@example.com"],
    );
    const claimed = await db.query<{
      status: string;
      claimed_user_id: string;
      discord_handle: string | null;
    }>(
      `select status, claimed_user_id, discord_handle
       from public.client_onboarding_sessions where id = $1`,
      [NEW_SESSION],
    );
    expect(claimed.rows[0]).toEqual({
      status: "collecting",
      claimed_user_id: NEW_CLIENT,
      discord_handle: null,
    });
  });

  it("never approves a new-client review before the Auth email is confirmed", async () => {
    await db.query(
      "update auth.users set email_confirmed_at = null where id = $1",
      [NEW_CLIENT],
    );
    await createInvitation(NEW_SESSION, "new_client", null, NEW_TOKEN, []);
    await claim(
      NEW_SESSION,
      NEW_TOKEN,
      NEW_CLIENT,
      "new-client@example.com",
      "casey.example",
    );
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      NEW_SESSION,
      NEW_TOKEN,
    ]);

    await expectSqlState(
      db.query(
        "select public.review_client_onboarding_session($1, $2, false)",
        [NEW_SESSION, ADMIN],
      ),
      "23514",
    );
    const state = await db.query<{ status: string; clients: string }>(
      `select session.status,
              (select count(*) from public.portal_clients where id = $2)::text as clients
       from public.client_onboarding_sessions session where session.id = $1`,
      [NEW_SESSION, NEW_CLIENT],
    );
    expect(state.rows[0]).toEqual({ status: "submitted", clients: "0" });
  });

  it("updates only the portal profile and normalizes optional Discord", async () => {
    await db.query(
      `insert into public.portal_clients (
         id, full_name, email, approval_status, approved_at, approved_by
       ) values ($1, 'Casey Example', 'client@example.com', 'approved', now(), $2)`,
      [CLIENT, ADMIN],
    );

    await db.query(
      `select public.update_portal_client_identity(
         $1, '  Casey    Updated  ', 'NEW-EMAIL@EXAMPLE.COM',
         '@casey.old#1234', $2
       )`,
      [CLIENT, ADMIN],
    );
    const updated = await db.query<{
      full_name: string;
      email: string;
      discord_handle: string | null;
      auth_email: string | null;
      approval_status: string;
    }>(
      `select client.full_name, client.email, client.discord_handle,
              auth_user.email as auth_email, client.approval_status
       from public.portal_clients client
       join auth.users auth_user on auth_user.id = client.id
       where client.id = $1`,
      [CLIENT],
    );
    expect(updated.rows[0]).toEqual({
      full_name: "Casey Updated",
      email: "new-email@example.com",
      discord_handle: "casey.old#1234",
      auth_email: "client@example.com",
      approval_status: "approved",
    });

    await db.query(
      "select public.update_portal_client_identity($1, 'Casey Updated', 'new-email@example.com', ' ', $2)",
      [CLIENT, ADMIN],
    );
    const cleared = await db.query<{ discord_handle: string | null }>(
      "select discord_handle from public.portal_clients where id = $1",
      [CLIENT],
    );
    expect(cleared.rows[0].discord_handle).toBeNull();

    await expectSqlState(
      db.query(
        "select public.update_portal_client_identity($1, 'Casey', 'casey@example.com', 'discord.com/casey', $2)",
        [CLIENT, ADMIN],
      ),
      "22023",
    );
  });

  it("archives access and open links without deleting any client data", async () => {
    await db.query(
      `insert into public.portal_clients (
         id, full_name, email, approval_status, approved_at, approved_by,
         referral_code, referred_by
       ) values
         ($1, 'Referrer', 'referrer@example.com', 'approved', now(), $3, 'REF51', null),
         ($2, 'Casey Example', 'client@example.com', 'approved', now(), $3, 'CASEY51', $1)`,
      [REFERRER, CLIENT, ADMIN],
    );
    await createInvitation(
      OPEN_SESSION,
      "add_assets",
      CLIENT,
      OPEN_TOKEN,
      ["shopify", "google_ads"],
    );
    await claim(
      OPEN_SESSION,
      OPEN_TOKEN,
      CLIENT,
      "client@example.com",
      "casey.old#1234",
    );
    await db.query(
      `insert into public.client_onboarding_secrets (
         session_id, windsor_access_token_ciphertext
       ) values ($1, 'encrypted-windsor-token')`,
      [OPEN_SESSION],
    );
    await db.query(
      `insert into public.client_shopify_connections (
         id, session_id, client_id, shopify_shop_id, shopify_name,
         shopify_domain, shopify_currency, credential_hint
       ) values (
         $1, $2, $3, 'gid://shopify/Shop/510', 'Preserved Store',
         'preserved-51.myshopify.com', 'EUR', 'cdef'
       )`,
      [SHOPIFY, OPEN_SESSION, CLIENT],
    );
    await db.query(
      `insert into public.client_shopify_credentials (
         connection_id, shopify_client_id, client_secret_ciphertext
       ) values ($1, 'shopify-client-id', 'encrypted-shopify-secret')`,
      [SHOPIFY],
    );
    await db.query(
      `insert into public.client_google_ads_connections (
         id, session_id, client_id, windsor_account_id, account_name
       ) values ($1, $2, $3, '510-510-5100', 'Preserved Ads')`,
      [GOOGLE, OPEN_SESSION, CLIENT],
    );
    await db.query(
      `insert into public.client_asset_mappings (
         id, session_id, shopify_connection_id, google_ads_connection_id
       ) values ($1, $2, $3, $4)`,
      [MAPPING, OPEN_SESSION, SHOPIFY, GOOGLE],
    );
    await db.query(
      `insert into public.ad_accounts (
         client_id, store_name, shopify_connected, shopify_admin_token
       ) values ($1, 'Legacy Store', true, 'legacy-shopify-token')`,
      [CLIENT],
    );
    await db.query(
      "insert into public.invoices (client_id, amount) values ($1, 125.50)",
      [CLIENT],
    );
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, mode, requested_assets, status, target_client_id,
         claimed_user_id, first_name, last_name, email,
         created_by, identity_created_at, submitted_at
       ) values (
         $1, 'add_assets', array['shopify']::text[], 'submitted', $2,
         $2, 'Casey', 'Example', 'client@example.com', $3, now(), now()
       )`,
      [HISTORICAL_SESSION, CLIENT, ADMIN],
    );

    await db.query("select public.archive_portal_client($1, $2)", [CLIENT, ADMIN]);
    await db.query("select public.archive_portal_client($1, $2)", [CLIENT, ADMIN]);

    const state = await db.query<{
      approval_status: string;
      approved_at: string | null;
      approved_by: string | null;
      referred_by: string | null;
      open_status: string;
      invite_token_hash: string | null;
      invite_expires_at: string | null;
      historical_status: string;
      onboarding_secrets: string;
      shopify_status: string;
      shopify_credentials: string;
      google_status: string;
      mappings: string;
      legacy_assets: string;
      invoices: string;
      auth_users: string;
      archive_events: string;
      operational_surface: string;
      rollout_session: string | null;
    }>(
      `select client.approval_status, client.approved_at::text, client.approved_by,
              client.referred_by,
              open_session.status as open_status,
              open_session.invite_token_hash,
              open_session.invite_expires_at::text,
              history.status as historical_status,
              (select count(*) from public.client_onboarding_secrets
               where session_id = $2)::text as onboarding_secrets,
              shopify.status as shopify_status,
              (select count(*) from public.client_shopify_credentials
               where connection_id = $3)::text as shopify_credentials,
              google.status as google_status,
              (select count(*) from public.client_asset_mappings
               where id = $4)::text as mappings,
              (select count(*) from public.ad_accounts
               where client_id = $1)::text as legacy_assets,
              (select count(*) from public.invoices
               where client_id = $1)::text as invoices,
              (select count(*) from auth.users
               where id = $1)::text as auth_users,
              (select count(*) from public.client_onboarding_events
               where session_id = $2
                 and event_type = 'invitation_revoked'
                 and details ->> 'reason' = 'client_archived')::text as archive_events,
              rollout.operational_surface,
              rollout.onboarding_session_id as rollout_session
       from public.portal_clients client
       join public.client_onboarding_sessions open_session on open_session.id = $2
       join public.client_onboarding_sessions history on history.id = $5
       join public.client_shopify_connections shopify on shopify.id = $3
       join public.client_google_ads_connections google on google.id = $6
       join public.client_rollout_states rollout on rollout.client_id = client.id
       where client.id = $1`,
      [CLIENT, OPEN_SESSION, SHOPIFY, MAPPING, HISTORICAL_SESSION, GOOGLE],
    );
    expect(state.rows[0]).toEqual({
      approval_status: "rejected",
      approved_at: null,
      approved_by: null,
      referred_by: REFERRER,
      open_status: "revoked",
      invite_token_hash: null,
      invite_expires_at: null,
      historical_status: "submitted",
      onboarding_secrets: "0",
      shopify_status: "connected",
      shopify_credentials: "1",
      google_status: "connected",
      mappings: "1",
      legacy_assets: "1",
      invoices: "1",
      auth_users: "1",
      archive_events: "1",
      operational_surface: "legacy_only",
      rollout_session: null,
    });
  });

  it("revokes owner and partner authorization when a workspace is archived", async () => {
    await db.query(
      `insert into public.portal_clients (id, full_name, email, approval_status)
       values ($1, 'Workspace Owner', 'client@example.com', 'approved'),
              ($2, 'Workspace Partner', 'new-client@example.com', 'approved')`,
      [CLIENT, NEW_CLIENT],
    );
    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [CLIENT, NEW_CLIENT],
    );

    await actAs(CLIENT, "authenticated");
    const ownerBefore = await db.query<{ member: boolean; open: boolean }>(
      "select public.is_client_member($1) as member, public.can_open_workspace($1) as open",
      [CLIENT],
    );
    expect(ownerBefore.rows[0]).toEqual({ member: true, open: true });

    await actAs(NEW_CLIENT, "authenticated");
    const partnerBefore = await db.query<{ member: boolean; open: boolean }>(
      "select public.is_client_member($1) as member, public.can_open_workspace($1) as open",
      [CLIENT],
    );
    expect(partnerBefore.rows[0]).toEqual({ member: true, open: true });

    await actAs(null, "service_role");
    await db.query("select public.archive_portal_client($1, $2)", [CLIENT, ADMIN]);

    await actAs(CLIENT, "authenticated");
    const ownerAfter = await db.query<{ member: boolean; open: boolean }>(
      "select public.is_client_member($1) as member, public.can_open_workspace($1) as open",
      [CLIENT],
    );
    expect(ownerAfter.rows[0]).toEqual({ member: false, open: false });
    await db.exec(
      `grant usage on schema public, auth to authenticated;
       grant select, update on public.portal_clients to authenticated;`,
    );
    await db.exec("set role authenticated");
    try {
      const blockedUpdate = await db.query<{ full_name: string }>(
        `update public.portal_clients set full_name = 'Should Not Persist'
         where id = $1 returning full_name`,
        [CLIENT],
      );
      expect(blockedUpdate.rows).toEqual([]);
    } finally {
      await db.exec("reset role");
    }

    await actAs(NEW_CLIENT, "authenticated");
    const partnerAfter = await db.query<{ member: boolean; open: boolean }>(
      "select public.is_client_member($1) as member, public.can_open_workspace($1) as open",
      [CLIENT],
    );
    expect(partnerAfter.rows[0]).toEqual({ member: false, open: false });
  });

  it("does not let a stale reviewed onboarding re-approve an archived client", async () => {
    await db.query(
      `insert into public.portal_clients (id, full_name, email, approval_status)
       values ($1, 'Casey Example', 'client@example.com', 'approved')`,
      [CLIENT],
    );
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, mode, requested_assets, status, target_client_id,
         claimed_user_id, first_name, last_name, email,
         created_by, identity_created_at, submitted_at, reviewed_at, reviewed_by
       ) values (
         $1, 'add_assets', array['shopify']::text[], 'reviewed', $2,
         $2, 'Casey', 'Example', 'client@example.com',
         $3, now(), now(), now(), $3
       )`,
      [HISTORICAL_SESSION, CLIENT, ADMIN],
    );

    await db.query("select public.archive_portal_client($1, $2)", [CLIENT, ADMIN]);
    await expectSqlState(
      db.query(
        "select public.review_client_onboarding_session($1, $2, false)",
        [HISTORICAL_SESSION, ADMIN],
      ),
      "23514",
    );

    const client = await db.query<{ approval_status: string }>(
      "select approval_status from public.portal_clients where id = $1",
      [CLIENT],
    );
    expect(client.rows[0].approval_status).toBe("rejected");
  });

  it("keeps admin targets protected and exposes admin RPCs only to service role", async () => {
    await db.query(
      `insert into public.portal_clients (id, full_name, email, approval_status)
       values ($1, 'Admin', 'admin@example.com', 'approved')`,
      [ADMIN],
    );
    await expectSqlState(
      db.query("select public.archive_portal_client($1, $1)", [ADMIN]),
      "42501",
    );
    await expectSqlState(
      db.query(
        "select public.update_portal_client_identity($1, 'Admin', 'admin@example.com', null, $1)",
        [ADMIN],
      ),
      "42501",
    );

    const privileges = await db.query<{
      anon_update: boolean;
      authenticated_update: boolean;
      service_update: boolean;
      anon_archive: boolean;
      authenticated_archive: boolean;
      service_archive: boolean;
    }>(
      `select
         has_function_privilege(
           'anon', 'public.update_portal_client_identity(uuid,text,text,text,uuid)', 'EXECUTE'
         ) as anon_update,
         has_function_privilege(
           'authenticated', 'public.update_portal_client_identity(uuid,text,text,text,uuid)', 'EXECUTE'
         ) as authenticated_update,
         has_function_privilege(
           'service_role', 'public.update_portal_client_identity(uuid,text,text,text,uuid)', 'EXECUTE'
         ) as service_update,
         has_function_privilege(
           'anon', 'public.archive_portal_client(uuid,uuid)', 'EXECUTE'
         ) as anon_archive,
         has_function_privilege(
           'authenticated', 'public.archive_portal_client(uuid,uuid)', 'EXECUTE'
         ) as authenticated_archive,
         has_function_privilege(
           'service_role', 'public.archive_portal_client(uuid,uuid)', 'EXECUTE'
         ) as service_archive`,
    );
    expect(privileges.rows[0]).toEqual({
      anon_update: false,
      authenticated_update: false,
      service_update: true,
      anon_archive: false,
      authenticated_archive: false,
      service_archive: true,
    });

    await actAs(CLIENT, "authenticated");
    await expectSqlState(
      db.query("select public.archive_portal_client($1, $2)", [ADMIN, ADMIN]),
      "42501",
    );
  });
});
