import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync("supabase/migrations/0086_admin_google_ads_label.sql", "utf8");

const ADMIN = "86000000-0000-4000-8000-000000000001";
const MEMBER = "86000000-0000-4000-8000-000000000002";
const CLIENT = "86000000-0000-4000-8000-000000000003";
const SESSION = "86000000-0000-4000-8000-000000000010";
const GOOGLE = "86000000-0000-4000-8000-000000000020";
const MISSING = "86000000-0000-4000-8000-000000000099";

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
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);
create table public.portal_clients (
  id uuid primary key,
  approval_status text not null
);
create table public.client_onboarding_sessions (
  id uuid primary key,
  status text not null,
  claimed_user_id uuid
);
create table public.client_google_ads_connections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  client_id uuid not null references public.portal_clients(id),
  status text not null,
  windsor_account_id text not null,
  account_name text not null,
  currency text,
  time_zone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  last_error_code text
);
`;

let db: PGlite;

async function actAs(role: string) {
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected SQLSTATE ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function rename(label: string | null, options: { connection?: string; admin?: string } = {}) {
  return db.query<{ id: string }>(
    "select public.set_client_google_ads_admin_label($1, $2, $3) as id",
    [options.connection ?? GOOGLE, label, options.admin ?? ADMIN],
  );
}

async function row() {
  const result = await db.query<{
    account_name: string;
    admin_label: string | null;
    admin_label_set_by: string | null;
    admin_label_set_at: string | null;
    updated_at: string;
  }>(
    "select account_name, admin_label, admin_label_set_by, admin_label_set_at, updated_at from public.client_google_ads_connections where id = $1",
    [GOOGLE],
  );
  return result.rows[0];
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);
  await db.query("insert into public.profiles (id, role) values ($1, 'admin'), ($2, 'member')", [
    ADMIN,
    MEMBER,
  ]);
  await db.query("insert into public.portal_clients (id, approval_status) values ($1, 'approved')", [
    CLIENT,
  ]);
  await db.query(
    "insert into public.client_onboarding_sessions (id, status, claimed_user_id) values ($1, 'reviewed', $2)",
    [SESSION, CLIENT],
  );
  await db.query(
    `insert into public.client_google_ads_connections
       (id, session_id, client_id, status, windsor_account_id, account_name)
     values ($1, $2, $3, 'connected', '760-812-4103', '760-812-4103')`,
    [GOOGLE, SESSION, CLIENT],
  );
  await actAs("service_role");
});

describe("0086 admin Google Ads label", () => {
  it("records the name, its author and when it was set", async () => {
    const result = await rename("MA CHERRIE MODE Ads");

    expect(result.rows[0]?.id).toBe(GOOGLE);
    const stored = await row();
    expect(stored).toMatchObject({
      admin_label: "MA CHERRIE MODE Ads",
      admin_label_set_by: ADMIN,
    });
    expect(stored?.admin_label_set_at).not.toBeNull();
  });

  it("leaves the Windsor name alone so a reconnect still has its own record", async () => {
    await rename("MA CHERRIE MODE Ads");

    expect((await row())?.account_name).toBe("760-812-4103");
  });

  it("does not disturb updated_at, which the reporting projection keys actions on", async () => {
    const before = (await row())?.updated_at;

    await rename("MA CHERRIE MODE Ads");

    expect(String((await row())?.updated_at)).toBe(String(before));
  });

  it("clears the name and its authorship together when the label is emptied", async () => {
    await rename("MA CHERRIE MODE Ads");

    await rename("   ");

    expect(await row()).toMatchObject({
      admin_label: null,
      admin_label_set_by: null,
      admin_label_set_at: null,
    });
  });

  it("trims a padded name rather than storing the padding", async () => {
    await rename("  Casa Luna  ");

    expect((await row())?.admin_label).toBe("Casa Luna");
  });

  it.each([
    ["longer than the column allows", "x".repeat(81)],
    ["carrying a control character", `Casa${String.fromCharCode(7)}Luna`],
  ])("refuses a name %s", async (_case, label) => {
    await expectSqlState(rename(label), "22023");
    expect((await row())?.admin_label).toBeNull();
  });

  it("refuses a caller who is not the server", async () => {
    await actAs("authenticated");

    await expectSqlState(rename("Casa Luna"), "42501");
  });

  it("refuses an actor who is not an admin", async () => {
    await expectSqlState(rename("Casa Luna", { admin: MEMBER }), "42501");
  });

  it("refuses a connection that does not exist", async () => {
    await expectSqlState(rename("Casa Luna", { connection: MISSING }), "P0002");
  });

  it("keeps a label and its authorship inseparable even against a direct write", async () => {
    await expectSqlState(
      db.query(
        "update public.client_google_ads_connections set admin_label = 'Orphan' where id = $1",
        [GOOGLE],
      ),
      "23514",
    );
  });
});
