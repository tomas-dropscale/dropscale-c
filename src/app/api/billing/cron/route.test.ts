import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  billingAutomationEnabled: vi.fn(),
  billingRecoveryEnabled: vi.fn(),
  beginBillingAutomationRun: vi.fn(),
  claimExpiredSkippedBillingItems: vi.fn(),
  createServiceClient: vi.fn(),
  finishBillingAutomationRun: vi.fn(),
  reconcileInvoices: vi.fn(),
  recordBillingAutomationOutcomes: vi.fn(),
  runAutomaticBilling: vi.fn(),
  skippedBillingRecoveryOutcome: vi.fn(),
}));

vi.mock("@/lib/billing/issuance-gate", () => ({
  billingAutomationEnabled: mocks.billingAutomationEnabled,
  billingRecoveryEnabled: mocks.billingRecoveryEnabled,
}));
vi.mock("@/lib/billing/automation", () => ({
  runAutomaticBilling: mocks.runAutomaticBilling,
}));
vi.mock("@/lib/billing/automation-receipts", () => ({
  beginBillingAutomationRun: mocks.beginBillingAutomationRun,
  claimExpiredSkippedBillingItems: mocks.claimExpiredSkippedBillingItems,
  finishBillingAutomationRun: mocks.finishBillingAutomationRun,
  recordBillingAutomationOutcomes: mocks.recordBillingAutomationOutcomes,
  skippedBillingRecoveryOutcome: mocks.skippedBillingRecoveryOutcome,
}));
vi.mock("@/lib/billing/invoices", () => ({
  reconcileInvoices: mocks.reconcileInvoices,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { GET, POST } from "./route";

const SECRET = "cron-test-secret";
const SERVICE = { service: true };
const ITEM = { id: "item-1" };
const OUTCOME = { itemId: "item-1", state: "no_charge" };

function request(path = "/api/billing/cron", secret = SECRET) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe("billing cron", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.createServiceClient.mockReturnValue(SERVICE);
    mocks.reconcileInvoices.mockResolvedValue({
      checked: 2,
      updated: 1,
      errors: [],
    });
    mocks.billingAutomationEnabled.mockReturnValue(true);
    mocks.billingRecoveryEnabled.mockReturnValue(true);
    mocks.beginBillingAutomationRun.mockResolvedValue({ id: "run-1" });
    mocks.claimExpiredSkippedBillingItems.mockResolvedValue([ITEM]);
    mocks.skippedBillingRecoveryOutcome.mockResolvedValue(OUTCOME);
    mocks.recordBillingAutomationOutcomes.mockResolvedValue(undefined);
    mocks.finishBillingAutomationRun.mockResolvedValue({ id: "run-1" });
    mocks.runAutomaticBilling.mockResolvedValue({
      alreadyRunning: false,
      runId: "run-auto",
      status: "succeeded",
      claimed: 1,
      issued: 1,
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("authenticates before opening service access", async () => {
    const response = await POST(request("/api/billing/cron?mode=recovery", "wrong"));

    expect(response.status).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.beginBillingAutomationRun).not.toHaveBeenCalled();
  });

  it("keeps GET and ordinary POST reconcile-only", async () => {
    const get = await GET(request());
    const post = await POST(request());

    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    expect(mocks.reconcileInvoices).toHaveBeenCalledTimes(2);
    expect(mocks.beginBillingAutomationRun).not.toHaveBeenCalled();
    expect(mocks.claimExpiredSkippedBillingItems).not.toHaveBeenCalled();
  });

  it("does not create a service client when recovery is disarmed", async () => {
    mocks.billingRecoveryEnabled.mockReturnValue(false);

    const response = await POST(request("/api/billing/cron?mode=recovery"));

    expect(response.status).toBe(503);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.beginBillingAutomationRun).not.toHaveBeenCalled();
  });

  it("keeps automatic mode reconcile-only while its separate arm is off", async () => {
    mocks.billingAutomationEnabled.mockReturnValue(false);

    const response = await POST(request("/api/billing/cron?mode=automatic"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      automatic: false,
      reason: "not_armed",
      checked: 2,
    });
    expect(mocks.runAutomaticBilling).not.toHaveBeenCalled();
    expect(mocks.reconcileInvoices).toHaveBeenCalledTimes(1);
  });

  it("runs the bounded automatic worker only when it is armed", async () => {
    const response = await POST(request("/api/billing/cron?mode=automatic"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      runId: "run-auto",
      status: "succeeded",
      issued: 1,
    });
    expect(mocks.runAutomaticBilling).toHaveBeenCalledWith(SERVICE);
    expect(mocks.reconcileInvoices).not.toHaveBeenCalled();
  });

  it("recovers only the purpose-bound claim and never runs reconciliation", async () => {
    const response = await POST(request("/api/billing/cron?mode=recovery"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      runId: "run-1",
      recovered: 1,
    });
    expect(mocks.claimExpiredSkippedBillingItems).toHaveBeenCalledWith(
      SERVICE,
      "run-1",
      2,
    );
    expect(mocks.recordBillingAutomationOutcomes).toHaveBeenCalledWith(
      SERVICE,
      "run-1",
      [OUTCOME],
    );
    expect(mocks.reconcileInvoices).not.toHaveBeenCalled();
  });
});
