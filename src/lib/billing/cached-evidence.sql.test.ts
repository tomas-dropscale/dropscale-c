import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "10400000-0000-4000-8000-000000000001";
const MEMBER = "10400000-0000-4000-8000-000000000002";
const CLIENT = "10400000-0000-4000-8000-000000000003";
const ACCOUNT = "10400000-0000-4000-8000-000000000004";
const START = "10400000-0000-4000-8000-000000000005";
const SOURCE = "10400000-0000-4000-8000-000000000006";
const ROW = "10400000-0000-4000-8000-000000000007";
let db: PGlite;
const migration = readFileSync("supabase/migrations/0104_reviewed_cached_billing_evidence.sql", "utf8");

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
    insert into profiles values('${ADMIN}','admin'),('${MEMBER}','member');
    insert into portal_clients values('${CLIENT}');
    insert into ad_accounts values('${ACCOUNT}','${CLIENT}','active','1234567890','EUR');
    insert into ad_account_billing_starts values('${START}','${ACCOUNT}','1234567890','EUR','2026-07-01');
    insert into revenue_sources values('${SOURCE}','Google Ads Management');
  `);
  // Compile and patch the actual current creator, not a stand-in fragment.
  await db.exec(readFileSync("supabase/migrations/0079_arrears_rollover_invoices.sql", "utf8"));
  await db.exec(migration);
}, 30000);
beforeEach(async () => {
  await db.exec(`
    set test.role = 'service_role';
    truncate invoice_cached_evidence_reviews, billing_cached_evidence_reviews, invoices, billing_cycle_skips, commissions;
    delete from ad_account_billing_ends;
    update ad_accounts set client_id='${CLIENT}', currency='EUR', google_ads_customer_id='1234567890';
    insert into commissions values('${ROW}','${ACCOUNT}','${SOURCE}','2026-07-20',100,'EUR','confirmed','2026-07-21T00:00:00Z');
  `);
});
afterAll(async () => { await db?.close(); });

async function approve(options: { reviewer?: string; snapshot?: unknown; week?: string } = {}) {
  const week = options.week ?? "2026-07-20";
  const snapshot = options.snapshot ?? (await db.query<{snapshot: unknown}>(
    "select public.cached_billing_ledger_snapshot($1,$2::date,$2::date+6) snapshot", [ACCOUNT, week],
  )).rows[0].snapshot;
  return db.query<{id: string; ledger_snapshot: unknown; last_ledger_update: string}>(
    "select * from public.approve_cached_billing_evidence($1,$2,$3::jsonb,$4,$5)",
    [ACCOUNT, week, JSON.stringify(snapshot), options.reviewer ?? ADMIN, "Owner explicitly approved using the existing stored values."],
  );
}
async function matches(reviewer: string | null = ADMIN, week = "2026-07-20") {
  return (await db.query<{ok: boolean}>(
    "select public.cached_billing_evidence_matches($1,$2,null,$3::date,$3::date+6,$4) ok",
    [ACCOUNT, START, week, reviewer],
  )).rows[0].ok;
}

describe("explicit cached billing evidence", () => {
  it("accepts only the exact approved stored rows and preserves their old capture time", async () => {
    expect(await matches()).toBe(false);
    const approved = await approve();
    expect(approved.rows).toHaveLength(1);
    expect(new Date(approved.rows[0].last_ledger_update).toISOString()).toBe("2026-07-21T00:00:00.000Z");
    expect(await matches()).toBe(true);
    expect((await approve()).rows[0].id).toBe(approved.rows[0].id);
  });
  it("cannot authorize unattended issuance, another reviewer or another cycle", async () => {
    await approve();
    expect(await matches(null)).toBe(false);
    expect(await matches(MEMBER)).toBe(false);
    expect(await matches(ADMIN, "2026-07-27")).toBe(false);
  });
  it("invalidates approval when any stored amount changes", async () => {
    await approve();
    await db.exec(`update commissions set gross_amount=101 where id='${ROW}'`);
    expect(await matches()).toBe(false);
  });
  it("invalidates approval when an additional source row appears", async () => {
    await approve();
    await db.exec(`insert into commissions select gen_random_uuid(),ad_account_id,source_id,'2026-07-21',10,currency,status,updated_at from commissions`);
    expect(await matches()).toBe(false);
  });
  it("invalidates approval when the billing boundary or Google identity changes", async () => {
    await approve();
    await db.exec(`insert into ad_account_billing_ends values(gen_random_uuid(),'${ACCOUNT}','${START}','2026-07-26')`);
    expect(await matches()).toBe(false);
    await db.exec(`delete from ad_account_billing_ends; update ad_accounts set google_ads_customer_id='9999999999'`);
    expect(await matches()).toBe(false);
  });
  it("refuses a changed snapshot instead of approving current values silently", async () => {
    await expect(approve({snapshot: []})).rejects.toThrow(/missing or changed/);
  });
  it("rejects a non-admin reviewer", async () => {
    await expect(approve({reviewer: MEMBER})).rejects.toThrow(/admin reviewer/);
  });
  it("rejects non-service requests and direct table writes", async () => {
    await db.exec("set test.role='authenticated'");
    await expect(approve()).rejects.toThrow(/Only the billing service/);
    const grants = await db.query<{allowed: boolean}>("select has_table_privilege('service_role','public.billing_cached_evidence_reviews','INSERT') allowed");
    expect(grants.rows[0].allowed).toBe(false);
  });
  it("refuses empty evidence rather than treating missing data as zero", async () => {
    await db.exec("delete from commissions");
    await expect(approve()).rejects.toThrow(/missing or changed/);
  });
  it("refuses negative or non-EUR stored spend", async () => {
    await db.exec("update commissions set gross_amount=-1");
    await expect(approve()).rejects.toThrow(/missing or changed/);
    await db.exec("update commissions set gross_amount=100,currency='USD'");
    await expect(approve()).rejects.toThrow(/missing or changed/);
  });
  it("refuses future/unsettled periods", async () => {
    await expect(approve({week: "2999-01-07"})).rejects.toThrow(/settled closed week/);
  });
  it("does not override a skipped or previously invoiced cycle", async () => {
    await db.exec(`insert into billing_cycle_skips values('${CLIENT}','2026-07-20','2026-07-26')`);
    await expect(approve()).rejects.toThrow(/skipped or already invoiced/);
    await db.exec(`delete from billing_cycle_skips; insert into invoices values(gen_random_uuid(),'${CLIENT}','2026-07-20','2026-07-26','open')`);
    await expect(approve()).rejects.toThrow(/skipped or already invoiced/);
  });
  it("keeps approvals immutable", async () => {
    await approve();
    await expect(db.exec("update billing_cached_evidence_reviews set reason='Changed authorization'")).rejects.toThrow(/immutable/);
    await expect(db.exec("delete from billing_cached_evidence_reviews")).rejects.toThrow(/immutable/);
  });
  it("patches only the explicit issuer's evidence alternative and saves invoice provenance", async () => {
    const definition = (await db.query<{definition: string}>("select pg_get_functiondef('public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure) definition")).rows[0].definition;
    expect(definition).toContain("public.cached_billing_evidence_matches(account.id, billing_start.id, billing_end.id, p_period_start, p_period_end, p_issued_by)");
    expect(definition).toContain("Every requested ledger row must be claimed exactly once.");
    expect(definition).toContain("insert into public.invoice_cached_evidence_reviews");
  });
});
