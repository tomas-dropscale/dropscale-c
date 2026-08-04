import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  automationTargets: vi.fn((items) =>
    items.map((item: Record<string, unknown>) => ({
      itemId: item.id,
      claimVersion: item.claim_version,
      clientId: item.client_id,
      periodStart: item.period_start,
      periodEnd: item.period_end,
    })),
  ),
  beginBillingAutomationRun: vi.fn(),
  automaticBillingIssuanceEnabled: vi.fn(),
  claimBillingAutomationItems: vi.fn(),
  createServiceClient: vi.fn(),
  finishBillingAutomationRun: vi.fn(),
  issueAutomaticClosedWeeks: vi.fn(),
  reconcileInvoices: vi.fn(),
  recordBillingAutomationOutcomes: vi.fn(),
  seedBillingAutomationItems: vi.fn(),
  syncCommissionLedger: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/billing/invoices", () => ({
  issueAutomaticClosedWeeks: mocks.issueAutomaticClosedWeeks,
  reconcileInvoices: mocks.reconcileInvoices,
}));
vi.mock("@/lib/billing/automation-receipts", () => ({
  automationTargets: mocks.automationTargets,
  beginBillingAutomationRun: mocks.beginBillingAutomationRun,
  claimBillingAutomationItems: mocks.claimBillingAutomationItems,
  finishBillingAutomationRun: mocks.finishBillingAutomationRun,
  recordBillingAutomationOutcomes: mocks.recordBillingAutomationOutcomes,
  seedBillingAutomationItems: mocks.seedBillingAutomationItems,
}));
vi.mock("@/lib/billing/issuance-gate", () => ({
  automaticBillingIssuanceEnabled: mocks.automaticBillingIssuanceEnabled,
}));
vi.mock("@/lib/billing/weekly", () => ({
  mondayOf: () => "2026-08-03",
  addDays: () => "2026-08-02",
}));
vi.mock("@/lib/admin/commission-sync", () => ({
  syncCommissionLedger: mocks.syncCommissionLedger,
}));

import * as cronRoute from "./route";

const { POST } = cronRoute;

const SECRET = "cron-test-secret";
const ITEM = {
  id: "item-1",
  client_id: "client-1",
  period_start: "2026-07-20",
  period_end: "2026-07-26",
  claim_version: 1,
};
const TARGET = {
  itemId: ITEM.id,
  clientId: ITEM.client_id,
  periodStart: ITEM.period_start,
  periodEnd: ITEM.period_end,
  claimVersion: ITEM.claim_version,
};
const ISSUED_OUTCOME = {
  ...TARGET,
  state: "issued",
  stage: "complete",
  code: null,
  invoiceId: "invoice-1",
  amount: 10,
  billableSpend: 100,
  evidenceAccountCount: 1,
};

function issuance(over: Record<string, unknown> = {}) {
  return {
    periodsChecked: 1,
    clientsChecked: 1,
    issued: 1,
    noCharge: 0,
    alreadySettled: 0,
    blocked: 0,
    historicalRolloversChecked: 0,
    exactRefreshPeriods: [],
    errors: [],
    outcomes: [ISSUED_OUTCOME],
    ...over,
  };
}

function request(secret = SECRET) {
  return new NextRequest("http://localhost/api/billing/cron", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe("automatic billing cron", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.automationTargets.mockImplementation((items) =>
      items.map((item: Record<string, unknown>) => ({
        itemId: item.id,
        claimVersion: item.claim_version,
        clientId: item.client_id,
        periodStart: item.period_start,
        periodEnd: item.period_end,
      })),
    );
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.automaticBillingIssuanceEnabled.mockReturnValue(true);
    mocks.createServiceClient.mockReturnValue({ service: true });
    mocks.beginBillingAutomationRun.mockResolvedValue({ id: "run-1" });
    mocks.seedBillingAutomationItems.mockResolvedValue(1);
    mocks.claimBillingAutomationItems
      .mockResolvedValueOnce([ITEM])
      .mockResolvedValue([]);
    mocks.issueAutomaticClosedWeeks.mockResolvedValue(issuance());
    mocks.recordBillingAutomationOutcomes.mockResolvedValue(undefined);
    mocks.finishBillingAutomationRun.mockResolvedValue({
      id: "run-1",
      status: "succeeded",
    });
    mocks.reconcileInvoices.mockResolvedValue({
      checked: 2,
      updated: 2,
      errors: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not expose a mutating GET handler", () => {
    expect((cronRoute as Record<string, unknown>).GET).toBeUndefined();
  });

  it("authenticates the scheduler before opening service access", async () => {
    const response = await POST(request("wrong"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.issueAutomaticClosedWeeks).not.toHaveBeenCalled();
    expect(mocks.beginBillingAutomationRun).not.toHaveBeenCalled();
  });

  it("fails closed when the server role is unavailable", async () => {
    mocks.createServiceClient.mockReturnValue(null);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.issueAutomaticClosedWeeks).not.toHaveBeenCalled();
    expect(mocks.reconcileInvoices).not.toHaveBeenCalled();
  });

  it("issues eligible weeks before reconciling Stripe", async () => {
    const service = { service: true };
    mocks.createServiceClient.mockReturnValue(service);

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      runId: "run-1",
      issuance: { issued: 1, errors: [] },
      healing: { requested: 0, completed: 0, errors: [] },
      reconciliation: { updated: 2, errors: [] },
    });
    expect(mocks.issueAutomaticClosedWeeks).toHaveBeenCalledWith(service, {
      targets: [TARGET],
      includeHistoricalRollovers: true,
    });
    expect(mocks.recordBillingAutomationOutcomes).toHaveBeenCalledWith(
      service,
      "run-1",
      [ISSUED_OUTCOME],
    );
    expect(mocks.reconcileInvoices).toHaveBeenCalledWith(service);
    expect(
      mocks.issueAutomaticClosedWeeks.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.reconcileInvoices.mock.invocationCallOrder[0]);
  });

  it("heals an exact closed week and retries issuance before reconciliation", async () => {
    const service = { service: true };
    const period = { start: "2026-07-20", end: "2026-07-26" };
    mocks.createServiceClient.mockReturnValue(service);
    mocks.issueAutomaticClosedWeeks
      .mockResolvedValueOnce(
        issuance({
          issued: 1,
          blocked: 1,
          exactRefreshPeriods: [period],
          outcomes: [
            {
              ...ISSUED_OUTCOME,
              state: "blocked",
              stage: "google_evidence",
              code: "ledger_missing",
              invoiceId: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        issuance({ issued: 2, alreadySettled: 3, blocked: 0 }),
      );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.syncCommissionLedger).toHaveBeenCalledWith({
      force: true,
      client: service,
      period,
    });
    expect(mocks.issueAutomaticClosedWeeks).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({
      ok: true,
      issuance: { issued: 3, blocked: 0, exactRefreshPeriods: [] },
      healing: { requested: 1, completed: 1, errors: [] },
    });
    expect(
      mocks.issueAutomaticClosedWeeks.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.syncCommissionLedger.mock.invocationCallOrder[0]);
    expect(
      mocks.syncCommissionLedger.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.issueAutomaticClosedWeeks.mock.invocationCallOrder[1]);
    expect(
      mocks.issueAutomaticClosedWeeks.mock.invocationCallOrder[1],
    ).toBeLessThan(mocks.reconcileInvoices.mock.invocationCallOrder[0]);
  });

  it("reports an exact-week healing failure while still retrying partial work", async () => {
    const period = { start: "2026-07-20", end: "2026-07-26" };
    mocks.issueAutomaticClosedWeeks
      .mockResolvedValueOnce(
        issuance({
          issued: 0,
          alreadySettled: 2,
          blocked: 1,
          exactRefreshPeriods: [period],
          outcomes: [
            {
              ...ISSUED_OUTCOME,
              state: "blocked",
              stage: "google_evidence",
              code: "ledger_missing",
              invoiceId: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        issuance({
          issued: 0,
          alreadySettled: 2,
          blocked: 1,
          exactRefreshPeriods: [period],
          outcomes: [
            {
              ...ISSUED_OUTCOME,
              state: "blocked",
              stage: "google_evidence",
              code: "ledger_missing",
              invoiceId: null,
            },
          ],
        }),
      );
    mocks.syncCommissionLedger.mockRejectedValue(
      new Error("Google account temporarily unavailable."),
    );

    const response = await POST(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      healing: {
        requested: 1,
        completed: 0,
        errors: [
          {
            periodStart: period.start,
            message: "Google account temporarily unavailable.",
          },
        ],
      },
    });
    expect(mocks.issueAutomaticClosedWeeks).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileInvoices).toHaveBeenCalledTimes(1);
  });

  it("reports a failed run when issuance or reconciliation has errors", async () => {
    mocks.issueAutomaticClosedWeeks.mockResolvedValue(
      issuance({
        issued: 0,
        blocked: 1,
        outcomes: [
          {
            ...ISSUED_OUTCOME,
            state: "blocked",
            stage: "stripe_issue",
            code: "issuance_disabled",
            invoiceId: null,
          },
        ],
        errors: [
        {
          clientId: null,
          periodStart: null,
          code: "issuance_disabled",
          message: "Billing issuance is disabled.",
        },
        ],
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mocks.finishBillingAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "failed", errorCount: 1 }),
    );
  });

  it("attempts a blocked claim once in the run and records a partial receipt", async () => {
    const blockedOutcome = {
      ...ISSUED_OUTCOME,
      state: "blocked",
      stage: "preview",
      code: "recipient_invalid",
      invoiceId: null,
    };
    mocks.issueAutomaticClosedWeeks.mockResolvedValue(
      issuance({
        issued: 0,
        blocked: 1,
        outcomes: [blockedOutcome],
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.claimBillingAutomationItems).toHaveBeenCalledTimes(2);
    expect(mocks.recordBillingAutomationOutcomes).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      [blockedOutcome],
    );
    expect(mocks.finishBillingAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "partial", errorCount: 0 }),
    );
  });

  it("fails the run unless every claim produces exactly one durable outcome", async () => {
    mocks.issueAutomaticClosedWeeks.mockResolvedValue(
      issuance({ issued: 0, outcomes: [] }),
    );

    const response = await POST(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      runId: "run-1",
      error: "Automatic billing run failed.",
    });
    expect(mocks.recordBillingAutomationOutcomes).not.toHaveBeenCalled();
    expect(mocks.finishBillingAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "failed", errorCount: 1 }),
    );
  });
});
