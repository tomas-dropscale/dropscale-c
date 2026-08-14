import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0054_client_reporting_bindings.sql",
  "utf8",
);

const ADMIN = "54000000-0000-4000-8000-000000000001";
const CLIENT = "54000000-0000-4000-8000-000000000002";
const OTHER_CLIENT = "54000000-0000-4000-8000-000000000003";

const HYBRID_ACCOUNT = "54000000-0000-4000-8000-000000000010";
const STORE_ACCOUNT = "54000000-0000-4000-8000-000000000011";
const GOOGLE_ACCOUNT_1 = "54000000-0000-4000-8000-000000000012";
const GOOGLE_ACCOUNT_2 = "54000000-0000-4000-8000-000000000013";
const OTHER_ACCOUNT = "54000000-0000-4000-8000-000000000014";
const WRONG_DOMAIN_ACCOUNT = "54000000-0000-4000-8000-000000000015";
const WRONG_GOOGLE_ACCOUNT = "54000000-0000-4000-8000-000000000016";
const UNMAPPED_ACCOUNT = "54000000-0000-4000-8000-000000000017";

const HYBRID_SHOPIFY = "54000000-0000-4000-8000-000000000020";
const MULTI_SHOPIFY = "54000000-0000-4000-8000-000000000021";
const OTHER_SHOPIFY = "54000000-0000-4000-8000-000000000022";
const UNMAPPED_SHOPIFY = "54000000-0000-4000-8000-000000000023";
const HYBRID_GOOGLE = "54000000-0000-4000-8000-000000000030";
const GOOGLE_1 = "54000000-0000-4000-8000-000000000031";
const GOOGLE_2 = "54000000-0000-4000-8000-000000000032";
const OTHER_GOOGLE = "54000000-0000-4000-8000-000000000033";
const UNMAPPED_GOOGLE = "54000000-0000-4000-8000-000000000034";

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
create schema auth;
create or replace function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create or replace function public.normalize_google_ads_customer_id(p_value text)
returns text
language sql immutable strict
set search_path = public
as $$
  select nullif(regexp_replace(trim(p_value), '[^0-9]', '', 'g'), '')
$$;

create table public.portal_clients (
  id uuid primary key,
  full_name text not null,
  approval_status text not null default 'approved'
);
create table public.profiles (
  id uuid primary key,
  role text not null
);
create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  store_name text not null,
  google_ads_customer_id text,
  shopify_url text,
  currency text not null default 'EUR'
);
create table public.client_shopify_connections (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  status text not null check (status in ('connected', 'revoked')),
  shopify_domain text not null,
  shopify_name text not null default 'Store'
);
create table public.client_google_ads_connections (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  status text not null check (status in ('connected', 'revoked')),
  windsor_account_id text not null,
  account_name text not null default 'Ads'
);
create table public.client_asset_mappings (
  id uuid primary key default gen_random_uuid(),
  shopify_connection_id uuid not null references public.client_shopify_connections(id),
  google_ads_connection_id uuid not null unique references public.client_google_ads_connections(id)
);

create table public.daily_metrics (
  ad_account_id uuid not null references public.ad_accounts(id),
  day date not null,
  ad_spend numeric not null,
  revenue numeric not null,
  primary key (ad_account_id, day)
);
create table public.commissions (
  id uuid primary key,
  ad_account_id uuid not null references public.ad_accounts(id),
  gross_amount numeric not null,
  amount numeric not null
);
create table public.ad_account_billing_starts (
  id uuid primary key,
  ad_account_id uuid not null unique references public.ad_accounts(id),
  google_ads_customer_id text not null,
  currency text not null,
  baseline_cost_micros numeric not null
);
create table public.ad_account_billing_ends (
  id uuid primary key,
  ad_account_id uuid not null unique references public.ad_accounts(id),
  google_ads_customer_id text not null,
  currency text not null,
  end_cost_micros numeric not null
);
create table public.invoices (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  amount numeric not null,
  status text not null
);
create table public.invoice_commission_rows (
  id uuid primary key,
  invoice_id uuid not null references public.invoices(id),
  commission_id uuid not null references public.commissions(id)
);
`;

let db: PGlite;

async function actAs(role: string) {
  await db.query("select set_config('test.role', $1, false)", [role]);
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected SQLSTATE ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

type CommitOptions = {
  account?: string;
  shopify?: string | null;
  google?: string | null;
  anchor?: string | null;
  key?: string;
  reason?: string;
  admin?: string;
};

async function commit(options: CommitOptions = {}) {
  const {
    account = HYBRID_ACCOUNT,
    shopify = HYBRID_SHOPIFY,
    google = HYBRID_GOOGLE,
    anchor = null,
    key = "bind:hybrid:001",
    reason = "Reviewed exact V2 migration match",
    admin = ADMIN,
  } = options;
  return db.query<{ id: string }>(
    `select public.commit_client_reporting_binding(
       $1, $2, $3, $4, $5, $6, $7
     ) as id`,
    [account, shopify, google, anchor, key, admin, reason],
  );
}

async function revoke(
  bindingId: string,
  key = "revoke:hybrid:001",
  reason = "Reviewed rollback of reporting source",
) {
  return db.query<{ id: string }>(
    "select public.revoke_client_reporting_binding($1, $2, $3, $4) as id",
    [bindingId, ADMIN, key, reason],
  );
}

async function financialSnapshot() {
  const result = await db.query<{ snapshot: unknown }>(`
    select jsonb_build_object(
      'accounts', jsonb_build_object(
        'count', (select count(*) from public.ad_accounts),
        'fingerprint', md5(coalesce((select jsonb_agg(to_jsonb(row) order by row.id)::text from public.ad_accounts row), '[]'))
      ),
      'metrics', jsonb_build_object(
        'count', (select count(*) from public.daily_metrics),
        'fingerprint', md5(coalesce((select jsonb_agg(to_jsonb(row) order by row.ad_account_id, row.day)::text from public.daily_metrics row), '[]'))
      ),
      'commissions', jsonb_build_object(
        'count', (select count(*) from public.commissions),
        'fingerprint', md5(coalesce((select jsonb_agg(to_jsonb(row) order by row.id)::text from public.commissions row), '[]'))
      ),
      'starts', jsonb_build_object(
        'count', (select count(*) from public.ad_account_billing_starts),
        'fingerprint', md5(coalesce((select jsonb_agg(to_jsonb(row) order by row.id)::text from public.ad_account_billing_starts row), '[]'))
      ),
      'ends', jsonb_build_object(
        'count', (select count(*) from public.ad_account_billing_ends),
        'fingerprint', md5(coalesce((select jsonb_agg(to_jsonb(row) order by row.id)::text from public.ad_account_billing_ends row), '[]'))
      ),
      'invoices', jsonb_build_object(
        'count', (select count(*) from public.invoices),
        'fingerprint', md5(coalesce((select jsonb_agg(to_jsonb(row) order by row.id)::text from public.invoices row), '[]'))
      ),
      'invoiceRows', jsonb_build_object(
        'count', (select count(*) from public.invoice_commission_rows),
        'fingerprint', md5(coalesce((select jsonb_agg(to_jsonb(row) order by row.id)::text from public.invoice_commission_rows row), '[]'))
      )
    ) as snapshot
  `);
  return result.rows[0]?.snapshot;
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
    `insert into public.portal_clients (id, full_name)
       values ($1, 'Primary Client'), ($2, 'Other Client')`,
    [CLIENT, OTHER_CLIENT],
  );
  await db.query(
    `insert into public.profiles (id, role)
       values ($1, 'admin'), ($2, 'member'), ($3, 'member')`,
    [ADMIN, CLIENT, OTHER_CLIENT],
  );
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, store_name, shopify_url, google_ads_customer_id, currency
     ) values
       ($1, $8, 'Hybrid', 'https://hybrid-store.myshopify.com/admin', '1111111111', 'EUR'),
       ($2, $8, 'Store anchor', 'multi-store.myshopify.com', null, 'EUR'),
       ($3, $8, 'Google child 1', null, '2222222222', 'EUR'),
       ($4, $8, 'Google child 2', null, '3333333333', 'EUR'),
       ($5, $9, 'Other owner', 'other-store.myshopify.com', '4444444444', 'EUR'),
       ($6, $8, 'Wrong domain', 'different-store.myshopify.com', null, 'EUR'),
       ($7, $8, 'Wrong Google', null, '5555555555', 'EUR'),
       ($10, $8, 'Unmapped', 'unmapped-store.myshopify.com', '6666666666', 'EUR')`,
    [
      HYBRID_ACCOUNT,
      STORE_ACCOUNT,
      GOOGLE_ACCOUNT_1,
      GOOGLE_ACCOUNT_2,
      OTHER_ACCOUNT,
      WRONG_DOMAIN_ACCOUNT,
      WRONG_GOOGLE_ACCOUNT,
      CLIENT,
      OTHER_CLIENT,
      UNMAPPED_ACCOUNT,
    ],
  );
  await db.query(
    `insert into public.client_shopify_connections (
       id, client_id, status, shopify_domain, shopify_name
     ) values
       ($1, $5, 'connected', 'hybrid-store.myshopify.com', 'Hybrid'),
       ($2, $5, 'connected', 'multi-store.myshopify.com', 'Multi'),
       ($3, $6, 'connected', 'other-store.myshopify.com', 'Other'),
       ($4, $5, 'connected', 'unmapped-store.myshopify.com', 'Unmapped')`,
    [
      HYBRID_SHOPIFY,
      MULTI_SHOPIFY,
      OTHER_SHOPIFY,
      UNMAPPED_SHOPIFY,
      CLIENT,
      OTHER_CLIENT,
    ],
  );
  await db.query(
    `insert into public.client_google_ads_connections (
       id, client_id, status, windsor_account_id, account_name
     ) values
       ($1, $6, 'connected', '111-111-1111', 'Hybrid Ads'),
       ($2, $6, 'connected', '222-222-2222', 'Child Ads 1'),
       ($3, $6, 'connected', '3333333333', 'Child Ads 2'),
       ($4, $7, 'connected', '444-444-4444', 'Other Ads'),
       ($5, $6, 'connected', '666-666-6666', 'Unmapped Ads')`,
    [
      HYBRID_GOOGLE,
      GOOGLE_1,
      GOOGLE_2,
      OTHER_GOOGLE,
      UNMAPPED_GOOGLE,
      CLIENT,
      OTHER_CLIENT,
    ],
  );
  await db.query(
    `insert into public.client_asset_mappings (
       shopify_connection_id, google_ads_connection_id
     ) values ($1, $2), ($3, $4), ($3, $5)`,
    [HYBRID_SHOPIFY, HYBRID_GOOGLE, MULTI_SHOPIFY, GOOGLE_1, GOOGLE_2],
  );
  await actAs("service_role");
});

describe("client reporting bindings migration", () => {
  it("keeps tables read-only and lifecycle RPCs service-role-only", async () => {
    const privileges = await db.query<{
      authenticated_commit: boolean;
      service_commit: boolean;
      authenticated_revoke: boolean;
      service_revoke: boolean;
      service_select: boolean;
      service_insert: boolean;
      authenticated_select: boolean;
      rls_tables: string;
      restrict_fks: string;
      total_fks: string;
    }>(`
      select
        has_function_privilege(
          'authenticated',
          'public.commit_client_reporting_binding(uuid,uuid,uuid,uuid,text,uuid,text)',
          'EXECUTE'
        ) as authenticated_commit,
        has_function_privilege(
          'service_role',
          'public.commit_client_reporting_binding(uuid,uuid,uuid,uuid,text,uuid,text)',
          'EXECUTE'
        ) as service_commit,
        has_function_privilege(
          'authenticated',
          'public.revoke_client_reporting_binding(uuid,uuid,text,text)',
          'EXECUTE'
        ) as authenticated_revoke,
        has_function_privilege(
          'service_role',
          'public.revoke_client_reporting_binding(uuid,uuid,text,text)',
          'EXECUTE'
        ) as service_revoke,
        has_table_privilege('service_role', 'public.client_reporting_bindings', 'SELECT')
          as service_select,
        has_table_privilege('service_role', 'public.client_reporting_bindings', 'INSERT')
          as service_insert,
        has_table_privilege('authenticated', 'public.client_reporting_bindings', 'SELECT')
          as authenticated_select,
        (
          select count(*)::text from pg_class
          where oid in (
            'public.client_reporting_bindings'::regclass,
            'public.client_reporting_binding_events'::regclass
          ) and relrowsecurity
        ) as rls_tables,
        (
          select count(*)::text from pg_constraint
          where conrelid in (
            'public.client_reporting_bindings'::regclass,
            'public.client_reporting_binding_events'::regclass
          ) and contype = 'f' and confdeltype = 'r'
        ) as restrict_fks,
        (
          select count(*)::text from pg_constraint
          where conrelid in (
            'public.client_reporting_bindings'::regclass,
            'public.client_reporting_binding_events'::regclass
          ) and contype = 'f'
        ) as total_fks
    `);
    expect(privileges.rows[0]).toEqual({
      authenticated_commit: false,
      service_commit: true,
      authenticated_revoke: false,
      service_revoke: true,
      service_select: true,
      service_insert: false,
      authenticated_select: false,
      rls_tables: "2",
      restrict_fks: "9",
      total_fks: "9",
    });

    await actAs("authenticated");
    await db.exec("set role authenticated");
    try {
      await expect(commit()).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }

    await db.exec("set role service_role");
    try {
      await expect(
        db.query(
          `insert into public.client_reporting_bindings (
             client_id, ad_account_id, shopify_connection_id,
             idempotency_key, bound_reason, bound_by
           ) values ($1, $2, $3, 'direct:write:001', 'Must use RPC', $4)`,
          [CLIENT, STORE_ACCOUNT, MULTI_SHOPIFY, ADMIN],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  });

  it("commits an exact hybrid match once and returns the same binding on retry", async () => {
    const first = await commit();
    const retry = await commit();
    expect(retry.rows[0]).toEqual(first.rows[0]);

    const result = await db.query<{
      bindings: string;
      events: string;
      customer_id: string;
      domain: string;
    }>(`
      select
        (select count(*)::text from public.client_reporting_bindings) as bindings,
        (select count(*)::text from public.client_reporting_binding_events) as events,
        event.details ->> 'googleAdsCustomerId' as customer_id,
        event.details ->> 'shopifyDomain' as domain
      from public.client_reporting_binding_events event
    `);
    expect(result.rows[0]).toEqual({
      bindings: "1",
      events: "1",
      customer_id: "1111111111",
      domain: "hybrid-store.myshopify.com",
    });
  });

  it("holds a share lock on the exact mapping until the binding transaction commits", async () => {
    await db.transaction(async (tx) => {
      await tx.query(
        `select public.commit_client_reporting_binding(
           $1, $2, $3, null, 'bind:mapping:lock', $4,
           'Reviewed exact mapping lock'
         )`,
        [HYBRID_ACCOUNT, HYBRID_SHOPIFY, HYBRID_GOOGLE, ADMIN],
      );

      const locks = await tx.query<{ row_share_locks: string }>(`
        select count(*)::text as row_share_locks
        from pg_locks held_lock
        where held_lock.pid = pg_backend_pid()
          and held_lock.relation = 'public.client_asset_mappings'::regclass
          and held_lock.mode = 'RowShareLock'
          and held_lock.granted
      `);
      expect(Number(locks.rows[0]?.row_share_locks)).toBeGreaterThan(0);

      const exactMapping = await tx.query<{ mappings: string }>(
        `select count(*)::text as mappings
         from public.client_asset_mappings
         where shopify_connection_id = $1 and google_ads_connection_id = $2`,
        [HYBRID_SHOPIFY, HYBRID_GOOGLE],
      );
      expect(exactMapping.rows[0]).toEqual({ mappings: "1" });
    });

    const definition = await db.query<{ source: string }>(`
      select pg_get_functiondef(
        'public.commit_client_reporting_binding(uuid,uuid,uuid,uuid,text,uuid,text)'::regprocedure
      ) as source
    `);
    expect(definition.rows[0]?.source.match(/from public\.client_asset_mappings mapping[\s\S]*?for share;/gi))
      .toHaveLength(3);
  });

  it("rejects owner, identifier, domain, absent-source and mapping mismatches", async () => {
    await expectSqlState(
      commit({
        account: OTHER_ACCOUNT,
        shopify: HYBRID_SHOPIFY,
        google: HYBRID_GOOGLE,
        key: "bind:wrong-owner",
      }),
      "23514",
    );
    await expectSqlState(
      commit({
        account: WRONG_DOMAIN_ACCOUNT,
        shopify: HYBRID_SHOPIFY,
        google: null,
        key: "bind:wrong-domain",
      }),
      "23514",
    );
    await expectSqlState(
      commit({
        account: WRONG_GOOGLE_ACCOUNT,
        shopify: null,
        google: GOOGLE_1,
        key: "bind:wrong-google",
      }),
      "23514",
    );
    await expectSqlState(
      commit({
        account: STORE_ACCOUNT,
        shopify: null,
        google: GOOGLE_1,
        key: "bind:absent-google",
      }),
      "23514",
    );
    await expectSqlState(
      commit({
        account: UNMAPPED_ACCOUNT,
        shopify: UNMAPPED_SHOPIFY,
        google: UNMAPPED_GOOGLE,
        key: "bind:no-mapping",
      }),
      "23514",
    );
  });

  it("binds an exact unmapped Google source without claiming the legacy Shopify source", async () => {
    const result = await commit({
      account: UNMAPPED_ACCOUNT,
      shopify: null,
      google: UNMAPPED_GOOGLE,
      key: "bind:partial:google",
    });
    const bindingId = result.rows[0]!.id;
    const stored = await db.query<{
      shopify_connection_id: string | null;
      google_ads_connection_id: string;
      event_shopify_domain: string | null;
      event_google_customer_id: string;
    }>(`
      select binding.shopify_connection_id,
             binding.google_ads_connection_id,
             event.details ->> 'shopifyDomain' as event_shopify_domain,
             event.details ->> 'googleAdsCustomerId' as event_google_customer_id
      from public.client_reporting_bindings binding
      join public.client_reporting_binding_events event on event.binding_id = binding.id
      where binding.id = $1
    `, [bindingId]);
    expect(stored.rows[0]).toEqual({
      shopify_connection_id: null,
      google_ads_connection_id: UNMAPPED_GOOGLE,
      event_shopify_domain: null,
      event_google_customer_id: "6666666666",
    });

    await db.query(
      "update public.ad_accounts set shopify_url = 'renamed-unbound.myshopify.com' where id = $1",
      [UNMAPPED_ACCOUNT],
    );
    await expectSqlState(
      db.query(
        "update public.ad_accounts set google_ads_customer_id = '7777777777' where id = $1",
        [UNMAPPED_ACCOUNT],
      ),
      "23514",
    );
  });

  it("requires connected sources and a verified admin", async () => {
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [HYBRID_GOOGLE],
    );
    await expectSqlState(commit(), "P0002");
    await expectSqlState(commit({ admin: CLIENT, key: "bind:not-admin" }), "42501");
  });

  it("rejects archived and internal ad account owners", async () => {
    await db.query(
      "update public.portal_clients set approval_status = 'rejected' where id = $1",
      [CLIENT],
    );
    await expectSqlState(commit({ key: "bind:rejected-owner" }), "23514");

    await db.query(
      "update public.portal_clients set approval_status = 'approved' where id = $1",
      [CLIENT],
    );
    await db.query("update public.profiles set role = 'admin' where id = $1", [CLIENT]);
    await expectSqlState(commit({ key: "bind:internal-owner" }), "23514");
  });

  it("locks the owner approval and profile role rows through commit", async () => {
    await db.transaction(async (tx) => {
      await tx.query(
        `select public.commit_client_reporting_binding(
           $1, $2, $3, null, 'bind:owner:locks', $4,
           'Reviewed owner lock serialization'
         )`,
        [HYBRID_ACCOUNT, HYBRID_SHOPIFY, HYBRID_GOOGLE, ADMIN],
      );

      const locks = await tx.query<{
        portal_client_locks: string;
        profile_locks: string;
      }>(`
        select
          count(*) filter (
            where held_lock.relation = 'public.portal_clients'::regclass
              and held_lock.mode = 'RowShareLock'
          )::text as portal_client_locks,
          count(*) filter (
            where held_lock.relation = 'public.profiles'::regclass
              and held_lock.mode = 'RowShareLock'
          )::text as profile_locks
        from pg_locks held_lock
        where held_lock.pid = pg_backend_pid() and held_lock.granted
      `);
      expect(Number(locks.rows[0]?.portal_client_locks)).toBeGreaterThan(0);
      expect(Number(locks.rows[0]?.profile_locks)).toBeGreaterThan(0);
    });

    const definition = await db.query<{ source: string }>(`
      select pg_get_functiondef(
        'public.commit_client_reporting_binding(uuid,uuid,uuid,uuid,text,uuid,text)'::regprocedure
      ) as source
    `);
    expect(definition.rows[0]?.source).toMatch(/for share of client, profile;/i);
  });

  it("supports one Shopify fact anchor with multiple mapped Google children", async () => {
    const anchor = await commit({
      account: STORE_ACCOUNT,
      shopify: MULTI_SHOPIFY,
      google: null,
      key: "bind:multi:anchor",
    });
    const anchorId = anchor.rows[0]!.id;
    await commit({
      account: GOOGLE_ACCOUNT_1,
      shopify: null,
      google: GOOGLE_1,
      anchor: anchorId,
      key: "bind:multi:google1",
    });
    await commit({
      account: GOOGLE_ACCOUNT_2,
      shopify: null,
      google: GOOGLE_2,
      anchor: anchorId,
      key: "bind:multi:google2",
    });

    const result = await db.query<{
      active: string;
      shopify_facts: string;
      google_sources: string;
      anchored_children: string;
    }>(`
      select
        count(*) filter (where status = 'active')::text as active,
        count(shopify_connection_id) filter (where status = 'active')::text as shopify_facts,
        count(google_ads_connection_id) filter (where status = 'active')::text as google_sources,
        count(shopify_anchor_binding_id) filter (where status = 'active')::text as anchored_children
      from public.client_reporting_bindings
    `);
    expect(result.rows[0]).toEqual({
      active: "3",
      shopify_facts: "1",
      google_sources: "2",
      anchored_children: "2",
    });

    await expectSqlState(revoke(anchorId, "revoke:anchor:blocked"), "23503");
  });

  it("enforces active uniqueness and rejects idempotency-key reuse", async () => {
    await commit();
    await expectSqlState(
      commit({ key: "bind:hybrid:other", reason: "A separate reviewed action" }),
      "23505",
    );
    await expectSqlState(
      commit({ reason: "Changed reason for the same key" }),
      "23505",
    );
  });

  it("revokes without deleting history and keeps both lifecycle events immutable", async () => {
    const bindingId = (await commit()).rows[0]!.id;
    const first = await revoke(bindingId);
    const retry = await revoke(bindingId);
    expect(retry.rows[0]).toEqual(first.rows[0]);

    const history = await db.query<{
      status: string;
      events: string[];
      active: string;
    }>(`
      select binding.status,
             array_agg(event.event_type order by event.created_at) as events,
             (select count(*)::text from public.client_reporting_bindings where status = 'active') as active
      from public.client_reporting_bindings binding
      join public.client_reporting_binding_events event on event.binding_id = binding.id
      where binding.id = $1
      group by binding.status
    `, [bindingId]);
    expect(history.rows[0]).toEqual({
      status: "revoked",
      events: ["bound", "revoked"],
      active: "0",
    });

    await expectSqlState(
      db.query(
        "update public.client_reporting_binding_events set reason = 'Tampered' where binding_id = $1",
        [bindingId],
      ),
      "23514",
    );
    await expectSqlState(
      db.query("delete from public.client_reporting_bindings where id = $1", [bindingId]),
      "23514",
    );

    const rebound = await commit({ key: "bind:hybrid:rebound" });
    expect(rebound.rows[0]!.id).not.toBe(bindingId);
  });

  it("prevents source drift until the binding is explicitly revoked", async () => {
    const bindingId = (await commit()).rows[0]!.id;
    await expectSqlState(
      db.query(
        "update public.ad_accounts set google_ads_customer_id = '9999999999' where id = $1",
        [HYBRID_ACCOUNT],
      ),
      "23514",
    );
    await expectSqlState(
      db.query(
        "update public.client_google_ads_connections set status = 'revoked' where id = $1",
        [HYBRID_GOOGLE],
      ),
      "23514",
    );
    await expectSqlState(
      db.query(
        "delete from public.client_asset_mappings where google_ads_connection_id = $1",
        [HYBRID_GOOGLE],
      ),
      "23514",
    );

    await revoke(bindingId);
    await db.query(
      "update public.client_google_ads_connections set status = 'revoked' where id = $1",
      [HYBRID_GOOGLE],
    );
    await db.query(
      "delete from public.client_asset_mappings where google_ads_connection_id = $1",
      [HYBRID_GOOGLE],
    );
  });

  it("rejects inserted and remapped pairs that contradict an active Google binding", async () => {
    await commit();

    await expectSqlState(
      db.query(
        `insert into public.client_asset_mappings (
           shopify_connection_id, google_ads_connection_id
         ) values ($1, $2)`,
        [UNMAPPED_SHOPIFY, HYBRID_GOOGLE],
      ),
      "23514",
    );

    // GOOGLE_1's current pair is not bound in this test. The guard must still
    // validate NEW and reject changing it to an already-bound Google source.
    await expectSqlState(
      db.query(
        `update public.client_asset_mappings
         set shopify_connection_id = $1, google_ads_connection_id = $2
         where google_ads_connection_id = $3`,
        [UNMAPPED_SHOPIFY, HYBRID_GOOGLE, GOOGLE_1],
      ),
      "23514",
    );

    await commit({
      account: UNMAPPED_ACCOUNT,
      shopify: null,
      google: UNMAPPED_GOOGLE,
      key: "bind:partial:insert-guard",
    });
    await expectSqlState(
      db.query(
        `insert into public.client_asset_mappings (
           shopify_connection_id, google_ads_connection_id
         ) values ($1, $2)`,
        [UNMAPPED_SHOPIFY, UNMAPPED_GOOGLE],
      ),
      "23514",
    );
  });

  it("serializes mapping creation and binding validation on the same Google source row", async () => {
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into public.client_asset_mappings (
           shopify_connection_id, google_ads_connection_id
         ) values ($1, $2)`,
        [UNMAPPED_SHOPIFY, UNMAPPED_GOOGLE],
      );

      const locks = await tx.query<{ google_row_locks: string }>(`
        select count(*)::text as google_row_locks
        from pg_locks held_lock
        where held_lock.pid = pg_backend_pid()
          and held_lock.relation = 'public.client_google_ads_connections'::regclass
          and held_lock.mode = 'RowShareLock'
          and held_lock.granted
      `);
      expect(Number(locks.rows[0]?.google_row_locks)).toBeGreaterThan(0);
    });

    const definitions = await db.query<{
      commit_source: string;
      guard_source: string;
    }>(`
      select
        pg_get_functiondef(
          'public.commit_client_reporting_binding(uuid,uuid,uuid,uuid,text,uuid,text)'::regprocedure
        ) as commit_source,
        pg_get_functiondef(
          'public.guard_bound_client_asset_mapping()'::regprocedure
        ) as guard_source
    `);
    expect(definitions.rows[0]?.commit_source).toMatch(
      /from public\.client_google_ads_connections\s+where id = p_google_ads_connection_id[\s\S]*?for update;/i,
    );
    expect(definitions.rows[0]?.guard_source).toMatch(
      /where connection\.id = new\.google_ads_connection_id\s+for update;/i,
    );
  });

  it("refuses inconsistent billing identity and never changes financial history", async () => {
    const COMMISSION = "54000000-0000-4000-8000-000000000040";
    const INVOICE = "54000000-0000-4000-8000-000000000041";
    await db.query(
      `insert into public.daily_metrics (ad_account_id, day, ad_spend, revenue)
       values ($1, date '2026-08-13', 125.25, 410.00)`,
      [HYBRID_ACCOUNT],
    );
    await db.query(
      `insert into public.commissions (id, ad_account_id, gross_amount, amount)
       values ($1, $2, 125.25, 12.525)`,
      [COMMISSION, HYBRID_ACCOUNT],
    );
    await db.query(
      `insert into public.ad_account_billing_starts (
         id, ad_account_id, google_ads_customer_id, currency, baseline_cost_micros
       ) values (gen_random_uuid(), $1, '1111111111', 'EUR', 1000000)`,
      [HYBRID_ACCOUNT],
    );
    await db.query(
      `insert into public.ad_account_billing_ends (
         id, ad_account_id, google_ads_customer_id, currency, end_cost_micros
       ) values (gen_random_uuid(), $1, '1111111111', 'EUR', 126250000)`,
      [HYBRID_ACCOUNT],
    );
    await db.query(
      `insert into public.invoices (id, client_id, amount, status)
       values ($1, $2, 12.53, 'paid')`,
      [INVOICE, CLIENT],
    );
    await db.query(
      `insert into public.invoice_commission_rows (id, invoice_id, commission_id)
       values (gen_random_uuid(), $1, $2)`,
      [INVOICE, COMMISSION],
    );
    const before = await financialSnapshot();
    const bindingId = (await commit()).rows[0]!.id;
    await revoke(bindingId);
    expect(await financialSnapshot()).toEqual(before);

    await db.query(
      `update public.ad_account_billing_starts
       set google_ads_customer_id = '9999999999'
       where ad_account_id = $1`,
      [HYBRID_ACCOUNT],
    );
    await expectSqlState(commit({ key: "bind:billing:mismatch" }), "23514");
  });
});
