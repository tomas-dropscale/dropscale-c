import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  // The route decides 502-vs-500 on `instanceof`, so the test has to throw the
  // very class the route imports. The real one cannot be loaded here: it lives
  // in a module whose "@/" imports the test runner does not resolve, which is
  // why that module is mocked whole. commission-sync.test.ts asserts the real
  // class against this shape.
  class PartialLedgerSync extends Error {
    readonly accounts: {
      adAccountId: string;
      storeName: string;
      message: string;
    }[];
    readonly booked: number;

    constructor(
      message: string,
      accounts: { adAccountId: string; storeName: string; message: string }[],
      booked: number,
    ) {
      super(message);
      this.name = "PartialLedgerSync";
      this.accounts = accounts;
      this.booked = booked;
    }
  }

  return {
    PartialLedgerSync,
    createServiceClient: vi.fn(),
    getSessionProfile: vi.fn(),
    purgeAdminAccountRevenue: vi.fn(),
    syncCommissionLedger: vi.fn(),
    syncHstCommission: vi.fn(),
    syncHstCosts: vi.fn().mockResolvedValue({ ok: true, accounts: 0, written: 0, unchanged: 0, unknownProducts: 0, charges: 0, unquotedLines: 0, pages: 0, stores: [] }),
    syncRevenueShareLedger: vi.fn(),
    refreshAccountsNow: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/admin/commission-sync", () => ({
  PartialLedgerSync: mocks.PartialLedgerSync,
  purgeAdminAccountRevenue: mocks.purgeAdminAccountRevenue,
  syncCommissionLedger: mocks.syncCommissionLedger,
  syncRevenueShareLedger: mocks.syncRevenueShareLedger,
}));
vi.mock("@/lib/admin/hst-cost-sync", () => ({
  syncHstCosts: mocks.syncHstCosts,
}));
vi.mock("@/lib/admin/hst", () => ({
  syncHstCommission: mocks.syncHstCommission,
}));
vi.mock("@/lib/metrics/recompute", () => ({
  refreshAccountsNow: mocks.refreshAccountsNow,
}));
vi.mock("@/lib/billing/weekly", async () =>
  vi.importActual("../../../../lib/billing/weekly"),
);

import { POST } from "./route";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const PERIOD = { start: "2026-07-27", end: "2026-08-02" } as const;
const READY_AT = "2026-08-03T14:05:00.000Z";
const BEFORE_CUTOFF = "2026-08-03T14:04:59.999Z";
const AFTER_CUTOFF = "2026-08-03T14:05:00.001Z";
const CRON_SECRET = "test-cron-secret";

function adminRequest() {
  return new NextRequest("http://localhost/api/admin/sync-ledgers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ periodStart: PERIOD.start }),
  });
}

function cronRequest() {
  return new NextRequest(
    "http://localhost/api/admin/sync-ledgers?billingWeek=latest",
    {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    },
  );
}

function expectNoLedgerSync() {
  expect(mocks.purgeAdminAccountRevenue).not.toHaveBeenCalled();
  expect(mocks.syncCommissionLedger).not.toHaveBeenCalled();
  expect(mocks.syncRevenueShareLedger).not.toHaveBeenCalled();
  expect(mocks.syncHstCommission).not.toHaveBeenCalled();
}

function expectBillingWeekSync(serviceClient: object) {
  const options = {
    force: true,
    client: serviceClient,
    period: PERIOD,
  };
  expect(mocks.purgeAdminAccountRevenue).toHaveBeenCalledOnce();
  expect(mocks.purgeAdminAccountRevenue).toHaveBeenCalledWith(options);
  expect(mocks.syncCommissionLedger).toHaveBeenCalledOnce();
  expect(mocks.syncCommissionLedger).toHaveBeenCalledWith(options);
  expect(mocks.syncRevenueShareLedger).not.toHaveBeenCalled();
  expect(mocks.syncHstCommission).not.toHaveBeenCalled();
}

describe("admin ledger billing evidence cutoff", () => {
  const serviceClient = { service: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: ADMIN_ID },
      profile: { id: ADMIN_ID, role: "admin" },
    });
    mocks.createServiceClient.mockReturnValue(serviceClient);
    mocks.purgeAdminAccountRevenue.mockResolvedValue(undefined);
    mocks.syncCommissionLedger.mockResolvedValue(undefined);
    mocks.syncRevenueShareLedger.mockResolvedValue(undefined);
    mocks.syncHstCommission.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("rejects an authenticated admin's explicit week before Monday 14:05 UTC", async () => {
    vi.setSystemTime(new Date(BEFORE_CUTOFF));

    const response = await POST(adminRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Google's Sunday spend is still settling. Refresh this billing week after the evidence cutoff.",
      readyAt: READY_AT,
    });
    expect(mocks.getSessionProfile).toHaveBeenCalledOnce();
    expectNoLedgerSync();
  });

  it("syncs an authenticated admin's explicit week after Monday 14:05 UTC", async () => {
    vi.setSystemTime(new Date(AFTER_CUTOFF));

    const response = await POST(adminRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      period: PERIOD,
      syncedAt: AFTER_CUTOFF,
    });
    expect(mocks.getSessionProfile).toHaveBeenCalledOnce();
    expectBillingWeekSync(serviceClient);
  });

  it("rejects the latest-week cron before Monday 14:05 UTC", async () => {
    vi.setSystemTime(new Date(BEFORE_CUTOFF));

    const response = await POST(cronRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Google's Sunday spend is still inside the settling window.",
      readyAt: READY_AT,
    });
    expect(mocks.getSessionProfile).not.toHaveBeenCalled();
    expectNoLedgerSync();
  });

  it("syncs the latest-week cron after Monday 14:05 UTC", async () => {
    vi.setSystemTime(new Date(AFTER_CUTOFF));

    const response = await POST(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      period: PERIOD,
      syncedAt: AFTER_CUTOFF,
    });
    expect(mocks.getSessionProfile).not.toHaveBeenCalled();
    expectBillingWeekSync(serviceClient);
  });
});

describe("a ledger run some accounts could not finish", () => {
  const serviceClient = {
    service: true,
    rpc: vi.fn().mockResolvedValue({ data: 3, error: null }),
  };
  const TIMEOUT = "Windsor could not be reached before the request timeout.";
  const LARA = {
    adAccountId: "aa000000-0000-4000-8000-000000000011",
    storeName: "Lara Rovinj",
    message: TIMEOUT,
  };
  const ITO = {
    adAccountId: "aa000000-0000-4000-8000-000000000012",
    storeName: "Miguel Casal - Ito -Tsuzuri",
    message: TIMEOUT,
  };
  const NOW = "2026-09-15T09:07:00.000Z";

  /** The message syncCommissionLedger builds, unchanged. */
  function partial(booked: number, ...accounts: typeof LARA[]) {
    return new mocks.PartialLedgerSync(
      `Google Ads sync incomplete — ${accounts
        .map((account) => `${account.storeName}: ${account.message}`)
        .join(" | ")}`,
      accounts,
      booked,
    );
  }

  /** Every step the route runs after the commission ledger, in its order. */
  const SKIPPED = [
    "revenue_share_ledger",
    "hst_commission",
    "hst_costs",
    "daily_metrics_rollup",
    "referral_rate_caches",
  ];

  /** The hourly machine call: no session, no billing week, no period. */
  function hourlyRequest() {
    return new NextRequest("http://localhost/api/admin/sync-ledgers", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
  }

  /** Everything the route runs AFTER the commission ledger. */
  function expectStepsAfterTheLedgerSkipped() {
    expect(mocks.syncRevenueShareLedger).not.toHaveBeenCalled();
    expect(mocks.syncHstCommission).not.toHaveBeenCalled();
    expect(mocks.syncHstCosts).not.toHaveBeenCalled();
    expect(mocks.refreshAccountsNow).not.toHaveBeenCalled();
    expect(serviceClient.rpc).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: ADMIN_ID },
      profile: { id: ADMIN_ID, role: "admin" },
    });
    mocks.createServiceClient.mockReturnValue(serviceClient);
    mocks.purgeAdminAccountRevenue.mockResolvedValue(undefined);
    mocks.syncCommissionLedger.mockResolvedValue(undefined);
    mocks.syncRevenueShareLedger.mockResolvedValue(undefined);
    mocks.syncHstCommission.mockResolvedValue({ ok: true });
    serviceClient.rpc.mockResolvedValue({ data: 3, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers the hourly job 502 and names the one account that stayed stale", async () => {
    // 502 is what the workflow already reads as "did work, but not all of it".
    // One transient Windsor timeout must not email the owner a red X for a run
    // that booked every other account.
    mocks.syncCommissionLedger.mockRejectedValue(partial(6, LARA));

    const response = await POST(hourlyRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: `Google Ads sync incomplete — Lara Rovinj: ${TIMEOUT}`,
      bookedAccounts: 6,
      failedAccounts: [
        {
          adAccountId: LARA.adAccountId,
          storeName: "Lara Rovinj",
          reason: TIMEOUT,
        },
      ],
      // Said out loud, because a 502 alone reads as "nearly everything
      // worked" and everything behind the ledger in fact did not run.
      skipped: SKIPPED,
      syncedAt: NOW,
    });
    expect(mocks.purgeAdminAccountRevenue).toHaveBeenCalledWith({
      force: true,
      client: serviceClient,
    });
    expect(mocks.syncCommissionLedger).toHaveBeenCalledWith({
      force: true,
      client: serviceClient,
    });
    expectStepsAfterTheLedgerSkipped();
  });

  it("keeps the loud 500 when the run booked nothing at all", async () => {
    // The ledger raises this class after running every account, so the failure
    // list alone cannot tell a bad hour for one client from a Windsor outage
    // that reached all of them. Nothing booked is not a partial refresh, and
    // the workflow reads 502 as green: a total outage has to stay loud, or it
    // repeats every hour with nobody told.
    mocks.syncCommissionLedger.mockRejectedValue(partial(0, LARA, ITO));

    const response = await POST(hourlyRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        `Google Ads sync incomplete — Lara Rovinj: ${TIMEOUT} | ` +
        `Miguel Casal - Ito -Tsuzuri: ${TIMEOUT}`,
    });
    expectStepsAfterTheLedgerSkipped();
  });

  it("still answers 502 when several failed but others booked", async () => {
    mocks.syncCommissionLedger.mockRejectedValue(partial(1, LARA, ITO));

    const response = await POST(hourlyRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error:
        `Google Ads sync incomplete — Lara Rovinj: ${TIMEOUT} | ` +
        `Miguel Casal - Ito -Tsuzuri: ${TIMEOUT}`,
      bookedAccounts: 1,
      failedAccounts: [
        {
          adAccountId: LARA.adAccountId,
          storeName: "Lara Rovinj",
          reason: TIMEOUT,
        },
        {
          adAccountId: ITO.adAccountId,
          storeName: "Miguel Casal - Ito -Tsuzuri",
          reason: TIMEOUT,
        },
      ],
      skipped: SKIPPED,
      syncedAt: NOW,
    });
  });

  it("keeps the loud 500 when an operator asked about one exact billing week", async () => {
    // The billing screen must never say "updated" over a week that did not
    // refresh, so a named period has no partial answer.
    vi.setSystemTime(new Date(AFTER_CUTOFF));
    mocks.syncCommissionLedger.mockRejectedValue(partial(6, LARA));

    const response = await POST(adminRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: `Google Ads sync incomplete — Lara Rovinj: ${TIMEOUT}`,
    });
    expect(mocks.syncCommissionLedger).toHaveBeenCalledWith({
      force: true,
      client: serviceClient,
      period: PERIOD,
    });
  });

  it("keeps the loud 500 for the latest-week cron too", async () => {
    vi.setSystemTime(new Date(AFTER_CUTOFF));
    mocks.syncCommissionLedger.mockRejectedValue(partial(6, LARA));

    const response = await POST(cronRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: `Google Ads sync incomplete — Lara Rovinj: ${TIMEOUT}`,
    });
  });

  it("keeps answering 500 for anything that is not a partial sync", async () => {
    mocks.syncCommissionLedger.mockRejectedValue(
      new Error("Commission sync: revenue source missing — run migration 0007."),
    );

    const failed = await POST(hourlyRequest());

    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({
      error: "Commission sync: revenue source missing — run migration 0007.",
    });

    mocks.syncCommissionLedger.mockRejectedValue("not an error at all");

    const thrown = await POST(hourlyRequest());

    expect(thrown.status).toBe(500);
    await expect(thrown.json()).resolves.toEqual({
      error: "Could not sync the ledgers.",
    });
  });

  it("leaves the hourly success answer exactly as it was", async () => {
    const response = await POST(hourlyRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      syncedAt: NOW,
      hst: { ok: true },
      hstCosts: {
        ok: true,
        accounts: 0,
        written: 0,
        unchanged: 0,
        unknownProducts: 0,
        charges: 0,
        unquotedLines: 0,
        pages: 0,
        stores: [],
      },
      referralRateCachesRefreshed: 3,
    });
    expect(serviceClient.rpc).toHaveBeenCalledWith("refresh_all_referral_rates");
  });
});
