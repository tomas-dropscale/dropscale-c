import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0060_google_reporting_metadata_enrichment.sql",
  "utf8",
);
const INCREMENTAL_GOOGLE_MIGRATION = readFileSync(
  "supabase/migrations/0049_incremental_google_ads_accounts.sql",
  "utf8",
);

const ADMIN = "60000000-0000-4000-8000-000000000001";
const MEMBER = "60000000-0000-4000-8000-000000000002";
const CLIENT = "60000000-0000-4000-8000-000000000003";
const OTHER_CLIENT = "60000000-0000-4000-8000-000000000004";
const PENDING_CLIENT = "60000000-0000-4000-8000-000000000005";
const INTERNAL_CLIENT = "60000000-0000-4000-8000-000000000006";
const SESSION = "60000000-0000-4000-8000-000000000010";
const OTHER_SESSION = "60000000-0000-4000-8000-000000000011";
const PENDING_SESSION = "60000000-0000-4000-8000-000000000012";
const INTERNAL_SESSION = "60000000-0000-4000-8000-000000000013";
const GOOGLE = "60000000-0000-4000-8000-000000000020";
const OTHER_GOOGLE = "60000000-0000-4000-8000-000000000021";
const MISMATCH_GOOGLE = "60000000-0000-4000-8000-000000000022";
const FILLED_GOOGLE = "60000000-0000-4000-8000-000000000023";
const PENDING_GOOGLE = "60000000-0000-4000-8000-000000000024";
const INTERNAL_GOOGLE = "60000000-0000-4000-8000-000000000025";
const WRONG_BINDING_GOOGLE = "60000000-0000-4000-8000-000000000026";
const ACCOUNT = "60000000-0000-4000-8000-000000000030";
const OTHER_ACCOUNT = "60000000-0000-4000-8000-000000000031";
const BINDING = "60000000-0000-4000-8000-000000000040";

const REASON = "Fresh Windsor exact-account reporting metadata proof";

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
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('test.role', true), '')
$$;

create or replace function public.normalize_google_ads_customer_id(p_value text)
returns text language sql immutable strict set search_path = public as $$
  select nullif(regexp_replace(btrim(p_value), '[^0-9]', '', 'g'), '')
$$;

create table public.profiles (
  id uuid primary key,
  role text not null
);
create table public.portal_clients (
  id uuid primary key,
  approval_status text not null
);
create table public.client_onboarding_sessions (
  id uuid primary key,
  requested_assets text[] not null default array['google_ads']::text[],
  status text not null,
  claimed_user_id uuid,
  invite_token_hash text,
  invite_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.client_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  event_type text not null,
  actor_type text not null,
  actor_id uuid,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.client_google_ads_connections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_onboarding_sessions(id),
  client_id uuid not null references public.portal_clients(id),
  status text not null,
  windsor_account_id text not null,
  account_name text not null,
  currency text,
  time_zone text,
  data_source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  revoked_at timestamptz,
  last_error_code text
);
create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  google_ads_customer_id text,
  currency text not null,
  store_name text not null
);
create table public.client_reporting_bindings (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id),
  ad_account_id uuid not null references public.ad_accounts(id),
  google_ads_connection_id uuid references public.client_google_ads_connections(id),
  status text not null
);

-- 0056 protects metadata underneath an active/staged binding with the legacy
-- purpose flag. 0060 must satisfy this guard while independently rejecting
-- the predecessor RPC and direct DML.
create or replace function public.guard_bound_google_ads_connection_identity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  purpose_bound_metadata_fill boolean := false;
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.google_ads_connection_id = old.id
      and binding.status in ('active', 'staged')
  ) then
    return new;
  end if;
  purpose_bound_metadata_fill :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.google_reporting_identity_refresh', true)
          is not distinct from old.id::text
    and (new.currency is not distinct from old.currency
      or (old.currency is null and new.currency ~ '^[A-Z]{3}$'))
    and (new.time_zone is not distinct from old.time_zone
      or (
        nullif(btrim(coalesce(old.time_zone, '')), '') is null
        and nullif(btrim(coalesce(new.time_zone, '')), '') is not null
      ));
  if (
    new.currency is distinct from old.currency
    or new.time_zone is distinct from old.time_zone
  ) and not purpose_bound_metadata_fill then
    raise exception 'Bound Google Ads identity is immutable.' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger client_google_ads_connections_guard_bound_identity
  before update on public.client_google_ads_connections
  for each row execute function public.guard_bound_google_ads_connection_identity();

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
  amount numeric not null
);
create table public.ad_account_billing_starts (
  id uuid primary key,
  ad_account_id uuid not null references public.ad_accounts(id),
  google_ads_customer_id text not null,
  currency text not null,
  baseline_cost_micros numeric not null
);
create table public.ad_account_billing_ends (
  id uuid primary key,
  ad_account_id uuid not null references public.ad_accounts(id),
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

grant select, insert, update, delete on table public.client_google_ads_connections
  to service_role;

create or replace function public.record_client_google_ads_reporting_identity(
  p_connection_id uuid,
  p_currency text,
  p_time_zone text,
  p_admin_id uuid,
  p_verified_at timestamptz
)
returns uuid language sql security definer set search_path = public as $$
  select p_connection_id
$$;
grant execute on function public.record_client_google_ads_reporting_identity(
  uuid, text, text, uuid, timestamptz
) to service_role;
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

type EnrichOptions = {
  connection?: string;
  currency?: string;
  timeZone?: string;
  admin?: string;
  verifiedAt?: string;
  reason?: string;
  key?: string;
};

async function enrich(options: EnrichOptions = {}) {
  return db.query<{ id: string }>(
    `select public.enrich_client_google_ads_reporting_metadata(
       $1, $2, $3, $4, $5, $6, $7
     ) as id`,
    [
      options.connection ?? GOOGLE,
      options.currency ?? "EUR",
      options.timeZone ?? "Europe/Lisbon",
      options.admin ?? ADMIN,
      options.verifiedAt ?? new Date().toISOString(),
      options.reason ?? REASON,
      options.key ?? "metadata:google:001",
    ],
  );
}

async function recordLegacyIdentity(options: EnrichOptions = {}) {
  return db.query<{ id: string }>(
    `select public.record_client_google_ads_reporting_identity(
       $1, $2, $3, $4, $5
     ) as id`,
    [
      options.connection ?? GOOGLE,
      options.currency ?? "EUR",
      options.timeZone ?? "Europe/Lisbon",
      options.admin ?? ADMIN,
      options.verifiedAt ?? new Date().toISOString(),
    ],
  );
}

async function protectedSnapshot() {
  const result = await db.query<{ snapshot: unknown }>(`
    select jsonb_build_object(
      'accounts', md5(coalesce((
        select jsonb_agg(to_jsonb(row) order by row.id)::text
        from public.ad_accounts row
      ), '[]')),
      'metrics', md5(coalesce((
        select jsonb_agg(to_jsonb(row) order by row.ad_account_id, row.day)::text
        from public.daily_metrics row
      ), '[]')),
      'commissions', md5(coalesce((
        select jsonb_agg(to_jsonb(row) order by row.id)::text
        from public.commissions row
      ), '[]')),
      'starts', md5(coalesce((
        select jsonb_agg(to_jsonb(row) order by row.id)::text
        from public.ad_account_billing_starts row
      ), '[]')),
      'ends', md5(coalesce((
        select jsonb_agg(to_jsonb(row) order by row.id)::text
        from public.ad_account_billing_ends row
      ), '[]')),
      'invoices', md5(coalesce((
        select jsonb_agg(to_jsonb(row) order by row.id)::text
        from public.invoices row
      ), '[]'))
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
  await db.exec(INCREMENTAL_GOOGLE_MIGRATION);
  await db.exec(MIGRATION);
  await db.query(
    `insert into public.profiles (id, role) values
       ($1, 'admin'), ($2, 'member'), ($3, 'member'), ($4, 'member'),
       ($5, 'member'), ($6, 'admin')`,
    [ADMIN, MEMBER, CLIENT, OTHER_CLIENT, PENDING_CLIENT, INTERNAL_CLIENT],
  );
  await db.query(
    `insert into public.portal_clients (id, approval_status) values
       ($1, 'approved'), ($2, 'approved'), ($3, 'pending'), ($4, 'approved')`,
    [CLIENT, OTHER_CLIENT, PENDING_CLIENT, INTERNAL_CLIENT],
  );
  await db.query(
    `insert into public.client_onboarding_sessions (id, status, claimed_user_id) values
       ($1, 'reviewed', $5), ($2, 'reviewed', $6),
       ($3, 'reviewed', $7), ($4, 'reviewed', $8)`,
    [
      SESSION,
      OTHER_SESSION,
      PENDING_SESSION,
      INTERNAL_SESSION,
      CLIENT,
      OTHER_CLIENT,
      PENDING_CLIENT,
      INTERNAL_CLIENT,
    ],
  );
  await db.query(
    `insert into public.client_google_ads_connections (
       id, session_id, client_id, status, windsor_account_id,
       account_name, currency, time_zone
     ) values
       ($1, $8, $9, 'connected', '111-111-1111', 'Primary', null, null),
       ($2, $10, $11, 'connected', '222-222-2222', 'Other', null, null),
       ($3, $8, $9, 'connected', '333-333-3333', 'Mismatch', 'USD', null),
       ($4, $8, $9, 'connected', '444-444-4444', 'Filled', 'EUR', 'Europe/Lisbon'),
       ($5, $12, $13, 'connected', '555-555-5555', 'Pending', null, null),
       ($6, $14, $15, 'connected', '666-666-6666', 'Internal', null, null),
       ($7, $8, $9, 'connected', '777-777-7777', 'Wrong binding', null, null)`,
    [
      GOOGLE,
      OTHER_GOOGLE,
      MISMATCH_GOOGLE,
      FILLED_GOOGLE,
      PENDING_GOOGLE,
      INTERNAL_GOOGLE,
      WRONG_BINDING_GOOGLE,
      SESSION,
      CLIENT,
      OTHER_SESSION,
      OTHER_CLIENT,
      PENDING_SESSION,
      PENDING_CLIENT,
      INTERNAL_SESSION,
      INTERNAL_CLIENT,
    ],
  );
  await db.query(
    `insert into public.ad_accounts (
       id, client_id, google_ads_customer_id, currency, store_name
     ) values
       ($1, $3, '1111111111', 'EUR', 'Primary'),
       ($2, $4, '7777777777', 'EUR', 'Wrong owner')`,
    [ACCOUNT, OTHER_ACCOUNT, CLIENT, OTHER_CLIENT],
  );
  await db.query(
    `insert into public.client_reporting_bindings (
       id, client_id, ad_account_id, google_ads_connection_id, status
     ) values ($1, $2, $3, $4, 'active')`,
    [BINDING, CLIENT, ACCOUNT, GOOGLE],
  );
  await db.query(
    "insert into public.daily_metrics values ($1, '2026-08-13', 12.34, 56.78)",
    [ACCOUNT],
  );
  await db.query(
    `insert into public.commissions values
       ('60000000-0000-4000-8000-000000000050', $1, 1.23)`,
    [ACCOUNT],
  );
  await db.query(
    `insert into public.ad_account_billing_starts values
       ('60000000-0000-4000-8000-000000000051', $1, '1111111111', 'EUR', 123456)`,
    [ACCOUNT],
  );
  await db.query(
    `insert into public.invoices values
       ('60000000-0000-4000-8000-000000000052', $1, 99.99, 'paid')`,
    [CLIENT],
  );
  await actAs("service_role");
});

describe("0060 Google reporting metadata enrichment", () => {
  it("fills only missing metadata and appends scoped immutable provenance", async () => {
    const verifiedAt = new Date().toISOString();
    const result = await enrich({ verifiedAt });
    expect(result.rows[0]?.id).toBe(GOOGLE);

    const connection = await db.query<{
      currency: string;
      time_zone: string;
      last_verified_at: string;
    }>(
      `select currency, time_zone, last_verified_at::text
       from public.client_google_ads_connections where id = $1`,
      [GOOGLE],
    );
    expect(connection.rows[0]).toMatchObject({
      currency: "EUR",
      time_zone: "Europe/Lisbon",
    });
    expect(Date.parse(connection.rows[0]!.last_verified_at)).toBe(Date.parse(verifiedAt));

    const event = await db.query<{
      client_id: string;
      binding_id: string;
      event_type: string;
      proof_scope: string;
      source_account_id: string;
      prior_currency: string | null;
      source_currency: string;
      prior_time_zone: string | null;
      source_time_zone: string;
      actor_id: string;
      reason: string;
      idempotency_key: string;
    }>("select * from public.client_google_ads_reporting_metadata_events");
    expect(event.rows).toEqual([
      expect.objectContaining({
        client_id: CLIENT,
        binding_id: BINDING,
        event_type: "metadata_enriched",
        proof_scope: "windsor_reporting_metadata_only",
        source_account_id: "1111111111",
        prior_currency: null,
        source_currency: "EUR",
        prior_time_zone: null,
        source_time_zone: "Europe/Lisbon",
        actor_id: ADMIN,
        reason: REASON,
        idempotency_key: "metadata:google:001",
      }),
    ]);
  });

  it("is exactly idempotent and rejects cross-source or changed retries", async () => {
    const verifiedAt = new Date().toISOString();
    await enrich({ verifiedAt });
    await expect(enrich({ verifiedAt })).resolves.toBeDefined();
    const count = await db.query<{ count: number }>(
      "select count(*)::int as count from public.client_google_ads_reporting_metadata_events",
    );
    expect(count.rows[0]?.count).toBe(1);

    await expectSqlState(
      enrich({ connection: OTHER_GOOGLE, verifiedAt }),
      "23505",
    );
    await expectSqlState(
      enrich({ verifiedAt, reason: "Different reporting proof reason" }),
      "23505",
    );
  });

  it("keeps the old Google Test RPC safe during a schema-first rolling deploy", async () => {
    const verifiedAt = new Date().toISOString();
    const result = await recordLegacyIdentity({
      currency: " eur ",
      timeZone: " Europe/Lisbon ",
      verifiedAt,
    });
    expect(result.rows[0]?.id).toBe(GOOGLE);

    const connection = await db.query<{ currency: string; time_zone: string }>(
      `select currency, time_zone from public.client_google_ads_connections
       where id = $1`,
      [GOOGLE],
    );
    expect(connection.rows[0]).toEqual({
      currency: "EUR",
      time_zone: "Europe/Lisbon",
    });

    const event = await db.query<{
      proof_scope: string;
      reason: string;
      idempotency_key: string;
    }>(
      `select proof_scope, reason, idempotency_key
       from public.client_google_ads_reporting_metadata_events`,
    );
    expect(event.rows).toEqual([
      expect.objectContaining({
        proof_scope: "windsor_reporting_metadata_only",
        reason: "Legacy admin Google Ads test verified reporting metadata.",
      }),
    ]);
    expect(event.rows[0]?.idempotency_key).toMatch(
      new RegExp(`^legacy-google-meta:${GOOGLE}:`),
    );

    const laterProof = new Date(Date.parse(verifiedAt) + 1).toISOString();
    await expect(
      recordLegacyIdentity({ verifiedAt: laterProof }),
    ).resolves.toBeDefined();
    const count = await db.query<{ count: number }>(
      "select count(*)::int as count from public.client_google_ads_reporting_metadata_events",
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("rejects stale proof, non-null mismatch, and a second enrichment", async () => {
    await expectSqlState(
      enrich({ verifiedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
      "22023",
    );
    await expectSqlState(
      enrich({ connection: MISMATCH_GOOGLE }),
      "23514",
    );
    await expectSqlState(
      enrich({ connection: FILLED_GOOGLE, key: "metadata:filled:001" }),
      "23514",
    );

    await enrich();
    await expectSqlState(
      enrich({ key: "metadata:google:second" }),
      "23514",
    );
  });

  it("rejects wrong admin, unapproved/internal owners, and binding ownership drift", async () => {
    await expectSqlState(enrich({ admin: MEMBER }), "42501");
    await expectSqlState(
      enrich({ connection: PENDING_GOOGLE, key: "metadata:pending:001" }),
      "42501",
    );
    await expectSqlState(
      enrich({ connection: INTERNAL_GOOGLE, key: "metadata:internal:001" }),
      "42501",
    );

    await db.query(
      `insert into public.client_reporting_bindings (
         id, client_id, ad_account_id, google_ads_connection_id, status
       ) values (
         '60000000-0000-4000-8000-000000000041', $1, $2, $3, 'active'
       )`,
      [OTHER_CLIENT, OTHER_ACCOUNT, WRONG_BINDING_GOOGLE],
    );
    await expectSqlState(
      enrich({ connection: WRONG_BINDING_GOOGLE, key: "metadata:owner:001" }),
      "23514",
    );
  });

  it("blocks direct metadata DML and keeps audit events immutable", async () => {
    await expectSqlState(
      db.query(
        `update public.client_google_ads_connections
         set currency = 'EUR', time_zone = 'Europe/Lisbon'
         where id = $1`,
        [OTHER_GOOGLE],
      ),
      "23514",
    );

    await enrich();
    await expectSqlState(
      db.query(
        `update public.client_google_ads_reporting_metadata_events
         set reason = 'Tampered reason'`,
      ),
      "23514",
    );
    await expectSqlState(
      db.query("delete from public.client_google_ads_reporting_metadata_events"),
      "23514",
    );
  });

  it("preserves the existing purpose-bound collecting-session upsert", async () => {
    const collectingSession = "60000000-0000-4000-8000-000000000014";
    const collectingGoogle = "60000000-0000-4000-8000-000000000027";
    const tokenHash = "a".repeat(64);
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, status, claimed_user_id, invite_token_hash, invite_expires_at
       ) values ($1, 'collecting', $2, $3, now() + interval '1 day')`,
      [collectingSession, OTHER_CLIENT, tokenHash],
    );
    await db.query(
      `insert into public.client_google_ads_connections (
         id, session_id, client_id, status, windsor_account_id,
         account_name, currency, time_zone
       ) values ($1, $2, $3, 'connected', '888-888-8888', 'Collecting', null, null)`,
      [collectingGoogle, collectingSession, OTHER_CLIENT],
    );

    const result = await db.query<{ id: string }>(
      `select public.upsert_client_google_ads_connection(
         $1, $2, '888-888-8888', 'Collecting', 'EUR', 'Europe/Lisbon', null
       ) as id`,
      [collectingSession, tokenHash],
    );
    expect(result.rows[0]?.id).toBe(collectingGoogle);
    const saved = await db.query<{ currency: string; time_zone: string }>(
      `select currency, time_zone from public.client_google_ads_connections
       where id = $1`,
      [collectingGoogle],
    );
    expect(saved.rows[0]).toEqual({ currency: "EUR", time_zone: "Europe/Lisbon" });
    const events = await db.query<{ count: number }>(
      "select count(*)::int as count from public.client_google_ads_reporting_metadata_events",
    );
    expect(events.rows[0]?.count).toBe(0);
  });

  it("preserves the 0049 plural same-session collection path", async () => {
    const collectingSession = "60000000-0000-4000-8000-000000000014";
    const collectingGoogle = "60000000-0000-4000-8000-000000000027";
    const tokenHash = "a".repeat(64);
    await db.query(
      `insert into public.client_onboarding_sessions (
         id, status, claimed_user_id, invite_token_hash, invite_expires_at
       ) values ($1, 'collecting', $2, $3, now() + interval '1 day')`,
      [collectingSession, OTHER_CLIENT, tokenHash],
    );
    await db.query(
      `insert into public.client_google_ads_connections (
         id, session_id, client_id, status, windsor_account_id,
         account_name, currency, time_zone
       ) values ($1, $2, $3, 'connected', '888-888-8888', 'Collecting', null, null)`,
      [collectingGoogle, collectingSession, OTHER_CLIENT],
    );

    const result = await db.query<{ ids: string[] }>(
      `select public.upsert_client_google_ads_connections(
         $1, $2, $3::jsonb
       ) as ids`,
      [
        collectingSession,
        tokenHash,
        JSON.stringify([
          {
            windsorAccountId: "888-888-8888",
            accountName: "Collecting retry",
            currency: "EUR",
            timeZone: "Europe/Lisbon",
            dataSourceId: null,
          },
        ]),
      ],
    );
    expect(result.rows[0]?.ids).toEqual([collectingGoogle]);
    const saved = await db.query<{
      account_name: string;
      currency: string;
      time_zone: string;
    }>(
      `select account_name, currency, time_zone
       from public.client_google_ads_connections where id = $1`,
      [collectingGoogle],
    );
    expect(saved.rows[0]).toEqual({
      account_name: "Collecting retry",
      currency: "EUR",
      time_zone: "Europe/Lisbon",
    });
  });

  it("keeps rolling-compatible RPCs service-only and evidence read-only", async () => {
    const privileges = await db.query<{
      service_rpc: boolean;
      authenticated_rpc: boolean;
      legacy_service_rpc: boolean;
      legacy_authenticated_rpc: boolean;
      plural_service_rpc: boolean;
      plural_authenticated_rpc: boolean;
      internal_service_rpc: boolean;
      service_select: boolean;
      service_insert: boolean;
      authenticated_select: boolean;
      service_connection_update: boolean;
    }>(`
      select
        has_function_privilege(
          'service_role',
          'public.enrich_client_google_ads_reporting_metadata(uuid,text,text,uuid,timestamptz,text,text)',
          'EXECUTE'
        ) service_rpc,
        has_function_privilege(
          'authenticated',
          'public.enrich_client_google_ads_reporting_metadata(uuid,text,text,uuid,timestamptz,text,text)',
          'EXECUTE'
        ) authenticated_rpc,
        has_function_privilege(
          'service_role',
          'public.record_client_google_ads_reporting_identity(uuid,text,text,uuid,timestamptz)',
          'EXECUTE'
        ) legacy_service_rpc,
        has_function_privilege(
          'authenticated',
          'public.record_client_google_ads_reporting_identity(uuid,text,text,uuid,timestamptz)',
          'EXECUTE'
        ) legacy_authenticated_rpc,
        has_function_privilege(
          'service_role',
          'public.upsert_client_google_ads_connections(uuid,text,jsonb)',
          'EXECUTE'
        ) plural_service_rpc,
        has_function_privilege(
          'authenticated',
          'public.upsert_client_google_ads_connections(uuid,text,jsonb)',
          'EXECUTE'
        ) plural_authenticated_rpc,
        has_function_privilege(
          'service_role',
          'public.upsert_client_google_ads_connections_0049(uuid,text,jsonb)',
          'EXECUTE'
        ) internal_service_rpc,
        has_table_privilege(
          'service_role', 'public.client_google_ads_reporting_metadata_events', 'SELECT'
        ) service_select,
        has_table_privilege(
          'service_role', 'public.client_google_ads_reporting_metadata_events', 'INSERT'
        ) service_insert,
        has_table_privilege(
          'authenticated', 'public.client_google_ads_reporting_metadata_events', 'SELECT'
        ) authenticated_select,
        has_table_privilege(
          'service_role', 'public.client_google_ads_connections', 'UPDATE'
        ) service_connection_update
    `);
    expect(privileges.rows[0]).toEqual({
      service_rpc: true,
      authenticated_rpc: false,
      legacy_service_rpc: true,
      legacy_authenticated_rpc: false,
      plural_service_rpc: true,
      plural_authenticated_rpc: false,
      internal_service_rpc: false,
      service_select: true,
      service_insert: false,
      authenticated_select: false,
      service_connection_update: false,
    });
  });

  it("leaves metrics and every financial fingerprint unchanged", async () => {
    const before = await protectedSnapshot();
    await enrich();
    expect(await protectedSnapshot()).toEqual(before);
  });
});
