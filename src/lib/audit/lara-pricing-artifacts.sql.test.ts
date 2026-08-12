import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS = [
  "supabase/migrations/0040_audit_shopify_connections.sql",
  "supabase/migrations/0041_audit_shopify_scope_clearance.sql",
  "supabase/migrations/0042_audit_shopify_runs.sql",
  "supabase/migrations/0043_audit_shopify_run_request_actors.sql",
  "supabase/migrations/0045_audit_shopify_pricing_artifacts.sql",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const ADMIN = "73000000-0000-4000-8000-000000000001";
const CONNECTION = "a023c7e2-a96b-4f04-bc6e-0165e23332c3";
const RUN = "73000000-0000-4000-8000-000000000002";
const LEASE = "73000000-0000-4000-8000-000000000003";
const NEW_LEASE = "73000000-0000-4000-8000-000000000004";
const DOMAIN = "jwmtjg-fm.myshopify.com";
const SHOP_ID = "gid://shopify/Shop/95462097276";
const KEY =
  `lara-pricing/lara-pricing-sale-repair.v1/${RUN}/products/0000.json`;
const SECOND_KEY =
  `lara-pricing/lara-pricing-sale-repair.v1/${RUN}/products/0001.json`;
const SCHEMA_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);

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

type ArtifactRow = {
  artifact_key: string;
  digest_sha256: string;
  byte_length: number;
  canonical_json: string;
};

let db: PGlite;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function actAs(role: string) {
  await db.query("select set_config('test.role', $1, false)", [role]);
}

function productJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "catalogue_product_partition",
    schemaVersion: "lara-pricing-sale-repair.v1",
    ordinal: 0,
    product: { id: "gid://shopify/Product/1" },
    operation: null,
    ...extra,
  });
}

async function put({
  key = KEY,
  canonicalJson = productJson(),
  digest = sha256(canonicalJson),
  byteLength = Buffer.byteLength(canonicalJson),
  connectionId = CONNECTION,
  domain = DOMAIN,
  shopId = SHOP_ID,
  lease = LEASE,
  generation = 1,
}: {
  key?: string;
  canonicalJson?: string;
  digest?: string;
  byteLength?: number;
  connectionId?: string;
  domain?: string;
  shopId?: string;
  lease?: string;
  generation?: number;
} = {}) {
  return db.query<ArtifactRow>(
    `select * from public.put_audit_shopify_pricing_artifact(
      $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::bigint,
      $7, $8, $9::integer, $10
    )`,
    [
      RUN,
      connectionId,
      domain,
      shopId,
      lease,
      generation,
      key,
      digest,
      byteLength,
      canonicalJson,
    ],
  );
}

async function get({
  key = KEY,
  lease = LEASE,
  generation = 1,
}: {
  key?: string;
  lease?: string;
  generation?: number;
} = {}) {
  return db.query<ArtifactRow>(
    `select * from public.get_audit_shopify_pricing_artifact(
      $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::bigint, $7
    )`,
    [RUN, CONNECTION, DOMAIN, SHOP_ID, lease, generation, key],
  );
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  await db.exec(PRELUDE);
  await db.exec(MIGRATIONS);
  await db.query("insert into public.profiles (id, role) values ($1, 'admin')", [
    ADMIN,
  ]);
  await db.query(
    `insert into public.audit_shopify_connections (
      id, store_label, status, shopify_shop_id, shopify_name, shopify_domain,
      primary_domain, shopify_currency, shopify_client_id, credential_hint,
      granted_scopes, scope_profile, created_by, connected_at, last_verified_at
    ) values (
      $1, 'Lara Rovinj', 'connected', $2, 'Lara Rovinj', $3,
      'www.lararovinj.com', 'EUR', 'client-id', 'bc84',
      array['read_products', 'write_products'], 'store-audit-clearance-v2',
      $4, now(), now()
    )`,
    [CONNECTION, SHOP_ID, DOMAIN, ADMIN],
  );
  await actAs("service_role");
  await db.query(
    `select public.enqueue_audit_shopify_run(
      $1::uuid, $2::uuid, $3::uuid, $4, 'lara_pricing_repair', null,
      $5, $6, 2, '{}'::jsonb, 'system'
    )`,
    [RUN, CONNECTION, ADMIN, DOMAIN, SCHEMA_HASH, MANIFEST_HASH],
  );
  await db.query(
    "select * from public.claim_audit_shopify_run($1::uuid, $2::uuid, $3, 300)",
    [LEASE, RUN, DOMAIN],
  );
});

describe("private immutable Lara pricing artifact SQL store", () => {
  it("has no table access or policies and exposes only three guarded service RPCs", async () => {
    const security = await db.query<{
      rls_enabled: boolean;
      policy_count: number;
      anon_select: boolean;
      authenticated_select: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
      service_delete: boolean;
    }>(`
      select
        class.relrowsecurity as rls_enabled,
        (select count(*)::int from pg_policies
          where schemaname = 'public'
            and tablename = 'audit_shopify_pricing_artifacts') as policy_count,
        has_table_privilege('anon', class.oid, 'select') as anon_select,
        has_table_privilege('authenticated', class.oid, 'select')
          as authenticated_select,
        has_table_privilege('service_role', class.oid, 'select')
          as service_select,
        has_table_privilege('service_role', class.oid, 'insert')
          as service_insert,
        has_table_privilege('service_role', class.oid, 'update')
          as service_update,
        has_table_privilege('service_role', class.oid, 'delete')
          as service_delete
      from pg_class class
      join pg_namespace namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'public'
        and class.relname = 'audit_shopify_pricing_artifacts'
    `);
    expect(security.rows[0]).toEqual({
      rls_enabled: true,
      policy_count: 0,
      anon_select: false,
      authenticated_select: false,
      service_select: false,
      service_insert: false,
      service_update: false,
      service_delete: false,
    });

    const functions = await db.query<{
      function_count: number;
      all_security_definer: boolean;
      all_role_guarded: boolean;
      authenticated_denied: boolean;
      service_allowed: boolean;
    }>(`
      select count(*)::int as function_count,
        bool_and(procedure.prosecdef) as all_security_definer,
        bool_and(position('auth.role()' in pg_get_functiondef(procedure.oid)) > 0)
          as all_role_guarded,
        bool_and(not has_function_privilege(
          'authenticated', procedure.oid, 'execute'
        )) as authenticated_denied,
        bool_and(has_function_privilege(
          'service_role', procedure.oid, 'execute'
        )) as service_allowed
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = any(array[
          'put_audit_shopify_pricing_artifact',
          'get_audit_shopify_pricing_artifact',
          'assert_audit_shopify_pricing_artifact_store_ready'
        ])
    `);
    expect(functions.rows[0]).toEqual({
      function_count: 3,
      all_security_definer: true,
      all_role_guarded: true,
      authenticated_denied: true,
      service_allowed: true,
    });

    await actAs("authenticated");
    await expect(put()).rejects.toThrow(/only the pricing repair service/i);
  });

  it("preflights the applied migration only under the exact current run lease", async () => {
    const ready = await db.query<{ ready: boolean }>(
      `select public.assert_audit_shopify_pricing_artifact_store_ready(
        $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::bigint
      ) as ready`,
      [RUN, CONNECTION, DOMAIN, SHOP_ID, LEASE, 1],
    );
    expect(ready.rows).toEqual([{ ready: true }]);

    await expect(
      db.query(
        `select public.assert_audit_shopify_pricing_artifact_store_ready(
          $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::bigint
        )`,
        [RUN, CONNECTION, DOMAIN, SHOP_ID, NEW_LEASE, 1],
      ),
    ).rejects.toThrow(/preflight pin is not current/i);
  });

  it("preserves exact retry error evidence on the queued run transition", async () => {
    const retried = await db.query<{
      state: string;
      error_code: string | null;
      retry_count: number;
      next_attempt_at: string | null;
    }>(
      `select state, error_code, retry_count, next_attempt_at
       from public.fail_audit_shopify_run(
         $1::uuid, $2, $3::uuid, 1, '{}'::jsonb,
         'pricing_artifact_read_failed', true, 30
       )`,
      [RUN, DOMAIN, LEASE],
    );
    expect(retried.rows[0]).toEqual(
      expect.objectContaining({
        state: "queued",
        error_code: "pricing_artifact_read_failed",
        retry_count: 1,
      }),
    );
    expect(retried.rows[0].next_attempt_at).not.toBeNull();
  });

  it("stores exact bytes once and independently reads them under the current pin", async () => {
    const canonicalJson = productJson();
    const digest = sha256(canonicalJson);
    const first = await put({ canonicalJson, digest });
    expect(first.rows).toEqual([
      {
        artifact_key: KEY,
        digest_sha256: digest,
        byte_length: Buffer.byteLength(canonicalJson),
        canonical_json: canonicalJson,
      },
    ]);

    const replay = await put({ canonicalJson, digest });
    expect(replay.rows).toEqual(first.rows);
    const read = await get();
    expect(read.rows).toEqual(first.rows);

    const count = await db.query<{ count: number }>(
      "select count(*)::int as count from public.audit_shopify_pricing_artifacts",
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("rejects key and digest collisions instead of overwriting immutable bytes", async () => {
    const canonicalJson = productJson();
    const digest = sha256(canonicalJson);
    await put({ canonicalJson, digest });

    const changed = productJson({ ordinal: 99 });
    await expect(
      put({ canonicalJson: changed, digest: sha256(changed) }),
    ).rejects.toThrow(/immutable pricing artifact collision/i);
    await expect(
      put({ key: SECOND_KEY, canonicalJson, digest }),
    ).rejects.toThrow(/immutable pricing artifact collision/i);

    const read = await get();
    expect(read.rows[0]).toMatchObject({
      artifact_key: KEY,
      digest_sha256: digest,
      canonical_json: canonicalJson,
    });
  });

  it("keeps sealed recovery bytes readable at the final generation after completion and revocation", async () => {
    const stored = await put();
    await db.query(
      `select * from public.complete_audit_shopify_run(
        $1::uuid, $2, $3::uuid, 1, '{"phase":"verified"}'::jsonb,
        '{"status":"verified","rootRef":"sealed"}'::jsonb
      )`,
      [RUN, DOMAIN, LEASE],
    );

    await expect(get()).resolves.toMatchObject({ rows: stored.rows });
    await expect(get({ generation: 2 })).rejects.toThrow(
      /run pin is not current/i,
    );
    await expect(put()).rejects.toThrow(/run pin is not current/i);

    await db.query(
      "select public.revoke_audit_shopify_connection($1::uuid, $2::uuid)",
      [CONNECTION, ADMIN],
    );
    await expect(get()).resolves.toMatchObject({ rows: stored.rows });
  });

  it("rejects foreign pins, stale leases, unsafe JSON and fixed-size overflow", async () => {
    await expect(
      put({ domain: "other.myshopify.com" }),
    ).rejects.toThrow(/invalid immutable pricing artifact/i);
    await expect(
      put({ shopId: "gid://shopify/Shop/1" }),
    ).rejects.toThrow(/invalid immutable pricing artifact/i);
    await expect(
      put({ key: KEY.replace(RUN, "74000000-0000-4000-8000-000000000001") }),
    ).rejects.toThrow(/invalid immutable pricing artifact/i);

    const unsafe = productJson({ nested: { client_secret: "never-store" } });
    await expect(
      put({ canonicalJson: unsafe, digest: sha256(unsafe) }),
    ).rejects.toThrow(/invalid immutable pricing artifact/i);

    const oversized = productJson({ padding: "x".repeat(2_097_152) });
    await expect(
      put({
        canonicalJson: oversized,
        digest: sha256(oversized),
        byteLength: Buffer.byteLength(oversized),
      }),
    ).rejects.toThrow(/invalid immutable pricing artifact/i);

    await db.query(
      `update public.audit_shopify_runs
       set lease_token = $2::uuid,
           lease_generation = 2,
           lease_renewed_at = clock_timestamp(),
           lease_expires_at = clock_timestamp() + interval '5 minutes',
           updated_at = clock_timestamp()
       where id = $1`,
      [RUN, NEW_LEASE],
    );
    await expect(put()).rejects.toThrow(/run pin is not current/i);
    await expect(get()).rejects.toThrow(/run pin is not current/i);
  });

  it("keeps the fixed run quotas visible in the audited function definition", async () => {
    const definition = await db.query<{ definition: string }>(`
      select pg_get_functiondef(procedure.oid) as definition
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = 'put_audit_shopify_pricing_artifact'
    `);
    expect(definition.rows[0].definition).toContain("existing_count >= 2001");
    expect(definition.rows[0].definition).toContain("134217728");
    expect(definition.rows[0].definition).toContain("2097152");
    expect(definition.rows[0].definition).toContain("4194304");
  });
});
