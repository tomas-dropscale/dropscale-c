import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sponsor: vi.fn(),
  collect: vi.fn(),
}));

vi.mock("@/lib/audit/connections", () => ({
  getAuditMachineSponsor: mocks.sponsor,
}));
vi.mock("@/lib/audit/lara-storefront-residual-collector", () => ({
  LARA_STOREFRONT_RESIDUAL_RUN_ID: "423ca684-157a-436a-b04b-262a2a0f7945",
  runLaraStorefrontResidualCollector: mocks.collect,
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

const URL = "https://dropscale.app/api/internal/audit/lara/storefront-residual-map";
const RUN_ID = "423ca684-157a-436a-b04b-262a2a0f7945";
const SUMMARY = {
  auditStatus: "complete",
  completionIssues: [],
  themeFileCount: 274,
  scannedSourceCount: 240,
  matchedSourceCount: 6,
  textSizeReconciliationCount: 44,
  kachingEmbedCount: 1,
  activeKachingEmbedCount: 1,
  croatianPostMatchedFileCount: 3,
  saleNarrativeMatchedFileCount: 1,
  summerSaleMenuItemCount: 1,
  contactLinks: { main: 1, footer: 0 },
  aboutLinks: { main: 0, footer: 0 },
  appInstallations: {
    status: "complete",
    scannedCount: 12,
    pagesRead: 1,
    matches: [
      {
        product: "shopify_flow",
        title: "Shopify Flow",
        handle: "shopify-flow",
        shopifyDeveloped: true,
      },
    ],
  },
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

describe("the exact machine-only Lara storefront residual map route", () => {
  it("rejects unauthorised and cross-origin callers before service-role work", async () => {
    const unauthorised = await POST(
      request({ action: "collect" }, { secret: "wrong" }),
    );
    expect(unauthorised.status).toBe(401);
    const crossOrigin = await POST(
      request(
        { action: "collect" },
        { origin: "https://attacker.invalid" },
      ),
    );
    expect(crossOrigin.status).toBe(403);
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("triggers only the fixed read and returns its bounded summary, never an artifact", async () => {
    const result = await POST(request({ action: "collect" }));
    expect(result.status).toBe(200);
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
    expect(JSON.stringify(await mocks.collect.mock.results[0].value)).not.toContain(
      "sourceScan",
    );
  });

  it("rejects every request-controlled query, shop, theme, filename or run id", async () => {
    for (const extra of [
      { query: "query { customers { nodes { email } } }" },
      { shopDomain: "attacker.myshopify.com" },
      { themeId: "gid://shopify/OnlineStoreTheme/999" },
      { filename: "config/settings_data.json" },
      { runId: "attacker-controlled" },
    ]) {
      const result = await POST(request({ action: "collect", ...extra }));
      expect(result.status).toBe(400);
    }
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("uses 202 only while the same durable map is in progress", async () => {
    mocks.collect.mockResolvedValueOnce({ runId: RUN_ID, state: "in_progress" });
    const result = await POST(request({ action: "collect" }));
    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({
      ok: true,
      runId: RUN_ID,
      state: "in_progress",
    });
  });

  it("returns a sanitized terminal failure without internal messages or raw source", async () => {
    mocks.collect.mockResolvedValueOnce({
      runId: RUN_ID,
      state: "failed",
      errorCode: "theme_body_error",
    });
    const result = await POST(request({ action: "collect" }));
    expect(result.status).toBe(502);
    await expect(result.json()).resolves.toEqual({
      ok: false,
      runId: RUN_ID,
      state: "failed",
      errorCode: "theme_body_error",
    });
  });
});
