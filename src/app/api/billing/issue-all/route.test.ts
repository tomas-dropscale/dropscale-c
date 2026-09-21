import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  billingEvidenceIsReady: vi.fn(),
  billingEvidenceReadyAt: vi.fn(),
  billingIssuanceEnabled: vi.fn(),
  closedWeeks: vi.fn(),
  createServiceClient: vi.fn(),
  getSessionProfile: vi.fn(),
  issueClosedBillingWeekBatch: vi.fn(),
  purgeAdminAccountRevenue: vi.fn(),
  syncCommissionLedger: vi.fn(),
}));

vi.mock("@/lib/admin/commission-sync", () => ({
  purgeAdminAccountRevenue: mocks.purgeAdminAccountRevenue,
  syncCommissionLedger: mocks.syncCommissionLedger,
}));
vi.mock("@/lib/billing/invoices", () => ({
  issueClosedBillingWeekBatch: mocks.issueClosedBillingWeekBatch,
}));
vi.mock("@/lib/billing/issuance-gate", () => ({
  billingIssuanceEnabled: mocks.billingIssuanceEnabled,
}));
vi.mock("@/lib/billing/weekly", async () => ({
  ...(await import("../../../../lib/billing/weekly")),
  billingEvidenceIsReady: mocks.billingEvidenceIsReady,
  billingEvidenceReadyAt: mocks.billingEvidenceReadyAt,
  closedWeeks: mocks.closedWeeks,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));

import { POST } from "./route";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const PERIOD = { start: "2026-08-10", end: "2026-08-16" };
const SERVICE = { service: true };
const RESULT = {
  period: PERIOD,
  issued: [
    {
      clientId: "00000000-0000-4000-8000-000000000002",
      clientName: "Client A",
      invoiceId: "00000000-0000-4000-8000-000000000003",
      amount: 10,
      alreadyIssued: false,
    },
  ],
  noCharge: [],
  blocked: [],
};

function request(options: { origin?: string; body?: string } = {}) {
  return new NextRequest("http://localhost/api/billing/issue-all", {
    method: "POST",
    headers: options.origin ? { Origin: options.origin } : undefined,
    body: options.body,
  });
}

describe("bulk billing issue route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T15:00:00.000Z"));
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: ADMIN_ID },
      profile: { id: ADMIN_ID, role: "admin" },
    });
    mocks.billingIssuanceEnabled.mockReturnValue(true);
    mocks.closedWeeks.mockReturnValue([PERIOD]);
    mocks.billingEvidenceIsReady.mockReturnValue(true);
    mocks.billingEvidenceReadyAt.mockReturnValue(
      new Date("2026-08-17T13:00:00.000Z"),
    );
    mocks.createServiceClient.mockReturnValue(SERVICE);
    mocks.issueClosedBillingWeekBatch.mockResolvedValue(RESULT);
  });

  afterEach(() => vi.useRealTimers());

  it("rejects unauthenticated, non-admin and cross-origin requests before financial work", async () => {
    mocks.getSessionProfile.mockResolvedValueOnce({ user: null, profile: null });
    expect((await POST(request())).status).toBe(401);
    mocks.getSessionProfile.mockResolvedValueOnce({
      user: { id: ADMIN_ID },
      profile: { id: ADMIN_ID, role: "client" },
    });
    expect((await POST(request())).status).toBe(403);
    expect(
      (await POST(request({ origin: "https://attacker.example" }))).status,
    ).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.issueClosedBillingWeekBatch).not.toHaveBeenCalled();
  });

  it.each([
    "{}",
    "null",
    "[]",
    "not json",
    JSON.stringify({ periodStart: 123 }),
    JSON.stringify({ periodStart: PERIOD.start, amount: 1 }),
  ])("rejects malformed selections before financial work: %s", async (body) => {
    expect((await POST(request({ body }))).status).toBe(400);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.purgeAdminAccountRevenue).not.toHaveBeenCalled();
    expect(mocks.issueClosedBillingWeekBatch).not.toHaveBeenCalled();
  });

  it.each(["2026-08-17", "2026-08-24", "2026-08-11", "2026-02-30", ""])(
    "rejects open, future or invalid cycles: %s",
    async (periodStart) => {
      const response = await POST(request({ body: JSON.stringify({ periodStart }) }));
      expect(response.status).toBe(422);
      expect(mocks.createServiceClient).not.toHaveBeenCalled();
      expect(mocks.syncCommissionLedger).not.toHaveBeenCalled();
      expect(mocks.issueClosedBillingWeekBatch).not.toHaveBeenCalled();
    },
  );

  it("refreshes and issues the selected older week instead of the latest cycle", async () => {
    const older = { start: "2026-08-03", end: "2026-08-09" };
    mocks.issueClosedBillingWeekBatch.mockResolvedValue({ ...RESULT, period: older });
    const response = await POST(request({ body: JSON.stringify({ periodStart: older.start }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).period).toEqual(older);
    expect(mocks.closedWeeks).not.toHaveBeenCalled();
    expect(mocks.billingEvidenceIsReady).toHaveBeenCalledWith(older.end, expect.any(Date));
    expect(mocks.purgeAdminAccountRevenue).toHaveBeenCalledWith({ force: true, client: SERVICE, period: older });
    expect(mocks.syncCommissionLedger).toHaveBeenCalledWith({ force: true, client: SERVICE, period: older });
    expect(mocks.issueClosedBillingWeekBatch).toHaveBeenCalledWith({ periodStart: older.start, issuedBy: ADMIN_ID, client: SERVICE });
  });

  it("keeps the confirmed cycle when a new Monday has begun", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00.000Z"));
    mocks.closedWeeks.mockReturnValue([{ start: "2026-08-17", end: "2026-08-23" }]);
    const response = await POST(request({ body: JSON.stringify({ periodStart: PERIOD.start }) }));
    expect(response.status).toBe(200);
    expect(mocks.issueClosedBillingWeekBatch).toHaveBeenCalledWith({ periodStart: PERIOD.start, issuedBy: ADMIN_ID, client: SERVICE });
  });

  it("keeps issuance disabled for an explicitly selected week", async () => {
    mocks.billingIssuanceEnabled.mockReturnValue(false);
    expect((await POST(request({ body: JSON.stringify({ periodStart: PERIOD.start }) }))).status).toBe(503);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.issueClosedBillingWeekBatch).not.toHaveBeenCalled();
  });

  it("blocks a selected cycle until its Google evidence cutoff", async () => {
    mocks.billingEvidenceIsReady.mockReturnValue(false);
    const response = await POST(request({ body: JSON.stringify({ periodStart: PERIOD.start }) }));
    expect(response.status).toBe(409);
    expect((await response.json()).readyAt).toBe("2026-08-17T13:00:00.000Z");
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.issueClosedBillingWeekBatch).not.toHaveBeenCalled();
  });

  it("refreshes the latest closed week and attributes every issue to the admin", async () => {
    const response = await POST(request({ origin: "http://localhost" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "succeeded",
      syncError: null,
      period: PERIOD,
      summary: {
        issued: 1,
        newlyIssued: 1,
        alreadyIssued: 0,
        noCharge: 0,
        blocked: 0,
      },
    });
    expect(mocks.purgeAdminAccountRevenue).toHaveBeenCalledWith({
      force: true,
      client: SERVICE,
      period: PERIOD,
    });
    expect(mocks.syncCommissionLedger).toHaveBeenCalledWith({
      force: true,
      client: SERVICE,
      period: PERIOD,
    });
    expect(mocks.issueClosedBillingWeekBatch).toHaveBeenCalledWith({
      periodStart: PERIOD.start,
      issuedBy: ADMIN_ID,
      client: SERVICE,
    });
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("continues with certified clients when the exact Google refresh is partial", async () => {
    mocks.syncCommissionLedger.mockRejectedValue(new Error("provider failed"));
    mocks.issueClosedBillingWeekBatch.mockResolvedValue({
      ...RESULT,
      blocked: [
        {
          clientId: "00000000-0000-4000-8000-000000000004",
          clientName: "Client B",
          code: "ledger_missing",
          message: "Exact evidence is missing.",
        },
      ],
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "partial",
      summary: {
        issued: 1,
        newlyIssued: 1,
        alreadyIssued: 0,
        noCharge: 0,
        blocked: 1,
      },
    });
    expect(body.syncError).toMatch(/could not be refreshed/i);
    expect(mocks.issueClosedBillingWeekBatch).toHaveBeenCalledOnce();
  });
});
