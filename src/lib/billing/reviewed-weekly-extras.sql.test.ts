import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewedWeeklyExtras } from "./reviewed-weekly-extras";

const CLIENT = "5107292f-1bf6-42a4-ba8d-dc1d730d4044";
const OTHER_CLIENT = "10400000-0000-4000-8000-000000000003";
const WEEK = "2026-10-19";
const migration = readFileSync("supabase/migrations/0105_reviewed_weekly_service_extra.sql", "utf8");
const signature = "public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)";
let db: PGlite;
let originalDefinition: string;

async function definition() {
  return (await db.query<{ definition: string }>(
    "select pg_get_functiondef($1::regprocedure) definition", [signature],
  )).rows[0].definition.replaceAll("\r\n", "\n");
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('test.role',true)$$;
    create function public.is_admin() returns boolean language sql as $$select true$$;
    create table profiles(id uuid primary key, role text);
    create table portal_clients(id uuid primary key);
    create table ad_accounts(id uuid primary key, client_id uuid, status text, google_ads_customer_id text, currency text);
    create table ad_account_billing_starts(id uuid primary key, ad_account_id uuid, google_ads_customer_id text, currency text, google_local_date date);
    create table ad_account_billing_ends(id uuid primary key, ad_account_id uuid, billing_start_id uuid, google_local_date date);
    create table revenue_sources(id uuid primary key, name text);
    create table commissions(id uuid primary key, ad_account_id uuid, source_id uuid, occurred_on date, gross_amount numeric, currency text, status text, updated_at timestamptz);
    create table invoices(id uuid primary key, client_id uuid, period_start date, period_end date, status text);
    create table billing_cycle_skips(client_id uuid, period_start date, period_end date);
  `);
  // Exercise the real live creator lineage, including the later evidence fix.
  await db.exec(readFileSync("supabase/migrations/0079_arrears_rollover_invoices.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0104_reviewed_cached_billing_evidence.sql", "utf8"));
  originalDefinition = await definition();
  await db.exec(migration);
}, 30000);

afterAll(async () => { await db?.close(); });

async function validate(lines: unknown[], client = CLIENT, week = WEEK) {
  return db.query(
    "select public.assert_reviewed_weekly_invoice_extras($1,$2,$3::jsonb)",
    [client, week, JSON.stringify(lines)],
  );
}

describe("database validation of the approved weekly service supplement", () => {
  it("agrees with the application and accepts the supplement alongside agency fees", async () => {
    const expected = reviewedWeeklyExtras(CLIENT, WEEK);
    const result = await db.query<{ extras: unknown }>(
      "select public.reviewed_weekly_invoice_extras($1,$2) extras", [CLIENT, WEEK],
    );
    expect(result.rows[0].extras).toEqual(expected);
    await expect(validate([{ kind: "fee", amount: 10 }, ...expected])).resolves.toBeDefined();
    await expect(validate([{ kind: "fee", amount: 10 }], OTHER_CLIENT)).resolves.toBeDefined();
    await expect(validate([{ kind: "fee", amount: 10 }], CLIENT, "2026-10-26")).resolves.toBeDefined();
  });

  it("rejects omission, duplication, another client or a recurring charge", async () => {
    const extras = reviewedWeeklyExtras(CLIENT, WEEK);
    await expect(validate([])).rejects.toThrow("explicitly approved");
    await expect(validate([...extras, ...extras])).rejects.toThrow("explicitly approved");
    await expect(validate(extras, OTHER_CLIENT)).rejects.toThrow("explicitly approved");
    await expect(validate(extras, CLIENT, "2026-10-26")).rejects.toThrow("explicitly approved");
    await expect(validate(extras, CLIENT, "2026-10-12")).rejects.toThrow("explicitly approved");
  });

  it.each([
    { amount: 34.81 },
    { amount: -34.8 },
    { amount: 100 },
    { label: "Another service" },
    { extraId: "another-extra" },
    { accountId: OTHER_CLIENT },
    { extraField: "unexpected" },
  ])("rejects a changed approved service line: %j", async (change) => {
    const [extra] = reviewedWeeklyExtras(CLIENT, WEEK);
    await expect(validate([{ ...extra, ...change }])).rejects.toThrow("explicitly approved");
  });

  it("preserves every existing creator check and remains idempotent", async () => {
    const anchor = "  select coalesce(jsonb_agg(line), '[]'::jsonb)\n    into fee_lines";
    const guard = "  perform public.assert_reviewed_weekly_invoice_extras(p_client_id, p_period_start, p_line_items);\n\n";
    const expected = originalDefinition
      .replace("not in ('fee', 'rev_share', 'arrears')", "not in ('fee', 'rev_share', 'arrears', 'service')")
      .replace(anchor, guard + anchor);
    expect(await definition()).toBe(expected);
    await db.exec(migration);
    expect(await definition()).toBe(expected);
    expect(expected.split(guard)).toHaveLength(2);
    expect((await db.query("select * from invoices")).rows).toEqual([]);
  });

  it("does not expose supplement validation to browser database roles", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const result = await db.query<{ allowed: boolean }>(
        "select has_function_privilege($1, 'public.assert_reviewed_weekly_invoice_extras(uuid,date,jsonb)', 'EXECUTE') allowed",
        [role],
      );
      expect(result.rows[0].allowed).toBe(role === "service_role");
    }
  });
});
