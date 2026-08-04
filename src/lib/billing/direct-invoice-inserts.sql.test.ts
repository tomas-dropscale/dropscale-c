import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0033_disable_direct_invoice_inserts.sql",
  "utf8",
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
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

    create table public.invoices (
      id uuid primary key default gen_random_uuid(),
      calculation_version text not null
    );

    grant select, insert, update on public.invoices
      to anon, authenticated, service_role;

    create or replace function public.create_reviewed_invoice()
    returns uuid
    language plpgsql
    security definer
    set search_path = public
    as $$
    declare
      created_id uuid;
    begin
      insert into public.invoices (calculation_version)
      values ('agency-fee-eur-v3-manual-referrals-google-boundaries')
      returning id into created_id;
      return created_id;
    end
    $$;

    revoke all on function public.create_reviewed_invoice() from public;
    grant execute on function public.create_reviewed_invoice() to service_role;
  `);
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db.close();
});

describe("RPC-only invoice creation", () => {
  it("revokes direct INSERT without removing read or reconciliation updates", async () => {
    const privileges = await db.query<{
      role_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
    }>(`
      select role_name,
        has_table_privilege(role_name, 'public.invoices', 'SELECT') as can_select,
        has_table_privilege(role_name, 'public.invoices', 'INSERT') as can_insert,
        has_table_privilege(role_name, 'public.invoices', 'UPDATE') as can_update
      from unnest(array['anon', 'authenticated', 'service_role']) role_name
      order by role_name
    `);

    expect(privileges.rows).toEqual([
      { role_name: "anon", can_select: true, can_insert: false, can_update: true },
      { role_name: "authenticated", can_select: true, can_insert: false, can_update: true },
      { role_name: "service_role", can_select: true, can_insert: false, can_update: true },
    ]);
  });

  it("keeps owner-backed SECURITY DEFINER creation available to service_role", async () => {
    const privilege = await db.query<{ can_execute: boolean }>(`
      select has_function_privilege(
        'service_role',
        'public.create_reviewed_invoice()',
        'EXECUTE'
      ) as can_execute
    `);
    expect(privilege.rows[0]).toEqual({ can_execute: true });

    await db.exec("set role service_role");
    try {
      await expect(
        db.query(
          "insert into public.invoices (calculation_version) values ('legacy')",
        ),
      ).rejects.toThrow(/permission denied/i);

      const created = await db.query<{ id: string }>(
        "select public.create_reviewed_invoice() as id",
      );
      expect(created.rows[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await db.exec("reset role");
    }
  });
});
