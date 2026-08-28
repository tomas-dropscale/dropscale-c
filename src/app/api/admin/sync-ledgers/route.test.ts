import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  getSessionProfile: vi.fn(),
  purgeAdminAccountRevenue: vi.fn(),
  syncCommissionLedger: vi.fn(),
  syncHstCommission: vi.fn(),
  syncHstCosts: vi.fn().mockResolvedValue({ ok: true, accounts: 0, written: 0, unchanged: 0, unknownProducts: 0, charges: 0, unquotedLines: 0, pages: 0, stores: [] }),
  syncRevenueShareLedger: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/admin/commission-sync", () => ({
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
