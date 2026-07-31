import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The affiliate rules, executed against a real Postgres.
 *
 * These migrations price invoices, and until now nothing had ever RUN them —
 * the floor bug (0022 raising a 0% store to 5%) shipped because reading SQL is
 * not the same as running it. PGlite is Postgres compiled to WASM, so the files
 * under test here are the actual migration files, read off disk, not a copy
 * that can drift from them.
 *
 * What this does NOT cover: RLS and the policies. Everything below runs as one
 * superuser, so it verifies the arithmetic, the triggers and the guards —
 * which is where money is decided — and not who is allowed to read what.
 */

const MIGRATIONS = "supabase/migrations";
const sql = (file: string) => readFileSync(`${MIGRATIONS}/${file}`, "utf8");

/**
 * The objects the referral migrations build on, from earlier migrations, cut
 * down to what they actually touch. auth.uid() reads a session variable so a
 * test can act as any client.
 */
const PRELUDE = `
-- Supabase ships these; a bare Postgres does not, and the migrations grant to
-- them. Created rather than stripped from the SQL, so the file under test stays
-- byte-for-byte the one that will run against the real database.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
end $$;

create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.profiles (id uuid primary key, role text not null default 'member');

create or replace function public.is_admin() returns boolean
language sql stable as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
$$;

create table public.portal_clients (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  approval_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients (id) on delete cascade,
  store_name text not null default 'Store',
  commission_rate numeric not null default 10,
  revenue_share_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.client_members (
  client_id uuid not null references public.portal_clients (id) on delete cascade,
  member_id uuid not null references public.portal_clients (id) on delete cascade,
  primary key (client_id, member_id)
);

create or replace function public.is_client_member(p_client_id uuid) returns boolean
language sql security definer stable as $$
  select p_client_id = auth.uid() or exists (
    select 1 from public.client_members m
    where m.client_id = p_client_id and m.member_id = auth.uid()
  )
$$;

create table public.daily_metrics (
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  day date not null,
  ad_spend numeric not null default 0,
  primary key (ad_account_id, day)
);

-- Migration 0006's guard, which 0022 replaces. Present so the replacement is
-- exercised rather than assumed.
create or replace function public.guard_ad_account_commission() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if new.commission_rate is distinct from old.commission_rate and not public.is_admin() then
    raise exception 'Only the team can change an account''s commission rate.';
  end if;
  return new;
end $$;

create trigger ad_accounts_guard_commission before update on public.ad_accounts
  for each row execute function public.guard_ad_account_commission();
`;

let db: PGlite;

/** Runs as nobody (a trusted context), unless a test says otherwise. */
async function actAs(clientId: string | null) {
  await db.query("select set_config('test.uid', $1, false)", [clientId ?? ""]);
}

async function newClient(name: string, approved = true): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.portal_clients (full_name, email, approval_status)
     values ($1, $2, $3) returning id`,
    [name, `${name.toLowerCase()}@example.com`, approved ? "approved" : "pending"],
  );
  return result.rows[0].id;
}

async function newStore(clientId: string, listRate = 10): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.ad_accounts (client_id, list_commission_rate)
     values ($1, $2) returning id`,
    [clientId, listRate],
  );
  return result.rows[0].id;
}

/** Ad spend `daysAgo` days back, which is what keeps a referral counting. */
async function spend(accountId: string, daysAgo: number, amount = 25) {
  await db.query(
    `insert into public.daily_metrics (ad_account_id, day, ad_spend)
     values ($1, current_date - $2::int, $3)
     on conflict (ad_account_id, day) do update set ad_spend = excluded.ad_spend`,
    [accountId, daysAgo, amount],
  );
}

async function billedRate(accountId: string): Promise<number> {
  const result = await db.query<{ commission_rate: string }>(
    "select commission_rate from public.ad_accounts where id = $1",
    [accountId],
  );
  return Number(result.rows[0].commission_rate);
}

/** A referral that counts: approved, arm's length, and advertising. */
async function activeReferral(referrerId: string, name: string): Promise<string> {
  const id = await newClient(name);
  const store = await newStore(id);
  await spend(store, 1);
  await db.query("update public.portal_clients set referred_by = $1 where id = $2", [
    referrerId,
    id,
  ]);
  return id;
}

beforeAll(async () => {
  db = await PGlite.create();
});

beforeEach(async () => {
  // A fresh database per test: triggers and derived columns make state sticky,
  // and a leaked referral from an earlier test would silently change a rate.
  await db.exec("drop schema if exists public cascade; create schema public;");
  await db.exec("drop schema if exists auth cascade;");
  await db.exec(PRELUDE);
  await db.exec(sql("0022_referrals.sql"));
  await db.exec(sql("0023_referral_anti_abuse.sql"));
  await db.exec(sql("0024_referral_floor_zero.sql"));
  await db.exec(sql("0025_referral_claim_guard.sql"));
  await actAs(null);
});

describe("the rate a store is billed at", () => {
  it("is the list price when nobody has been referred", async () => {
    const client = await newClient("Solo");
    const store = await newStore(client, 10);
    expect(await billedRate(store)).toBe(10);
  });

  it("drops 0.5 per active referral, and stacks", async () => {
    const client = await newClient("Referrer");
    const store = await newStore(client, 10);

    await activeReferral(client, "First");
    expect(await billedRate(store)).toBe(9.5);

    await activeReferral(client, "Second");
    await activeReferral(client, "Third");
    expect(await billedRate(store)).toBe(8.5);
  });

  it("applies to every store the referrer owns", async () => {
    const client = await newClient("Multi");
    const a = await newStore(client, 10);
    const b = await newStore(client, 10);

    await activeReferral(client, "Brought");

    expect(await billedRate(a)).toBe(9.5);
    expect(await billedRate(b)).toBe(9.5);
  });

  it("reaches 0% and never goes below it", async () => {
    const client = await newClient("Machine");
    const store = await newStore(client, 10);

    for (let index = 0; index < 21; index++) {
      await activeReferral(client, `Client${index}`);
    }

    expect(await billedRate(store)).toBe(0);
  });

  // The bug that shipped in 0022: greatest(FLOOR, 0) re-priced a free store UP.
  it("never raises a store priced below the floor", async () => {
    const client = await newClient("Freebie");
    const store = await newStore(client, 0);
    expect(await billedRate(store)).toBe(0);

    const cheap = await newStore(client, 3);
    expect(await billedRate(cheap)).toBe(3);
  });
});

describe("what stops a referral counting", () => {
  it("a referral awaiting approval", async () => {
    const client = await newClient("Referrer");
    const store = await newStore(client, 10);

    const pending = await newClient("Pending", false);
    const pendingStore = await newStore(pending);
    await spend(pendingStore, 1);
    await db.query("update public.portal_clients set referred_by = $1 where id = $2", [
      client,
      pending,
    ]);

    expect(await billedRate(store)).toBe(10);

    // …and it starts counting the moment the team approves them.
    await db.query(
      "update public.portal_clients set approval_status = 'approved' where id = $1",
      [pending],
    );
    expect(await billedRate(store)).toBe(9.5);
  });

  it("a referral who is also a sócio — in either direction", async () => {
    const client = await newClient("Referrer");
    const store = await newStore(client, 10);
    const referred = await activeReferral(client, "SecondAccount");
    expect(await billedRate(store)).toBe(9.5);

    // The self-referral trick: add the referred account to your own workspace.
    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [client, referred],
    );
    expect(await billedRate(store)).toBe(10);

    await db.query("delete from public.client_members");
    expect(await billedRate(store)).toBe(9.5);

    // The same thing the other way round: the referrer joins THEIR workspace.
    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [referred, client],
    );
    expect(await billedRate(store)).toBe(10);
  });

  it("a referral with no ad spend in the last 7 days", async () => {
    const client = await newClient("Referrer");
    const store = await newStore(client, 10);

    const dormant = await newClient("Dormant");
    const dormantStore = await newStore(dormant);
    await spend(dormantStore, 30); // spent, but a month ago
    await db.query("update public.portal_clients set referred_by = $1 where id = $2", [
      client,
      dormant,
    ]);

    expect(await billedRate(store)).toBe(10);

    await spend(dormantStore, 2);
    await db.query("select public.refresh_all_referral_rates()");
    expect(await billedRate(store)).toBe(9.5);
  });

  it("a referral who never advertised at all", async () => {
    const client = await newClient("Referrer");
    const store = await newStore(client, 10);

    const idle = await newClient("SignedUpOnly");
    await newStore(idle);
    await db.query("update public.portal_clients set referred_by = $1 where id = $2", [
      client,
      idle,
    ]);

    expect(await billedRate(store)).toBe(10);
  });
});

describe("the hourly sweep", () => {
  // The rule that expires with time is the one nothing writes for. Without the
  // sweep a discount earned once would never come off.
  it("re-prices a referral that went dormant, and reports how many", async () => {
    const client = await newClient("Referrer");
    const store = await newStore(client, 10);
    const referred = await activeReferral(client, "Fades");
    expect(await billedRate(store)).toBe(9.5);

    // Time passes: the only spend on record slides out of the window. Nothing
    // in the database is written, so nothing recomputes on its own.
    await db.query(
      `update public.daily_metrics set day = current_date - 20
       where ad_account_id in (select id from public.ad_accounts where client_id = $1)`,
      [referred],
    );
    expect(await billedRate(store)).toBe(9.5);

    const swept = await db.query<{ refresh_all_referral_rates: number }>(
      "select public.refresh_all_referral_rates()",
    );
    expect(swept.rows[0].refresh_all_referral_rates).toBe(1);
    expect(await billedRate(store)).toBe(10);
  });

  it("writes nothing when every rate is already correct", async () => {
    const client = await newClient("Steady");
    await newStore(client, 10);
    await activeReferral(client, "Stays");

    const swept = await db.query<{ refresh_all_referral_rates: number }>(
      "select public.refresh_all_referral_rates()",
    );
    expect(swept.rows[0].refresh_all_referral_rates).toBe(0);
  });
});

describe("claiming a code", () => {
  async function claim(code: string): Promise<string> {
    const result = await db.query<{ claim_referral_code: string }>(
      "select public.claim_referral_code($1)",
      [code],
    );
    return result.rows[0].claim_referral_code;
  }

  it("links the caller and starts the discount", async () => {
    const referrer = await newClient("Owner");
    const store = await newStore(referrer, 10);
    const joiner = await newClient("Joiner");
    const joinerStore = await newStore(joiner);
    await spend(joinerStore, 1);

    const code = (
      await db.query<{ referral_code: string }>(
        "select referral_code from public.portal_clients where id = $1",
        [referrer],
      )
    ).rows[0].referral_code;

    await actAs(joiner);
    expect(await claim(code.toLowerCase())).toBe("ok"); // case-insensitive
    await actAs(null);

    expect(await billedRate(store)).toBe(9.5);
  });

  // The fix in 0025 lets the claim function past the guard with a
  // transaction-local flag. These pin that it opened a door for that function
  // and for nothing else — a client writing referred_by directly is exactly
  // how somebody would credit themselves to a friend after the fact.
  it("still refuses a client writing referred_by by hand", async () => {
    const referrer = await newClient("Owner");
    const joiner = await newClient("Joiner");

    await actAs(joiner);
    await expect(
      db.query("update public.portal_clients set referred_by = $1 where id = $2", [
        referrer,
        joiner,
      ]),
    ).rejects.toThrow(/only the sign-up flow/i);
  });

  it("does not leave the door open after a successful claim", async () => {
    const referrer = await newClient("Owner");
    const other = await newClient("Other");
    const joiner = await newClient("Joiner");
    const code = (
      await db.query<{ referral_code: string }>(
        "select referral_code from public.portal_clients where id = $1",
        [referrer],
      )
    ).rows[0].referral_code;

    await actAs(joiner);
    expect(await claim(code)).toBe("ok");

    // Same session, straight after: the flag is transaction-scoped and gone.
    await expect(
      db.query("update public.portal_clients set referred_by = $1 where id = $2", [other, joiner]),
    ).rejects.toThrow(/only the sign-up flow/i);
  });

  it("refuses a client rewriting their own code", async () => {
    const client = await newClient("Client");
    await actAs(client);
    await expect(
      db.query("update public.portal_clients set referral_code = 'MINEMINE' where id = $1", [
        client,
      ]),
    ).rejects.toThrow(/cannot be changed/i);
  });

  it("refuses your own code, an unknown one, and a second attempt", async () => {
    const referrer = await newClient("Owner");
    const joiner = await newClient("Joiner");
    const code = (
      await db.query<{ referral_code: string }>(
        "select referral_code from public.portal_clients where id = $1",
        [referrer],
      )
    ).rows[0].referral_code;

    await actAs(referrer);
    expect(await claim(code)).toBe("own_code");

    await actAs(joiner);
    expect(await claim("NOPENOPE")).toBe("unknown_code");
    expect(await claim(code)).toBe("ok");
    expect(await claim(code)).toBe("already_referred");
  });
});

describe("referral_summary", () => {
  it("explains each referral without exposing anything else", async () => {
    const client = await newClient("Referrer");
    await newStore(client, 10);

    await activeReferral(client, "Counting");

    const pending = await newClient("Pending", false);
    await db.query("update public.portal_clients set referred_by = $1 where id = $2", [
      client,
      pending,
    ]);

    const partner = await activeReferral(client, "Partner");
    await db.query(
      "insert into public.client_members (client_id, member_id) values ($1, $2)",
      [client, partner],
    );

    const dormant = await newClient("Dormant");
    await newStore(dormant);
    await db.query("update public.portal_clients set referred_by = $1 where id = $2", [
      client,
      dormant,
    ]);

    await actAs(client);
    const rows = await db.query<{ name: string; status: string }>(
      "select * from public.referral_summary($1)",
      [client],
    );

    expect(Object.fromEntries(rows.rows.map((row) => [row.name, row.status]))).toEqual({
      Counting: "counting",
      Pending: "pending",
      Partner: "partner",
      Dormant: "inactive",
    });
  });

  it("answers with nothing about a workspace you cannot open", async () => {
    const client = await newClient("Referrer");
    await activeReferral(client, "Brought");
    const stranger = await newClient("Stranger");

    await actAs(stranger);
    const rows = await db.query("select * from public.referral_summary($1)", [client]);
    expect(rows.rows).toHaveLength(0);
  });
});

describe("who may change the price", () => {
  it("lets the team change the list rate and refuses everyone else", async () => {
    const client = await newClient("Client");
    const store = await newStore(client, 10);

    const adminId = await newClient("Staff");
    await db.query("insert into public.profiles (id, role) values ($1, 'admin')", [adminId]);

    await actAs(client);
    await expect(
      db.query("update public.ad_accounts set list_commission_rate = 1 where id = $1", [store]),
    ).rejects.toThrow(/only the team/i);

    await actAs(adminId);
    await db.query("update public.ad_accounts set list_commission_rate = 12 where id = $1", [
      store,
    ]);
    expect(await billedRate(store)).toBe(12);
  });

  it("ignores a direct write to the billed rate", async () => {
    const client = await newClient("Client");
    const store = await newStore(client, 10);
    await activeReferral(client, "Brought");

    // Not an error — simply overwritten by the derived value, which is what
    // makes it impossible for any code path to leave the column wrong.
    await db.query("update public.ad_accounts set commission_rate = 1 where id = $1", [store]);
    expect(await billedRate(store)).toBe(9.5);
  });
});
