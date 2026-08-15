import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0063_connected_clients_auto_approval.sql",
  "utf8",
);

const ADMIN = "63000000-0000-4000-8000-000000000001";
const CONNECTED = "63000000-0000-4000-8000-000000000002";
const EMPTY = "63000000-0000-4000-8000-000000000003";
const REJECTED = "63000000-0000-4000-8000-000000000004";
const LEGACY = "63000000-0000-4000-8000-000000000005";
const INVALID_LEGACY = "63000000-0000-4000-8000-000000000006";
const NEW_CLIENT = "63000000-0000-4000-8000-000000000007";

const SUBMITTED_SESSION = "63000000-0000-4000-8000-000000000010";
const REJECTED_SESSION = "63000000-0000-4000-8000-000000000011";
const NEW_SESSION = "63000000-0000-4000-8000-000000000012";

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
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create or replace function public.normalize_shopify_reporting_domain(p_value text)
returns text language sql immutable strict as $$
  select nullif(lower(regexp_replace(
    regexp_replace(btrim(p_value), '^https?://', '', 'i'), '/.*$', ''
  )), '')
$$;

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null,
  discord_handle text,
  approval_status text not null,
  approved_at timestamptz,
  approved_by uuid
);

create table public.client_onboarding_sessions (
  id uuid primary key,
  mode text not null,
  requested_assets text[] not null,
  status text not null,
  invite_token_hash text,
  invite_expires_at timestamptz,
  target_client_id uuid,
  claimed_user_id uuid,
  first_name text,
  last_name text,
  email text,
  discord_handle text,
  reconnect_completed_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid,
  updated_at timestamptz not null default now(),
  last_error_code text,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table public.client_shopify_connections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  client_id uuid not null,
  status text not null
);
create table public.client_google_ads_connections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  client_id uuid not null,
  status text not null
);
create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  shopify_connected boolean not null default false,
  shopify_url text,
  google_ads_connected boolean not null default false,
  google_ads_customer_id text
);
create table public.client_onboarding_secrets (
  session_id uuid primary key references public.client_onboarding_sessions(id)
);
create table public.client_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  event_type text not null,
  actor_type text not null,
  actor_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create table public.client_rollout_states (
  client_id uuid primary key references public.portal_clients(id),
  operational_surface text not null,
  onboarding_session_id uuid references public.client_onboarding_sessions(id),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
`;

let db: PGlite;

async function status(clientId: string) {
  const result = await db.query<{ approval_status: string; approved_by: string | null }>(
    "select approval_status, approved_by from public.portal_clients where id = $1",
    [clientId],
  );
  return result.rows[0] ?? null;
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected SQLSTATE ${code}`);
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

  await db.query(
    `insert into public.portal_clients (
       id, full_name, email, approval_status, approved_by
     ) values
       ($1, 'Connected', 'connected@example.com', 'pending', $6),
       ($2, 'Empty', 'empty@example.com', 'pending', null),
       ($3, 'Archived', 'archived@example.com', 'rejected', $6),
       ($4, 'Legacy', 'legacy@example.com', 'pending', null),
       ($5, 'Invalid legacy', 'invalid@example.com', 'pending', null)`,
    [CONNECTED, EMPTY, REJECTED, LEGACY, INVALID_LEGACY, ADMIN],
  );
  await db.query(
    `insert into public.client_onboarding_sessions (
       id, mode, requested_assets, status, claimed_user_id,
       first_name, last_name, email, discord_handle, created_by
     ) values
       ($1, 'add_assets', array['shopify'], 'submitted', $4,
        'Connected', 'Client', 'connected@example.com', null, $7),
       ($2, 'add_assets', array['google_ads'], 'submitted', $5,
        'Archived', 'Client', 'archived@example.com', null, $7),
       ($3, 'new_client', array['shopify'], 'collecting', $6,
        'New', 'Client', 'new@example.com', 'new.client', $7)`,
    [
      SUBMITTED_SESSION,
      REJECTED_SESSION,
      NEW_SESSION,
      CONNECTED,
      REJECTED,
      NEW_CLIENT,
      ADMIN,
    ],
  );
  await db.query(
    `insert into public.client_shopify_connections (session_id, client_id, status)
     values ($1, $2, 'connected'), ($3, $4, 'connected')`,
    [SUBMITTED_SESSION, CONNECTED, NEW_SESSION, NEW_CLIENT],
  );
  await db.query(
    `insert into public.client_google_ads_connections (session_id, client_id, status)
     values ($1, $2, 'connected')`,
    [REJECTED_SESSION, REJECTED],
  );
  await db.query(
    `insert into public.ad_accounts (
       client_id, shopify_connected, shopify_url,
       google_ads_connected, google_ads_customer_id
     ) values
       ($1, true, 'legacy.myshopify.com', false, null),
       ($2, true, 'not-shopify.example.com', false, null)`,
    [LEGACY, INVALID_LEGACY],
  );

  await db.exec(MIGRATION);
  await db.query("select set_config('test.role', 'service_role', false)");
});

describe("0063 connected-client automatic approval", () => {
  it("backfills only clients with a valid connected asset and never revives archived clients", async () => {
    expect(await status(CONNECTED)).toEqual({
      approval_status: "approved",
      approved_by: null,
    });
    expect(await status(LEGACY)).toEqual({
      approval_status: "approved",
      approved_by: null,
    });
    expect(await status(EMPTY)).toEqual({
      approval_status: "pending",
      approved_by: null,
    });
    expect(await status(INVALID_LEGACY)).toEqual({
      approval_status: "pending",
      approved_by: null,
    });
    expect(await status(REJECTED)).toEqual({
      approval_status: "rejected",
      approved_by: ADMIN,
    });

    const sessions = await db.query<{ id: string; status: string }>(
      `select id, status from public.client_onboarding_sessions
       where id in ($1, $2) order by id`,
      [SUBMITTED_SESSION, REJECTED_SESSION],
    );
    expect(sessions.rows).toEqual([
      { id: SUBMITTED_SESSION, status: "reviewed" },
      { id: REJECTED_SESSION, status: "submitted" },
    ]);
    expect(await status(NEW_CLIENT)).toEqual({
      approval_status: "approved",
      approved_by: null,
    });
  });

  it("approves future connected Shopify, Google and legacy rows but ignores revoked assets", async () => {
    const shopClient = "63000000-0000-4000-8000-000000000020";
    const googleClient = "63000000-0000-4000-8000-000000000021";
    const revokedClient = "63000000-0000-4000-8000-000000000022";
    const legacyClient = "63000000-0000-4000-8000-000000000023";
    const mismatchedClient = "63000000-0000-4000-8000-000000000024";
    const sessions = [
      "63000000-0000-4000-8000-000000000030",
      "63000000-0000-4000-8000-000000000031",
      "63000000-0000-4000-8000-000000000032",
    ];
    await db.query(
      `insert into public.portal_clients (id, full_name, email, approval_status)
       values
         ($1, 'Shop', 'shop@example.com', 'pending'),
         ($2, 'Google', 'google@example.com', 'pending'),
         ($3, 'Revoked', 'revoked@example.com', 'pending'),
         ($4, 'Legacy Google', 'legacy-google@example.com', 'pending'),
         ($5, 'Mismatched', 'mismatched@example.com', 'pending')`,
      [shopClient, googleClient, revokedClient, legacyClient, mismatchedClient],
    );
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, mode, requested_assets, status, claimed_user_id,
         first_name, last_name, email, created_by
       ) values
         ($1, 'add_assets', array['shopify'], 'collecting', $4,
          'Shop', 'Client', 'shop@example.com', $7),
         ($2, 'add_assets', array['google_ads'], 'collecting', $5,
          'Google', 'Client', 'google@example.com', $7),
         ($3, 'add_assets', array['shopify'], 'collecting', $6,
          'Revoked', 'Client', 'revoked@example.com', $7)`,
      [...sessions, shopClient, googleClient, revokedClient, ADMIN],
    );

    await db.query(
      `insert into public.client_shopify_connections (session_id, client_id, status)
       values ($1, $2, 'connected'), ($3, $4, 'revoked')`,
      [sessions[0], shopClient, sessions[2], revokedClient],
    );
    await db.query(
      `insert into public.client_google_ads_connections (session_id, client_id, status)
       values ($1, $2, 'connected'), ($3, $4, 'connected')`,
      [sessions[1], googleClient, sessions[2], mismatchedClient],
    );
    await db.query(
      `insert into public.ad_accounts (
         client_id, google_ads_connected, google_ads_customer_id
       ) values ($1, true, '1234567890')`,
      [legacyClient],
    );

    expect((await status(shopClient))?.approval_status).toBe("approved");
    expect((await status(googleClient))?.approval_status).toBe("approved");
    expect((await status(legacyClient))?.approval_status).toBe("approved");
    expect((await status(revokedClient))?.approval_status).toBe("pending");
    expect((await status(mismatchedClient))?.approval_status).toBe("pending");

    await db.query(
      `update public.client_shopify_connections set status = 'connected'
       where client_id = $1`,
      [revokedClient],
    );
    expect((await status(revokedClient))?.approval_status).toBe("approved");
  });

  it("reviews an asset-bearing submission atomically and leaves account-only clients empty", async () => {
    const connectedClient = "63000000-0000-4000-8000-000000000040";
    const emptyClient = "63000000-0000-4000-8000-000000000041";
    const connectedSession = "63000000-0000-4000-8000-000000000050";
    const emptySession = "63000000-0000-4000-8000-000000000051";
    const token = "a".repeat(64);
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, mode, requested_assets, status, invite_token_hash, invite_expires_at,
         claimed_user_id, first_name, last_name, email, discord_handle, created_by
       ) values
         ($1, 'new_client', array['shopify'], 'collecting', $3, now() + interval '1 day',
          $4, 'Connected', 'New', 'connected-new@example.com', 'connected.new', $6),
         ($2, 'new_client', array[]::text[], 'collecting', $3, now() + interval '1 day',
          $5, 'Empty', 'New', 'empty-new@example.com', 'empty.new', $6)`,
      [connectedSession, emptySession, token, connectedClient, emptyClient, ADMIN],
    );
    await db.query(
      `insert into public.client_shopify_connections (session_id, client_id, status)
       values ($1, $2, 'connected')`,
      [connectedSession, connectedClient],
    );

    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      connectedSession,
      token,
    ]);
    await db.query("select public.submit_client_onboarding_session($1, $2)", [
      emptySession,
      token,
    ]);

    const saved = await db.query<{ id: string; status: string }>(
      `select id, status from public.client_onboarding_sessions
       where id in ($1, $2) order by id`,
      [connectedSession, emptySession],
    );
    expect(saved.rows).toEqual([
      { id: connectedSession, status: "reviewed" },
      { id: emptySession, status: "submitted" },
    ]);
    expect((await status(connectedClient))?.approval_status).toBe("approved");
    expect(await status(emptyClient)).toBeNull();

    const events = await db.query<{ event_type: string; actor_type: string }>(
      `select event_type, actor_type from public.client_onboarding_events
       where session_id = $1 order by created_at, event_type`,
      [connectedSession],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows).toEqual(
      expect.arrayContaining([
        { event_type: "submitted", actor_type: "client" },
        { event_type: "reviewed", actor_type: "system" },
      ]),
    );
  });

  it("rejects a submission replay for an archived client", async () => {
    await db.query(
      `update public.client_onboarding_sessions
       set status = 'collecting', invite_token_hash = $2,
           invite_expires_at = now() + interval '1 day'
       where id = $1`,
      [REJECTED_SESSION, "b".repeat(64)],
    );

    await expectSqlState(
      db.query("select public.submit_client_onboarding_session($1, $2)", [
        REJECTED_SESSION,
        "b".repeat(64),
      ]),
      "23514",
    );
    expect((await status(REJECTED))?.approval_status).toBe("rejected");
  });
});
