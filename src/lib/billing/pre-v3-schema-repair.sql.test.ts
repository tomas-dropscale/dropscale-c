import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "supabase/migrations/0027_pre_v3_schema_repair.sql",
  "utf8",
);

const CLIENT = "40000000-0000-4000-8000-000000000001";
const ACCOUNT = "40000000-0000-4000-8000-000000000002";

const PRELUDE = `
create schema auth;
create or replace function auth.uid() returns uuid
language sql stable as $$ select null::uuid $$;
create or replace function public.is_admin() returns boolean
language sql stable as $$ select false $$;

create table public.portal_clients (id uuid primary key);
create table public.ad_accounts (
  id uuid primary key,
  client_id uuid not null references public.portal_clients(id)
);
create table public.daily_metrics (
  ad_account_id uuid not null references public.ad_accounts(id),
  day date not null,
  primary key (ad_account_id, day)
);
create table public.billing_profiles (
  client_id uuid primary key references public.portal_clients(id),
  profile_type text not null default 'individual',
  currency text not null default 'EUR',
  available_budget numeric,
  updated_at timestamptz not null default now()
);
create table public.creative_submissions (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts(id),
  title text not null,
  url text not null,
  status text not null default 'new',
  review_notes text,
  reviewed_at timestamptz,
  reviewed_by uuid
);

insert into public.portal_clients (id) values ('${CLIENT}');
insert into public.ad_accounts (id, client_id) values ('${ACCOUNT}', '${CLIENT}');
`;

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.exec(MIGRATION);
});

describe("pre-v3 schema repair", () => {
  it("restores every known missing column and remains idempotent", async () => {
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
    const columns = await db.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'daily_metrics'
            and column_name in ('attributed_orders', 'attributed_revenue'))
          or (table_name = 'billing_profiles'
            and column_name in (
              'billing_name', 'tax_id', 'address_line1', 'address_line2',
              'address_city', 'address_postal_code', 'address_state',
              'address_country'
            ))
          or (table_name = 'creative_submissions'
            and column_name = 'collection_url')
        )
      order by table_name, column_name
    `);
    expect(columns.rows).toHaveLength(11);
  });

  it("normalises the invoice recipient fields and rejects a malformed country", async () => {
    await db.query(
      `insert into public.billing_profiles (
         client_id, billing_name, tax_id, address_line1, address_country
       ) values ($1, '  Client Ltd  ', '  PT 123  ', '  Street 1  ', ' pt ')`,
      [CLIENT],
    );
    const profile = await db.query<{
      billing_name: string;
      tax_id: string;
      address_line1: string;
      address_country: string;
    }>(
      `select billing_name, tax_id, address_line1, address_country
       from public.billing_profiles where client_id = $1`,
      [CLIENT],
    );
    expect(profile.rows[0]).toEqual({
      billing_name: "Client Ltd",
      tax_id: "PT 123",
      address_line1: "Street 1",
      address_country: "PT",
    });

    await expect(
      db.query(
        `update public.billing_profiles set address_country = 'Portugal'
         where client_id = $1`,
        [CLIENT],
      ),
    ).rejects.toThrow(/two-letter code/i);
  });

  it("restores collection links under the same URL guard", async () => {
    await db.query(
      `insert into public.creative_submissions (
         ad_account_id, title, url, collection_url
       ) values ($1, '  Summer  ', ' https://example.com/asset ',
         ' https://example.com/collections/summer ')`,
      [ACCOUNT],
    );
    const submission = await db.query<{
      title: string;
      url: string;
      collection_url: string;
    }>(
      `select title, url, collection_url
       from public.creative_submissions`,
    );
    expect(submission.rows[0]).toEqual({
      title: "Summer",
      url: "https://example.com/asset",
      collection_url: "https://example.com/collections/summer",
    });
  });
});
