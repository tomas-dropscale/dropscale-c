import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sponsor: vi.fn(),
  resolvePlan: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/audit/connections", () => ({
  getAuditMachineSponsor: mocks.sponsor,
}));
vi.mock("@/lib/audit/shopify-priority-quarantine", () => {
  class LaraPriorityQuarantineError extends Error {}
  return {
    resolveLaraPriorityQuarantinePlan: mocks.resolvePlan,
    executeLaraPriorityQuarantine: mocks.execute,
    LARA_PRIORITY_QUARANTINE_RUN_ID: "9766fd58-5abc-45c9-a248-fd12bd8fd27c",
    LaraPriorityQuarantineError,
  };
});
vi.mock("@/lib/audit/shopify-lara", () => ({
  LARA_AUDIT_CONNECTION: {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
  },
}));

import { NextRequest } from "next/server";
import { POST } from "./route";

const URL = "https://dropscale.app/api/internal/audit/lara/priority-quarantine";
const LARA_PRIORITY_QUARANTINE_RUN_ID = "9766fd58-5abc-45c9-a248-fd12bd8fd27c";
const PLAN = { payload: { planId: "fixed" }, digestSha256: "a".repeat(64) };

function request(body: unknown, secret = "test-cron-secret") {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  mocks.sponsor.mockResolvedValue("10000000-0000-4000-8000-000000000001");
  mocks.resolvePlan.mockResolvedValue(PLAN);
  mocks.execute.mockResolvedValue({
    runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
    state: "completed",
    planDigestSha256: "a".repeat(64),
    verifiedCount: 10,
  });
});

describe("the exact machine-only Lara priority quarantine route", () => {
  it("rejects requests before constructing any Shopify or service-role work", async () => {
    const result = await POST(request({ action: "dry-run" }, "wrong"));
    expect(result.status).toBe(401);
    expect(mocks.resolvePlan).not.toHaveBeenCalled();
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns the immutable dry-run plan with zero writes", async () => {
    const result = await POST(request({ action: "dry-run" }));
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      ok: true,
      mode: "dry-run",
      writesAttempted: 0,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      plan: PLAN,
    });
    expect(mocks.resolvePlan).toHaveBeenCalledWith({
      requestedBy: "10000000-0000-4000-8000-000000000001",
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("injects the fixed run ID and sponsor for an exactly confirmed apply", async () => {
    const result = await POST(
      request({
        action: "apply",
        confirmation: "apply-lara-priority-quarantine-active-to-draft",
      }),
    );
    expect(result.status).toBe(200);
    expect(mocks.sponsor).toHaveBeenCalledWith({
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      shopifyDomain: "jwmtjg-fm.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/95462097276",
    });
    expect(mocks.execute).toHaveBeenCalledWith({
      sealedPlan: PLAN,
      requestedBy: "10000000-0000-4000-8000-000000000001",
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
    });
    expect(mocks.resolvePlan).toHaveBeenCalledWith({
      requestedBy: "10000000-0000-4000-8000-000000000001",
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
    });
  });

  it("rejects missing confirmation or every request-controlled plan/ID", async () => {
    const missing = await POST(request({ action: "apply" }));
    expect(missing.status).toBe(400);
    const extra = await POST(
      request({
        action: "apply",
        confirmation: "apply-lara-priority-quarantine-active-to-draft",
        plan: PLAN,
        runId: "attacker-controlled",
      }),
    );
    expect(extra.status).toBe(400);
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.resolvePlan).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns 202 for a queued retry so the same exact trigger can run again", async () => {
    mocks.execute.mockResolvedValueOnce({
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      state: "in_progress",
    });

    const result = await POST(
      request({
        action: "apply",
        confirmation: "apply-lara-priority-quarantine-active-to-draft",
      }),
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({
      ok: true,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      state: "in_progress",
    });
    expect(mocks.resolvePlan).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("accepts the same plan-free trigger on the next tick and reaches completion", async () => {
    mocks.execute
      .mockResolvedValueOnce({
        runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
        state: "in_progress",
      })
      .mockResolvedValueOnce({
        runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
        state: "completed",
        planDigestSha256: "a".repeat(64),
        verifiedCount: 10,
      });
    const triggerBody = {
      action: "apply",
      confirmation: "apply-lara-priority-quarantine-active-to-draft",
    };

    const first = await POST(request(triggerBody));
    const second = await POST(request(triggerBody));

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(mocks.resolvePlan).toHaveBeenCalledTimes(2);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute).toHaveBeenNthCalledWith(2, {
      sealedPlan: PLAN,
      requestedBy: "10000000-0000-4000-8000-000000000001",
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
    });
  });
});
