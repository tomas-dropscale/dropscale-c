import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS = [
  "supabase/migrations/0040_audit_shopify_connections.sql",
  "supabase/migrations/0041_audit_shopify_scope_clearance.sql",
  "supabase/migrations/0042_audit_shopify_runs.sql",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const ADMIN = "42000000-0000-4000-8000-000000000001";
const CONNECTION = "42000000-0000-4000-8000-000000000002";
const RUN = "42000000-0000-4000-8000-000000000003";
const LEASE_A = "42000000-0000-4000-8000-000000000004";
const LEASE_B = "42000000-0000-4000-8000-000000000005";
const LEASE_C = "42000000-0000-4000-8000-000000000006";
const RUN_2 = "42000000-0000-4000-8000-000000000007";
const DOMAIN = "lara-rovinj.myshopify.com";
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

type RunRow = {
  id: string;
  connection_id: string;
  requested_by: string;
  shopify_domain: string;
  state: "queued" | "running" | "completed" | "failed";
  requested_source: string;
  requested_note: string | null;
  schema_hash: string;
  manifest_hash: string;
  checkpoint: Record<string, unknown>;
  artifact: Record<string, unknown> | null;
  attempt_count: number;
  retry_count: number;
  max_retries: number;
  next_attempt_at: Date | null;
  lease_token: string | null;
  lease_generation: number;
  lease_expires_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  error_code: string | null;
};

let db: PGlite;

async function actAs(role: string) {
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function enqueue({
  runId = RUN,
  domain = DOMAIN,
  note = "Initial GMC compliance baseline",
  schemaHash = SCHEMA_HASH,
  maxRetries = 3,
  checkpoint = {},
}: {
  runId?: string;
  domain?: string;
  note?: string | null;
  schemaHash?: string;
  maxRetries?: number;
  checkpoint?: Record<string, unknown>;
} = {}) {
  return db.query<{ id: string }>(
    `select public.enqueue_audit_shopify_run(
      $1::uuid, $2::uuid, $3::uuid, $4, 'gmc_compliance', $5, $6, $7, $8, $9::jsonb
    ) as id`,
    [
      runId,
      CONNECTION,
      ADMIN,
      domain,
      note,
      schemaHash,
      MANIFEST_HASH,
      maxRetries,
      JSON.stringify(checkpoint),
    ],
  );
}

async function claim(
  leaseToken: string,
  runId: string | null = RUN,
  domain: string | null = DOMAIN,
) {
  return db.query<RunRow>(
    `select * from public.claim_audit_shopify_run(
      $1::uuid, $2::uuid, $3, 55
    )`,
    [leaseToken, runId, domain],
  );
}

async function renew(
  leaseToken: string,
  generation: number,
  checkpoint: Record<string, unknown>,
) {
  return db.query<RunRow>(
    `select * from public.renew_audit_shopify_run(
      $1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb, 55
    )`,
    [RUN, DOMAIN, leaseToken, generation, JSON.stringify(checkpoint)],
  );
}

async function yieldRun(
  leaseToken: string,
  generation: number,
  checkpoint: Record<string, unknown>,
) {
  return db.query<RunRow>(
    `select * from public.yield_audit_shopify_run(
      $1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb, 0
    )`,
    [RUN, DOMAIN, leaseToken, generation, JSON.stringify(checkpoint)],
  );
}

async function complete(
  leaseToken: string,
  generation: number,
  checkpoint: Record<string, unknown>,
  artifact: Record<string, unknown>,
) {
  return db.query<RunRow>(
    `select * from public.complete_audit_shopify_run(
      $1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb, $6::jsonb
    )`,
    [
      RUN,
      DOMAIN,
      leaseToken,
      generation,
      JSON.stringify(checkpoint),
      JSON.stringify(artifact),
    ],
  );
}

async function fail(
  leaseToken: string,
  generation: number,
  retryable: boolean,
  errorCode = "shopify_rate_limited",
  checkpoint: Record<string, unknown> = { catalog: { cursor: "cursor-1" } },
) {
  return db.query<RunRow>(
    `select * from public.fail_audit_shopify_run(
      $1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb, $6, $7, 0
    )`,
    [
      RUN,
      DOMAIN,
      leaseToken,
      generation,
      JSON.stringify(checkpoint),
      errorCode,
      retryable,
    ],
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
  await db.query(
    "insert into public.profiles (id, role) values ($1, 'admin')",
    [ADMIN],
  );
  await db.query(
    `insert into public.audit_shopify_connections (
      id, store_label, status, shopify_shop_id, shopify_name, shopify_domain,
      primary_domain, shopify_currency, shopify_client_id, credential_hint,
      granted_scopes, scope_profile, created_by, connected_at, last_verified_at
    ) values (
      $1, 'Lara Rovinj', 'connected', 'gid://shopify/Shop/95462097276',
      'Lara Rovinj', $2, 'www.lararovinj.com', 'EUR', 'client-id', 'bc84',
      array['read_products'], 'store-audit-clearance-v2', $3, now(), now()
    )`,
    [CONNECTION, DOMAIN, ADMIN],
  );
  await actAs("service_role");
});

describe("durable Shopify audit collector runs", () => {
  it("exposes only service reads and keeps every lifecycle mutation RPC service-only", async () => {
    const tableSecurity = await db.query<{
      rls_enabled: boolean;
      policy_count: number;
      anon_select: boolean;
      authenticated_select: boolean;
      service_select: boolean;
      service_insert: boolean;
    }>(`
      select
        class.relrowsecurity as rls_enabled,
        (select count(*)::int from pg_policies
          where schemaname = 'public' and tablename = 'audit_shopify_runs')
          as policy_count,
        has_table_privilege('anon', class.oid, 'select') as anon_select,
        has_table_privilege('authenticated', class.oid, 'select')
          as authenticated_select,
        has_table_privilege('service_role', class.oid, 'select') as service_select,
        has_table_privilege('service_role', class.oid, 'insert') as service_insert
      from pg_class class
      join pg_namespace namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'public'
        and class.relname = 'audit_shopify_runs'
    `);
    expect(tableSecurity.rows[0]).toEqual({
      rls_enabled: true,
      policy_count: 0,
      anon_select: false,
      authenticated_select: false,
      service_select: true,
      service_insert: false,
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
          'enqueue_audit_shopify_run',
          'claim_audit_shopify_run',
          'renew_audit_shopify_run',
          'yield_audit_shopify_run',
          'complete_audit_shopify_run',
          'fail_audit_shopify_run'
        ])
    `);
    expect(functions.rows[0]).toEqual({
      function_count: 6,
      all_security_definer: true,
      all_role_guarded: true,
      authenticated_denied: true,
      service_allowed: true,
    });

    await actAs("authenticated");
    await expect(enqueue()).rejects.toThrow(/only the audit collector service/i);
  });

  it("enqueues only against the exact connected domain and replays immutable evidence idempotently", async () => {
    const first = await enqueue({ checkpoint: { catalog: { cursor: null } } });
    expect(first.rows).toEqual([{ id: RUN }]);

    const queued = await db.query<RunRow>(
      "select * from public.audit_shopify_runs where id = $1",
      [RUN],
    );
    expect(queued.rows[0]).toMatchObject({
      id: RUN,
      connection_id: CONNECTION,
      requested_by: ADMIN,
      shopify_domain: DOMAIN,
      state: "queued",
      requested_source: "gmc_compliance",
      requested_note: "Initial GMC compliance baseline",
      schema_hash: SCHEMA_HASH,
      manifest_hash: MANIFEST_HASH,
      checkpoint: { catalog: { cursor: null } },
      artifact: null,
      attempt_count: 0,
      retry_count: 0,
      max_retries: 3,
      lease_token: null,
      lease_generation: 0,
    });
    expect(queued.rows[0].next_attempt_at).toBeInstanceOf(Date);

    const replay = await enqueue({ checkpoint: { catalog: { cursor: null } } });
    expect(replay.rows).toEqual([{ id: RUN }]);
    const concurrent = await enqueue({
      runId: RUN_2,
      checkpoint: { catalog: { cursor: null } },
    });
    expect(concurrent.rows).toEqual([{ id: RUN }]);
    await expect(
      enqueue({ runId: RUN_2, note: "different active evidence" }),
    ).rejects.toThrow(/active audit manifest.*different evidence/i);
    await expect(
      enqueue({ runId: RUN_2, schemaHash: "c".repeat(64) }),
    ).rejects.toThrow(/active audit manifest.*different evidence/i);
    const activeCount = await db.query<{ count: number }>(
      "select count(*)::int as count from public.audit_shopify_runs where state in ('queued', 'running')",
    );
    expect(activeCount.rows[0].count).toBe(1);
    const requests = await db.query<{
      actor_profile_id: string;
      run_id: string;
      reused_active: boolean;
    }>(`
      select actor_profile_id,
        details->>'run_id' as run_id,
        (details->>'reused_active')::boolean as reused_active
      from public.audit_shopify_connection_events
      where event_type = 'audit_collector_requested'
      order by created_at, id
    `);
    expect(requests.rows).toEqual([
      { actor_profile_id: ADMIN, run_id: RUN, reused_active: false },
      { actor_profile_id: ADMIN, run_id: RUN, reused_active: true },
      { actor_profile_id: ADMIN, run_id: RUN, reused_active: true },
    ]);
    await expect(enqueue({ note: "different request" })).rejects.toThrow(
      /different evidence/i,
    );
    await expect(
      enqueue({ domain: "another-shop.myshopify.com" }),
    ).rejects.toThrow(/exact connected Shopify domain/i);
  });

  it("persists bounded progress across renew, voluntary yield, resume and completion", async () => {
    await enqueue({ checkpoint: { catalog: { cursor: null, pages: 0 } } });
    const firstClaim = await claim(LEASE_A);
    expect(firstClaim.rows).toHaveLength(1);
    expect(firstClaim.rows[0]).toMatchObject({
      state: "running",
      attempt_count: 1,
      retry_count: 0,
      lease_token: LEASE_A,
      lease_generation: 1,
    });

    const firstExpiry = firstClaim.rows[0].lease_expires_at;
    const renewed = await renew(LEASE_A, 1, {
      catalog: { cursor: "cursor-1", pages: 1 },
    });
    expect(renewed.rows[0].checkpoint).toEqual({
      catalog: { cursor: "cursor-1", pages: 1 },
    });
    expect(renewed.rows[0].lease_expires_at!.getTime()).toBeGreaterThanOrEqual(
      firstExpiry!.getTime(),
    );

    const yielded = await yieldRun(LEASE_A, 1, {
      catalog: { cursor: "cursor-2", pages: 2 },
    });
    expect(yielded.rows[0]).toMatchObject({
      state: "queued",
      attempt_count: 1,
      retry_count: 0,
      checkpoint: { catalog: { cursor: "cursor-2", pages: 2 } },
      lease_token: null,
    });

    const secondClaim = await claim(LEASE_B);
    expect(secondClaim.rows[0]).toMatchObject({
      state: "running",
      attempt_count: 2,
      retry_count: 0,
      checkpoint: { catalog: { cursor: "cursor-2", pages: 2 } },
      lease_token: LEASE_B,
      lease_generation: 2,
    });

    const completed = await complete(
      LEASE_B,
      2,
      { catalog: { cursor: null, pages: 3, done: true } },
      {
        schemaVersion: 1,
        summary: { products: 1448, variants: 38068 },
      },
    );
    expect(completed.rows[0]).toMatchObject({
      state: "completed",
      checkpoint: { catalog: { cursor: null, pages: 3, done: true } },
      artifact: {
        schemaVersion: 1,
        summary: { products: 1448, variants: 38068 },
      },
      lease_token: null,
      error_code: null,
    });
    expect(completed.rows[0].completed_at).toBeInstanceOf(Date);
    await expect(fail(LEASE_B, 2, false)).rejects.toThrow(/lease is not current/i);
  });

  it("serializes active claims and fences workers after an expired-lease reclaim", async () => {
    await enqueue({ maxRetries: 1 });
    const first = await claim(LEASE_A);
    expect(first.rows[0].lease_generation).toBe(1);

    const contended = await claim(LEASE_B);
    expect(contended.rows).toHaveLength(0);

    await db.query(
      `update public.audit_shopify_runs
       set lease_acquired_at = clock_timestamp() - interval '2 minutes',
           lease_renewed_at = clock_timestamp() - interval '2 minutes',
           lease_expires_at = clock_timestamp() - interval '1 minute'
       where id = $1`,
      [RUN],
    );
    const reclaimed = await claim(LEASE_B);
    expect(reclaimed.rows[0]).toMatchObject({
      state: "running",
      attempt_count: 2,
      retry_count: 1,
      lease_token: LEASE_B,
      lease_generation: 2,
    });
    await expect(
      renew(LEASE_A, 1, { catalog: { cursor: "stale" } }),
    ).rejects.toThrow(/lease is not current/i);

    await db.query(
      `update public.audit_shopify_runs
       set lease_acquired_at = clock_timestamp() - interval '2 minutes',
           lease_renewed_at = clock_timestamp() - interval '2 minutes',
           lease_expires_at = clock_timestamp() - interval '1 minute'
       where id = $1`,
      [RUN],
    );
    const exhausted = await claim(LEASE_C);
    expect(exhausted.rows).toHaveLength(0);

    const terminal = await db.query<RunRow>(
      "select * from public.audit_shopify_runs where id = $1",
      [RUN],
    );
    expect(terminal.rows[0]).toMatchObject({
      state: "failed",
      retry_count: 1,
      error_code: "lease_expired",
      lease_token: null,
    });
    expect(terminal.rows[0].failed_at).toBeInstanceOf(Date);

    const definition = await db.query<{ definition: string }>(`
      select pg_get_functiondef(procedure.oid) as definition
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = 'claim_audit_shopify_run'
    `);
    expect(definition.rows[0].definition.toLowerCase()).toContain(
      "for update of run skip locked",
    );
  });

  it("stops live work after revocation and still records a fenced expired failure", async () => {
    await enqueue({ maxRetries: 0 });
    await claim(LEASE_A);

    await db.query(
      "select public.revoke_audit_shopify_connection($1::uuid, $2::uuid)",
      [CONNECTION, ADMIN],
    );
    await expect(
      renew(LEASE_A, 1, { catalog: { cursor: "after-revocation" } }),
    ).rejects.toThrow(/lease is not current/i);
    await expect(
      complete(LEASE_A, 1, {}, { summary: { products: 1 } }),
    ).rejects.toThrow(/lease is not current/i);

    await db.query(
      `update public.audit_shopify_runs
       set lease_acquired_at = clock_timestamp() - interval '2 minutes',
           lease_renewed_at = clock_timestamp() - interval '2 minutes',
           lease_expires_at = clock_timestamp() - interval '1 minute'
       where id = $1`,
      [RUN],
    );
    const terminal = await fail(
      LEASE_A,
      1,
      false,
      "connection_revoked",
    );
    expect(terminal.rows[0]).toMatchObject({
      state: "failed",
      error_code: "connection_revoked",
      lease_token: null,
    });
  });

  it("requeues retryable failures without losing progress and guards terminal transitions", async () => {
    await enqueue({ maxRetries: 1 });
    await claim(LEASE_A);

    const retried = await fail(LEASE_A, 1, true);
    expect(retried.rows[0]).toMatchObject({
      state: "queued",
      retry_count: 1,
      checkpoint: { catalog: { cursor: "cursor-1" } },
      error_code: "shopify_rate_limited",
      lease_token: null,
    });

    const second = await claim(LEASE_B);
    expect(second.rows[0]).toMatchObject({
      state: "running",
      retry_count: 1,
      error_code: null,
      lease_generation: 2,
    });
    const terminal = await fail(LEASE_B, 2, true, "shopify_unavailable");
    expect(terminal.rows[0]).toMatchObject({
      state: "failed",
      retry_count: 1,
      error_code: "shopify_unavailable",
      lease_token: null,
    });
    expect(terminal.rows[0].failed_at).toBeInstanceOf(Date);
    await expect(
      complete(LEASE_B, 2, {}, { summary: { products: 1 } }),
    ).rejects.toThrow(/lease is not current/i);
  });

  it("rejects secret-shaped keys recursively and enforces the checkpoint bound", async () => {
    await expect(
      enqueue({
        checkpoint: {
          catalog: { nested: [{ client_secret: "must-not-be-stored" }] },
        },
      }),
    ).rejects.toThrow(/invalid audit run request/i);

    await expect(
      enqueue({ checkpoint: { cursor: "x".repeat(70_000) } }),
    ).rejects.toThrow(/invalid audit run request/i);

    await enqueue({ checkpoint: { catalog: { cursor: "safe-cursor" } } });
    await claim(LEASE_A);
    await expect(
      renew(LEASE_A, 1, {
        catalog: {
          pages: [{ tokensByPage: { accessToken: "must-not-be-stored" } }],
        },
      }),
    ).rejects.toThrow(/invalid audit run renewal/i);
    await expect(
      complete(
        LEASE_A,
        1,
        { catalog: { done: true } },
        { summary: {}, raw: [{ api_key: "must-not-be-stored" }] },
      ),
    ).rejects.toThrow(/invalid completed audit artifact/i);

    await expect(
      db.query(
        `update public.audit_shopify_runs
         set checkpoint = '{"outer":{"password":"must-not-be-stored"}}'::jsonb
         where id = $1`,
        [RUN],
      ),
    ).rejects.toThrow(/audit_shopify_runs_checkpoint_safe/i);
  });
});
