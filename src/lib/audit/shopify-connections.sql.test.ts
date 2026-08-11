import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { REQUIRED_AUDIT_SHOPIFY_SCOPES } from "./shopify-scopes";

const MIGRATION = readFileSync(
  "supabase/migrations/0040_audit_shopify_connections.sql",
  "utf8",
);

const ADMIN = "40000000-0000-4000-8000-000000000001";
const MEMBER = "40000000-0000-4000-8000-000000000002";
const CONNECTION = "40000000-0000-4000-8000-000000000003";
const TOKEN_HASH = "a".repeat(64);
const REQUIRED_SCOPES = [...REQUIRED_AUDIT_SHOPIFY_SCOPES];

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
create or replace function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles profile
    where profile.id = auth.uid() and profile.role = 'admin'
  )
$$;
`;

let db: PGlite;

async function actAs(id: string | null, role: string) {
  await db.query("select set_config('test.uid', $1, false)", [id ?? ""]);
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function createPending(
  connectionId = CONNECTION,
  tokenHash = TOKEN_HASH,
) {
  return db.query(
    `select public.create_audit_shopify_invitation(
      $1, 'Willow & Wren', $2, now() + interval '1 day', $3
    ) as id`,
    [connectionId, tokenHash, ADMIN],
  );
}

async function complete(
  scopes: string[] = REQUIRED_SCOPES,
  connectionId = CONNECTION,
  tokenHash = TOKEN_HASH,
) {
  return db.query(
    `select public.complete_audit_shopify_connection(
      $1, $2, 'gid://shopify/Shop/123', 'Willow & Wren',
      'willow-wren.myshopify.com', 'willowren-melbourne.com', 'EUR',
      'client-id-123456', 'cdef', $3::text[], 'encrypted-secret-value'
    ) as id`,
    [connectionId, tokenHash, scopes],
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
    "insert into public.profiles (id, role) values ($1, 'admin'), ($2, 'member')",
    [ADMIN, MEMBER],
  );
  await actAs(null, "service_role");
});

describe("audit Shopify connection migration", () => {
  it("creates a one-time invitation and a non-secret event atomically", async () => {
    const created = await createPending();
    expect(created.rows[0]).toEqual({ id: CONNECTION });

    const connection = await db.query<{
      status: string;
      invite_token_hash: string;
      shopify_domain: string | null;
    }>(
      "select status, invite_token_hash, shopify_domain from public.audit_shopify_connections",
    );
    expect(connection.rows[0]).toEqual({
      status: "pending",
      invite_token_hash: TOKEN_HASH,
      shopify_domain: null,
    });

    const events = await db.query<{ event_type: string; details: unknown }>(
      "select event_type, details from public.audit_shopify_connection_events",
    );
    expect(events.rows).toEqual([{ event_type: "invitation_created", details: {} }]);
  });

  it("stores only ciphertext and consumes the invitation in one completion", async () => {
    await createPending();
    await complete();

    const connection = await db.query<{
      status: string;
      invite_token_hash: string | null;
      shopify_domain: string;
      connected_at: Date;
    }>(
      "select status, invite_token_hash, shopify_domain, connected_at from public.audit_shopify_connections",
    );
    expect(connection.rows[0].status).toBe("connected");
    expect(connection.rows[0].invite_token_hash).toBeNull();
    expect(connection.rows[0].shopify_domain).toBe("willow-wren.myshopify.com");
    expect(connection.rows[0].connected_at).toBeInstanceOf(Date);

    const credential = await db.query<{ client_secret_ciphertext: string }>(
      "select client_secret_ciphertext from public.audit_shopify_credentials",
    );
    expect(credential.rows).toEqual([
      { client_secret_ciphertext: "encrypted-secret-value" },
    ]);
    expect(JSON.stringify(connection.rows)).not.toContain("encrypted-secret-value");

    await expect(complete()).rejects.toThrow(/not available/i);
    const count = await db.query<{ count: string }>(
      "select count(*) as count from public.audit_shopify_credentials",
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("fails closed for any missing or unexpected audit scope", async () => {
    await createPending();
    await expect(
      complete(REQUIRED_SCOPES.filter((scope) => scope !== "read_products")),
    ).rejects.toThrow(/missing/i);
    await expect(
      complete(REQUIRED_SCOPES.filter((scope) => scope !== "write_products")),
    ).rejects.toThrow(/missing/i);
    await expect(complete([...REQUIRED_SCOPES, "root_store_access"])).rejects.toThrow(
      /unexpected scopes/i,
    );

    const row = await db.query<{ status: string }>(
      "select status from public.audit_shopify_connections where id = $1",
      [CONNECTION],
    );
    expect(row.rows[0].status).toBe("pending");
    const credentials = await db.query<{ count: string }>(
      "select count(*) as count from public.audit_shopify_credentials",
    );
    expect(Number(credentials.rows[0].count)).toBe(0);
  });

  it("keeps lifecycle RPCs service-only and ciphertext unavailable to browsers", async () => {
    const functions = await db.query<{
      function_count: number;
      authenticated_denied: boolean;
      service_allowed: boolean;
    }>(`
      select count(*)::int as function_count,
        bool_and(not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')) as authenticated_denied,
        bool_and(has_function_privilege('service_role', procedure.oid, 'EXECUTE')) as service_allowed
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = any(array[
          'create_audit_shopify_invitation',
          'complete_audit_shopify_connection',
          'rotate_audit_shopify_invitation',
          'record_audit_shopify_invitation_failure',
          'revoke_audit_shopify_connection',
          'review_audit_shopify_connection'
        ])
    `);
    expect(functions.rows[0]).toEqual({
      function_count: 6,
      authenticated_denied: true,
      service_allowed: true,
    });

    const tables = await db.query<{
      anon_connections: boolean;
      authenticated_connections: boolean;
      authenticated_credentials: boolean;
      authenticated_events: boolean;
      service_connections: boolean;
      service_credentials: boolean;
    }>(`
      select
        has_table_privilege('anon', 'public.audit_shopify_connections', 'SELECT') as anon_connections,
        has_table_privilege('authenticated', 'public.audit_shopify_connections', 'SELECT') as authenticated_connections,
        has_table_privilege('authenticated', 'public.audit_shopify_credentials', 'SELECT') as authenticated_credentials,
        has_table_privilege('authenticated', 'public.audit_shopify_connection_events', 'SELECT') as authenticated_events,
        has_table_privilege('service_role', 'public.audit_shopify_connections', 'SELECT,INSERT,UPDATE,DELETE') as service_connections,
        has_table_privilege('service_role', 'public.audit_shopify_credentials', 'SELECT,INSERT,UPDATE,DELETE') as service_credentials
    `);
    expect(tables.rows[0]).toEqual({
      anon_connections: false,
      authenticated_connections: false,
      authenticated_credentials: false,
      authenticated_events: true,
      service_connections: true,
      service_credentials: true,
    });
  });

  it("refuses invitation creation outside the service role", async () => {
    await actAs(ADMIN, "authenticated");
    await expect(createPending()).rejects.toThrow(/only the server/i);
  });

  it("binds failure accounting to the current bearer and caps it atomically", async () => {
    await createPending();

    const wrong = await db.query<{ attempts: number | null }>(
      "select public.record_audit_shopify_invitation_failure($1, $2, 'invalid_credentials') as attempts",
      [CONNECTION, "b".repeat(64)],
    );
    expect(wrong.rows[0].attempts).toBeNull();

    for (let expected = 1; expected <= 10; expected += 1) {
      const recorded = await db.query<{ attempts: number | null }>(
        "select public.record_audit_shopify_invitation_failure($1, $2, 'invalid_credentials') as attempts",
        [CONNECTION, TOKEN_HASH],
      );
      expect(recorded.rows[0].attempts).toBe(expected);
    }

    const capped = await db.query<{ attempts: number | null }>(
      "select public.record_audit_shopify_invitation_failure($1, $2, 'invalid_credentials') as attempts",
      [CONNECTION, TOKEN_HASH],
    );
    expect(capped.rows[0].attempts).toBeNull();

    const state = await db.query<{ failed_attempts: number; events: number }>(
      `select connection.failed_attempts,
        (select count(*) from public.audit_shopify_connection_events
          where event_type = 'credentials_rejected') as events
       from public.audit_shopify_connections connection where id = $1`,
      [CONNECTION],
    );
    expect(state.rows[0]).toEqual({ failed_attempts: 10, events: 10 });
  });

  it("revocation destroys the credential while retaining safe history", async () => {
    await createPending();
    await complete();
    await db.query(
      "select public.revoke_audit_shopify_connection($1, $2)",
      [CONNECTION, ADMIN],
    );

    const row = await db.query<{
      status: string;
      credential_hint: string | null;
      revoked_at: Date;
    }>(
      "select status, credential_hint, revoked_at from public.audit_shopify_connections where id = $1",
      [CONNECTION],
    );
    expect(row.rows[0].status).toBe("revoked");
    expect(row.rows[0].credential_hint).toBeNull();
    expect(row.rows[0].revoked_at).toBeInstanceOf(Date);

    const credentials = await db.query<{ count: string }>(
      "select count(*) as count from public.audit_shopify_credentials",
    );
    expect(Number(credentials.rows[0].count)).toBe(0);
  });

  it("keeps active audit domains unique without referring to ad_accounts", async () => {
    await createPending();
    await complete();
    const second = "40000000-0000-4000-8000-000000000004";
    const secondHash = "b".repeat(64);
    await createPending(second, secondHash);
    await expect(complete(REQUIRED_SCOPES, second, secondHash)).rejects.toThrow(
      /already has an active audit connection/i,
    );
  });
});
