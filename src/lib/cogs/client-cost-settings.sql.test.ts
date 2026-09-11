import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 0101 gives a client back the four cost figures on its own store.
 *
 * The bug it fixes was invisible: 0055 tightened the ad_accounts update policy
 * so a client could not rewrite reporting fields after the cutover, and the
 * cost settings, which live on the same table, were caught with them. An UPDATE
 * a policy filters out matches no rows and returns SUCCESS, so the page saved,
 * reloaded, and showed the old numbers, which read as "the form forces the
 * defaults".
 *
 * These tests do not re-test RLS; they pin what the function itself allows and
 * refuses, because that is now the only door.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/0101_client_cost_settings.sql",
  "utf8",
);

const OWNER = "aa000000-0000-4000-8000-000000000001";
const PARTNER = "aa000000-0000-4000-8000-000000000002";
const STRANGER = "aa000000-0000-4000-8000-000000000003";
const ADMIN = "aa000000-0000-4000-8000-000000000004";
const ACCOUNT = "aa000000-0000-4000-8000-000000000011";

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
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null,
  store_name text not null,
  default_product_cost_pct numeric not null default 30,
  payment_fee_pct numeric not null default 2.9,
  payment_fee_fixed numeric not null default 0.30,
  shipping_cost_per_order numeric not null default 0
);

create table public.client_members (
  client_id uuid not null,
  member_id uuid not null
);

create or replace function public.is_admin() returns boolean
language sql stable as $$
  select auth.uid() = '${ADMIN}'::uuid
$$;

create or replace function public.is_client_member(p_client_id uuid) returns boolean
language sql stable as $$
  select p_client_id = auth.uid()
    or exists (
      select 1 from public.client_members m
      where m.client_id = p_client_id and m.member_id = auth.uid()
    )
$$;
`;

let db: PGlite;

async function actAs(uid: string | null) {
  await db.query("select set_config('test.uid', $1, false)", [uid ?? ""]);
}

async function settings() {
  const row = await db.query<{
    default_product_cost_pct: string;
    payment_fee_pct: string;
    payment_fee_fixed: string;
    shipping_cost_per_order: string;
  }>(
    `select default_product_cost_pct, payment_fee_pct, payment_fee_fixed,
            shipping_cost_per_order
     from public.ad_accounts where id = $1`,
    [ACCOUNT],
  );
  return row.rows[0]!;
}

function save(values: [number, number, number, number], account = ACCOUNT) {
  return db.query(
    "select public.set_ad_account_cost_settings($1, $2, $3, $4, $5)",
    [account, ...values],
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

beforeAll(async () => {
  db = new PGlite();
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);
});

beforeEach(async () => {
  await db.exec("delete from public.ad_accounts; delete from public.client_members;");
  await db.query(
    "insert into public.ad_accounts(id, client_id, store_name) values ($1, $2, 'Kinu-Ito')",
    [ACCOUNT, OWNER],
  );
  await db.query(
    "insert into public.client_members(client_id, member_id) values ($1, $2)",
    [OWNER, PARTNER],
  );
  await actAs(OWNER);
});

describe("a client's own cost settings (0101)", () => {
  it("writes all four figures for the workspace owner", async () => {
    await save([42, 1.4, 0.25, 7.5]);
    expect(await settings()).toEqual({
      default_product_cost_pct: "42",
      payment_fee_pct: "1.4",
      payment_fee_fixed: "0.25",
      shipping_cost_per_order: "7.5",
    });
  });

  it("lets a partner of the same workspace write them too", async () => {
    // Clients are often two people, and both open the same workspace.
    await actAs(PARTNER);
    await save([25, 0, 0, 0]);
    expect((await settings()).default_product_cost_pct).toBe("25");
  });

  it("does not care which reporting surface the client is on", async () => {
    // The whole point of the fix: v2_active clients could not save at all, and
    // this function deliberately never consults the rollout state. There is no
    // rollout table here, which is the assertion.
    await save([31, 2, 0.1, 1]);
    expect((await settings()).default_product_cost_pct).toBe("31");
  });

  it("lets an admin act for any client", async () => {
    await actAs(ADMIN);
    await save([10, 1, 0.05, 2]);
    expect((await settings()).payment_fee_pct).toBe("1");
  });

  it("refuses a stranger, and changes nothing", async () => {
    await actAs(STRANGER);
    await expectSqlState(save([99, 9, 9, 9]), "42501");
    expect(await settings()).toEqual({
      default_product_cost_pct: "30",
      payment_fee_pct: "2.9",
      payment_fee_fixed: "0.30",
      shipping_cost_per_order: "0",
    });
  });

  it("refuses a store that does not exist", async () => {
    await expectSqlState(
      save([30, 2.9, 0.3, 0], "aa000000-0000-4000-8000-0000000000ff"),
      "23514",
    );
  });

  it("refuses figures that would silently distort every profit number", async () => {
    // A percentage above 100 or a negative cost is always a typing mistake, and
    // stored it would quietly wrong every margin the client reads.
    await expectSqlState(save([101, 2.9, 0.3, 0]), "22023");
    await expectSqlState(save([-1, 2.9, 0.3, 0]), "22023");
    await expectSqlState(save([30, 101, 0.3, 0]), "22023");
    await expectSqlState(save([30, -0.1, 0.3, 0]), "22023");
    await expectSqlState(save([30, 2.9, -0.01, 0]), "22023");
    await expectSqlState(save([30, 2.9, 0.3, -5]), "22023");
    expect((await settings()).default_product_cost_pct).toBe("30");
  });

  it("refuses a number that is not a number", async () => {
    // numeric carries NaN and Infinity, and Postgres sorts NaN above every
    // value, so a range test written as "less than zero" lets both through.
    // Stored, they reach the rollup, which writes a null into a not-null
    // metrics column and then fails on every run for that store.
    for (const bad of ["NaN", "Infinity", "-Infinity"]) {
      await expectSqlState(
        db.query("select public.set_ad_account_cost_settings($1, $2, $3, $4, $5)", [
          ACCOUNT,
          30,
          2.9,
          bad,
          0,
        ]),
        "22023",
      );
      await expectSqlState(
        db.query("select public.set_ad_account_cost_settings($1, $2, $3, $4, $5)", [
          ACCOUNT,
          bad,
          2.9,
          0.3,
          0,
        ]),
        "22023",
      );
    }
    expect((await settings()).payment_fee_fixed).toBe("0.30");
  });

  it("accepts the honest zeroes", async () => {
    // A client who pays no card fee and ships free is not a mistake.
    await save([0, 0, 0, 0]);
    expect(await settings()).toEqual({
      default_product_cost_pct: "0",
      payment_fee_pct: "0",
      payment_fee_fixed: "0",
      shipping_cost_per_order: "0",
    });
  });

  it("answers with the four figures it wrote, and with nothing else", async () => {
    // Two properties at once. A function that returns what it stored cannot
    // report success while changing nothing, which was the original bug. And it
    // must return ONLY these four columns: ad_accounts also carries the store's
    // Shopify and Google tokens, and this is called from the browser.
    const result = await db.query<Record<string, unknown>>(
      "select * from public.set_ad_account_cost_settings($1, $2, $3, $4, $5)",
      [ACCOUNT, 33, 1.9, 0.2, 3],
    );
    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0]!).sort()).toEqual([
      "default_product_cost_pct",
      "payment_fee_fixed",
      "payment_fee_pct",
      "shipping_cost_per_order",
    ]);
    expect(result.rows[0]!.default_product_cost_pct).toBe("33");
  });
});
