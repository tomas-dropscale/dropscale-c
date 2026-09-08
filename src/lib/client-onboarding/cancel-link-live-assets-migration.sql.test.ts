import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Cancelling an onboarding link when one of the assets it delivered is already
 * live in reporting.
 *
 * The lineage matters here: 0048 owns the cancel RPC, 0054 owns the reporting
 * bindings and the guards that protect a bound connection. Both are applied
 * for real, so the failure this migration fixes is reproduced exactly as
 * production hit it, and 0099 is applied mid-test to prove the before/after.
 */

const BASE_MIGRATION = [
  "supabase/migrations/0044_client_onboarding_v2.sql",
  "supabase/migrations/0046_client_shopify_reconnect_targets.sql",
  "supabase/migrations/0047_legacy_shopify_disconnect.sql",
  "supabase/migrations/0048_parallel_client_asset_invitations.sql",
  "supabase/migrations/0054_client_reporting_bindings.sql",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const CANCEL_KEEPS_LIVE_MIGRATION = readFileSync(
  "supabase/migrations/0099_cancel_link_keeps_live_assets.sql",
  "utf8",
);

const ADMIN = "99000000-0000-4000-8000-000000000001";
const CLIENT = "99000000-0000-4000-8000-000000000002";
const OPEN_SESSION = "99000000-0000-4000-8000-000000000010";
const OTHER_SESSION = "99000000-0000-4000-8000-000000000011";
const LIVE_SHOPIFY = "99000000-0000-4000-8000-000000000020";
const SPARE_SHOPIFY = "99000000-0000-4000-8000-000000000021";
const LIVE_GOOGLE = "99000000-0000-4000-8000-000000000030";
const ANCHOR_ACCOUNT = "99000000-0000-4000-8000-000000000040";
const CHILD_ACCOUNT = "99000000-0000-4000-8000-000000000041";
const ANCHOR_BINDING = "99000000-0000-4000-8000-000000000050";
const CHILD_BINDING = "99000000-0000-4000-8000-000000000051";
const OPEN_TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const LIVE_DOMAIN = "amelia-bristol.myshopify.com";
const SPARE_DOMAIN = "spare-store.myshopify.com";

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
  google_ads_customer_id text,
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

async function actAs(uid: string | null, role: string) {
  await db.query("select set_config('test.uid', $1, false)", [uid ?? ""]);
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function cancel(sessionId = OPEN_SESSION) {
  return db.query<{ id: string }>(
    "select public.revoke_client_onboarding_session($1, $2) as id",
    [sessionId, ADMIN],
  );
}

async function connectionStates() {
  const rows = await db.query<{
    id: string;
    status: string;
    credential_hint: string | null;
  }>(
    "select id, status, credential_hint from public.client_shopify_connections order by id",
  );
  return rows.rows;
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  await db.exec(PRELUDE);
  await db.exec(BASE_MIGRATION);

  await db.query(
    `insert into auth.users (id, email, email_confirmed_at)
     values ($1, 'admin@example.com', now()), ($2, 'client@example.com', now())`,
    [ADMIN, CLIENT],
  );
  await db.query(
    "insert into public.profiles (id, role) values ($1, 'admin'), ($2, 'member')",
    [ADMIN, CLIENT],
  );
  await db.query(
    `insert into public.portal_clients (id, full_name, email, approval_status)
     values ($1, 'Diogo e Patricia', 'client@example.com', 'approved')`,
    [CLIENT],
  );
  await db.query(
    `insert into public.ad_accounts (id, client_id, store_name, shopify_url)
     values ($1, $2, 'Amelia Bristol', $3), ($4, $2, 'Lia Google', null)`,
    [ANCHOR_ACCOUNT, CLIENT, LIVE_DOMAIN, CHILD_ACCOUNT],
  );
  await actAs(null, "service_role");

  // An earlier link delivered the Google account and was closed; only then
  // could the current one be sent - a client holds one open slot per asset,
  // which is exactly why the open link below has to be cancellable.
  await db.query(
    `select public.create_client_onboarding_invitation(
       $1, 'add_assets', array['google_ads']::text[], $2, $3,
       now() + interval '7 days', $4
     )`,
    [OTHER_SESSION, CLIENT, OTHER_TOKEN, ADMIN],
  );
  await db.query(
    `update public.client_onboarding_sessions
     set status = 'reviewed', claimed_user_id = $3, submitted_at = now(),
         reviewed_at = now(), reviewed_by = $2,
         invite_token_hash = null, invite_expires_at = null
     where id = $1`,
    [OTHER_SESSION, ADMIN, CLIENT],
  );
  // The link still open: it asked for both assets and only the store arrived.
  await db.query(
    `select public.create_client_onboarding_invitation(
       $1, 'add_assets', array['shopify','google_ads']::text[], $2, $3,
       now() + interval '7 days', $4
     )`,
    [OPEN_SESSION, CLIENT, OPEN_TOKEN, ADMIN],
  );

  // The store the client delivered through the open link, plus a second one
  // nobody ever bound.
  for (const [id, domain, shopId, hint] of [
    [LIVE_SHOPIFY, LIVE_DOMAIN, "gid://shopify/Shop/990", "live"],
    [SPARE_SHOPIFY, SPARE_DOMAIN, "gid://shopify/Shop/991", "spare"],
  ] as const) {
    await db.query(
      `insert into public.client_shopify_connections (
         id, session_id, client_id, status, shopify_shop_id, shopify_name,
         shopify_domain, shopify_currency, credential_hint, granted_scopes,
         last_verified_at
       ) values ($1, $2, $3, 'connected', $4, 'Store', $5, 'EUR', $6,
         array['read_orders']::text[], now())`,
      [id, OPEN_SESSION, CLIENT, shopId, domain, hint],
    );
    await db.query(
      `insert into public.client_shopify_credentials (
         connection_id, shopify_client_id, client_secret_ciphertext
       ) values ($1, 'client-id', 'ciphertext')`,
      [id],
    );
  }
  await db.query(
    `insert into public.client_google_ads_connections (
       id, session_id, client_id, status, windsor_account_id, account_name,
       currency, time_zone, last_verified_at
     ) values ($1, $2, $3, 'connected', '385-546-6298', 'Lia Ads', 'EUR',
       'Europe/Lisbon', now())`,
    [LIVE_GOOGLE, OTHER_SESSION, CLIENT],
  );
  // The mapping that ties the Google account to the store from the open link.
  await db.query(
    `insert into public.client_asset_mappings (
       session_id, shopify_connection_id, google_ads_connection_id
     ) values ($1, $2, $3)`,
    [OTHER_SESSION, LIVE_SHOPIFY, LIVE_GOOGLE],
  );
  // Reporting is live on both: the store is an anchor, the Google account is
  // a child under it. Inserted directly - the commit RPC's own validation is
  // covered by its own harness; what this suite needs is the bindings' shape.
  await db.query(
    `insert into public.client_reporting_bindings (
       id, client_id, ad_account_id, shopify_connection_id,
       google_ads_connection_id, shopify_anchor_binding_id, status,
       idempotency_key, bound_reason, bound_by
     ) values
       ($1, $3, $4, $6, null, null, 'active', 'anchor:live', 'Reviewed', $8),
       ($2, $3, $5, null, $7, $1, 'active', 'child:live', 'Reviewed', $8)`,
    [
      ANCHOR_BINDING,
      CHILD_BINDING,
      CLIENT,
      ANCHOR_ACCOUNT,
      CHILD_ACCOUNT,
      LIVE_SHOPIFY,
      LIVE_GOOGLE,
      ADMIN,
    ],
  );
});

describe("cancelling an onboarding link that delivered a live asset (0099)", () => {
  it("is impossible before the fix: the reporting guards refuse the withdrawal", async () => {
    // Exactly what production hit: the mapping the live child resolves through
    // belongs to the open link, so the cancellation aborts and the link can
    // never be closed.
    await expectSqlState(cancel(), "23514");

    const session = await db.query<{ status: string }>(
      "select status from public.client_onboarding_sessions where id = $1",
      [OPEN_SESSION],
    );
    // Still open, and no other action can close it: the client keeps a link
    // it cannot use and cannot replace.
    expect(session.rows[0]!.status).toBe("pending");
  });

  it("cancels the link, keeps the live store, and withdraws only what nothing uses", async () => {
    await db.exec(CANCEL_KEEPS_LIVE_MIGRATION);

    const cancelled = await cancel();
    expect(cancelled.rows[0]!.id).toBe(OPEN_SESSION);

    // The link is closed and can never be used again.
    const session = await db.query<{
      status: string;
      invite_token_hash: string | null;
      invite_expires_at: string | null;
    }>(
      `select status, invite_token_hash, invite_expires_at
       from public.client_onboarding_sessions where id = $1`,
      [OPEN_SESSION],
    );
    expect(session.rows[0]).toMatchObject({
      status: "revoked",
      invite_token_hash: null,
      invite_expires_at: null,
    });

    // The live store survives untouched; the spare one is withdrawn.
    expect(await connectionStates()).toEqual([
      { id: LIVE_SHOPIFY, status: "connected", credential_hint: "live" },
      { id: SPARE_SHOPIFY, status: "revoked", credential_hint: null },
    ]);

    // Its credentials and its store mapping - what reporting reads every sync
    // - are still there; the spare store's credentials are gone.
    const credentials = await db.query<{ connection_id: string }>(
      "select connection_id from public.client_shopify_credentials",
    );
    expect(credentials.rows).toEqual([{ connection_id: LIVE_SHOPIFY }]);
    const mappings = await db.query<{ shopify_connection_id: string }>(
      "select shopify_connection_id from public.client_asset_mappings",
    );
    expect(mappings.rows).toEqual([{ shopify_connection_id: LIVE_SHOPIFY }]);

    // Both bindings keep reporting exactly as before.
    const bindings = await db.query<{ id: string; status: string }>(
      "select id, status from public.client_reporting_bindings order by id",
    );
    expect(bindings.rows).toEqual([
      { id: ANCHOR_BINDING, status: "active" },
      { id: CHILD_BINDING, status: "active" },
    ]);

    // A withdrawal did happen (the spare store), so the audit says so.
    const events = await db.query<{ event_type: string }>(
      `select event_type from public.client_onboarding_events
       where session_id = $1 order by created_at desc limit 1`,
      [OPEN_SESSION],
    );
    expect(events.rows[0]!.event_type).toBe("connections_revoked");
  });

  it("withdraws nothing, and says so, when every asset of the link is live", async () => {
    await db.exec(CANCEL_KEEPS_LIVE_MIGRATION);
    // The spare store leaves the picture: now the link owns only the live one.
    await db.query("delete from public.client_shopify_credentials where connection_id = $1", [
      SPARE_SHOPIFY,
    ]);
    await db.query("delete from public.client_shopify_connections where id = $1", [
      SPARE_SHOPIFY,
    ]);

    await cancel();

    expect(await connectionStates()).toEqual([
      { id: LIVE_SHOPIFY, status: "connected", credential_hint: "live" },
    ]);
    const events = await db.query<{ event_type: string }>(
      `select event_type from public.client_onboarding_events
       where session_id = $1 order by created_at desc limit 1`,
      [OPEN_SESSION],
    );
    expect(events.rows[0]!.event_type).toBe("invitation_revoked");
  });

  it("still withdraws everything when the link's assets are not in reporting", async () => {
    // The unchanged case, proven after the fix: a link whose assets nobody
    // bound is cancelled exactly as it always was.
    await db.exec(CANCEL_KEEPS_LIVE_MIGRATION);
    for (const binding of [CHILD_BINDING, ANCHOR_BINDING]) {
      await db.query(
        `update public.client_reporting_bindings
         set status = 'revoked', revoked_by = $2, revoked_at = now(),
             revoke_reason = 'Reporting released before the test'
         where id = $1`,
        [binding, ADMIN],
      );
    }

    await cancel();

    expect(await connectionStates()).toEqual([
      { id: LIVE_SHOPIFY, status: "revoked", credential_hint: null },
      { id: SPARE_SHOPIFY, status: "revoked", credential_hint: null },
    ]);
    const credentials = await db.query<{ n: string }>(
      "select count(*)::text as n from public.client_shopify_credentials",
    );
    expect(credentials.rows[0]!.n).toBe("0");
    const mappings = await db.query<{ n: string }>(
      "select count(*)::text as n from public.client_asset_mappings",
    );
    expect(mappings.rows[0]!.n).toBe("0");
  });

  it("never reaches across links: another link's assets and status are untouched", async () => {
    await db.exec(CANCEL_KEEPS_LIVE_MIGRATION);

    await cancel();

    const google = await db.query<{ status: string }>(
      "select status from public.client_google_ads_connections where id = $1",
      [LIVE_GOOGLE],
    );
    expect(google.rows[0]!.status).toBe("connected");
    const other = await db.query<{ status: string }>(
      "select status from public.client_onboarding_sessions where id = $1",
      [OTHER_SESSION],
    );
    expect(other.rows[0]!.status).toBe("reviewed");
  });
});
