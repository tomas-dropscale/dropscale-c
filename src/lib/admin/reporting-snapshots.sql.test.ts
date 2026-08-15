import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0062_admin_reporting_range_snapshots.sql",
  "utf8",
);

const ACCOUNT = "62000000-0000-4000-8000-000000000001";
const CLIENT = "62000000-0000-4000-8000-000000000002";
const AUTHORITY_A = "a".repeat(64);
const AUTHORITY_B = "b".repeat(64);
const MANIFEST_A = { surface: "legacy", accountId: ACCOUNT };
const MANIFEST_B = { surface: "v2_active", bindingId: "binding-1" };

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
create function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create table public.portal_clients (id uuid primary key);
create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id)
);
`;

type Claim = { claim_admin_reporting_snapshot_refresh: string | null };
type Complete = { complete_admin_reporting_snapshot_refresh: boolean };
type Failed = { fail_admin_reporting_snapshot_refresh: boolean };

let db: PGlite;

async function resetRole() {
  await db.exec("reset role");
}

async function actAs(role: "authenticated" | "service_role") {
  await resetRole();
  await db.query("select set_config('test.role', $1, false)", [role]);
  await db.exec(`set role ${role}`);
}

async function claim(
  authority = AUTHORITY_A,
  manifest: Record<string, unknown> = MANIFEST_A,
) {
  return db.query<Claim>(
    `select public.claim_admin_reporting_snapshot_refresh(
       'google_campaigns', $1, date '2026-08-09', date '2026-08-15',
       $2, $3::jsonb, 300
     )`,
    [ACCOUNT, authority, JSON.stringify(manifest)],
  );
}

async function complete(token: string, authority = AUTHORITY_A) {
  return db.query<Complete>(
    `select public.complete_admin_reporting_snapshot_refresh(
       'google_campaigns', $1, date '2026-08-09', date '2026-08-15',
       $2, $3, 'ready', $4::jsonb, null
     )`,
    [ACCOUNT, authority, token, JSON.stringify([{ campaignId: "123" }])],
  );
}

async function fail(token: string, authority = AUTHORITY_A) {
  return db.query<Failed>(
    `select public.fail_admin_reporting_snapshot_refresh(
       'google_campaigns', $1, date '2026-08-09', date '2026-08-15',
       $2, $3, 'provider_failed'
     )`,
    [ACCOUNT, authority, token],
  );
}

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.query("insert into public.portal_clients(id) values ($1)", [CLIENT]);
  await db.query(
    "insert into public.ad_accounts(id, client_id) values ($1, $2)",
    [ACCOUNT, CLIENT],
  );
  await db.exec(MIGRATION);
});

afterEach(async () => {
  await db.close();
});

describe("0062 admin reporting range snapshots", () => {
  it("is service-only and refuses direct writes", async () => {
    await actAs("authenticated");
    await expect(claim()).rejects.toThrow(/permission denied/i);
    await expect(
      db.query("select * from public.admin_reporting_range_snapshots"),
    ).rejects.toThrow(/permission denied/i);

    await actAs("service_role");
    await expect(
      db.query(
        `insert into public.admin_reporting_range_snapshots(
           family, scope_account_id, from_day, to_day,
           authority_key, authority_manifest
         ) values ('google_campaigns', $1, current_date, current_date, $2, '{}'::jsonb)`,
        [ACCOUNT, AUTHORITY_A],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("leases one exact family/range and completes it atomically", async () => {
    await actAs("service_role");
    const token = (await claim()).rows[0].claim_admin_reporting_snapshot_refresh;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect((await claim()).rows[0].claim_admin_reporting_snapshot_refresh).toBeNull();

    const completed = await complete(token!);
    expect(completed.rows[0].complete_admin_reporting_snapshot_refresh).toBe(true);

    const row = (await db.query<{
      state: string;
      payload: unknown;
      revision: number;
      lease_token: string | null;
    }>(
      `select state, payload, revision, lease_token
       from public.admin_reporting_range_snapshots`,
    )).rows[0];
    expect(row).toMatchObject({
      state: "ready",
      payload: [{ campaignId: "123" }],
      revision: 1,
      lease_token: null,
    });
  });

  it("keeps the last success when a later provider attempt fails", async () => {
    await actAs("service_role");
    const first = (await claim()).rows[0].claim_admin_reporting_snapshot_refresh!;
    await complete(first);

    const retry = (await claim()).rows[0].claim_admin_reporting_snapshot_refresh!;
    expect((await fail(retry)).rows[0].fail_admin_reporting_snapshot_refresh).toBe(true);

    const row = (await db.query<{
      state: string;
      payload: unknown;
      last_error_code: string | null;
      revision: number;
    }>(
      `select state, payload, last_error_code, revision
       from public.admin_reporting_range_snapshots`,
    )).rows[0];
    expect(row).toEqual({
      state: "ready",
      payload: [{ campaignId: "123" }],
      last_error_code: "provider_failed",
      revision: 1,
    });
  });

  it("fences an old writer and clears payload when source authority changes", async () => {
    await actAs("service_role");
    const first = (await claim()).rows[0].claim_admin_reporting_snapshot_refresh!;
    await complete(first);

    const oldRetry = (await claim()).rows[0].claim_admin_reporting_snapshot_refresh!;
    const next = (await claim(AUTHORITY_B, MANIFEST_B)).rows[0]
      .claim_admin_reporting_snapshot_refresh!;
    expect(next).not.toBe(oldRetry);
    expect((await complete(oldRetry)).rows[0].complete_admin_reporting_snapshot_refresh).toBe(
      false,
    );

    const reset = (await db.query<{
      authority_key: string;
      state: string | null;
      payload: unknown;
      last_success_at: string | null;
    }>(
      `select authority_key, state, payload, last_success_at
       from public.admin_reporting_range_snapshots`,
    )).rows[0];
    expect(reset).toEqual({
      authority_key: AUTHORITY_B,
      state: null,
      payload: null,
      last_success_at: null,
    });

    expect((await complete(next, AUTHORITY_B)).rows[0]
      .complete_admin_reporting_snapshot_refresh).toBe(true);
  });
});
