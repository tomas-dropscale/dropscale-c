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
  adminReportingSnapshotIsStale: vi.fn(),
  adminReportingAuthority: vi.fn(),
  readAdminReportingSnapshotFamilies: vi.fn(),
  refreshAdminReportingSnapshot: vi.fn(),
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
vi.mock("@/lib/admin/reporting-snapshots", () => ({
  adminReportingSnapshotIsStale: mocks.adminReportingSnapshotIsStale,
  adminReportingAuthority: mocks.adminReportingAuthority,
  readAdminReportingSnapshotFamilies: mocks.readAdminReportingSnapshotFamilies,
  refreshAdminReportingSnapshot: mocks.refreshAdminReportingSnapshot,
}));

import {
  ensureAdminAnalyticsRollupCoverage,
  fetchAdminStoreAnalytics,
  fetchCachedAdminStoreAnalytics,
} from "./store-analytics";
import { ShopifyReportingAdapterError } from "@/lib/reporting/shopify";

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
  supplemental?: {
    connections?: unknown[];
    connectionError?: unknown;
    credential?: unknown;
    credentialError?: unknown;
  },
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
  const connectionQuery: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = { select: vi.fn(), eq: vi.fn() };
  connectionQuery.select.mockReturnValue(connectionQuery);
  connectionQuery.eq.mockReturnValue(connectionQuery);
  connectionQuery.then = (resolve, reject) => Promise.resolve({
    data: supplemental?.connections ?? [],
    error: supplemental?.connectionError ?? null,
  }).then(resolve, reject);
  const credentialQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  credentialQuery.select = vi.fn(() => credentialQuery);
  credentialQuery.eq = vi.fn(() => credentialQuery);
  credentialQuery.maybeSingle = vi.fn().mockResolvedValue({
    data: supplemental?.credential ?? null,
    error: supplemental?.credentialError ?? null,
  });
  return {
    from: vi.fn((table: string) => {
      if (table === "ad_accounts") return accountQuery;
      if (table === "daily_metrics") return metricsQuery;
      if (table === "client_shopify_connections") return connectionQuery;
      if (table === "client_shopify_credentials") return credentialQuery;
      return rolloutQuery;
    }),
  };
}

function supplementalConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    client_id: CLIENT_ID,
    status: "connected",
    shopify_shop_id: "gid://shopify/Shop/1",
    shopify_name: "Northwind",
    shopify_domain: "northwind.myshopify.com",
    primary_domain: "northwind.example",
    shopify_currency: "EUR",
    credential_hint: "client-id…1234",
    granted_scopes: ["read_reports", "read_products"],
    scope_profile: "client-reporting-read-v1",
    updated_at: "2026-08-15T10:00:00.000Z",
    last_verified_at: "2026-08-15T10:00:00.000Z",
    last_error_code: null,
    ...overrides,
  };
}

function supplementalCredential(overrides: Record<string, unknown> = {}) {
  return {
    connection_id: "40000000-0000-4000-8000-000000000001",
    shopify_client_id: "shopify-client-id",
    client_secret_ciphertext: "encrypted-v2-client-secret",
    updated_at: "2026-08-15T10:00:00.000Z",
    ...overrides,
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
    mocks.adminReportingSnapshotIsStale.mockReturnValue(false);
    mocks.adminReportingAuthority.mockImplementation(async (manifest) => ({
      key: "a".repeat(64),
      manifest,
    }));
    mocks.readAdminReportingSnapshotFamilies.mockResolvedValue(new Map());
    mocks.fetchLiveGoogleDemandGenBreakdowns.mockResolvedValue([]);
    mocks.fetchLiveGooglePmaxProductBreakdowns.mockResolvedValue([]);
    mocks.fetchGoogleReportingDemandGenAds.mockResolvedValue([]);
    mocks.fetchGoogleReportingPmaxProducts.mockResolvedValue([]);
    mocks.listCampaignActionActivity.mockResolvedValue({
      history: [],
      truncated: false,
    });
  });

  it("returns failed detail families instead of crashing the analytics page", async () => {
    mocks.createServiceClient.mockReturnValue(null);

    await expect(
      fetchAdminStoreAnalytics({
        clientId: CLIENT_ID,
        store: {
          accountId: STORE_ID,
          activityAccountIds: [STORE_ID],
          currency: "EUR",
          days: [],
        },
        range: RANGE,
      }),
    ).resolves.toMatchObject({
      storeAccountId: STORE_ID,
      funnel: { state: "failed" },
      campaigns: { state: "failed" },
      collections: { state: "failed" },
      spend: { state: "failed" },
      activity: { state: "failed" },
    });

    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
  });

  it("renders cached provider families plus DB rollups without opening a provider", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const snapshot = (rows: unknown[]) => ({
      state: "ready",
      rows,
      message: null,
      refreshedAt: "2026-08-15T10:00:00.000Z",
      lastAttemptAt: "2026-08-15T10:00:00.000Z",
      lastErrorCode: null,
      revision: 1,
    });
    mocks.readAdminReportingSnapshotFamilies.mockResolvedValue(new Map([
      ["shopify_funnel", snapshot([{
        daily: [{
          day: "2026-08-14",
          sessions: 200,
          addedToCart: 44,
          reachedCheckout: 19,
          completedCheckout: 8,
        }],
        totals: {
          sessions: 200,
          addedToCart: 44,
          reachedCheckout: 19,
          completedCheckout: 8,
        },
      }])],
      ["store_campaign_performance", snapshot([{ rows: [] }])],
      ["shopify_collection_sales", snapshot([{ rows: [] }])],
    ]));

    const result = await fetchCachedAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [],
      },
      range: RANGE,
    });

    expect(result).toMatchObject({
      funnel: { state: "ready", data: { totals: { sessions: 200 } } },
      campaigns: { state: "ready", data: { rows: [] } },
      collections: { state: "ready", data: { rows: [] } },
      spend: { state: "ready", data: { daily: expect.any(Array) } },
      providerFreshness: {
        state: "ready",
        refreshedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    expect(mocks.readAdminReportingSnapshotFamilies).toHaveBeenCalledWith({
      client: expect.any(Object),
      families: [
        "shopify_funnel",
        "store_campaign_performance",
        "shopify_collection_sales",
      ],
      accountId: STORE_ID,
      authorityKey: "a".repeat(64),
      from: RANGE.from,
      to: RANGE.to,
    });
    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.createLegacyShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.fetchLiveCampaignsDetailed).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
    expect(mocks.refreshAccountsNow).not.toHaveBeenCalled();
  });

  it("degrades current provider freshness while preserving ready data after a failed refresh", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    mocks.adminReportingSnapshotIsStale.mockReturnValue(true);
    const snapshot = (rows: unknown[], lastErrorCode: string | null = null) => ({
      state: "ready",
      rows,
      message: null,
      refreshedAt: "2026-08-15T08:00:00.000Z",
      lastAttemptAt: "2026-08-15T11:30:00.000Z",
      lastErrorCode,
      revision: 2,
    });
    mocks.readAdminReportingSnapshotFamilies.mockResolvedValue(new Map([
      ["shopify_funnel", snapshot([{
        daily: [],
        totals: {
          sessions: 200,
          addedToCart: 44,
          reachedCheckout: 19,
          completedCheckout: 8,
        },
      }], "provider_failed")],
      ["store_campaign_performance", snapshot([{ rows: [] }])],
      ["shopify_collection_sales", snapshot([{ rows: [] }])],
    ]));

    const result = await fetchCachedAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [],
      },
      range: { from: "2026-08-15", to: "2026-08-15" },
    });

    expect(result.funnel).toMatchObject({
      state: "ready",
      data: { totals: { sessions: 200 } },
      message: expect.stringContaining("last refresh failed (provider_failed)"),
    });
    expect(result.providerFreshness).toEqual({
      state: "partial",
      refreshedAt: "2026-08-15T08:00:00.000Z",
      lastAttemptAt: "2026-08-15T11:30:00.000Z",
      lastErrorCode: "provider_failed",
      stale: true,
    });
    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
  });

  it("does not let one malformed provider projection erase independent families", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignProducts.mockResolvedValue([null]);
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);

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

    expect(result.campaigns).toMatchObject({ state: "failed" });
    expect(result.funnel).toMatchObject({ state: "ready" });
    expect(result.collections).toMatchObject({ state: "ready" });
    expect(result.spend).toMatchObject({ state: "ready" });
    expect(result.rollupCoverage).toMatchObject({ state: "ready" });
    expect(result.activity).toMatchObject({ state: "empty" });
  });

  it("contains a synchronous missing collection scope to that Shopify family", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCollectionSales.mockImplementation(() => {
      throw new ShopifyReportingAdapterError(
        "missing_scope",
        "read_reports is missing",
      );
    });
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);

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

    expect(result.collections).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("read-only scope"),
    });
    expect(result.funnel).toMatchObject({ state: "ready" });
    expect(result.campaigns).toMatchObject({ state: "ready" });
    expect(result.spend).toMatchObject({ state: "ready" });
    expect(result.activity).toMatchObject({ state: "empty" });
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

  it("uses one exact verified onboarding Shopify source only for pre-cutover detail families", async () => {
    const rollout = {
      operational_surface: "v2_ready_for_cutover",
      reporting_cutover_at: null,
      reporting_cutover_by: null,
      reporting_cutover_reason: null,
    };
    const scopedService = service([account()], rollout, undefined, {
      connections: [supplementalConnection()],
      credential: supplementalCredential(),
    });
    mocks.createServiceClient.mockReturnValue(scopedService);
    const adapter = shopifyAdapter();
    mocks.createShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);

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

    expect(mocks.createShopifyReportingAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        adAccountId: STORE_ID,
        kind: "shopify",
        shopify: expect.objectContaining({
          connectionId: "40000000-0000-4000-8000-000000000001",
          shopId: "gid://shopify/Shop/1",
          domain: "northwind.myshopify.com",
          currency: "EUR",
        }),
      }),
    );
    expect(mocks.createLegacyShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.fetchLiveCampaignsDetailed).toHaveBeenCalledOnce();
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
    expect(mocks.refreshAccountsNow).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      shopifyProvenance: "supplemental_v2_shopify",
      funnel: { state: "ready" },
      campaigns: { state: "ready" },
      collections: { state: "ready" },
      spend: { state: "ready" },
    });

    const manifest = mocks.adminReportingAuthority.mock.calls[0]?.[0];
    expect(manifest).toMatchObject({
      mode: "legacy",
      operationalSurface: "v2_ready_for_cutover",
      shopifyProvider: {
        provenance: "supplemental_v2_shopify",
        connectionId: "40000000-0000-4000-8000-000000000001",
        shopId: "gid://shopify/Shop/1",
        domain: "northwind.myshopify.com",
        currency: "EUR",
        verifiedAt: "2026-08-15T10:00:00.000Z",
        connectionUpdatedAt: "2026-08-15T10:00:00.000Z",
        shopifyClientId: "shopify-client-id",
        credentialUpdatedAt: "2026-08-15T10:00:00.000Z",
        credentialKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("encrypted-v2-client-secret");
  });

  it.each([
    {
      reason: "cross-client connection",
      connections: [supplementalConnection({ client_id: "10000000-0000-4000-8000-000000000099" })],
      credential: supplementalCredential(),
    },
    {
      reason: "different canonical domain",
      connections: [supplementalConnection({ shopify_domain: "other.myshopify.com" })],
      credential: supplementalCredential(),
    },
    {
      reason: "different currency",
      connections: [supplementalConnection({ shopify_currency: "GBP" })],
      credential: supplementalCredential(),
    },
    {
      reason: "invalid Shopify shop identity",
      connections: [supplementalConnection({ shopify_shop_id: "gid://shopify/Shop/not-a-number" })],
      credential: supplementalCredential(),
    },
    {
      reason: "duplicate exact connections",
      connections: [
        supplementalConnection(),
        supplementalConnection({ id: "40000000-0000-4000-8000-000000000002" }),
      ],
      credential: supplementalCredential(),
    },
    {
      reason: "unhealthy connection",
      connections: [supplementalConnection({ last_error_code: "health_check_failed" })],
      credential: supplementalCredential(),
    },
    {
      reason: "unverified connection",
      connections: [supplementalConnection({ last_verified_at: null })],
      credential: supplementalCredential(),
    },
    {
      reason: "missing required detail scope",
      connections: [supplementalConnection({ granted_scopes: ["read_reports"] })],
      credential: supplementalCredential(),
    },
    {
      reason: "credential for another connection",
      connections: [supplementalConnection()],
      credential: supplementalCredential({
        connection_id: "40000000-0000-4000-8000-000000000099",
      }),
    },
  ])("fails closed to the legacy Shopify source for a $reason", async ({ connections, credential }) => {
    mocks.createServiceClient.mockReturnValue(service(
      [account()],
      {
        operational_surface: "v2_ready_for_cutover",
        reporting_cutover_at: null,
        reporting_cutover_by: null,
        reporting_cutover_reason: null,
      },
      undefined,
      { connections, credential },
    ));
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

    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.createLegacyShopifyReportingAdapter).toHaveBeenCalledOnce();
    expect(result.shopifyProvenance).toBe("legacy");
    expect(mocks.refreshAccountsNow).not.toHaveBeenCalled();
  });

  it("never uses the supplemental source outside v2_ready_for_cutover", async () => {
    mocks.createServiceClient.mockReturnValue(service(
      [account()],
      {
        operational_surface: "v2_onboarding",
        reporting_cutover_at: null,
        reporting_cutover_by: null,
        reporting_cutover_reason: null,
      },
      undefined,
      {
        connections: [supplementalConnection()],
        credential: supplementalCredential(),
      },
    ));
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

    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.createLegacyShopifyReportingAdapter).toHaveBeenCalledOnce();
    expect(result.shopifyProvenance).toBe("legacy");
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
      state: "partial",
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

  it("uses an exact materialized spend window without refreshing during page render", async () => {
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
    const scopedService = service([account()], null, [complete]);
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

    expect(mocks.refreshAccountsNow).not.toHaveBeenCalled();
    expect(result.spend).toMatchObject({
      state: "ready",
      data: { daily: expect.arrayContaining([{ day: "2026-08-14", spend: 250 }]) },
    });
    expect(result.rollupCoverage).toMatchObject({
      state: "ready",
      data: { dayCount: 7, refreshed: false },
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

  it("keeps a 5/7 spend grid partial after manual refresh and reports exact coverage", async () => {
    const partial = ["08", "09", "10", "11", "12"].map((day, index) => ({
      ad_account_id: STORE_ID,
      day: `2026-08-${day}`,
      ad_spend: index + 1,
      attributed_revenue: index + 10,
      attributed_orders: 1,
      computed_at: "2026-08-15T10:00:00.000Z",
    }));
    mocks.createServiceClient.mockReturnValue(
      service([account()], null, [partial, partial]),
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
      state: "partial",
      data: {
        storeCount: 1,
        dayCount: 7,
        refreshed: true,
        materializedAccountDays: 5,
        expectedAccountDays: 7,
      },
      message: "5 of 7 account-days are materialised after the exact-range refresh.",
    });
    expect(mocks.refreshAccountsNow).toHaveBeenCalledOnce();
    expect(mocks.fetchLiveCampaignsDetailed).not.toHaveBeenCalled();
    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
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
