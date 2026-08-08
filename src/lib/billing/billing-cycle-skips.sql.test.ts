import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0038_billing_cycle_skips.sql",
  "utf8",
);

const ADMIN = "38000000-0000-4000-8000-000000000001";
const MEMBER = "38000000-0000-4000-8000-000000000002";
const CLIENT = "38000000-0000-4000-8000-000000000003";
const OTHER_CLIENT = "38000000-0000-4000-8000-000000000004";
const MONDAY = "2026-08-03";
const SUNDAY = "2026-08-09";

/**
 * Only what 0038 touches. The migration references portal_clients, profiles
 * and invoices plus the is_admin()/is_client_member() helpers, so the fixture
 * reproduces those shapes rather than the whole schema.
 */
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

create schema if not exists auth;
create or replace function auth.role() returns text
language sql stable as $$ select current_setting('test.role', true) $$;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.profiles (
  id uuid primary key,
  role text not null default 'member'
);

create table public.portal_clients (
  id uuid primary key,
  full_name text not null
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  period_start date not null,
  status text not null
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  )
$$;

create or replace function public.is_client_member(p_client_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() = p_client_id
$$;
`;

let db: PGlite;

async function actAs(id: string | null, role = id ? "authenticated" : "") {
  await db.query("select set_config('test.uid', $1, false)", [id ?? ""]);
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function actAsService() {
  await actAs(null, "service_role");
}

async function skip(
  clientId = CLIENT,
  periodStart = MONDAY,
  periodEnd = SUNDAY,
  reason: string | null = "Goodwill after an outage",
  createdBy = ADMIN,
) {
  return db.query(
    "select * from public.skip_billing_cycle($1,$2,$3,$4,$5)",
    [clientId, periodStart, periodEnd, reason, createdBy],
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
    "insert into public.profiles (id, role) values ($1,'admin'), ($2,'member')",
    [ADMIN, MEMBER],
  );
  await db.query(
    "insert into public.portal_clients (id, full_name) values ($1,'Client'), ($2,'Other')",
    [CLIENT, OTHER_CLIENT],
  );
  await actAs(null);
});

describe("billing cycle skips", () => {
  it("records one admin-attributed skip for a Monday-to-Sunday week", async () => {
    await actAsService();
    const created = await skip();

    const row = created.rows[0] as Record<string, unknown>;
    expect(row.client_id).toBe(CLIENT);
    const isoDay = (value: unknown) =>
      value instanceof Date
        ? value.toISOString().slice(0, 10)
        : String(value).slice(0, 10);
    expect(isoDay(row.period_start)).toBe(MONDAY);
    expect(isoDay(row.period_end)).toBe(SUNDAY);
    expect(row.reason).toBe("Goodwill after an outage");
    expect(row.created_by).toBe(ADMIN);
  });

  it("is idempotent: skipping twice keeps one row", async () => {
    await actAsService();
    await skip();
    const again = await skip();
    expect(again.rows).toHaveLength(1);

    const { rows } = await db.query<{ count: string }>(
      "select count(*) as count from public.billing_cycle_skips",
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("refuses a week that already carries a payable invoice", async () => {
    await actAsService();
    await db.query(
      "insert into public.invoices (client_id, period_start, status) values ($1,$2,'open')",
      [CLIENT, MONDAY],
    );

    await expect(skip()).rejects.toThrow(/already invoiced/i);
  });

  it("allows skipping a week whose only invoice was voided", async () => {
    await actAsService();
    await db.query(
      "insert into public.invoices (client_id, period_start, status) values ($1,$2,'void')",
      [CLIENT, MONDAY],
    );

    const created = await skip();
    expect(created.rows).toHaveLength(1);
  });

  it("refuses a period that is not a Monday-to-Sunday week", async () => {
    await actAsService();
    await expect(skip(CLIENT, "2026-08-04", "2026-08-10")).rejects.toThrow(
      /Monday to Sunday/i,
    );
    await expect(skip(CLIENT, MONDAY, "2026-08-08")).rejects.toThrow(
      /Monday to Sunday/i,
    );
  });

  it("refuses an unknown client", async () => {
    await actAsService();
    await expect(skip(OTHER_CLIENT.replace(/4$/, "9"))).rejects.toThrow(
      /does not exist/i,
    );
  });

  it("requires the service role and a verified admin reviewer", async () => {
    await actAs(ADMIN);
    await expect(skip()).rejects.toThrow(/Only the billing service/i);

    await actAsService();
    await expect(skip(CLIENT, MONDAY, SUNDAY, null, MEMBER)).rejects.toThrow(
      /verified admin/i,
    );
  });

  it("cannot be written directly, even by the service role", async () => {
    await actAsService();
    await db.exec("set role service_role");
    try {
      await expect(
        db.query(
          "insert into public.billing_cycle_skips (client_id, period_start, period_end, created_by) values ($1,$2,$3,$4)",
          [CLIENT, MONDAY, SUNDAY, ADMIN],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  });

  it("undoes a skip through its own admin-gated function", async () => {
    await actAsService();
    await skip();

    const removed = await db.query<{ remove_billing_cycle_skip: boolean }>(
      "select public.remove_billing_cycle_skip($1,$2,$3)",
      [CLIENT, MONDAY, ADMIN],
    );
    expect(removed.rows[0].remove_billing_cycle_skip).toBe(true);

    const missing = await db.query<{ remove_billing_cycle_skip: boolean }>(
      "select public.remove_billing_cycle_skip($1,$2,$3)",
      [CLIENT, MONDAY, ADMIN],
    );
    expect(missing.rows[0].remove_billing_cycle_skip).toBe(false);
  });

  it("keeps skips readable by the team and by their own client only", async () => {
    await actAsService();
    await skip();

    await db.exec("grant usage on schema auth to authenticated");
    await db.exec("grant usage on schema public to authenticated");
    await db.exec("grant select on public.billing_cycle_skips to authenticated");

    async function readAs(id: string) {
      await actAs(id);
      await db.exec("set role authenticated");
      try {
        return await db.query("select * from public.billing_cycle_skips");
      } finally {
        await db.exec("reset role");
      }
    }

    expect((await readAs(ADMIN)).rows).toHaveLength(1);
    expect((await readAs(CLIENT)).rows).toHaveLength(1);
    expect((await readAs(OTHER_CLIENT)).rows).toHaveLength(0);
  });
});
