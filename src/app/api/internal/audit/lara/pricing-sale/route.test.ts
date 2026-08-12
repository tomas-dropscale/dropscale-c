import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  sponsor: vi.fn(async () => "71000000-0000-4000-8000-000000000001"),
  run: vi.fn(),
}));

vi.mock("@/lib/audit/connections", () => ({
  getAuditMachineSponsor: mocks.sponsor,
}));
vi.mock("@/lib/audit/lara-pricing-live-repair", () => ({
  LaraPricingLiveRepairError: class LaraPricingLiveRepairError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  runLaraPricingLiveRepairOneShot: mocks.run,
}));
vi.mock("@/lib/audit/lara-pricing-live-runtime", () => ({
  LaraPricingLiveRuntimeError: class LaraPricingLiveRuntimeError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
}));
vi.mock("@/lib/audit/shopify-lara", () => ({
  LARA_AUDIT_CONNECTION: {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
  },
}));

import { POST } from "./route";

const LARA_AUDIT_CONNECTION = {
  connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
  shopDomain: "jwmtjg-fm.myshopify.com",
  shopId: "gid://shopify/Shop/95462097276",
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://dropscale.app/api/internal/audit/lara/pricing-sale", {
    method: "POST",
    headers: {
      authorization: "Bearer machine-secret",
      "content-type": "application/json",
      origin: "https://dropscale.app",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "machine-secret";
  mocks.run.mockResolvedValue({
    state: "in_progress",
    runId: "526c1b70-3b99-40d7-9761-bd67f083bcd9",
    phase: "preparing",
    products: 1_449,
    variants: 38_069,
    targetVariants: 38_069,
    processedProducts: 20,
    errorCode: null,
  });
});

describe("fixed Lara pricing repair machine route", () => {
  it("accepts only the exact action and confirmation and passes only the server sponsor", async () => {
    const response = await POST(
      request({
        action: "advance",
        confirmation: "apply-lara-remove-unsupported-compare-at-prices",
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(
      expect.objectContaining({ ok: true, state: "in_progress", phase: "preparing" }),
    );
    expect(mocks.sponsor).toHaveBeenCalledWith({
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      shopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
      shopifyShopId: LARA_AUDIT_CONNECTION.shopId,
    });
    expect(mocks.run).toHaveBeenCalledWith({
      requestedBy: "71000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects every caller-supplied query, URL, id, digest, price or plan value", async () => {
    for (const [key, value] of Object.entries({
      graphql: "mutation { unsafe }",
      url: "https://evil.example/file",
      productId: "gid://shopify/Product/1",
      planDigest: "a".repeat(64),
      compareAtPrice: "1.00",
      vendor: "Other",
    })) {
      const response = await POST(
        request({
          action: "advance",
          confirmation: "apply-lara-remove-unsupported-compare-at-prices",
          [key]: value,
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("enforces machine authentication, same origin and bounded JSON", async () => {
    expect((await POST(request({}, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect(
      (
        await POST(
          request(
            {
              action: "advance",
              confirmation: "apply-lara-remove-unsupported-compare-at-prices",
            },
            { origin: "https://evil.example" },
          ),
        )
      ).status,
    ).toBe(403);
    expect((await POST(request("{"))).status).toBe(400);
    expect(
      (
        await POST(
          request(
            {
              action: "advance",
              confirmation: "apply-lara-remove-unsupported-compare-at-prices",
            },
            { "content-length": "2048" },
          ),
        )
      ).status,
    ).toBe(413);
  });

  it("returns a no-store completed proof and does not expose private material", async () => {
    mocks.run.mockResolvedValueOnce({
      state: "completed",
      runId: "526c1b70-3b99-40d7-9761-bd67f083bcd9",
      phase: "verified",
      products: 1_449,
      variants: 38_069,
      targetVariants: 38_069,
      processedProducts: 1_449,
      errorCode: null,
    });
    const response = await POST(
      request({
        action: "advance",
        confirmation: "apply-lara-remove-unsupported-compare-at-prices",
      }),
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload).not.toHaveProperty("url");
    expect(payload).not.toHaveProperty("graphql");
    expect(payload).not.toHaveProperty("rootRef");
  });
});
