import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sponsor: vi.fn(),
  collect: vi.fn(),
}));

vi.mock("@/lib/audit/connections", () => ({
  getAuditMachineSponsor: mocks.sponsor,
}));
vi.mock("@/lib/audit/lara-markets-delivery-collector", () => ({
  LARA_MARKETS_DELIVERY_RUN_ID: "1477f9be-a1da-42e7-af35-2e028d693a60",
  runLaraMarketsDeliveryCollector: mocks.collect,
}));
vi.mock("@/lib/audit/shopify-lara", () => ({
  LARA_AUDIT_CONNECTION: {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
  },
}));

import { NextRequest } from "next/server";
import { POST } from "./route";

const URL = "https://dropscale.app/api/internal/audit/lara/markets-delivery-map";
const RUN_ID = "1477f9be-a1da-42e7-af35-2e028d693a60";
const SUMMARY = {
  auditStatus: "complete",
  completionIssues: [],
  sourceOfTruth: "legacy_delivery_profiles",
  sourceOfTruthScope: "merchant_owned_shipping_configuration",
  sourceOfTruthComplete: true,
  assessmentBoundary: "admin_configuration_not_checkout_quote",
  inheritedMarketShippingPresent: true,
  marketDrivenShipping: false,
  moduleStatuses: {
    shopCurrencies: "complete",
    markets: "complete",
    webPresences: "complete",
    locales: "complete",
    marketShipping: "complete",
    legacyDelivery: "complete",
  },
  shopCurrencyCode: "EUR",
  enabledPresentmentCurrencies: ["EUR"],
  marketCount: 2,
  activeMarketCount: 2,
  webPresenceCount: 1,
  publishedLocales: ["hr", "pt-PT"],
  marketShippingOptionCount: 0,
  legacyProfileCount: 1,
  legacyZoneCount: 1,
  legacyMethodCount: 1,
  portugal: { countryCode: "PT", legacyZones: [] },
  croatia: { countryCode: "HR", legacyZones: [{ zoneName: "Croatia" }] },
  croatianPostReferences: [],
  dpdReferences: [],
  brandVendorPolicy: "accepted_non_issue_out_of_scope",
};

function request(body: unknown, options: { secret?: string; origin?: string } = {}) {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.secret ?? "test-cron-secret"}`,
      "content-type": "application/json",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  mocks.sponsor.mockResolvedValue("10000000-0000-4000-8000-000000000001");
  mocks.collect.mockResolvedValue({
    runId: RUN_ID,
    state: "completed",
    summary: SUMMARY,
  });
});

describe("the exact machine-only Lara Markets and delivery map route", () => {
  it("rejects unauthorised and cross-origin callers before service-role work", async () => {
    const unauthorised = await POST(
      request({ action: "collect" }, { secret: "wrong" }),
    );
    expect(unauthorised.status).toBe(401);
    const crossOrigin = await POST(
      request({ action: "collect" }, { origin: "https://attacker.invalid" }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("returns only the fixed durable run summary, never the raw artifact", async () => {
    const result = await POST(request({ action: "collect" }));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(result.json()).resolves.toEqual({
      ok: true,
      runId: RUN_ID,
      state: "completed",
      summary: SUMMARY,
    });
    expect(mocks.sponsor).toHaveBeenCalledWith({
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      shopifyDomain: "jwmtjg-fm.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/95462097276",
    });
    expect(mocks.collect).toHaveBeenCalledWith({
      requestedBy: "10000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects every request-controlled query, shop, profile, country or run ID", async () => {
    for (const extra of [
      { query: "query { customers { nodes { email } } }" },
      { shopDomain: "attacker.myshopify.com" },
      { profileId: "gid://shopify/DeliveryProfile/999" },
      { countryCode: "US" },
      { runId: "attacker-controlled" },
    ]) {
      const result = await POST(request({ action: "collect", ...extra }));
      expect(result.status).toBe(400);
    }
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("uses 202 only while the same durable read is in progress", async () => {
    mocks.collect.mockResolvedValueOnce({ runId: RUN_ID, state: "in_progress" });
    const result = await POST(request({ action: "collect" }));
    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({
      ok: true,
      runId: RUN_ID,
      state: "in_progress",
    });
  });

  it("returns a sanitized terminal failure without internal messages or evidence", async () => {
    mocks.collect.mockResolvedValueOnce({
      runId: RUN_ID,
      state: "failed",
      errorCode: "query_rate_limited",
    });
    const result = await POST(request({ action: "collect" }));
    expect(result.status).toBe(502);
    await expect(result.json()).resolves.toEqual({
      ok: false,
      runId: RUN_ID,
      state: "failed",
      errorCode: "query_rate_limited",
    });
  });
});
