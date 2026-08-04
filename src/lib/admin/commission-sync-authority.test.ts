import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  hasGoogleAdsEnv: vi.fn(),
  withClientGoogleAds: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/google-ads/env", () => ({
  hasGoogleAdsEnv: mocks.hasGoogleAdsEnv,
}));

vi.mock("@/lib/google-ads/ledger-authority", () => ({
  withClientGoogleAds: mocks.withClientGoogleAds,
}));

vi.mock("@/lib/google-ads/billing-start", () => ({
  addIsoDays: vi.fn(),
  decimalToMicros: vi.fn(),
  fetchGoogleBillingMetadataAsAgency: vi.fn(),
  fetchGoogleDailyCostMicrosAsAgency: vi.fn(),
  googleLocalDate: vi.fn(() => "2026-08-10"),
  googlePeriodIsClosed: vi.fn(() => true),
  microsToDecimal: vi.fn(),
  parseGoogleMicros: vi.fn((value: string | number) => BigInt(value)),
  percentageOfMicrosToDecimal: vi.fn(),
}));

vi.mock("@/lib/finance/config", () => ({
  GOOGLE_ADS_NOTE_PREFIX: "Google Ads · ",
  NOTE_DETAIL_SEPARATOR: " · ",
  REV_SHARE_NOTE_PREFIX: "Revenue share · ",
}));

vi.mock("@/lib/admin/commission-sync-logic", () => ({
  billableGoogleSpendWindow: vi.fn(),
  manualReferralRateForDate: vi.fn(),
  matchesAuthoritativeGoogleSpend: vi.fn(),
  needsGoogleLedgerRewrite: vi.fn(),
}));

import { syncCommissionLedger } from "./commission-sync";

type QueryResult = {
  data: unknown;
  error: null;
};

function queryResult(table: string, operation: string, columns: string): QueryResult {
  if (table === "commissions") return { data: null, error: null };
  if (table === "revenue_sources") return { data: { id: "source-1" }, error: null };
  if (table === "profiles") return { data: [], error: null };
  if (table === "ad_accounts" && columns.includes("store_name")) {
    return {
      data: [
        {
          id: "account-1",
          client_id: "client-1",
          store_name: "Test Store",
          google_ads_customer_id: "1234567890",
          google_ads_connected: true,
          currency: "EUR",
        },
      ],
      error: null,
    };
  }
  if (table === "ad_account_billing_starts") {
    return {
      data: [
        {
          id: "start-1",
          ad_account_id: "account-1",
          google_ads_customer_id: "1234567890",
          google_local_date: "2026-07-27",
          google_time_zone: "Europe/Lisbon",
          currency: "EUR",
          baseline_cost_micros: "0",
          captured_at: "2026-07-27T09:00:00.000Z",
          start_basis: "observed_google_counter",
          reviewed_full_day_boundary_id: null,
        },
      ],
      error: null,
    };
  }
  if (table === "ad_account_billing_ends") return { data: [], error: null };
  if (table === "portal_clients") {
    return {
      data: [{ id: "client-1", crm_client_id: null, full_name: "Test Client" }],
      error: null,
    };
  }
  if (table === "referral_discount_terms") return { data: [], error: null };
  if (table === "google_ledger_sync_windows" && operation !== "select") {
    return { data: null, error: null };
  }
  throw new Error(`Unexpected fake Supabase query: ${operation} ${table} ${columns}`);
}

function fakeSupabase() {
  const from = vi.fn((table: string) => {
    let operation = "select";
    let columns = "";
    const chain: Record<string, unknown> = {};
    const result = () => queryResult(table, operation, columns);

    chain.select = vi.fn((nextColumns: string) => {
      operation = "select";
      columns = nextColumns;
      return chain;
    });
    chain.upsert = vi.fn(() => {
      operation = "upsert";
      return chain;
    });
    chain.update = vi.fn(() => {
      operation = "update";
      return chain;
    });
    for (const method of ["eq", "gt", "in", "is", "limit", "not", "order"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => result());
    chain.then = (
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result()).then(onFulfilled, onRejected);

    return chain;
  });

  return { from };
}

describe("commission ledger client connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    mocks.hasGoogleAdsEnv.mockReturnValue(true);
    mocks.withClientGoogleAds.mockRejectedValue(new Error("OAuth sentinel"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("passes the connected account to the established client OAuth boundary", async () => {
    const supabase = fakeSupabase();

    await expect(
      syncCommissionLedger({
        force: true,
        client: supabase as never,
        period: { start: "2026-07-27", end: "2026-08-02" },
      }),
    ).rejects.toThrow(/OAuth sentinel/i);

    expect(mocks.withClientGoogleAds).toHaveBeenCalledOnce();
    expect(mocks.withClientGoogleAds).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        id: "account-1",
        google_ads_connected: true,
      }),
      expect.any(Function),
    );
    expect(mocks.hasGoogleAdsEnv).toHaveBeenCalledOnce();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
