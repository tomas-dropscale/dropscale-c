import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The @/ alias does not resolve under vitest; billing-start also pulls the
// Google client env chain. These two helpers are re-implemented identically.
vi.mock("@/lib/google-ads/billing-start", () => ({
  googleLocalDate: (instant: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant),
  addIsoDays: (day: string, days: number) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  },
}));

import { ensureAutomaticBillingStarts } from "./auto-start";

const ADMIN = "65000000-0000-4000-8000-000000000001";
const CLIENT = "65000000-0000-4000-8000-000000000002";
const ACCOUNT = "65000000-0000-4000-8000-000000000010";
const CONNECTION = "65000000-0000-4000-8000-000000000030";

type Tables = Record<string, { data: unknown[]; error: null }>;

function fakeService(tables: Tables) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; row: Record<string, unknown>; filters: unknown[] }> = [];
  let insertError: { code: string } | null = null;
  const service = {
    from(table: string) {
      const result = tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const method of ["select", "in", "not", "eq"]) chain[method] = self;
      chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
      chain.insert = (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return Promise.resolve({ error: insertError });
      };
      chain.update = (row: Record<string, unknown>) => {
        const filters: unknown[] = [];
        const updateChain: Record<string, unknown> = {
          eq: (...args: unknown[]) => {
            filters.push(args);
            return updateChain;
          },
          then: (resolve: (value: unknown) => unknown) => resolve({ error: null }),
        };
        updates.push({ table, row, filters });
        return updateChain;
      };
      return chain;
    },
  };
  return {
    service,
    inserts,
    updates,
    failNextInsert(code: string) {
      insertError = { code };
    },
  };
}

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    ad_accounts: {
      data: [{
        id: ACCOUNT,
        client_id: CLIENT,
        store_name: "Northwind",
        status: "pending",
        currency: "EUR",
        google_ads_customer_id: "1234567890",
      }],
      error: null,
    },
    ad_account_billing_starts: { data: [], error: null },
    profiles: { data: [{ id: ADMIN }], error: null },
    client_reporting_bindings: {
      data: [{
        ad_account_id: ACCOUNT,
        bound_by: ADMIN,
        bound_at: "2026-08-16T15:00:00.000Z",
        google_ads_connection_id: CONNECTION,
      }],
      error: null,
    },
    client_google_ads_connections: {
      data: [{
        id: CONNECTION,
        status: "connected",
        currency: "EUR",
        time_zone: "Europe/Lisbon",
        windsor_account_id: "123-456-7890",
        connected_at: "2026-08-16T14:30:00.000Z",
        created_at: "2026-08-16T14:00:00.000Z",
      }],
      error: null,
    },
    ...overrides,
  };
}

describe("automatic billing starts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts billing on the first full Google-local day after connection and activates the account", async () => {
    const harness = fakeService(baseTables());

    const outcome = await ensureAutomaticBillingStarts(harness.service);

    expect(outcome).toEqual({ attempted: 1, started: 1, activated: 1, failed: 0 });
    expect(harness.inserts).toHaveLength(1);
    expect(harness.inserts[0].row).toMatchObject({
      ad_account_id: ACCOUNT,
      google_ads_customer_id: "1234567890",
      // Connected 2026-08-16 14:30Z (Lisbon 15:30) → first full day is the 17th.
      google_local_date: "2026-08-17",
      google_time_zone: "Europe/Lisbon",
      currency: "EUR",
      baseline_cost_micros: "0",
      start_basis: "observed_google_counter",
      source: "agency",
      reviewed_by: ADMIN,
    });
    expect(harness.updates).toEqual([
      expect.objectContaining({
        table: "ad_accounts",
        row: { status: "active" },
      }),
    ]);
  });

  it("counts a connection instant that is already the next Google-local day", async () => {
    const tables = baseTables();
    // 23:30Z on the 16th is already 00:30 on the 17th in WEST — the first
    // full billable day must then be the 18th, never a partially owned day.
    tables.client_google_ads_connections.data = [{
      ...(tables.client_google_ads_connections.data[0] as Record<string, unknown>),
      connected_at: "2026-08-16T23:30:00.000Z",
    }];
    const harness = fakeService(tables);

    await ensureAutomaticBillingStarts(harness.service);

    expect(harness.inserts[0].row).toMatchObject({ google_local_date: "2026-08-18" });
  });

  it("leaves alone accounts that are already started, internal, mismatched or non-EUR", async () => {
    const started = fakeService(baseTables({
      ad_account_billing_starts: { data: [{ ad_account_id: ACCOUNT }], error: null },
    }));
    expect(await ensureAutomaticBillingStarts(started.service)).toMatchObject({ attempted: 0 });
    expect(started.inserts).toHaveLength(0);

    const internal = fakeService(baseTables({
      profiles: { data: [{ id: ADMIN }, { id: CLIENT }], error: null },
    }));
    expect(await ensureAutomaticBillingStarts(internal.service)).toMatchObject({ attempted: 0 });

    const mismatched = baseTables();
    (mismatched.client_google_ads_connections.data[0] as Record<string, unknown>).windsor_account_id = "999-999-9999";
    const wrongIdentity = fakeService(mismatched);
    expect(await ensureAutomaticBillingStarts(wrongIdentity.service)).toMatchObject({ attempted: 0 });

    const foreign = baseTables();
    (foreign.client_google_ads_connections.data[0] as Record<string, unknown>).currency = "JPY";
    const nonEur = fakeService(foreign);
    expect(await ensureAutomaticBillingStarts(nonEur.service)).toMatchObject({ attempted: 0 });
  });

  it("treats a concurrent duplicate insert as already handled, not a failure", async () => {
    const harness = fakeService(baseTables());
    harness.failNextInsert("23505");

    const outcome = await ensureAutomaticBillingStarts(harness.service);

    expect(outcome).toEqual({ attempted: 1, started: 0, activated: 1, failed: 0 });
  });
});
