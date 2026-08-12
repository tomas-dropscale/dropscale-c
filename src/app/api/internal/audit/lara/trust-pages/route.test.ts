import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sponsor: vi.fn(),
  dryRun: vi.fn(),
  runOneShot: vi.fn(),
}));

vi.mock("@/lib/audit/connections", () => ({
  getAuditMachineSponsor: mocks.sponsor,
}));
vi.mock("@/lib/audit/lara-trust-pages-repair", () => {
  class LaraTrustPagesRepairError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    buildLaraTrustPagesDryRun: mocks.dryRun,
    runLaraTrustPagesRepairOneShot: mocks.runOneShot,
    LARA_TRUST_PAGES_REPAIR_RUN_ID: "622f8f1d-bb20-4ecf-86ac-56f5f3a08be8",
    LaraTrustPagesRepairError,
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

const URL = "https://dropscale.app/api/internal/audit/lara/trust-pages";
const RUN_ID = "622f8f1d-bb20-4ecf-86ac-56f5f3a08be8";
const DIGEST = "a".repeat(64);
const DRY_RUN = {
  runId: RUN_ID,
  mode: "dry-run",
  writesAttempted: 0,
  planId: "lara-trust-pages-contact-about-v1",
  planDigestSha256: DIGEST,
  inverseDigestSha256: "b".repeat(64),
  operations: [],
};

function request(body: unknown, secret = "test-cron-secret", origin?: string) {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  mocks.sponsor.mockResolvedValue("10000000-0000-4000-8000-000000000001");
  mocks.dryRun.mockResolvedValue(DRY_RUN);
  mocks.runOneShot.mockResolvedValue({
    runId: RUN_ID,
    state: "completed",
    status: "verified",
    planDigestSha256: DIGEST,
    verifiedCount: 2,
  });
});

describe("the exact machine-only Lara trust-pages route", () => {
  it("rejects unauthorised or cross-origin requests before runtime work", async () => {
    const unauthorised = await POST(request({ action: "dry-run" }, "wrong"));
    expect(unauthorised.status).toBe(401);
    const crossOrigin = await POST(
      request({ action: "dry-run" }, "test-cron-secret", "https://evil.invalid"),
    );
    expect(crossOrigin.status).toBe(403);
    expect(mocks.dryRun).not.toHaveBeenCalled();
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.runOneShot).not.toHaveBeenCalled();
  });

  it("returns a server-generated digest-only dry run with zero writes", async () => {
    const result = await POST(request({ action: "dry-run" }));
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true, ...DRY_RUN });
    expect(mocks.dryRun).toHaveBeenCalledOnce();
    expect(mocks.runOneShot).not.toHaveBeenCalled();
  });

  it("generates and applies the fixed server-owned plan in one machine call", async () => {
    const result = await POST(
      request({
        action: "apply",
        confirmation: "apply-lara-contact-about-approved-copy",
      }),
    );
    expect(result.status).toBe(200);
    expect(mocks.sponsor).toHaveBeenCalledWith({
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      shopifyDomain: "jwmtjg-fm.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/95462097276",
    });
    expect(mocks.runOneShot).toHaveBeenCalledWith({
      requestedBy: "10000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects request-controlled page ids, HTML, run ids and plan payloads", async () => {
    for (const extra of [
      { resourceId: "gid://shopify/Page/999" },
      { bodyHtml: "<p>attacker supplied</p>" },
      { runId: "attacker-controlled" },
      { plan: { operations: [] } },
      { planDigestSha256: DIGEST },
    ]) {
      const result = await POST(
        request({
          action: "apply",
          confirmation: "apply-lara-contact-about-approved-copy",
          ...extra,
        }),
      );
      expect(result.status).toBe(400);
    }
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.runOneShot).not.toHaveBeenCalled();
  });
});
