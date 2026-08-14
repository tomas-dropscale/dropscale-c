import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0061_account_commission_terms.sql",
  "utf8",
);
const CORE_END = MIGRATION.indexOf("\n-- 0037");
if (CORE_END < 0) throw new Error("0061 core migration boundary is missing.");
const CORE_MIGRATION = MIGRATION.slice(0, CORE_END);

const ADMIN = "61000000-0000-4000-8000-000000000001";
const MEMBER = "61000000-0000-4000-8000-000000000002";
const ACCOUNT = "61000000-0000-4000-8000-000000000003";
const DECISION_1 = "61000000-0000-4000-8000-000000000011";
const DECISION_2 = "61000000-0000-4000-8000-000000000012";

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
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  )
$$;

create table public.portal_clients (
  id uuid primary key
);
create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id),
  list_commission_rate numeric(5,2) not null default 10,
  commission_rate numeric(5,2) not null default 10,
  revenue_share_enabled boolean not null default false
);

create function public.manual_referral_effective_monday(p_day date)
returns date language sql immutable strict as $$
  select p_day + ((8 - extract(isodow from p_day)::integer) % 7)
$$;
create function public.manual_referral_current_monday(p_day date)
returns date language sql immutable strict as $$
  select p_day - (extract(isodow from p_day)::integer - 1)
$$;
create function public.effective_commission_rate(
  p_client_id uuid,
  p_list numeric
) returns numeric language sql stable security definer as $$
  select case when p_list = 10 then 9::numeric else p_list end
$$;
create function public.derive_commission_rate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.commission_rate := public.effective_commission_rate(
    new.client_id,
    new.list_commission_rate
  );
  return new;
end
$$;
create trigger ad_accounts_derive_rate
  before insert or update on public.ad_accounts
  for each row execute function public.derive_commission_rate();

alter table public.ad_accounts enable row level security;
grant select, insert, update, delete on public.ad_accounts to authenticated;
create policy ad_accounts_member_read on public.ad_accounts for select
  to authenticated using (client_id = auth.uid() or public.is_admin());
create policy ad_accounts_member_insert on public.ad_accounts for insert
  to authenticated with check (client_id = auth.uid() or public.is_admin());
create policy ad_accounts_member_update on public.ad_accounts for update
  to authenticated
  using (client_id = auth.uid() or public.is_admin())
  with check (client_id = auth.uid() or public.is_admin());
`;

type Term = {
  id: string;
  ad_account_id: string;
  effective_from: string | Date;
  revision: number;
  supersedes_id: string | null;
  decision_id: string;
  list_rate: string | number;
  reviewed_by: string;
};

let db: PGlite;

async function resetRole() {
  await db.exec("reset role");
}

async function actAs(userId: string, role = "authenticated") {
  await resetRole();
  await db.query(
    "select set_config('test.uid', $1, false), set_config('test.role', $2, false)",
    [userId, role],
  );
  await db.exec(`set role ${role}`);
}

async function schedule(
  rate: number,
  expectedTermId: string | null,
  decisionId: string,
) {
  return db.query<Term>(
    `select * from public.schedule_ad_account_commission_rate(
       $1, $2, $3, $4
     )`,
    [ACCOUNT, rate, expectedTermId, decisionId],
  );
}

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.query("insert into public.portal_clients (id) values ($1), ($2)", [
    ADMIN,
    MEMBER,
  ]);
  await db.query(
    "insert into public.profiles (id, role) values ($1, 'admin')",
    [ADMIN],
  );
  await db.query(
    "insert into public.ad_accounts (id, client_id) values ($1, $2)",
    [ACCOUNT, MEMBER],
  );
  await db.exec(CORE_MIGRATION);
});

afterEach(async () => {
  await db.close();
});

describe("0061 account commission terms", () => {
  it("installs without a speculative backfill and resolves the historical 10% default", async () => {
    const count = await db.query<{ count: number }>(
      "select count(*)::int as count from public.ad_account_commission_terms",
    );
    expect(count.rows[0].count).toBe(0);

    const resolved = await db.query<{
      term_id: string | null;
      revision: number;
      list_rate: string | number;
    }>(
      "select * from public.resolve_ad_account_commission_term($1, date '2020-01-06')",
      [ACCOUNT],
    );
    expect(resolved.rows[0]).toMatchObject({ term_id: null, revision: 0 });
    expect(Number(resolved.rows[0].list_rate)).toBe(10);
  });

  it("allows only an authenticated admin and makes a decision replay idempotent", async () => {
    await actAs(MEMBER);
    await expect(schedule(12, null, DECISION_1)).rejects.toThrow(
      /authenticated admin/i,
    );

    await actAs(ADMIN);
    const first = (await schedule(12, null, DECISION_1)).rows[0];
    expect(first).toMatchObject({
      ad_account_id: ACCOUNT,
      revision: 1,
      supersedes_id: null,
      decision_id: DECISION_1,
      reviewed_by: ADMIN,
    });
    expect(Number(first.list_rate)).toBe(12);

    const replay = (await schedule(12, null, DECISION_1)).rows[0];
    expect(replay.id).toBe(first.id);
    await expect(schedule(12, first.id, DECISION_1)).rejects.toThrow(
      /decision id was already used/i,
    );
  });

  it("uses the absolute head as CAS and appends a higher same-Monday revision", async () => {
    await actAs(ADMIN);
    const first = (await schedule(12, null, DECISION_1)).rows[0];
    await expect(schedule(15, null, DECISION_2)).rejects.toThrow(
      /changed.*refresh.*review/i,
    );

    const second = (await schedule(15, first.id, DECISION_2)).rows[0];
    expect(second.effective_from).toEqual(first.effective_from);
    expect(second.revision).toBe(2);
    expect(second.supersedes_id).toBe(first.id);

    await resetRole();
    const resolved = await db.query<{ term_id: string; list_rate: string }>(
      "select term_id, list_rate from public.resolve_ad_account_commission_term($1, $2)",
      [ACCOUNT, second.effective_from],
    );
    expect(resolved.rows[0].term_id).toBe(second.id);
    expect(Number(resolved.rows[0].list_rate)).toBe(15);
  });

  it("does not activate a future term early and only caches the current Monday authority", async () => {
    await actAs(ADMIN);
    const term = (await schedule(12, null, DECISION_1)).rows[0];
    await resetRole();
    const state = await db.query<{
      target_is_current: boolean;
      list_commission_rate: string | number;
      commission_rate: string | number;
    }>(
      `select
         $2::date = public.manual_referral_current_monday(
           (now() at time zone 'Europe/Lisbon')::date
         ) as target_is_current,
         list_commission_rate,
         commission_rate
       from public.ad_accounts where id = $1`,
      [ACCOUNT, term.effective_from],
    );
    const row = state.rows[0];
    expect(Number(row.list_commission_rate)).toBe(
      row.target_is_current ? 12 : 10,
    );
    expect(Number(row.commission_rate)).toBe(row.target_is_current ? 12 : 9);
  });

  it("rejects direct writes even when an authenticated admin forges the cache flag", async () => {
    await actAs(ADMIN);
    await expect(
      db.query(
        "update public.ad_accounts set list_commission_rate = 13 where id = $1",
        [ACCOUNT],
      ),
    ).rejects.toThrow(/scheduled through its reviewed RPC/i);

    await db.query(
      "select set_config('dropscale.account_commission_term_rpc', 'on', false)",
    );
    await expect(
      db.query(
        "update public.ad_accounts set list_commission_rate = 13 where id = $1",
        [ACCOUNT],
      ),
    ).rejects.toThrow(/scheduled through its reviewed RPC/i);
  });

  it("keeps sealed terms append-only", async () => {
    await actAs(ADMIN);
    const term = (await schedule(12, null, DECISION_1)).rows[0];
    await resetRole();
    await expect(
      db.query(
        "update public.ad_account_commission_terms set list_rate = 14 where id = $1",
        [term.id],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.query("delete from public.ad_account_commission_terms where id = $1", [
        term.id,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it("denies TRUNCATE to browser and service roles", async () => {
    await actAs(ADMIN);
    await schedule(12, null, DECISION_1);
    await expect(
      db.exec("truncate table public.ad_account_commission_terms"),
    ).rejects.toThrow(/permission denied/i);

    await actAs(ADMIN, "service_role");
    await expect(
      db.exec("truncate table public.ad_account_commission_terms"),
    ).rejects.toThrow(/permission denied/i);
  });

  it("fails migration preflight instead of inventing history for a custom cache", async () => {
    const preflight = await PGlite.create();
    try {
      await preflight.exec(PRELUDE);
      await preflight.query(
        "insert into public.portal_clients (id) values ($1)",
        [MEMBER],
      );
      await preflight.query(
        `insert into public.ad_accounts (
           id, client_id, list_commission_rate
         ) values ($1, $2, 12)`,
        [ACCOUNT, MEMBER],
      );
      await expect(preflight.exec(CORE_MIGRATION)).rejects.toThrow(
        /explicit reviewed historical rollover/i,
      );
    } finally {
      await preflight.close();
    }
  });

  it("keeps V3 line shape separate while requiring V4 per-store provenance", () => {
    expect(MIGRATION).toContain("not is_v4");
    expect(MIGRATION).toContain("not (item ? 'pricingMode')");
    expect(MIGRATION).toContain("not (item ? 'commissionTermId')");
    expect(MIGRATION).toContain("is_v4\n        and item ? 'pricingMode'");
    expect(MIGRATION).toContain("and item ? 'commissionTermId'");
    expect(MIGRATION).toContain(
      "case when uses_referral_pricing then commercial_term.term_id else null end",
    );
  });

  it("compiles the complete same-signature V3/V4 invoice RPC", async () => {
    const functionStart = MIGRATION.indexOf(
      "CREATE OR REPLACE FUNCTION public.create_manual_referral_invoice",
    );
    const functionEnd = MIGRATION.indexOf(
      "comment on function public.create_manual_referral_invoice",
      functionStart,
    );
    expect(functionStart).toBeGreaterThan(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const compileDb = await PGlite.create();
    try {
      await compileDb.exec(
        "create table public.invoices (id uuid primary key)",
      );
      await compileDb.exec(MIGRATION.slice(functionStart, functionEnd));
    } finally {
      await compileDb.close();
    }
  });
});
