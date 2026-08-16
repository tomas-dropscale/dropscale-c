import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0067_billing_automation_single_run.sql",
  "utf8",
);

const PRELUDE = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

create schema auth;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;
grant usage on schema public, auth to service_role;

create table public.billing_automation_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  status text not null default 'running',
  issuance_enabled boolean not null,
  seeded_items integer not null default 0,
  claimed_items integer not null default 0,
  issued_items integer not null default 0,
  no_charge_items integer not null default 0,
  blocked_items integer not null default 0,
  historical_rollovers_checked integer not null default 0,
  exact_refresh_requested integer not null default 0,
  exact_refresh_completed integer not null default 0,
  reconciliation_checked integer not null default 0,
  reconciliation_updated integer not null default 0,
  error_count integer not null default 0
);
`;

let db: PGlite;

async function begin(enabled: boolean) {
  return db.query<{ id: string; issuance_enabled: boolean }>(
    "select id, issuance_enabled from public.begin_billing_automation_run($1)",
    [enabled],
  );
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);
});

beforeEach(async () => {
  await db.exec("truncate table public.billing_automation_runs");
  await db.query("select set_config('test.role', 'service_role', false)");
});

describe("billing automation singleton run", () => {
  it("turns a duplicate fresh invocation into a no-op", async () => {
    const first = await begin(true);
    const duplicate = await begin(true);

    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].issuance_enabled).toBe(true);
    expect(duplicate.rows).toEqual([]);
    await expect(
      db.query("select count(*)::int as count from public.billing_automation_runs"),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("closes an abandoned owner before admitting its retry", async () => {
    await db.exec(`
      insert into public.billing_automation_runs (
        started_at, status, issuance_enabled
      ) values (
        clock_timestamp() - interval '3 hours', 'running', true
      )
    `);

    const retry = await begin(true);
    const rows = await db.query<{
      status: string;
      error_count: number;
    }>(`
      select status, error_count
      from public.billing_automation_runs
      order by started_at
    `);

    expect(retry.rows).toHaveLength(1);
    expect(rows.rows).toEqual([
      { status: "failed", error_count: 1 },
      { status: "running", error_count: 0 },
    ]);
  });
});
