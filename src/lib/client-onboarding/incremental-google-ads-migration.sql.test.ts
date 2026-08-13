import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = [
  "supabase/migrations/0044_client_onboarding_v2.sql",
  "supabase/migrations/0046_client_shopify_reconnect_targets.sql",
  "supabase/migrations/0048_parallel_client_asset_invitations.sql",
  "supabase/migrations/0049_incremental_google_ads_accounts.sql",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const ADMIN = "49000000-0000-4000-8000-000000000001";
const CLIENT_A = "49000000-0000-4000-8000-000000000002";
const CLIENT_B = "49000000-0000-4000-8000-000000000003";
const OLD_SESSION = "49000000-0000-4000-8000-000000000004";
const CURRENT_SESSION = "49000000-0000-4000-8000-000000000005";
const OTHER_SESSION = "49000000-0000-4000-8000-000000000006";
const OLD_TOKEN = "a".repeat(64);
const CURRENT_TOKEN = "b".repeat(64);
const OTHER_TOKEN = "c".repeat(64);

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

type GoogleAccount = {
  windsorAccountId: string;
  accountName: string;
  currency: string | null;
  timeZone: string | null;
  dataSourceId: string | null;
};

type SavedAccount = {
  id: string;
  session_id: string;
  client_id: string;
  account_name: string;
  currency: string | null;
  time_zone: string | null;
  data_source_id: string | null;
  status: string;
  updated_at: string;
  last_verified_at: string | null;
  last_error_code: string | null;
};

const OLD_ONE: GoogleAccount = {
  windsorAccountId: "111-111-1111",
  accountName: "Existing Ads One",
  currency: "EUR",
  timeZone: "Europe/Lisbon",
  dataSourceId: "source-old-one",
};
const OLD_TWO: GoogleAccount = {
  windsorAccountId: "222-222-2222",
  accountName: "Existing Ads Two",
  currency: "GBP",
  timeZone: "Europe/London",
  dataSourceId: "source-old-two",
};
const NEW_ACCOUNT: GoogleAccount = {
  windsorAccountId: "333-333-3333",
  accountName: "New Ads Three",
  currency: "usd",
  timeZone: "America/New_York",
  dataSourceId: null,
};

let db: PGlite;

async function actAsService() {
  await db.query(
    "select set_config('test.uid', '', false), set_config('test.role', 'service_role', false)",
  );
}

async function openGoogleSession(
  sessionId: string,
  tokenHash: string,
  clientId: string,
  email: string,
) {
  await db.query(
    `select public.create_client_onboarding_invitation(
       $1, 'add_assets', array['google_ads']::text[], $2, $3,
       now() + interval '1 day', $4
     )`,
    [sessionId, clientId, tokenHash, ADMIN],
  );
  await db.query(
    `select public.claim_client_onboarding_identity(
       $1, $2, $3, 'Google', 'Client', $4
     )`,
    [sessionId, tokenHash, clientId, email],
  );
}

async function connectBatch(
  sessionId: string,
  tokenHash: string,
  accounts: GoogleAccount[],
) {
  return db.query<{ ids: string[] }>(
    "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb) as ids",
    [sessionId, tokenHash, JSON.stringify(accounts)],
  );
}

async function submit(sessionId: string, tokenHash: string) {
  return db.query(
    "select public.submit_client_onboarding_session($1, $2)",
    [sessionId, tokenHash],
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

async function savedAccounts(accountIds: string[]) {
  return db.query<SavedAccount>(
    `select id, session_id, client_id, account_name, currency, time_zone,
            data_source_id, status, updated_at::text, last_verified_at::text,
            last_error_code
     from public.client_google_ads_connections
     where windsor_account_id = any($1::text[])
     order by windsor_account_id`,
    [accountIds],
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
     values ($1, 'client-a@example.com', now()),
            ($2, 'client-b@example.com', now()),
            ($3, 'admin@example.com', now())`,
    [CLIENT_A, CLIENT_B, ADMIN],
  );
  await db.query(
    `insert into public.profiles (id, role)
     values ($1, 'member'), ($2, 'member'), ($3, 'admin')`,
    [CLIENT_A, CLIENT_B, ADMIN],
  );
  await db.query(
    `insert into public.portal_clients (
       id, full_name, email, approval_status, approved_at, approved_by
     ) values
       ($1, 'Client A', 'client-a@example.com', 'approved', now(), $3),
       ($2, 'Client B', 'client-b@example.com', 'approved', now(), $3)`,
    [CLIENT_A, CLIENT_B, ADMIN],
  );
  await actAsService();
});

describe("incremental Google Ads accounts migration", () => {
  it("keeps two older same-client accounts untouched and inserts only the new account", async () => {
    await openGoogleSession(OLD_SESSION, OLD_TOKEN, CLIENT_A, "client-a@example.com");
    const old = await connectBatch(OLD_SESSION, OLD_TOKEN, [OLD_ONE, OLD_TWO]);
    await submit(OLD_SESSION, OLD_TOKEN);
    const before = await savedAccounts([
      OLD_ONE.windsorAccountId,
      OLD_TWO.windsorAccountId,
    ]);

    await openGoogleSession(
      CURRENT_SESSION,
      CURRENT_TOKEN,
      CLIENT_A,
      "client-a@example.com",
    );
    const result = await connectBatch(CURRENT_SESSION, CURRENT_TOKEN, [
      {
        ...OLD_ONE,
        accountName: "Must Not Replace One",
        currency: "CAD",
        timeZone: "America/Toronto",
        dataSourceId: "replacement-one",
      },
      {
        ...OLD_TWO,
        accountName: "Must Not Replace Two",
        currency: "AUD",
        timeZone: "Australia/Sydney",
        dataSourceId: "replacement-two",
      },
      NEW_ACCOUNT,
    ]);

    expect(result.rows[0].ids.slice(0, 2)).toEqual(old.rows[0].ids);
    expect(result.rows[0].ids).toHaveLength(3);
    const after = await savedAccounts([
      OLD_ONE.windsorAccountId,
      OLD_TWO.windsorAccountId,
    ]);
    expect(after.rows).toEqual(before.rows);

    const inserted = await db.query<{
      id: string;
      session_id: string;
      client_id: string;
      account_name: string;
      currency: string;
    }>(
      `select id, session_id, client_id, account_name, currency
       from public.client_google_ads_connections
       where windsor_account_id = $1 and status = 'connected'`,
      [NEW_ACCOUNT.windsorAccountId],
    );
    expect(inserted.rows[0]).toEqual({
      id: result.rows[0].ids[2],
      session_id: CURRENT_SESSION,
      client_id: CLIENT_A,
      account_name: NEW_ACCOUNT.accountName,
      currency: "USD",
    });
    const currentEvents = await db.query<{ connection_id: string }>(
      `select details ->> 'connection_id' as connection_id
       from public.client_onboarding_events
       where session_id = $1 and event_type = 'google_connected'`,
      [CURRENT_SESSION],
    );
    expect(currentEvents.rows).toEqual([{ connection_id: result.rows[0].ids[2] }]);
    await expect(submit(CURRENT_SESSION, CURRENT_TOKEN)).resolves.toBeDefined();
  });

  it("rejects a cross-client account with 23505 and rolls back the whole batch", async () => {
    await openGoogleSession(
      OTHER_SESSION,
      OTHER_TOKEN,
      CLIENT_B,
      "client-b@example.com",
    );
    await connectBatch(OTHER_SESSION, OTHER_TOKEN, [OLD_ONE]);
    await submit(OTHER_SESSION, OTHER_TOKEN);
    const before = await savedAccounts([OLD_ONE.windsorAccountId]);

    await openGoogleSession(
      CURRENT_SESSION,
      CURRENT_TOKEN,
      CLIENT_A,
      "client-a@example.com",
    );
    await expectSqlState(
      connectBatch(CURRENT_SESSION, CURRENT_TOKEN, [
        NEW_ACCOUNT,
        { ...OLD_ONE, accountName: "Must Not Cross Clients" },
      ]),
      "23505",
    );

    const after = await savedAccounts([OLD_ONE.windsorAccountId]);
    expect(after.rows).toEqual(before.rows);
    const currentWrites = await db.query<{ accounts: string; events: string }>(
      `select
         (select count(*) from public.client_google_ads_connections
          where session_id = $1)::text as accounts,
         (select count(*) from public.client_onboarding_events
          where session_id = $1 and event_type = 'google_connected')::text as events`,
      [CURRENT_SESSION],
    );
    expect(currentWrites.rows[0]).toEqual({ accounts: "0", events: "0" });
  });

  it("returns an all-old same-client batch but does not satisfy current-session submit", async () => {
    await openGoogleSession(OLD_SESSION, OLD_TOKEN, CLIENT_A, "client-a@example.com");
    const old = await connectBatch(OLD_SESSION, OLD_TOKEN, [OLD_ONE, OLD_TWO]);
    await submit(OLD_SESSION, OLD_TOKEN);
    await openGoogleSession(
      CURRENT_SESSION,
      CURRENT_TOKEN,
      CLIENT_A,
      "client-a@example.com",
    );

    const result = await connectBatch(CURRENT_SESSION, CURRENT_TOKEN, [
      OLD_TWO,
      OLD_ONE,
    ]);
    expect(result.rows[0].ids).toEqual([
      old.rows[0].ids[1],
      old.rows[0].ids[0],
    ]);
    const currentAccounts = await db.query<{ count: string }>(
      `select count(*)::text as count
       from public.client_google_ads_connections
       where session_id = $1 and status = 'connected'`,
      [CURRENT_SESSION],
    );
    expect(currentAccounts.rows[0]).toEqual({ count: "0" });
    await expectSqlState(submit(CURRENT_SESSION, CURRENT_TOKEN), "23514");
    const session = await db.query<{ status: string }>(
      "select status from public.client_onboarding_sessions where id = $1",
      [CURRENT_SESSION],
    );
    expect(session.rows[0]).toEqual({ status: "collecting" });
  });

  it("refreshes same-current-session metadata idempotently", async () => {
    await openGoogleSession(
      CURRENT_SESSION,
      CURRENT_TOKEN,
      CLIENT_A,
      "client-a@example.com",
    );
    const first = await connectBatch(CURRENT_SESSION, CURRENT_TOKEN, [OLD_ONE]);
    await db.query(
      `update public.client_google_ads_connections
       set last_error_code = 'stale_metadata'
       where id = $1`,
      [first.rows[0].ids[0]],
    );
    const refreshedAccount: GoogleAccount = {
      ...OLD_ONE,
      accountName: "Refreshed Ads One",
      currency: "usd",
      timeZone: "America/Chicago",
      dataSourceId: null,
    };

    const second = await connectBatch(CURRENT_SESSION, CURRENT_TOKEN, [
      refreshedAccount,
    ]);
    const third = await connectBatch(CURRENT_SESSION, CURRENT_TOKEN, [
      refreshedAccount,
    ]);
    expect(second.rows[0].ids).toEqual(first.rows[0].ids);
    expect(third.rows[0].ids).toEqual(first.rows[0].ids);

    const saved = await db.query<{
      id: string;
      session_id: string;
      client_id: string;
      account_name: string;
      currency: string;
      time_zone: string;
      data_source_id: string | null;
      last_error_code: string | null;
    }>(
      `select id, session_id, client_id, account_name, currency, time_zone,
              data_source_id, last_error_code
       from public.client_google_ads_connections
       where windsor_account_id = $1`,
      [OLD_ONE.windsorAccountId],
    );
    expect(saved.rows).toEqual([
      {
        id: first.rows[0].ids[0],
        session_id: CURRENT_SESSION,
        client_id: CLIENT_A,
        account_name: refreshedAccount.accountName,
        currency: "USD",
        time_zone: refreshedAccount.timeZone,
        data_source_id: null,
        last_error_code: null,
      },
    ]);
    const events = await db.query<{ count: string }>(
      `select count(*)::text as count
       from public.client_onboarding_events
       where session_id = $1 and event_type = 'google_connected'`,
      [CURRENT_SESSION],
    );
    expect(events.rows[0]).toEqual({ count: "1" });
  });

  it("validates the full batch before inserting its valid prefix", async () => {
    await openGoogleSession(
      CURRENT_SESSION,
      CURRENT_TOKEN,
      CLIENT_A,
      "client-a@example.com",
    );
    const invalid = { ...OLD_TWO, unexpected: "not allowed" };
    await expectSqlState(
      db.query(
        "select public.upsert_client_google_ads_connections($1, $2, $3::jsonb)",
        [
          CURRENT_SESSION,
          CURRENT_TOKEN,
          JSON.stringify([NEW_ACCOUNT, invalid]),
        ],
      ),
      "22023",
    );
    const writes = await db.query<{ accounts: string; events: string }>(
      `select
         (select count(*) from public.client_google_ads_connections
          where session_id = $1)::text as accounts,
         (select count(*) from public.client_onboarding_events
          where session_id = $1 and event_type = 'google_connected')::text as events`,
      [CURRENT_SESSION],
    );
    expect(writes.rows[0]).toEqual({ accounts: "0", events: "0" });
  });
});
