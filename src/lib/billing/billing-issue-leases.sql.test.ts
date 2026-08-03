import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0029_billing_issue_leases.sql",
  "utf8",
);

const ADMIN = "20000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000002";
const CLIENT = "20000000-0000-4000-8000-000000000003";
const TOKEN_A = "20000000-0000-4000-8000-000000000004";
const TOKEN_B = "20000000-0000-4000-8000-000000000005";
const INVOICE = "20000000-0000-4000-8000-000000000006";
const MONDAY = "2026-07-20";

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
create or replace function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  email text not null
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.portal_clients (id),
  stripe_invoice_id text,
  status text not null default 'draft',
  issue_error text,
  issued_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

grant usage on schema public to authenticated, anon, service_role;
`;

let db: PGlite;

async function actAs(role: string) {
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function acquire(token: string, issuedBy = ADMIN) {
  return db.query<{
    lease_token: string;
    fencing_token: number;
    acquired_at: Date;
    lease_expires_at: Date;
  }>(
    `select lease_token, fencing_token, acquired_at, lease_expires_at
       from public.acquire_billing_issue_lease($1::uuid, $2::uuid, $3::date, $4::uuid)`,
    [CLIENT, token, MONDAY, issuedBy],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);
});

beforeEach(async () => {
  await db.exec(`
    truncate table public.billing_issue_leases, public.invoices,
      public.portal_clients, public.profiles cascade;
    insert into public.profiles (id, role)
      values ('${ADMIN}', 'admin'), ('${USER}', 'member');
    insert into public.portal_clients (id, full_name, email)
      values ('${CLIENT}', 'Lease Client', 'lease@example.com');
  `);
  await actAs("service_role");
});

describe("fenced billing issue leases", () => {
  it("marks historical delivery as assumed without fabricating sent evidence", async () => {
    const historyDb = new PGlite();
    try {
      await historyDb.exec(PRELUDE);
      await historyDb.exec(`
        insert into public.invoices (stripe_invoice_id, status, issued_at)
        values
          ('in_historical', 'open', '2026-07-20T09:00:00Z'),
          (null, 'draft', null);
      `);
      await historyDb.exec(MIGRATION);
      const rows = await historyDb.query<{
        status: string;
        stripe_invoice_id: string | null;
        stripe_sent_at: Date | null;
        stripe_delivery_assumed_at: Date | null;
      }>(`
        select status, stripe_invoice_id, stripe_sent_at,
          stripe_delivery_assumed_at
        from public.invoices
        order by status
      `);

      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]).toMatchObject({
        status: "draft",
        stripe_invoice_id: null,
        stripe_sent_at: null,
        stripe_delivery_assumed_at: null,
      });
      expect(rows.rows[1].stripe_invoice_id).toBe("in_historical");
      expect(rows.rows[1].stripe_sent_at).toBeNull();
      expect(rows.rows[1].stripe_delivery_assumed_at).toBeInstanceOf(Date);
    } finally {
      await historyDb.close();
    }
  });

  it("refuses to guess whether a Stripe-linked local draft was delivered", async () => {
    const ambiguousDb = new PGlite();
    try {
      await ambiguousDb.exec(PRELUDE);
      await ambiguousDb.exec(`
        insert into public.invoices (stripe_invoice_id, status, issued_at)
        values ('in_ambiguous', 'draft', null);
      `);
      await expect(ambiguousDb.exec(MIGRATION)).rejects.toThrow(
        /explicit delivery reconciliation/i,
      );
      const deliveryColumn = await ambiguousDb.query<{ exists: boolean }>(`
        select exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'invoices'
            and column_name = 'stripe_sent_at'
        ) as exists
      `);
      expect(deliveryColumn.rows[0].exists).toBe(false);
    } finally {
      await ambiguousDb.close();
    }
  });

  it("exposes only service RPCs and no direct lease-table surface", async () => {
    const privileges = await db.query<{
      authenticated_table: boolean;
      service_table: boolean;
      authenticated_acquire: boolean;
      service_acquire: boolean;
      policies: number;
    }>(`
      select
        has_table_privilege('authenticated', 'public.billing_issue_leases', 'select')
          as authenticated_table,
        has_table_privilege('service_role', 'public.billing_issue_leases', 'select')
          as service_table,
        has_function_privilege(
          'authenticated',
          'public.acquire_billing_issue_lease(uuid,uuid,date,uuid)',
          'execute'
        ) as authenticated_acquire,
        has_function_privilege(
          'service_role',
          'public.acquire_billing_issue_lease(uuid,uuid,date,uuid)',
          'execute'
        ) as service_acquire,
        (select count(*)::int from pg_policies
          where schemaname = 'public' and tablename = 'billing_issue_leases')
          as policies
    `);

    expect(privileges.rows[0]).toEqual({
      authenticated_table: false,
      service_table: false,
      authenticated_acquire: false,
      service_acquire: true,
      policies: 0,
    });

    await actAs("authenticated");
    await expect(acquire(TOKEN_A)).rejects.toThrow(/billing service/i);
  });

  it("idempotently renews the same token and rejects a concurrent owner", async () => {
    const first = await acquire(TOKEN_A);
    const replay = await acquire(TOKEN_A);
    const blocked = await acquire(TOKEN_B);

    expect(first.rows).toHaveLength(1);
    expect(replay.rows).toHaveLength(1);
    expect(blocked.rows).toHaveLength(0);
    expect(replay.rows[0].fencing_token).toBe(first.rows[0].fencing_token);
    expect(replay.rows[0].acquired_at).toEqual(first.rows[0].acquired_at);
    expect(replay.rows[0].lease_expires_at.getTime()).toBeGreaterThanOrEqual(
      first.rows[0].lease_expires_at.getTime(),
    );
  });

  it("fences a released generation and never resurrects its UUID", async () => {
    const first = await acquire(TOKEN_A);
    const fence = first.rows[0].fencing_token;
    await db.query(
      `insert into public.invoices (id, client_id, status)
       values ($1::uuid, $2::uuid, 'draft')`,
      [INVOICE, CLIENT],
    );
    const recorded = await db.query<{ recorded: boolean }>(
      `select public.record_billing_issue_error(
        $1::uuid, $2::uuid, $3::bigint, $4::uuid, 'first failure'
      ) as recorded`,
      [CLIENT, TOKEN_A, fence, INVOICE],
    );
    expect(recorded.rows[0].recorded).toBe(true);

    const released = await db.query<{ released: boolean }>(
      `select public.release_billing_issue_lease($1::uuid, $2::uuid, $3::bigint)
         as released`,
      [CLIENT, TOKEN_A, fence],
    );
    expect(released.rows[0].released).toBe(true);

    await expect(acquire(TOKEN_A)).rejects.toThrow(/cannot be reused/i);
    const second = await acquire(TOKEN_B);
    expect(second.rows[0].fencing_token).toBe(fence + 1);

    const staleRenew = await db.query(
      `select * from public.renew_billing_issue_lease($1::uuid, $2::uuid, $3::bigint)`,
      [CLIENT, TOKEN_A, fence],
    );
    const staleRelease = await db.query<{ released: boolean }>(
      `select public.release_billing_issue_lease($1::uuid, $2::uuid, $3::bigint)
         as released`,
      [CLIENT, TOKEN_A, fence],
    );
    const staleRecord = await db.query<{ recorded: boolean }>(
      `select public.record_billing_issue_error(
        $1::uuid, $2::uuid, $3::bigint, $4::uuid, 'stale overwrite'
      ) as recorded`,
      [CLIENT, TOKEN_A, fence, INVOICE],
    );
    const invoice = await db.query<{ issue_error: string | null }>(
      "select issue_error from public.invoices where id = $1::uuid",
      [INVOICE],
    );
    expect(staleRenew.rows).toHaveLength(0);
    expect(staleRelease.rows[0].released).toBe(false);
    expect(staleRecord.rows[0].recorded).toBe(false);
    expect(invoice.rows[0].issue_error).toBe("first failure");
  });

  it("allows takeover only after expiry and keeps the old fence powerless", async () => {
    const first = await acquire(TOKEN_A);
    await db.exec(`
      update public.billing_issue_leases
      set acquired_at = clock_timestamp() - interval '20 minutes',
          renewed_at = clock_timestamp() - interval '10 minutes',
          lease_expires_at = clock_timestamp() - interval '1 minute'
      where lease_token = '${TOKEN_A}'::uuid;
    `);

    const second = await acquire(TOKEN_B);
    expect(second.rows[0].fencing_token).toBe(first.rows[0].fencing_token + 1);
    const staleRenew = await db.query(
      `select * from public.renew_billing_issue_lease($1::uuid, $2::uuid, $3::bigint)`,
      [CLIENT, TOKEN_A, first.rows[0].fencing_token],
    );
    expect(staleRenew.rows).toHaveLength(0);
  });

  it("rejects non-admin issuers and non-Monday periods", async () => {
    await expect(acquire(TOKEN_A, USER)).rejects.toThrow(/verified admin/i);
    await expect(
      db.query(
        `select * from public.acquire_billing_issue_lease(
          $1::uuid, $2::uuid, '2026-07-21'::date, $3::uuid
        )`,
        [CLIENT, TOKEN_A, ADMIN],
      ),
    ).rejects.toThrow(/Monday period/i);
  });
});
