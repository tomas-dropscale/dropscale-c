import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  decryptToken: vi.fn(),
  hasGoogleAdsEnv: vi.fn(),
  hasWindsorEnv: vi.fn(),
  fetchLiveCampaignsDetailed: vi.fn(),
  fetchLiveGoogleDemandGenBreakdowns: vi.fn(),
  fetchLiveGooglePmaxProductBreakdowns: vi.fn(),
  fetchGoogleReportingCampaigns: vi.fn(),
  fetchGoogleReportingDemandGenAds: vi.fn(),
  fetchGoogleReportingPmaxProducts: vi.fn(),
  createLegacyShopifyReportingAdapter: vi.fn(),
  createShopifyReportingAdapter: vi.fn(),
  resolveReportingSources: vi.fn(),
  listCampaignActionActivity: vi.fn(),
  refreshAccountsNow: vi.fn(),
}));

vi.mock("@/lib/client-onboarding/sessions", () => ({
  requireClientOnboardingAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decryptToken }));
vi.mock("@/lib/google-ads/env", () => ({ hasGoogleAdsEnv: mocks.hasGoogleAdsEnv }));
vi.mock("@/lib/windsor/client", () => ({ hasWindsorEnv: mocks.hasWindsorEnv }));
vi.mock("@/lib/google-ads/portal", () => ({
  fetchLiveCampaignsDetailed: mocks.fetchLiveCampaignsDetailed,
  fetchLiveGoogleDemandGenBreakdowns: mocks.fetchLiveGoogleDemandGenBreakdowns,
  fetchLiveGooglePmaxProductBreakdowns: mocks.fetchLiveGooglePmaxProductBreakdowns,
}));
vi.mock("@/lib/reporting/google", () => ({
  fetchGoogleReportingCampaigns: mocks.fetchGoogleReportingCampaigns,
  fetchGoogleReportingDemandGenAds: mocks.fetchGoogleReportingDemandGenAds,
  fetchGoogleReportingPmaxProducts: mocks.fetchGoogleReportingPmaxProducts,
}));
vi.mock("@/lib/reporting/shopify", () => ({
  ShopifyReportingAdapterError: class ShopifyReportingAdapterError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
  createLegacyShopifyReportingAdapter: mocks.createLegacyShopifyReportingAdapter,
  createShopifyReportingAdapter: mocks.createShopifyReportingAdapter,
}));
vi.mock("@/lib/reporting/sources", () => ({
  resolveReportingSources: mocks.resolveReportingSources,
}));
vi.mock("@/lib/admin/campaign-actions", () => ({
  listCampaignActionActivity: mocks.listCampaignActionActivity,
}));
vi.mock("@/lib/metrics/recompute", () => ({
  refreshAccountsNow: mocks.refreshAccountsNow,
}));

import {
  ensureAdminAnalyticsRollupCoverage,
  fetchAdminStoreAnalytics,
} from "./store-analytics";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const STORE_ID = "20000000-0000-4000-8000-000000000001";
const CHILD_ID = "20000000-0000-4000-8000-000000000002";
const CHILD_TWO_ID = "20000000-0000-4000-8000-000000000003";
const RANGE = { from: "2026-08-08", to: "2026-08-14" };

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: STORE_ID,
    client_id: CLIENT_ID,
    currency: "EUR",
    shopify_url: "northwind.myshopify.com",
    shopify_connected: true,
    shopify_client_id: "legacy-client-id",
    shopify_admin_token: "encrypted-shopify-token",
    google_ads_customer_id: "1234567890",
    google_ads_refresh_token: "encrypted-google-token",
    google_ads_connected: true,
    ...overrides,
  };
}

function service(
  accounts: unknown[],
  rollout: unknown,
  metricResponses?: unknown[][],
) {
  const accountQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  accountQuery.select = vi.fn(() => accountQuery);
  accountQuery.in = vi.fn().mockResolvedValue({ data: accounts, error: null });
  const rolloutQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  rolloutQuery.select = vi.fn(() => rolloutQuery);
  rolloutQuery.eq = vi.fn(() => rolloutQuery);
  rolloutQuery.maybeSingle = vi.fn().mockResolvedValue({ data: rollout, error: null });
  const days = Array.from({ length: 7 }, (_, index) => `2026-08-${String(index + 8).padStart(2, "0")}`);
  const metricRows = (accounts as Array<{ id: string }>).flatMap((row) =>
    days.map((day) => ({
      ad_account_id: row.id,
      day,
      ad_spend: day === "2026-08-14" ? 250 : 0,
      attributed_revenue: row.id === STORE_ID && day === "2026-08-14" ? 625 : 0,
      attributed_orders: row.id === STORE_ID && day === "2026-08-14" ? 8 : 0,
      computed_at: "2026-08-14T19:00:00.000Z",
    })),
  );
  const metricsQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "in", "gte"]) {
    metricsQuery[method] = vi.fn(() => metricsQuery);
  }
  let metricRead = 0;
  metricsQuery.lte = vi.fn().mockImplementation(async () => {
    const responses = metricResponses ?? [metricRows];
    const data = responses[Math.min(metricRead, responses.length - 1)];
    metricRead += 1;
    return { data, error: null };
  });
  return {
    from: vi.fn((table: string) => {
      if (table === "ad_accounts") return accountQuery;
      if (table === "daily_metrics") return metricsQuery;
      return rolloutQuery;
    }),
  };
}

function shopifyAdapter() {
  return {
    fetchDailySales: vi.fn(),
    fetchCollectionProductKeys: vi.fn(),
    fetchFunnel: vi.fn().mockResolvedValue([
      {
        day: "2026-08-14",
        sessions: 200,
        addedToCart: 44,
        reachedCheckout: 19,
        completedCheckout: 8,
      },
    ]),
    fetchCampaignAttribution: vi.fn().mockResolvedValue([
      {
        campaignId: "987654321",
        attributionModel: "last_non_direct_click",
        orders: 8,
        revenue: 625,
      },
    ]),
    fetchCampaignProducts: vi.fn().mockResolvedValue([
      {
        campaignId: "987654321",
        productId: "gid://shopify/Product/10",
        title: "Lamp",
        attributionModel: "last_non_direct_click",
        units: 3,
      },
    ]),
    fetchCollectionSales: vi.fn().mockResolvedValue([
      {
        collectionId: "gid://shopify/Collection/20",
        title: "Best sellers",
        revenue: 625,
        units: 8,
        products: [
          {
            productId: "gid://shopify/Product/10",
            title: "Lamp",
            revenue: 300,
            units: 3,
          },
        ],
      },
    ]),
  };
}

function googleCampaign(accountId = STORE_ID) {
  return {
    id: `google-${accountId}-987654321`,
    providerCampaignId: "987654321",
    ad_account_id: accountId,
    name: "PMax · Best sellers",
    status: "active",
    spend: 250,
    impressions: 10_000,
    clicks: 400,
    ctr: 0.04,
    cpc: 0.625,
    daily_budget: 90,
    updated_at: "2026-08-14T12:00:00.000Z",
    startDate: "2026-08-01",
    conversions: 12,
    conversionValue: 800,
    advertisingChannelType: "PERFORMANCE_MAX",
    shoppingFeed: true,
    googleRoas: 3.2,
  };
}

function v2Topology() {
  const rollout = {
    operational_surface: "v2_active",
    reporting_cutover_at: "2026-08-01T00:00:00.000Z",
    reporting_cutover_by: "admin",
    reporting_cutover_reason: "verified",
  };
  const anchor = {
    bindingId: "30000000-0000-4000-8000-000000000001",
    clientId: CLIENT_ID,
    adAccountId: STORE_ID,
    kind: "shopify",
    group: {
      id: "30000000-0000-4000-8000-000000000001",
      shopifyAnchorBindingId: "30000000-0000-4000-8000-000000000001",
      shopifyAnchorAdAccountId: STORE_ID,
    },
    shopify: {
      connectionId: "40000000-0000-4000-8000-000000000001",
      shopId: "gid://shopify/Shop/1",
      shopifyName: "Northwind",
      domain: "northwind.myshopify.com",
      primaryDomain: null,
      currency: "JPY",
      credential: {
        shopifyClientId: "client-id",
        clientSecretCiphertext: "ciphertext",
      },
    },
    googleAds: null,
  };
  const child = {
    bindingId: "30000000-0000-4000-8000-000000000002",
    clientId: CLIENT_ID,
    adAccountId: CHILD_ID,
    kind: "google_ads",
    group: {
      id: anchor.bindingId,
      shopifyAnchorBindingId: anchor.bindingId,
      shopifyAnchorAdAccountId: STORE_ID,
    },
    shopify: null,
    googleAds: {
      connectionId: "50000000-0000-4000-8000-000000000001",
      windsorAccountId: "123-456-7890",
      accountId: "123-456-7890",
      customerId: "1234567890",
      accountName: "Northwind Ads",
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      dataSourceId: null,
    },
  };
  const childTwo = {
    ...child,
    bindingId: "30000000-0000-4000-8000-000000000003",
    adAccountId: CHILD_TWO_ID,
    googleAds: {
      ...child.googleAds,
      connectionId: "50000000-0000-4000-8000-000000000002",
      windsorAccountId: "234-567-8901",
      accountId: "234-567-8901",
      customerId: "2345678901",
      accountName: "Northwind Ads 2",
    },
  };
  return { rollout, anchor, child, childTwo };
}

describe("admin store analytics DAL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin" });
    mocks.decryptToken.mockResolvedValue("google-refresh-token");
    mocks.hasGoogleAdsEnv.mockReturnValue(true);
    mocks.hasWindsorEnv.mockReturnValue(true);
    mocks.refreshAccountsNow.mockResolvedValue(undefined);
    mocks.fetchLiveGoogleDemandGenBreakdowns.mockResolvedValue([]);
    mocks.fetchLiveGooglePmaxProductBreakdowns.mockResolvedValue([]);
    mocks.fetchGoogleReportingDemandGenAds.mockResolvedValue([]);
    mocks.fetchGoogleReportingPmaxProducts.mockResolvedValue([]);
    mocks.listCampaignActionActivity.mockResolvedValue({
      history: [],
      truncated: false,
    });
  });

  it("uses the exact inclusive range for every legacy source and only exact campaign IDs", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);
    mocks.fetchLiveGoogleDemandGenBreakdowns.mockRejectedValue(
      new Error("Demand Gen unavailable"),
    );
    mocks.fetchLiveGooglePmaxProductBreakdowns.mockResolvedValue([
      {
        accountId: STORE_ID,
        campaignId: "987654321",
        provider: "google_ads",
        kind: "product",
        id: "merchant:feed:en:lamp-1",
        name: "Lamp",
        detail: "lamp-1",
        spend: 120,
        impressions: 5_000,
        clicks: 200,
        conversions: 6,
        googleRevenue: 400,
      },
    ]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [{ day: "2026-08-14", adSpend: 250, revenue: 625 }],
      },
      range: RANGE,
    });

    expect(mocks.requireAdmin).toHaveBeenCalledBefore(mocks.createServiceClient);
    expect(mocks.fetchLiveCampaignsDetailed).toHaveBeenCalledWith(
      "1234567890",
      "google-refresh-token",
      STORE_ID,
      RANGE,
      "EUR",
    );
    expect(mocks.fetchLiveGooglePmaxProductBreakdowns).toHaveBeenCalledWith(
      "1234567890",
      "google-refresh-token",
      STORE_ID,
      RANGE,
    );
    expect(adapter.fetchFunnel).toHaveBeenCalledWith(RANGE.from, RANGE.to);
    expect(adapter.fetchCampaignAttribution).toHaveBeenCalledWith(
      RANGE.from,
      RANGE.to,
      "EUR",
    );
    expect(adapter.fetchCampaignProducts).toHaveBeenCalledWith(RANGE.from, RANGE.to);
    expect(adapter.fetchCollectionSales).toHaveBeenCalledWith(
      RANGE.from,
      RANGE.to,
      "EUR",
    );
    expect(mocks.listCampaignActionActivity).toHaveBeenCalledWith(
      CLIENT_ID,
      [STORE_ID],
      RANGE,
    );
    expect(result.funnel).toMatchObject({
      state: "ready",
      data: { totals: { sessions: 200, completedCheckout: 8 } },
    });
    expect(result.rollupCoverage).toMatchObject({
      state: "ready",
      data: { dayCount: 7, refreshed: false },
    });
    expect(result.campaigns).toMatchObject({
      state: "ready",
      data: {
        rows: [
          {
            campaignId: "987654321",
            shopifyOrders: 8,
            shopifyRevenue: 625,
            realRoas: 2.5,
            attributionState: "matched",
            breakdown: {
              state: "ready",
              rows: expect.arrayContaining([
                expect.objectContaining({ provider: "google_ads", spend: 120 }),
                expect.objectContaining({ provider: "shopify", shopifyUnits: 3 }),
              ]),
            },
          },
        ],
      },
    });
    expect(result.collections).toMatchObject({
      state: "ready",
      message: expect.stringContaining("collection rows are not additive"),
      data: {
        rows: [
          {
            revenue: 625,
            units: 8,
            spend: null,
            roas: null,
          },
        ],
      },
    });
  });

  it("marks an all-zero, fully materialised funnel as empty", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchFunnel.mockResolvedValue([
      {
        day: "2026-08-08",
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        completedCheckout: 0,
      },
      {
        day: "2026-08-14",
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        completedCheckout: 0,
      },
    ]);
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [],
      },
      range: RANGE,
    });

    expect(result.funnel).toMatchObject({
      state: "empty",
      data: {
        daily: [{ day: "2026-08-08" }, { day: "2026-08-14" }],
        totals: {
          sessions: 0,
          addedToCart: 0,
          reachedCheckout: 0,
          completedCheckout: 0,
        },
      },
    });
  });

  it("resolves the exact V2 anchor and Google child without falling back to legacy", async () => {
    const rollout = {
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-01T00:00:00.000Z",
      reporting_cutover_by: "admin",
      reporting_cutover_reason: "verified",
    };
    mocks.createServiceClient.mockReturnValue(
      service(
        [
          account(),
          account({ id: CHILD_ID, shopify_url: null, shopify_connected: false }),
          account({ id: CHILD_TWO_ID, shopify_url: null, shopify_connected: false }),
        ],
        rollout,
      ),
    );
    const anchor = {
      bindingId: "30000000-0000-4000-8000-000000000001",
      clientId: CLIENT_ID,
      adAccountId: STORE_ID,
      kind: "shopify",
      group: {
        id: "30000000-0000-4000-8000-000000000001",
        shopifyAnchorBindingId: "30000000-0000-4000-8000-000000000001",
        shopifyAnchorAdAccountId: STORE_ID,
      },
      shopify: {
        connectionId: "40000000-0000-4000-8000-000000000001",
        shopId: "gid://shopify/Shop/1",
        shopifyName: "Northwind",
        domain: "northwind.myshopify.com",
        primaryDomain: null,
        currency: "JPY",
        credential: {
          shopifyClientId: "client-id",
          clientSecretCiphertext: "ciphertext",
        },
      },
      googleAds: null,
    };
    const child = {
      bindingId: "30000000-0000-4000-8000-000000000002",
      clientId: CLIENT_ID,
      adAccountId: CHILD_ID,
      kind: "google_ads",
      group: {
        id: anchor.bindingId,
        shopifyAnchorBindingId: anchor.bindingId,
        shopifyAnchorAdAccountId: STORE_ID,
      },
      shopify: null,
      googleAds: {
        connectionId: "50000000-0000-4000-8000-000000000001",
        windsorAccountId: "123-456-7890",
        accountId: "123-456-7890",
        customerId: "1234567890",
        accountName: "Northwind Ads",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        dataSourceId: null,
      },
    };
    const childTwo = {
      ...child,
      bindingId: "30000000-0000-4000-8000-000000000003",
      adAccountId: CHILD_TWO_ID,
      googleAds: {
        ...child.googleAds,
        connectionId: "50000000-0000-4000-8000-000000000002",
        windsorAccountId: "234-567-8901",
        accountId: "234-567-8901",
        customerId: "2345678901",
        accountName: "Northwind Ads 2",
      },
    };
    mocks.resolveReportingSources.mockResolvedValue([anchor, child, childTwo]);
    const adapter = shopifyAdapter();
    mocks.createShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchGoogleReportingCampaigns
      .mockResolvedValueOnce([googleCampaign(CHILD_ID)])
      .mockRejectedValueOnce(new Error("second source unavailable"));

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID, CHILD_ID, CHILD_TWO_ID],
        currency: "EUR",
        days: [],
      },
      range: RANGE,
    });

    expect(mocks.resolveReportingSources).toHaveBeenCalledWith({
      service: expect.any(Object),
      adAccountIds: [STORE_ID, CHILD_ID, CHILD_TWO_ID],
      includeShopifyCredentials: true,
    });
    expect(mocks.createShopifyReportingAdapter).toHaveBeenCalledWith(anchor);
    expect(mocks.createLegacyShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingCampaigns).toHaveBeenCalledWith(
      child,
      RANGE.from,
      RANGE.to,
    );
    expect(result.campaigns).toMatchObject({
      state: "ready",
      message: expect.stringContaining("Some Google Ads accounts"),
      data: { rows: [{ accountId: CHILD_ID }] },
    });
  });

  it("withholds Shopify UTM attribution when a campaign id repeats across Google accounts", async () => {
    const { rollout, anchor, child, childTwo } = v2Topology();
    mocks.createServiceClient.mockReturnValue(
      service(
        [
          account(),
          account({ id: CHILD_ID, shopify_url: null, shopify_connected: false }),
          account({ id: CHILD_TWO_ID, shopify_url: null, shopify_connected: false }),
        ],
        rollout,
      ),
    );
    mocks.resolveReportingSources.mockResolvedValue([anchor, child, childTwo]);
    mocks.createShopifyReportingAdapter.mockResolvedValue(shopifyAdapter());
    mocks.fetchGoogleReportingCampaigns
      .mockResolvedValueOnce([googleCampaign(CHILD_ID)])
      .mockResolvedValueOnce([googleCampaign(CHILD_TWO_ID)]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID, CHILD_ID, CHILD_TWO_ID],
        currency: "EUR",
        days: [],
      },
      range: RANGE,
    });

    expect(result.campaigns).toMatchObject({
      state: "ready",
      message: expect.stringContaining("repeated across Google accounts"),
      data: {
        rows: [
          {
            accountId: CHILD_ID,
            campaignId: "987654321",
            shopifyRevenue: null,
            realRoas: null,
            attributionState: "unmatched",
            breakdown: {
              sources: expect.arrayContaining([
                expect.objectContaining({
                  provider: "shopify",
                  state: "unavailable",
                  reason: expect.stringContaining("repeated across store accounts"),
                }),
              ]),
            },
          },
          {
            accountId: CHILD_TWO_ID,
            campaignId: "987654321",
            shopifyRevenue: null,
            realRoas: null,
            attributionState: "unmatched",
          },
        ],
      },
    });
  });

  it("materialises an exact missing spend window before marking it ready", async () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      `2026-08-${String(index + 8).padStart(2, "0")}`,
    );
    const complete = days.map((day) => ({
      ad_account_id: STORE_ID,
      day,
      ad_spend: day === "2026-08-14" ? 250 : 0,
      attributed_revenue: day === "2026-08-14" ? 625 : 0,
      attributed_orders: day === "2026-08-14" ? 8 : 0,
      computed_at: "2026-08-14T19:00:00.000Z",
    }));
    const scopedService = service([account()], null, [[], complete]);
    mocks.createServiceClient.mockReturnValue(scopedService);
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(shopifyAdapter());
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [],
      },
      range: RANGE,
    });

    expect(mocks.refreshAccountsNow).toHaveBeenCalledWith([STORE_ID], {
      client: scopedService,
      reportingClient: scopedService,
      from: RANGE.from,
      to: RANGE.to,
    });
    expect(result.spend).toMatchObject({
      state: "ready",
      data: { daily: expect.arrayContaining([{ day: "2026-08-14", spend: 250 }]) },
    });
    expect(result.rollupCoverage).toMatchObject({
      state: "ready",
      data: { dayCount: 7, refreshed: true },
    });
  });

  it("materialises and proves All Stores rollup coverage without loading detail families", async () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      `2026-08-${String(index + 8).padStart(2, "0")}`,
    );
    const complete = days.map((day) => ({
      ad_account_id: STORE_ID,
      day,
      ad_spend: day === "2026-08-14" ? 250 : 0,
      attributed_revenue: day === "2026-08-14" ? 625 : 0,
      attributed_orders: day === "2026-08-14" ? 8 : 0,
      computed_at: "2026-08-14T19:00:00.000Z",
    }));
    const scopedService = service([account()], null, [[], complete]);
    mocks.createServiceClient.mockReturnValue(scopedService);

    await expect(
      ensureAdminAnalyticsRollupCoverage({
        clientId: CLIENT_ID,
        stores: [{
          accountId: STORE_ID,
          activityAccountIds: [STORE_ID],
          currency: "EUR",
        }],
        range: RANGE,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { storeCount: 1, dayCount: 7, refreshed: true },
    });

    expect(mocks.requireAdmin).toHaveBeenCalledBefore(mocks.createServiceClient);
    expect(mocks.refreshAccountsNow).toHaveBeenCalledWith([STORE_ID], {
      client: scopedService,
      reportingClient: scopedService,
      from: RANGE.from,
      to: RANGE.to,
    });
    expect(mocks.fetchLiveCampaignsDetailed).not.toHaveBeenCalled();
    expect(mocks.createLegacyShopifyReportingAdapter).not.toHaveBeenCalled();
  });

  it("fails coverage instead of treating an unmaterialised Shopify revenue family as zero", async () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      `2026-08-${String(index + 8).padStart(2, "0")}`,
    );
    const incomplete = days.map((day) => ({
      ad_account_id: STORE_ID,
      day,
      ad_spend: 0,
      attributed_revenue: null,
      attributed_orders: null,
      computed_at: "2026-08-14T19:00:00.000Z",
    }));
    mocks.createServiceClient.mockReturnValue(
      service([account()], null, [incomplete, incomplete]),
    );

    await expect(
      ensureAdminAnalyticsRollupCoverage({
        clientId: CLIENT_ID,
        stores: [{
          accountId: STORE_ID,
          activityAccountIds: [STORE_ID],
          currency: "EUR",
        }],
        range: RANGE,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      message: expect.stringContaining("could not be proved"),
    });
    expect(mocks.refreshAccountsNow).toHaveBeenCalledTimes(1);
  });
});
