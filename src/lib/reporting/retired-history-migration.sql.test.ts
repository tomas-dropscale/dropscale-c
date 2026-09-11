import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 0102 lets a client read the frozen history of an account a handover retired.
 *
 * The portal folds a retired child's ids into its store's totals, but the
 * member's session read daily_metrics under owns_ad_account(), which admits a
 * normalized account only while an active binding exists - so the rows came
 * back empty and the store's spend quietly shrank the day the account moved.
 *
 * These tests pin the new read against the same evidence the projection
 * trusts, and pin what did NOT change: writes, strangers, abandoned sources.
 */

const MIGRATION = readFileSync(
  "supabase/migrations/0102_retired_history_readable_by_client.sql",
  "utf8",
);

const OWNER = "bb000000-0000-4000-8000-000000000001";
const PARTNER = "bb000000-0000-4000-8000-000000000002";
const STRANGER = "bb000000-0000-4000-8000-000000000003";
const ADMIN = "bb000000-0000-4000-8000-000000000004";
const OTHER_OWNER = "bb000000-0000-4000-8000-000000000005";

const ANCHOR = "bb000000-0000-4000-8000-000000000011";
const LEGACY = "bb000000-0000-4000-8000-000000000012";
const LIVE_CHILD = "bb000000-0000-4000-8000-000000000013";
const HANDED_OVER = "bb000000-0000-4000-8000-000000000014";
const RETIRED = "bb000000-0000-4000-8000-000000000015";
const ABANDONED = "bb000000-0000-4000-8000-000000000016";
const OTHER_ANCHOR = "bb000000-0000-4000-8000-000000000021";
const OTHER_HANDED_OVER = "bb000000-0000-4000-8000-000000000022";

const B_ANCHOR = "bb000000-0000-4000-8000-000000000031";
const B_LIVE = "bb000000-0000-4000-8000-000000000033";
const B_HANDED = "bb000000-0000-4000-8000-000000000034";
const B_RETIRED = "bb000000-0000-4000-8000-000000000035";
const B_ABANDONED = "bb000000-0000-4000-8000-000000000036";
const B_NEW_HOME = "bb000000-0000-4000-8000-000000000037";
const B_OTHER_ANCHOR = "bb000000-0000-4000-8000-000000000041";
const B_OTHER_HANDED = "bb000000-0000-4000-8000-000000000042";
const B_OTHER_NEW_HOME = "bb000000-0000-4000-8000-000000000043";

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
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null,
  reporting_role text not null default 'legacy_hybrid'
);
create table public.client_members (
  client_id uuid not null,
  member_id uuid not null
);
create table public.client_reporting_bindings (
  id uuid primary key,
  client_id uuid not null,
  ad_account_id uuid not null references public.ad_accounts(id),
  shopify_connection_id uuid,
  shopify_anchor_binding_id uuid references public.client_reporting_bindings(id),
  status text not null default 'active' check (status in ('active', 'revoked'))
);
create table public.client_reporting_anchor_events (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.client_reporting_bindings(id),
  prior_binding_id uuid references public.client_reporting_bindings(id),
  ad_account_id uuid not null references public.ad_accounts(id),
  event_type text not null
);
create table public.daily_metrics (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts(id),
  day date not null,
  ad_spend numeric not null default 0
);
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;

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

-- owns_ad_account exactly as 0055 left it: legacy, or an ACTIVE binding.
create or replace function public.owns_ad_account(p_ad_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.ad_accounts account
    where account.id = p_ad_account_id
      and public.is_client_member(account.client_id)
      and (
        account.reporting_role = 'legacy_hybrid'
        or exists (
          select 1 from public.client_reporting_bindings binding
          where binding.ad_account_id = account.id
            and binding.status = 'active'
        )
      )
  )
$$;

alter table public.daily_metrics enable row level security;
create policy daily_metrics_select_own on public.daily_metrics
  for select using (public.owns_ad_account(ad_account_id) or public.is_admin());
create policy daily_metrics_insert_own on public.daily_metrics
  for insert with check (public.owns_ad_account(ad_account_id) or public.is_admin());
create policy daily_metrics_update_own on public.daily_metrics
  for update using (public.owns_ad_account(ad_account_id) or public.is_admin())
  with check (public.owns_ad_account(ad_account_id) or public.is_admin());
`;

let db: PGlite;

/** The database owner: seeds without RLS. */
async function actAsPostgres() {
  await db.exec("reset role");
  await db.query("select set_config('test.uid', '', false)");
}

/** A signed-in viewer, under RLS. */
async function actAs(uid: string) {
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await db.query("select set_config('test.uid', $1, false)", [uid]);
}

async function visibleAccounts(): Promise<string[]> {
  const result = await db.query<{ ad_account_id: string }>(
    "select distinct ad_account_id from public.daily_metrics order by ad_account_id",
  );
  return result.rows.map((row) => row.ad_account_id);
}

async function spendOf(accountId: string): Promise<string> {
  const result = await db.query<{ ad_spend: string }>(
    "select ad_spend from public.daily_metrics where ad_account_id = $1",
    [accountId],
  );
  return result.rows[0]!.ad_spend;
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
  await actAsPostgres();
  await db.exec(`
    delete from public.daily_metrics;
    delete from public.client_reporting_anchor_events;
    delete from public.client_reporting_bindings;
    delete from public.client_members;
    delete from public.ad_accounts;
  `);
  await db.query("insert into public.client_members(client_id, member_id) values ($1, $2)", [
    OWNER,
    PARTNER,
  ]);
  // One store of OWNER's: a Shopify anchor, a legacy account, a live Google
  // child, a child a handover moved away, a child a retirement closed, and a
  // staged source that was abandoned (revoked, no event). Then another
  // client's store with its own handed-over child.
  await db.query(
    `insert into public.ad_accounts(id, client_id, reporting_role) values
       ($1, $9, 'shopify_anchor'), ($2, $9, 'legacy_hybrid'), ($3, $9, 'google_spend'),
       ($4, $9, 'google_spend'), ($5, $9, 'google_spend'), ($6, $9, 'google_spend'),
       ($7, $10, 'shopify_anchor'), ($8, $10, 'google_spend')`,
    [ANCHOR, LEGACY, LIVE_CHILD, HANDED_OVER, RETIRED, ABANDONED, OTHER_ANCHOR, OTHER_HANDED_OVER, OWNER, OTHER_OWNER],
  );
  await db.query(
    `insert into public.client_reporting_bindings
       (id, client_id, ad_account_id, shopify_connection_id, shopify_anchor_binding_id, status) values
       ($1, $10, $11, gen_random_uuid(), null, 'active'),
       ($2, $10, $12, null, $1, 'active'),
       ($3, $10, $13, null, $1, 'revoked'),
       ($4, $10, $14, null, $1, 'revoked'),
       ($5, $10, $15, null, $1, 'revoked'),
       ($6, $10, $12, null, $1, 'active'),
       ($7, $16, $17, gen_random_uuid(), null, 'active'),
       ($8, $16, $18, null, $7, 'revoked'),
       ($9, $16, $17, null, $7, 'active')`,
    [
      B_ANCHOR, B_LIVE, B_HANDED, B_RETIRED, B_ABANDONED, B_NEW_HOME, B_OTHER_ANCHOR, B_OTHER_HANDED, B_OTHER_NEW_HOME,
      OWNER, ANCHOR, LIVE_CHILD, HANDED_OVER, RETIRED, ABANDONED,
      OTHER_OWNER, OTHER_ANCHOR, OTHER_HANDED_OVER,
    ],
  );
  // The evidence, shaped as 0096 and 0100 write it: a handover names the
  // binding it moved as prior_binding_id; a retirement names the binding.
  await db.query(
    `insert into public.client_reporting_anchor_events
       (binding_id, prior_binding_id, ad_account_id, event_type) values
       ($1, $2, $3, 'handed_over'),
       ($4, null, $5, 'source_retired'),
       ($6, $7, $8, 'handed_over')`,
    [B_NEW_HOME, B_HANDED, LIVE_CHILD, B_RETIRED, RETIRED, B_OTHER_NEW_HOME, B_OTHER_HANDED, OTHER_HANDED_OVER],
  );
  await db.query(
    `insert into public.daily_metrics(ad_account_id, day, ad_spend) values
       ($1, '2026-09-01', 1), ($2, '2026-09-01', 2), ($3, '2026-09-01', 3),
       ($4, '2026-09-01', 4), ($5, '2026-09-01', 5), ($6, '2026-09-01', 6),
       ($7, '2026-09-01', 7), ($8, '2026-09-01', 8)`,
    [ANCHOR, LEGACY, LIVE_CHILD, HANDED_OVER, RETIRED, ABANDONED, OTHER_ANCHOR, OTHER_HANDED_OVER],
  );
});

describe("a client's read of retired history (0102)", () => {
  it("reads the rows of a child a handover moved away, and of one a retirement closed", async () => {
    await actAs(OWNER);
    expect(await visibleAccounts()).toEqual(
      [ANCHOR, LEGACY, LIVE_CHILD, HANDED_OVER, RETIRED].sort(),
    );
    expect(await spendOf(HANDED_OVER)).toBe("4");
    expect(await spendOf(RETIRED)).toBe("5");
  });

  it("reads them for a partner of the workspace too", async () => {
    await actAs(PARTNER);
    expect(await visibleAccounts()).toContain(HANDED_OVER);
    expect(await visibleAccounts()).toContain(RETIRED);
  });

  it("still hides an abandoned staged source: revoked, but never retired", async () => {
    // Row shape alone would admit it; the event is what makes history history.
    await actAs(OWNER);
    expect(await visibleAccounts()).not.toContain(ABANDONED);
  });

  it("shows nothing of another client's retired account, to a member or a stranger", async () => {
    await actAs(OWNER);
    expect(await visibleAccounts()).not.toContain(OTHER_HANDED_OVER);
    await actAs(OTHER_OWNER);
    expect(await visibleAccounts()).toEqual([OTHER_ANCHOR, OTHER_HANDED_OVER].sort());
    await actAs(STRANGER);
    expect(await visibleAccounts()).toEqual([]);
  });

  it("grants the read only: a member still cannot write a retired account's rows", async () => {
    await actAs(OWNER);
    await expectSqlState(
      db.query(
        "insert into public.daily_metrics(ad_account_id, day, ad_spend) values ($1, '2026-09-02', 99)",
        [HANDED_OVER],
      ),
      "42501",
    );
    // An UPDATE a policy filters out matches no rows and reports success.
    const updated = await db.query(
      "update public.daily_metrics set ad_spend = 99 where ad_account_id = $1",
      [HANDED_OVER],
    );
    expect(updated.affectedRows ?? 0).toBe(0);
    await actAsPostgres();
    expect(await spendOf(HANDED_OVER)).toBe("4");
  });

  it("changes nothing for the agency, which read every row already", async () => {
    await actAs(ADMIN);
    expect(await visibleAccounts()).toHaveLength(8);
  });

  it("answers the question directly, for the projection to ask", async () => {
    await actAs(OWNER);
    const asked = await db.query<{ history: boolean }>(
      `select public.reads_retired_ad_account_history($1) as history
       union all select public.reads_retired_ad_account_history($2)
       union all select public.reads_retired_ad_account_history($3)`,
      [HANDED_OVER, ABANDONED, LIVE_CHILD],
    );
    expect(asked.rows.map((row) => row.history)).toEqual([true, false, false]);
    await actAs(STRANGER);
    const stranger = await db.query<{ history: boolean }>(
      "select public.reads_retired_ad_account_history($1) as history",
      [HANDED_OVER],
    );
    expect(stranger.rows[0]!.history).toBe(false);
  });
});
