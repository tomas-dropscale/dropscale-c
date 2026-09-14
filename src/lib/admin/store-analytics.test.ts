import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The store's product costs are read on a best-effort basis; here they cannot be
// read at all, so every sheet prices its units as unknown. The engine that
// prices them is the real one - the attribution test proves a manual cost.
vi.mock("@/lib/cogs/context", () => ({
  loadCostContext: vi.fn(async () => {
    throw new Error("no cost tables in this harness");
  }),
}));
vi.mock("@/lib/cogs/engine", () => import("../cogs/engine"));
// The rate table is fixed here so a forint store can be priced in euros
// without the network: a flat 0.0025 EUR per HUF for every day.
vi.mock("@/lib/shopify/fx", async () => {
  const real = await import("../shopify/fx");
  return { ...real, fxDailyRates: vi.fn(async () => [["2026-01-01", 0.0025]] as [string, number][]) };
});

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  decryptToken: vi.fn(),
  hasGoogleAdsEnv: vi.fn(),
  hasWindsorEnv: vi.fn(),
  fetchLiveCampaignsDetailed: vi.fn(),
  fetchLiveCampaignTimeline: vi.fn(),
  fetchLiveGoogleDemandGenBreakdowns: vi.fn(),
  fetchLiveGooglePmaxProductBreakdowns: vi.fn(),
  fetchGoogleReportingCampaigns: vi.fn(),
  fetchGoogleReportingCampaignTimeline: vi.fn(),
  fetchGoogleReportingDemandGenAds: vi.fn(),
  fetchGoogleReportingPmaxProducts: vi.fn(),
  createLegacyShopifyReportingAdapter: vi.fn(),
  createShopifyReportingAdapter: vi.fn(),
  resolveReportingSources: vi.fn(),
  listCampaignActionActivity: vi.fn(),
  refreshAccountsNow: vi.fn(),
  adminReportingSnapshotIsStale: vi.fn(),
  adminReportingAuthority: vi.fn(),
  readAdminReportingSnapshotFamilySelections: vi.fn(),
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
  fetchLiveCampaignTimeline: mocks.fetchLiveCampaignTimeline,
  fetchLiveGoogleDemandGenBreakdowns: mocks.fetchLiveGoogleDemandGenBreakdowns,
  fetchLiveGooglePmaxProductBreakdowns: mocks.fetchLiveGooglePmaxProductBreakdowns,
}));
vi.mock("@/lib/reporting/google-currency", () => ({
  // Passthrough: these suites test EUR stores, where the module is a no-op.
  reportingMoneyRates: async () => null,
  convertCampaigns: (rows: unknown[]) => rows,
  convertCampaignTimeline: (points: unknown[]) => points,
  convertBreakdownAtParentRate: (rows: unknown[]) => rows,
}));
vi.mock("@/lib/reporting/google", () => ({
  fetchGoogleReportingCampaigns: mocks.fetchGoogleReportingCampaigns,
  fetchGoogleReportingCampaignTimeline: mocks.fetchGoogleReportingCampaignTimeline,
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
// Only the error classes are read from these two modules: they decide which
// failures carry Shopify's own words into a family message.
vi.mock("@/lib/client-onboarding/shopify", () => ({
  ShopifyReportingError: class ShopifyReportingError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
      this.name = "ShopifyReportingError";
    }
  },
}));
vi.mock("@/lib/shopify/client", () => ({
  ShopifyError: class ShopifyError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
      this.name = "ShopifyError";
    }
  },
}));
// The landing rule is the real one: the sheet matches orders by the revenue
// share's own path rule (decoded, since the sheet bills nothing), so the
// module is not mocked.
vi.mock("@/lib/finance/rev-share", () => import("../finance/rev-share"));
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
  readAdminReportingSnapshotFamilySelections: mocks.readAdminReportingSnapshotFamilySelections,
  refreshAdminReportingSnapshot: mocks.refreshAdminReportingSnapshot,
}));

import {
  attributeCampaignCollections,
  attributeCollectionSpend,
  campaignCollectionHandle,
  concurrencyLimiter,
  ensureAdminAnalyticsRollupCoverage,
  fetchAdminStoreAnalytics,
  fetchCachedAdminStoreAnalytics,
  refreshAdminStoreAnalyticsSnapshots,
} from "./store-analytics";
import { ShopifyReportingError } from "@/lib/client-onboarding/shopify";
import { ShopifyReportingAdapterError } from "@/lib/reporting/shopify";
import { ShopifyError } from "@/lib/shopify/client";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const STORE_ID = "20000000-0000-4000-8000-000000000001";
const CHILD_ID = "20000000-0000-4000-8000-000000000002";
const CHILD_TWO_ID = "20000000-0000-4000-8000-000000000003";
const RANGE = { from: "2026-08-08", to: "2026-08-14" };

function exactSelection(snapshot: unknown, range = RANGE) {
  return {
    snapshot,
    sourceFrom: range.from,
    sourceTo: range.to,
    availableFrom: range.from,
    availableTo: range.to,
    exact: true,
  };
}

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
    timeZone: "Europe/Lisbon",
    fetchDailySales: vi.fn().mockResolvedValue({ currency: "EUR", timeZone: "Europe/Lisbon", days: [], orders: [] }),
    fetchCollectionProductKeys: vi.fn(),
    readCollectionProductKeys: vi.fn(),
    fetchFunnelSeries: vi.fn().mockResolvedValue({
      granularity: "day",
      points: [
        {
          bucket: "2026-08-14",
          day: "2026-08-14",
          sessions: 200,
          addedToCart: 44,
          reachedCheckout: 19,
          completedCheckout: 8,
        },
      ],
    }),
    fetchCampaignAttributionSeries: vi.fn().mockResolvedValue([
      {
        campaignId: "987654321",
        attributionModel: "last_non_direct_click",
        sessions: null,
        addedToCart: 12,
        orders: 8,
        revenue: 625,
        timeline: [
          { bucket: "2026-08-14", sessions: null, addedToCart: 12, orders: 8, revenue: 625 },
        ],
      },
    ]),
    fetchCampaignProductSeries: vi.fn().mockResolvedValue([
      {
        campaignId: "987654321",
        productId: "gid://shopify/Product/10",
        title: "Lamp",
        attributionModel: "last_non_direct_click",
        units: 3,
        timeline: [{ bucket: "2026-08-14", units: 3 }],
      },
    ]),
    fetchCollectionSalesSeries: vi.fn().mockResolvedValue([
      {
        collectionId: "gid://shopify/Collection/20",
        handle: "best-sellers",
        title: "Best sellers",
        revenue: 625,
        units: 8,
        timeline: [{ bucket: "2026-08-14", revenue: 625, units: 8, orders: 7 }],
        products: [
          {
            productId: "gid://shopify/Product/10",
            title: "Lamp",
            revenue: 300,
            units: 3,
            costKeys: ["LAMP-1", "Lamp"],
            timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
          },
        ],
      },
    ]),
    fetchLandingSessionsSeries: vi.fn().mockResolvedValue([]),
  };
}

/** Two orders for the fixture collection: one landed on it, one bought one of its items elsewhere. */
function collectionOrders() {
  return {
    currency: "EUR",
    timeZone: "Europe/Lisbon",
    days: [],
    orders: [
      {
        date: "2026-08-14",
        total: 100,
        paid: true,
        landingPath: "/collections/best-sellers?utm_source=google",
        refunded: 0,
        lines: [
          { productKey: "LAMP-1", title: "Lamp", quantity: 2, unitPrice: 40 },
          { productKey: "VASE-1", title: "Vase", quantity: 1, unitPrice: 20 },
        ],
      },
      {
        date: "2026-08-14",
        total: 60,
        paid: true,
        landingPath: "/",
        refunded: 0,
        lines: [
          { productKey: "LAMP-1", title: "Lamp", quantity: 1, unitPrice: 40 },
          { productKey: "VASE-1", title: "Vase", quantity: 1, unitPrice: 20 },
        ],
      },
    ],
  };
}

/** One Google-delivered day for the fixture campaign, as the timeline reports it. */
function deliveredDay(accountId = STORE_ID, campaignId = "987654321", spend = 250) {
  return {
    accountId,
    campaignId,
    bucket: "2026-08-14",
    granularity: "day" as const,
    spend,
    impressions: 10_000,
    clicks: 400,
    conversions: 12,
    googleRevenue: 800,
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
    mocks.readAdminReportingSnapshotFamilySelections.mockResolvedValue(new Map());
    mocks.fetchLiveGoogleDemandGenBreakdowns.mockResolvedValue([]);
    mocks.fetchLiveGooglePmaxProductBreakdowns.mockResolvedValue([]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([]);
    mocks.fetchGoogleReportingDemandGenAds.mockResolvedValue([]);
    mocks.fetchGoogleReportingPmaxProducts.mockResolvedValue([]);
    mocks.fetchGoogleReportingCampaignTimeline.mockResolvedValue([]);
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
    mocks.readAdminReportingSnapshotFamilySelections.mockResolvedValue(new Map([
      ["shopify_funnel", exactSelection(snapshot([{
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
      }]))],
      ["store_campaign_performance", exactSelection(snapshot([{ rows: [] }]))],
      ["shopify_collection_sales", exactSelection(snapshot([{ rows: [] }]))],
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
    expect(mocks.readAdminReportingSnapshotFamilySelections).toHaveBeenCalledWith({
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
    const range = { from: "2026-08-15", to: "2026-08-15" };
    mocks.readAdminReportingSnapshotFamilySelections.mockResolvedValue(new Map([
      ["shopify_funnel", exactSelection(snapshot([{
        daily: [],
        totals: {
          sessions: 200,
          addedToCart: 44,
          reachedCheckout: 19,
          completedCheckout: 8,
        },
      }], "provider_failed"), range)],
      ["store_campaign_performance", exactSelection(snapshot([{ rows: [] }]), range)],
      ["shopify_collection_sales", exactSelection(snapshot([{ rows: [] }]), range)],
    ]));

    const result = await fetchCachedAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [],
      },
      range,
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
    // The campaigns family's own row carries no error: the funnel's failure
    // must not read as a campaign one on the Campaign Performance section.
    expect(result.campaignsFreshness).toEqual({
      state: "partial",
      refreshedAt: "2026-08-15T08:00:00.000Z",
      lastAttemptAt: "2026-08-15T11:30:00.000Z",
      lastErrorCode: null,
      stale: true,
    });
    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
  });

  it("reports the campaigns family's own kept-last-good failure as its freshness", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const range = { from: "2026-08-08", to: "2026-08-14" };
    const clean = (rows: unknown[]) => ({
      state: "ready",
      rows,
      message: null,
      refreshedAt: "2026-08-15T10:03:00.000Z",
      lastAttemptAt: "2026-08-15T10:03:00.000Z",
      lastErrorCode: null,
      revision: 2,
    });
    mocks.readAdminReportingSnapshotFamilySelections.mockResolvedValue(new Map([
      ["shopify_funnel", exactSelection(clean([{
        daily: [],
        totals: { sessions: 1, addedToCart: 0, reachedCheckout: 0, completedCheckout: 0 },
      }]), range)],
      ["store_campaign_performance", exactSelection({
        ...clean([{ rows: [] }]),
        message: "Last failure: Google metrics are ready; Shopify attribution is unavailable.",
        lastAttemptAt: "2026-08-15T11:01:00.000Z",
        lastErrorCode: "provider_partial",
      }, range)],
      ["shopify_collection_sales", exactSelection(clean([{ rows: [] }]), range)],
    ]));

    const result = await fetchCachedAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [],
      },
      range,
    });

    expect(result.campaigns).toMatchObject({
      state: "ready",
      message: expect.stringContaining("Last failure: Google metrics are ready"),
    });
    expect(result.campaignsFreshness).toEqual({
      state: "partial",
      refreshedAt: "2026-08-15T10:03:00.000Z",
      lastAttemptAt: "2026-08-15T11:01:00.000Z",
      lastErrorCode: "provider_partial",
      stale: false,
    });
  });

  it("names what Shopify said when the reporting connection cannot be opened", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    mocks.createLegacyShopifyReportingAdapter.mockRejectedValue(
      new ShopifyReportingError(
        "invalid_credentials",
        "Shopify rejected the Client ID or Client Secret. Confirm that the reporting app is installed on this store.",
      ),
    );
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

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

    const cause =
      "The selected Shopify reporting connection could not be verified (Shopify rejected the Client ID or Client Secret. Confirm that the reporting app is installed on this store.).";
    expect(result.campaigns).toMatchObject({
      state: "partial",
      message: expect.stringContaining(
        `UTM attribution matched to Google campaign IDs is unavailable. ${cause}`,
      ),
    });
    expect(result.funnel).toMatchObject({
      state: "failed",
      message: expect.stringContaining(cause),
    });
    expect(error).toHaveBeenCalledWith(
      "Shopify reporting connection could not be opened:",
      expect.objectContaining({ code: "invalid_credentials" }),
    );
    error.mockRestore();
  });

  it("appends the cause to a failed Shopify read but never to a missing scope", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockRejectedValue(
      new ShopifyError("Shopify is rate limiting this store. Wait a moment and try again.", 429),
    );
    adapter.fetchCampaignProductSeries.mockRejectedValue(
      new ShopifyReportingAdapterError("missing_scope", "read_reports was not granted"),
    );
    adapter.fetchLandingSessionsSeries.mockRejectedValue(
      new ShopifyReportingAdapterError("invalid_response", "x".repeat(300)),
    );
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

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

    expect(result.campaigns).toMatchObject({
      state: "partial",
      message: expect.stringContaining(
        "Shopify campaign attribution could not be loaded (Shopify is rate limiting this store. Wait a moment and try again.).",
      ),
      data: {
        rows: [
          expect.objectContaining({
            breakdown: expect.objectContaining({
              sources: expect.arrayContaining([
                {
                  provider: "shopify",
                  source: "campaign_products",
                  state: "unavailable",
                  reason: "Shopify has not granted campaign product report access.",
                },
              ]),
            }),
          }),
        ],
      },
    });
    if (!("message" in result.campaigns) || !result.campaigns.message) {
      throw new Error("Expected a campaign family message.");
    }
    // The appended cause is capped so the stored message stays well within
    // the row's limit even when several reads fail with long errors.
    expect(result.campaigns.message).not.toContain("x".repeat(201));
    expect(result.campaigns.message.length).toBeLessThanOrEqual(1_000);
    expect(error).toHaveBeenCalledWith(
      "Shopify read failed (Shopify campaign attribution could not be loaded.)",
      expect.objectContaining({ status: 429 }),
    );
    error.mockRestore();
  });

  it("runs at most two Shopify reads at a time for one store and still collects every outcome", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    let active = 0;
    let peak = 0;
    const gate = async <T,>(value: T, fail = false): Promise<T> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (fail) throw new ShopifyError("Shopify is rate limiting this store.", 429);
      return value;
    };
    adapter.fetchFunnelSeries.mockImplementation(() =>
      gate({ granularity: "day", points: [] }));
    adapter.fetchCampaignAttributionSeries.mockImplementation(() => gate([]));
    adapter.fetchCampaignProductSeries.mockImplementation(() => gate([]));
    adapter.fetchCollectionSalesSeries.mockImplementation(() => gate([]));
    adapter.fetchLandingSessionsSeries.mockImplementation(() => gate([], true));
    adapter.fetchDailySales.mockImplementation(() =>
      gate({ currency: "EUR", timeZone: "Europe/Lisbon", days: [], orders: [] }));
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

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

    expect(peak).toBe(2);
    for (const read of [
      adapter.fetchFunnelSeries,
      adapter.fetchCampaignAttributionSeries,
      adapter.fetchCampaignProductSeries,
      adapter.fetchCollectionSalesSeries,
      adapter.fetchLandingSessionsSeries,
      adapter.fetchDailySales,
    ]) {
      expect(read).toHaveBeenCalledTimes(1);
    }
    expect(result.funnel).toMatchObject({ state: "empty" });
    expect(result.collections).toMatchObject({ state: "empty" });
    // The one rejected read (landing sessions) feeds only the collection
    // basis, and no campaign here lands on a collection, so the family is
    // still ready: there was no collection column to lose.
    expect(result.campaigns).toMatchObject({ state: "ready" });
    vi.mocked(console.error).mockRestore();
  });

  it("flags a partial family as degraded when the snapshot refresh loads it", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockRejectedValue(
      new ShopifyError("Shopify is rate limiting this store.", 429),
    );
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([googleCampaign()]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loaded = new Map<string, unknown>();
    mocks.refreshAdminReportingSnapshot.mockImplementation(
      async (input: { family: string; load: () => Promise<{ state: string }> }) => {
        const result = await input.load();
        loaded.set(input.family, result);
        return { state: "refreshed", snapshotState: result.state, refreshedAt: "now" };
      },
    );

    const summary = await refreshAdminStoreAnalyticsSnapshots({
      clientId: CLIENT_ID,
      store: {
        accountId: STORE_ID,
        activityAccountIds: [STORE_ID],
        currency: "EUR",
        days: [],
      },
      range: RANGE,
    });

    expect(summary).toMatchObject({ refreshed: 3, partial: 1, failed: 0 });
    expect(loaded.get("store_campaign_performance")).toMatchObject({
      state: "partial",
      degraded: { code: "provider_partial" },
      message: expect.stringContaining("Shopify campaign attribution could not be loaded"),
    });
    expect(loaded.get("shopify_funnel")).toMatchObject({ state: "ready" });
    expect(loaded.get("shopify_funnel")).not.toHaveProperty("degraded");
    expect(loaded.get("shopify_collection_sales")).not.toHaveProperty("degraded");
    vi.mocked(console.error).mockRestore();
  });

  it("does not let one malformed provider projection erase independent families", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignProductSeries.mockResolvedValue([null]);
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
    adapter.fetchCollectionSalesSeries.mockImplementation(() => {
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

  it("attributes the landing collection's sales to a campaign Shopify never matched", async () => {
    // The ads carry no utm_campaign, so Shopify's own campaign attribution is
    // empty - but the campaign lands on /collections/best-sellers, and that
    // page's real sales, cart additions and orders can stand for it.
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    adapter.fetchDailySales.mockResolvedValue(collectionOrders());
    adapter.fetchLandingSessionsSeries.mockResolvedValue([
      { bucket: "2026-08-14", landingPath: "/collections/best-sellers", platform: "alphabet", sessions: 100, addedToCart: 9, completedCheckout: 2 },
      { bucket: "2026-08-14", landingPath: "/collections/best-sellers/products/lamp", platform: "google", sessions: 10, addedToCart: 1, completedCheckout: 1 },
      // Not Google, and not this page: neither counts.
      { bucket: "2026-08-14", landingPath: "/collections/best-sellers", platform: "meta", sessions: 50, addedToCart: 5, completedCheckout: 5 },
      { bucket: "2026-08-14", landingPath: "/collections/other", platform: "alphabet", sessions: 50, addedToCart: 5, completedCheckout: 5 },
    ]);
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers?utm_source=google"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([deliveredDay()]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    expect(result.campaigns).toMatchObject({
      data: {
        rows: [
          {
            campaignId: "987654321",
            attributionState: "unmatched",
            shopifyRevenue: null,
            collectionHandle: "best-sellers",
            collectionSharedWith: 1,
            timeline: [
              expect.objectContaining({
                bucket: "2026-08-14",
                shopifyRevenue: null,
                addedToCart: null,
                // The order that landed on the page counts whole (100, 3 units);
                // the one that landed elsewhere counts its Lamp line only (40, 1).
                collectionRevenue: 140,
                collectionUnits: 4,
                collectionOrders: 2,
                // Google visits that landed on the page, product pages within it included.
                collectionAddedToCart: 10,
                // The service fake has no cost tables, so costs could not be read.
                cogs: null,
              }),
            ],
          },
        ],
      },
    });
  });

  it("keeps an hourly timeline hourly, and an unknown cost unknown on every hour", async () => {
    // A single-day range reports by hour. The day's collection figures ride on
    // the first hour once; no day-shaped bucket is invented among the hours;
    // and when costs could not be read, no hour prints a measured 0 for them.
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    adapter.fetchDailySales.mockResolvedValue(collectionOrders());
    adapter.fetchLandingSessionsSeries.mockResolvedValue([
      { bucket: "2026-08-14", landingPath: "/collections/best-sellers", platform: "google", sessions: 40, addedToCart: 4, completedCheckout: 1 },
    ]);
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([
      { ...deliveredDay(), bucket: "2026-08-14T00:00:00", granularity: "hour" as const, spend: 100 },
      { ...deliveredDay(), bucket: "2026-08-14T13:00:00", granularity: "hour" as const, spend: 150 },
    ]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: { from: "2026-08-14", to: "2026-08-14" },
    });

    const timeline = (result.campaigns as { data: { rows: Array<{ timeline: Array<Record<string, unknown>> }> } }).data.rows[0]!.timeline;
    expect(timeline.map((point) => point.bucket)).toEqual(["2026-08-14T00:00:00", "2026-08-14T13:00:00"]);
    expect(timeline[0]).toMatchObject({ collectionRevenue: 140, collectionOrders: 2, collectionAddedToCart: 4, cogs: null });
    expect(timeline[1]).toMatchObject({ collectionRevenue: 0, collectionOrders: 0, collectionAddedToCart: 0, cogs: null });
  });

  it("shares a collection between the campaigns landing on it, by spend, and prices the units", async () => {
    const costs = {
      manualCosts: new Map([["LAMP-1", [{ cost: 20, effectiveFrom: "2026-01-01" }]]]),
      tiers: new Map(),
      collections: [],
      defaultCostPct: 30,
    };
    const rows = [
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] },
      { ...googleCampaign(), providerCampaignId: "111", finalUrls: ["https://northwind.example/collections/best-sellers/"] },
      // Lands on no single collection: left out.
      { ...googleCampaign(), providerCampaignId: "222", finalUrls: ["https://northwind.example/"] },
    ];
    const attribution = await attributeCampaignCollections({
      orders: { ok: true, value: collectionOrders() },
      collectionProductKeys: async () => null,
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: rows as never,
          granularity: "day",
          timeline: [deliveredDay(STORE_ID, "987654321", 150), deliveredDay(STORE_ID, "111", 50)],
        },
      },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/20",
            handle: "best-sellers",
            title: "Best sellers",
            revenue: 300,
            units: 3,
            timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
            products: [
              {
                productId: "gid://shopify/Product/10",
                title: "Lamp",
                revenue: 300,
                units: 3,
                costKeys: ["LAMP-1", "Lamp"],
                timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
              },
            ],
          },
        ],
      },
      landing: {
        ok: true,
        value: [
          { bucket: "2026-08-14", landingPath: "/collections/best-sellers", platform: "google", sessions: 40, addedToCart: 8, completedCheckout: 4 },
        ],
      },
      costs,
    });

    expect(attribution.has(`${STORE_ID}:222`)).toBe(false);
    const first = attribution.get(`${STORE_ID}:987654321`)!;
    const second = attribution.get(`${STORE_ID}:111`)!;
    expect(first.sharedWith).toBe(2);
    expect(first.costsKnown).toBe(true);
    // The collection earned 140 on 4 units over 2 orders. COGS per order: the
    // landed order prices Lamp x2 at the manual 20 and Vase x1 at 30% of 20
    // (46); the other order's Lamp line alone is 20. 150 of 200 spent gives
    // the first campaign three quarters of everything.
    expect(first.byDay.get("2026-08-14")).toEqual({
      revenue: 105,
      units: 3,
      orders: 1.5,
      addedToCart: 6,
      cogs: 49.5,
    });
    expect(second.byDay.get("2026-08-14")).toEqual({
      revenue: 35,
      units: 1,
      orders: 0.5,
      addedToCart: 2,
      cogs: 16.5,
    });
  });

  it("marks orders and cart additions unknown, not zero, when the landing sessions could not be read", async () => {
    const attribution = await attributeCampaignCollections({
      orders: { ok: true, value: collectionOrders() },
      collectionProductKeys: async () => null,
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/20",
            handle: "best-sellers",
            title: "Best sellers",
            revenue: 300,
            units: 3,
            timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
            products: [
              {
                productId: "gid://shopify/Product/10",
                title: "Lamp",
                revenue: 300,
                units: 3,
                costKeys: ["LAMP-1", "Lamp"],
                timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
              },
            ],
          },
        ],
      },
      landing: { ok: false, state: "failed", message: "Shopify landing page sessions could not be loaded." },
      costs: null,
    });

    expect(attribution.get(`${STORE_ID}:987654321`)!.byDay.get("2026-08-14")).toEqual({
      revenue: 140,
      units: 4,
      orders: 2,
      addedToCart: null,
      cogs: null,
    });
  });

  it("prices a forint store's costs in euros exactly once", async () => {
    // A HUF store reporting in EUR: the manual cost is stored in euros already
    // (11 EUR a lamp), so a landed order of two lamps at 20,000 HUF must read
    // revenue 100 EUR and COGS 22 EUR - not 22 rated down to 0.055.
    const attribution = await attributeCampaignCollections({
      orders: {
        ok: true,
        value: {
          currency: "HUF",
          orders: [
            {
              date: "2026-08-14",
              total: 40_000,
              paid: true,
              landingPath: "/collections/best-sellers",
              refunded: 0,
              lines: [{ productKey: "LAMP-1", title: "Lamp", quantity: 2, unitPrice: 20_000 }],
            },
          ],
        },
      },
      collectionProductKeys: async () => null,
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/20",
            handle: "best-sellers",
            title: "Best sellers",
            revenue: 100,
            units: 2,
            timeline: [{ bucket: "2026-08-14", revenue: 100, units: 2, orders: 1 }],
            products: [
              {
                productId: "gid://shopify/Product/10",
                title: "Lamp",
                revenue: 100,
                units: 2,
                costKeys: ["LAMP-1", "Lamp"],
                timeline: [{ bucket: "2026-08-14", revenue: 100, units: 2, orders: 1 }],
              },
            ],
          },
        ],
      },
      landing: { ok: true, value: [] },
      costs: {
        manualCosts: new Map([["LAMP-1", [{ cost: 11, effectiveFrom: "2026-01-01" }]]]),
        tiers: new Map(),
        collections: [],
        defaultCostPct: 30,
      },
    });

    const day = attribution.get(`${STORE_ID}:987654321`)!.byDay.get("2026-08-14")!;
    expect(day.revenue).toBeCloseTo(100, 6);
    expect(day.cogs).toBeCloseTo(22, 6);
  });

  it("counts a landed order net of its refunds", async () => {
    const orders = collectionOrders();
    orders.orders[0]!.refunded = 30;
    const attribution = await attributeCampaignCollections({
      orders: { ok: true, value: orders },
      collectionProductKeys: async () => null,
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/20",
            handle: "best-sellers",
            title: "Best sellers",
            revenue: 300,
            units: 3,
            timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
            products: [
              {
                productId: "gid://shopify/Product/10",
                title: "Lamp",
                revenue: 300,
                units: 3,
                costKeys: ["LAMP-1", "Lamp"],
                timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
              },
            ],
          },
        ],
      },
      landing: { ok: true, value: [] },
      costs: null,
    });

    // 100 landed minus 30 refunded, plus the other order's Lamp line at 40.
    expect(attribution.get(`${STORE_ID}:987654321`)!.byDay.get("2026-08-14")).toMatchObject({
      revenue: 110,
      units: 4,
      orders: 2,
    });
  });

  it("marks the collection's sales unknown, not zero, when the orders could not be read", async () => {
    const attribution = await attributeCampaignCollections({
      orders: { ok: false, state: "failed", message: "Shopify orders could not be loaded." },
      collectionProductKeys: async () => null,
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/20",
            handle: "best-sellers",
            title: "Best sellers",
            revenue: 300,
            units: 3,
            timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
            products: [],
          },
        ],
      },
      landing: {
        ok: true,
        value: [
          { bucket: "2026-08-14", landingPath: "/collections/best-sellers", platform: "google", sessions: 40, addedToCart: 8, completedCheckout: 4 },
        ],
      },
      costs: null,
    });

    expect(attribution.get(`${STORE_ID}:987654321`)!.byDay.get("2026-08-14")).toEqual({
      revenue: null,
      units: null,
      orders: null,
      addedToCart: 8,
      cogs: null,
    });
  });

  it("gives a campaign on a collection that sold nothing in the window a sheet of real zeros", async () => {
    // Early in the day, or on a quiet week, the sales report leaves the
    // collection out: it only lists what sold. The store still has the page,
    // so the campaign keeps its handle and its zeros are measured ones.
    const collectionProductKeys = vi.fn(async (handle: string) =>
      handle === "best-sellers" ? new Set(["LAMP-1", "Lamp"]) : null);
    const attribution = await attributeCampaignCollections({
      collectionProductKeys,
      orders: { ok: true, value: { currency: "EUR", orders: [] } },
      targetCurrency: "EUR",
      range: { from: "2026-08-14", to: "2026-08-14" },
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] }] as never,
          granularity: "hour",
          timeline: [{ ...deliveredDay(), bucket: "2026-08-14T09:00:00", granularity: "hour" as const, spend: 4 }],
        },
      },
      collectionSales: { ok: true, value: [] },
      landing: { ok: true, value: [] },
      costs: { manualCosts: new Map(), tiers: new Map(), collections: [], defaultCostPct: 30 },
    });

    expect(collectionProductKeys).toHaveBeenCalledTimes(1);
    expect(collectionProductKeys).toHaveBeenCalledWith("best-sellers");
    const entry = attribution.get(`${STORE_ID}:987654321`)!;
    expect(entry).toMatchObject({ handle: "best-sellers", sharedWith: 1, costsKnown: true, salesKnown: true, landingKnown: true });
    expect(entry.byDay.get("2026-08-14")).toEqual({ revenue: 0, units: 0, orders: 0, addedToCart: 0, cogs: 0 });
  });

  it("reads a looked-up collection's products for the lines rule, and keeps the handle with no days at all", async () => {
    const attribution = await attributeCampaignCollections({
      // The store has both pages; only one of them carries the Lamp.
      collectionProductKeys: async (handle) => new Set(handle === "best-sellers" ? ["LAMP-1"] : []),
      orders: { ok: true, value: collectionOrders() },
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [
            { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] },
            // Landed nowhere, sold nothing, spent nothing: still names its page.
            { ...googleCampaign(), providerCampaignId: "111", finalUrls: ["https://northwind.example/collections/quiet"] },
          ] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: { ok: true, value: [] },
      landing: { ok: true, value: [] },
      costs: null,
    });

    // The landed order counts whole (100, 3 units); the other counts its
    // Lamp line only (40, 1), known from the lookup, not the sales report.
    expect(attribution.get(`${STORE_ID}:987654321`)!.byDay.get("2026-08-14")).toEqual({
      revenue: 140,
      units: 4,
      orders: 2,
      addedToCart: 0,
      cogs: null,
    });
    const quiet = attribution.get(`${STORE_ID}:111`)!;
    expect(quiet).toMatchObject({ handle: "quiet", sharedWith: 1, salesKnown: true, landingKnown: true, costsKnown: false });
    expect(quiet.byDay.size).toBe(0);
  });

  it("keeps skipping a campaign whose collection the store does not have", async () => {
    const attribution = await attributeCampaignCollections({
      collectionProductKeys: async () => null,
      orders: { ok: true, value: collectionOrders() },
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: ["https://northwind.example/collections/renamed"] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: { ok: true, value: [] },
      landing: { ok: true, value: [] },
      costs: null,
    });

    expect(attribution.size).toBe(0);
  });

  it("asks the store once per collection the sales left out, two at a time, and survives a failed read", async () => {
    let inFlight = 0;
    let peak = 0;
    const collectionProductKeys = vi.fn(async (handle: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (handle === "broken") throw new Error("Shopify timed out");
      return handle === "gone" ? null : new Set([handle]);
    });
    const rows = ["a", "b", "best-sellers", "gone", "a", "broken"].map((handle, index) => ({
      ...googleCampaign(),
      providerCampaignId: String(index),
      finalUrls: [`https://northwind.example/collections/${handle}`],
    }));
    const attribution = await attributeCampaignCollections({
      collectionProductKeys,
      orders: { ok: true, value: { currency: "EUR", orders: [] } },
      targetCurrency: "EUR",
      range: RANGE,
      google: { ok: true, value: { rows: rows as never, granularity: "day", timeline: [] } },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/20",
            handle: "best-sellers",
            title: "Best sellers",
            revenue: 300,
            units: 3,
            timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
            products: [],
          },
        ],
      },
      landing: { ok: true, value: [] },
      costs: null,
    });

    // Sold collections are not asked about; the same handle is asked once.
    expect(collectionProductKeys.mock.calls.map(([handle]) => handle).sort()).toEqual(["a", "b", "broken", "gone"]);
    expect(peak).toBe(2);
    expect(attribution.get(`${STORE_ID}:0`)).toMatchObject({ handle: "a", sharedWith: 2 });
    expect(attribution.get(`${STORE_ID}:4`)).toMatchObject({ handle: "a", sharedWith: 2 });
    expect(attribution.get(`${STORE_ID}:1`)).toMatchObject({ handle: "b", sharedWith: 1 });
    expect(attribution.get(`${STORE_ID}:2`)).toMatchObject({ handle: "best-sellers", sharedWith: 1 });
    expect(attribution.has(`${STORE_ID}:3`)).toBe(false);
    expect(attribution.has(`${STORE_ID}:5`)).toBe(false);
  });

  it("marks a quiet collection's days unknown, not zero, when the orders or landing sessions could not be read", async () => {
    const attribution = await attributeCampaignCollections({
      collectionProductKeys: async () => new Set(["LAMP-1"]),
      orders: { ok: false, state: "failed", message: "Shopify orders could not be loaded." },
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: { ok: true, value: [] },
      landing: { ok: false, state: "failed", message: "Shopify landing page sessions could not be loaded." },
      costs: null,
    });

    const entry = attribution.get(`${STORE_ID}:987654321`)!;
    expect(entry).toMatchObject({ handle: "best-sellers", salesKnown: false, landingKnown: false });
    expect(entry.byDay.get("2026-08-14")).toEqual({ revenue: null, units: null, orders: null, addedToCart: null, cogs: null });
  });

  it("gives the live campaign row its handle and zeros when the store confirms a quiet collection", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    // Nothing of the collection sold in the window, so the report has no row
    // for it; the store answers the lookup with the collection's products.
    adapter.fetchCollectionSalesSeries.mockResolvedValue([]);
    adapter.readCollectionProductKeys.mockResolvedValue(new Set(["LAMP-1", "Lamp"]));
    adapter.fetchDailySales.mockResolvedValue({ currency: "EUR", timeZone: "Europe/Lisbon", days: [], orders: [] });
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([deliveredDay()]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    expect(adapter.readCollectionProductKeys).toHaveBeenCalledWith("best-sellers");
    expect(result.campaigns).toMatchObject({
      data: {
        rows: [
          {
            campaignId: "987654321",
            attributionState: "unmatched",
            collectionHandle: "best-sellers",
            collectionSharedWith: 1,
            timeline: [
              expect.objectContaining({
                bucket: "2026-08-14",
                collectionRevenue: 0,
                collectionUnits: 0,
                collectionOrders: 0,
                collectionAddedToCart: 0,
                // Costs could not be read in this harness: unknown, not 0.
                cogs: null,
              }),
            ],
          },
        ],
      },
    });
  });

  it("reads the store's null as a collection it does not have", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    adapter.fetchCollectionSalesSeries.mockResolvedValue([]);
    adapter.readCollectionProductKeys.mockResolvedValue(null);
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/renamed"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([deliveredDay()]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    // A renamed collection is the store's own answer, not a failure: the
    // campaign keeps its skip and the family stays ready.
    expect(result.campaigns).toMatchObject({
      state: "ready",
      data: {
        rows: [
          {
            campaignId: "987654321",
            collectionHandle: null,
            collectionSharedWith: null,
            timeline: [expect.objectContaining({ bucket: "2026-08-14", collectionRevenue: null, cogs: null })],
          },
        ],
      },
    });
  });

  it("reads an empty product list as a collection the store has, with nothing to sell", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    adapter.fetchCollectionSalesSeries.mockResolvedValue([]);
    adapter.readCollectionProductKeys.mockResolvedValue(new Set());
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/empty"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([deliveredDay()]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    expect(result.campaigns).toMatchObject({
      state: "ready",
      data: {
        rows: [
          {
            campaignId: "987654321",
            collectionHandle: "empty",
            collectionSharedWith: 1,
            timeline: [expect.objectContaining({ bucket: "2026-08-14", collectionRevenue: 0, collectionOrders: 0 })],
          },
        ],
      },
    });
  });

  it("keeps a campaign's skip when its collection lookup fails, and marks the family partial so the last good sheet is kept", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    adapter.fetchCollectionSalesSeries.mockResolvedValue([]);
    adapter.readCollectionProductKeys.mockRejectedValue(
      new ShopifyError("Shopify is rate limiting this store.", 429),
    );
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/renamed"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([deliveredDay()]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    // A failed read is not a collection the store lacks. It is logged, the
    // campaign keeps its skip for this refresh, and the family is partial so
    // the snapshot refresh keeps the last good sheet and records the failure
    // instead of publishing one that says the store has no such collection.
    expect(error).toHaveBeenCalledWith(
      'Admin store analytics could not read the products of collection "renamed":',
      expect.objectContaining({ status: 429 }),
    );
    expect(result.campaigns).toMatchObject({
      state: "partial",
      message: expect.stringContaining(
        "The products of one collection could not be read from Shopify (renamed)",
      ),
      data: {
        rows: [{ campaignId: "987654321", collectionHandle: null, collectionSharedWith: null }],
      },
    });
    error.mockRestore();
  });

  it("marks the campaigns family partial when a read behind a campaign's collection basis fails", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    adapter.fetchLandingSessionsSeries.mockRejectedValue(
      new ShopifyError("Shopify is rate limiting this store.", 429),
    );
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([deliveredDay()]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    // The sheet keeps its basis with the landing column unknown, and the
    // family says why, so the snapshot refresh keeps the last good sheet.
    expect(result.campaigns).toMatchObject({
      state: "partial",
      message: expect.stringContaining(
        "Shopify landing page sessions could not be loaded (Shopify is rate limiting this store.).",
      ),
      data: {
        rows: [
          {
            campaignId: "987654321",
            collectionHandle: "best-sellers",
            timeline: [
              expect.objectContaining({ bucket: "2026-08-14", collectionRevenue: 0, collectionAddedToCart: null }),
            ],
          },
        ],
      },
    });
    vi.mocked(console.error).mockRestore();
  });

  it("stays ready when a missing scope, not a failure, withholds a basis read", async () => {
    mocks.createServiceClient.mockReturnValue(service([account()], null));
    const adapter = shopifyAdapter();
    adapter.fetchCampaignAttributionSeries.mockResolvedValue([]);
    adapter.fetchCampaignProductSeries.mockResolvedValue([]);
    adapter.fetchLandingSessionsSeries.mockRejectedValue(
      new ShopifyReportingAdapterError("missing_scope", "Shopify has not granted report access."),
    );
    mocks.createLegacyShopifyReportingAdapter.mockResolvedValue(adapter);
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      { ...googleCampaign(), finalUrls: ["https://northwind.example/collections/best-sellers"] },
    ]);
    mocks.fetchLiveCampaignTimeline.mockResolvedValue([deliveredDay()]);

    const result = await fetchAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    // Withheld on every refresh alike: there is no better sheet to keep.
    expect(result.campaigns).toMatchObject({
      state: "ready",
      message: null,
      data: {
        rows: [
          {
            collectionHandle: "best-sellers",
            timeline: [expect.objectContaining({ bucket: "2026-08-14", collectionAddedToCart: null })],
          },
        ],
      },
    });
  });

  it("reads the landing collection from the final URLs first, and from the name only when the URLs name none", async () => {
    const deal = "Deal https://northwind.example/collections/deal 5%";
    expect(campaignCollectionHandle({ name: deal, finalUrls: ["https://northwind.example/collections/best-sellers"] })).toBe("best-sellers");
    expect(campaignCollectionHandle({ name: deal, finalUrls: [] })).toBe("deal");
    expect(campaignCollectionHandle({ name: deal })).toBe("deal");
    expect(campaignCollectionHandle({ name: deal, finalUrls: ["https://northwind.example/"] })).toBe("deal");
    expect(campaignCollectionHandle({ name: "Plain", finalUrls: ["https://northwind.example/"] })).toBeNull();
    // Two collections in the URLs land nowhere in particular, whatever the name says.
    expect(campaignCollectionHandle({
      name: deal,
      finalUrls: ["https://northwind.example/collections/a", "https://northwind.example/collections/b"],
    })).toBeNull();
    // The same page spelled twice is one collection.
    expect(campaignCollectionHandle({
      name: "x",
      finalUrls: ["https://northwind.example/collections/a/", "https://northwind.example/Collections/A?page=2"],
    })).toBe("a");

    // Through the attribution: the rev-share name next to the ads' own URL
    // used to make two handles and drop the campaign; now the URL wins.
    const attribution = await attributeCampaignCollections({
      collectionProductKeys: async () => null,
      orders: { ok: true, value: collectionOrders() },
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), name: deal, finalUrls: ["https://northwind.example/collections/best-sellers"] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/20",
            handle: "best-sellers",
            title: "Best sellers",
            revenue: 300,
            units: 3,
            timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
            products: [
              {
                productId: "gid://shopify/Product/10",
                title: "Lamp",
                revenue: 300,
                units: 3,
                costKeys: ["LAMP-1", "Lamp"],
                timeline: [{ bucket: "2026-08-14", revenue: 300, units: 3, orders: 3 }],
              },
            ],
          },
        ],
      },
      landing: { ok: true, value: [] },
      costs: null,
    });
    expect(attribution.get(`${STORE_ID}:987654321`)).toMatchObject({ handle: "best-sellers" });
    expect(attribution.get(`${STORE_ID}:987654321`)!.byDay.get("2026-08-14")).toMatchObject({ revenue: 140, units: 4, orders: 2 });
  });

  it("matches a percent-encoded landing path to a non-ASCII collection handle", async () => {
    // A Japanese store: Shopify's handle is plain, its ShopifyQL landing path
    // and the order's landing page arrive percent-encoded, and the campaign
    // URL can be either. All four must be the same page.
    const handle = "ハンド";
    const encoded = "%E3%83%8F%E3%83%B3%E3%83%89";
    const attribution = await attributeCampaignCollections({
      collectionProductKeys: async () => null,
      orders: {
        ok: true,
        value: {
          currency: "EUR",
          orders: [
            {
              date: "2026-08-14",
              total: 100,
              paid: true,
              landingPath: `/collections/${encoded}?utm_source=google`,
              refunded: 0,
              lines: [{ productKey: "OTHER-1", title: "Other", quantity: 1, unitPrice: 100 }],
            },
            {
              date: "2026-08-14",
              total: 30,
              paid: true,
              landingPath: "/",
              refunded: 0,
              lines: [{ productKey: "BAG-1", title: "Bag", quantity: 1, unitPrice: 30 }],
            },
          ],
        },
      },
      targetCurrency: "EUR",
      range: RANGE,
      google: {
        ok: true,
        value: {
          rows: [{ ...googleCampaign(), finalUrls: [`https://northwind.example/collections/${encoded}`] }] as never,
          granularity: "day",
          timeline: [deliveredDay()],
        },
      },
      collectionSales: {
        ok: true,
        value: [
          {
            collectionId: "gid://shopify/Collection/21",
            handle,
            title: "Hand",
            revenue: 30,
            units: 1,
            timeline: [{ bucket: "2026-08-14", revenue: 30, units: 1, orders: 1 }],
            products: [
              {
                productId: "gid://shopify/Product/11",
                title: "Bag",
                revenue: 30,
                units: 1,
                costKeys: ["BAG-1", "Bag"],
                timeline: [{ bucket: "2026-08-14", revenue: 30, units: 1, orders: 1 }],
              },
            ],
          },
        ],
      },
      landing: {
        ok: true,
        value: [
          { bucket: "2026-08-14", landingPath: `/collections/${encoded}`, platform: "google", sessions: 10, addedToCart: 3, completedCheckout: 1 },
          { bucket: "2026-08-14", landingPath: `/collections/${encoded}/products/bag`, platform: "alphabet", sessions: 4, addedToCart: 2, completedCheckout: 0 },
          { bucket: "2026-08-14", landingPath: "/collections/other", platform: "google", sessions: 4, addedToCart: 2, completedCheckout: 0 },
        ],
      },
      costs: null,
    });

    const entry = attribution.get(`${STORE_ID}:987654321`)!;
    expect(entry.handle).toBe(handle);
    // The landed order counts whole (100, 1 unit); the other counts its Bag
    // line (30, 1); the cart additions are the two Google rows on the page.
    expect(entry.byDay.get("2026-08-14")).toEqual({ revenue: 130, units: 2, orders: 2, addedToCart: 5, cogs: null });
  });

  it("keeps an unmatched campaign unmatched when a wider snapshot is sliced to the period", async () => {
    // The fallback slice used to call every campaign without Shopify revenue
    // "unavailable", as if the provider had failed. An unmatched campaign
    // never had a revenue to lose; only a match that lost its sliced days is
    // unavailable.
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
    const point = (bucket: string, shopifyRevenue: number | null) => ({
      bucket,
      spend: 10,
      impressions: 100,
      clicks: 10,
      conversions: 0,
      shopifyRevenue,
      shopifySessions: null,
      addedToCart: null,
      shopifyOrders: shopifyRevenue === null ? null : 0,
      units: null,
      googleRevenue: 0,
      realRoas: null,
      googleRoas: null,
    });
    const row = (campaignId: string, attributionState: string, shopifyRevenue: number | null) => ({
      accountId: STORE_ID,
      campaignId,
      name: `Campaign ${campaignId}`,
      status: "active",
      type: "PERFORMANCE_MAX",
      shoppingFeed: false,
      budget: 10,
      spend: 20,
      impressions: 200,
      clicks: 20,
      conversions: 0,
      googleRevenue: 0,
      shopifySessions: null,
      shopifyOrders: null,
      shopifyRevenue,
      ctr: 0.1,
      cpc: 1,
      cpm: 100,
      cpa: null,
      googleRoas: null,
      realRoas: null,
      attributionState,
      timeline: [point("2026-08-01", shopifyRevenue), point("2026-08-14", shopifyRevenue)],
      breakdown: { state: "empty", rows: [], sources: [], reason: null },
    });
    const sliced = {
      snapshot: snapshot([{
        granularity: "day",
        rows: [row("1", "unmatched", null), row("2", "matched", null), row("3", "unavailable", null), row("4", "matched", 50)],
      }]),
      sourceFrom: "2026-08-01",
      sourceTo: "2026-08-14",
      availableFrom: RANGE.from,
      availableTo: RANGE.to,
      exact: false,
    };
    mocks.readAdminReportingSnapshotFamilySelections.mockResolvedValue(new Map([
      ["shopify_funnel", exactSelection(snapshot([{
        daily: [],
        totals: { sessions: 0, addedToCart: 0, reachedCheckout: 0, completedCheckout: 0 },
      }]))],
      ["store_campaign_performance", sliced],
      ["shopify_collection_sales", exactSelection(snapshot([{ rows: [] }]))],
    ]));

    const result = await fetchCachedAdminStoreAnalytics({
      clientId: CLIENT_ID,
      store: { accountId: STORE_ID, activityAccountIds: [STORE_ID], currency: "EUR", days: [] },
      range: RANGE,
    });

    expect(result.campaigns).toMatchObject({ state: "partial" });
    const rows = (result.campaigns as { data: { rows: Array<{ campaignId: string; attributionState: string; timeline: unknown[] }> } }).data.rows;
    expect(rows.map((campaign) => [campaign.campaignId, campaign.attributionState])).toEqual([
      ["1", "unmatched"],
      ["2", "unavailable"],
      ["3", "unavailable"],
      ["4", "matched"],
    ]);
    // Only the days inside the period survive the slice.
    expect(rows[0]!.timeline).toHaveLength(1);
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
    expect(mocks.fetchLiveCampaignTimeline).toHaveBeenCalledWith(
      "1234567890",
      "google-refresh-token",
      STORE_ID,
      RANGE,
      "EUR",
    );
    expect(adapter.fetchFunnelSeries).toHaveBeenCalledWith(RANGE.from, RANGE.to);
    expect(adapter.fetchCampaignAttributionSeries).toHaveBeenCalledWith(
      RANGE.from,
      RANGE.to,
      "EUR",
    );
    expect(adapter.fetchCampaignProductSeries).toHaveBeenCalledWith(RANGE.from, RANGE.to);
    expect(adapter.fetchCollectionSalesSeries).toHaveBeenCalledWith(
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
            addedToCart: 12,
            shopifyUnits: 3,
            shopifyRevenue: 625,
            realRoas: 2.5,
            attributionState: "matched",
            // The daily sheet reads these per bucket: Shopify's own cart
            // additions and orders next to Google's delivery, and the net
            // units summed across the campaign's products.
            timeline: expect.arrayContaining([
              expect.objectContaining({
                bucket: "2026-08-14",
                addedToCart: 12,
                shopifyOrders: 8,
                units: 3,
                shopifyRevenue: 625,
              }),
            ]),
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
      message: expect.stringContaining("non-additive"),
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
    adapter.fetchFunnelSeries.mockResolvedValue({
      granularity: "day",
      points: [
        {
          bucket: "2026-08-08",
          day: "2026-08-08",
          sessions: 0,
          addedToCart: 0,
          reachedCheckout: 0,
          completedCheckout: 0,
        },
        {
          bucket: "2026-08-14",
          day: "2026-08-14",
          sessions: 0,
          addedToCart: 0,
          reachedCheckout: 0,
          completedCheckout: 0,
        },
      ],
    });
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
    // A delivered day for each account, so the sheet has points to read: the
    // Shopify columns on those points must be withheld too.
    const deliveredDay = (accountId: string) => ({
      accountId,
      campaignId: "987654321",
      bucket: "2026-08-14",
      granularity: "day" as const,
      spend: 120,
      impressions: 1_000,
      clicks: 40,
      conversions: 1,
      googleRevenue: 0,
    });
    mocks.fetchGoogleReportingCampaignTimeline
      .mockResolvedValueOnce([deliveredDay(CHILD_ID)])
      .mockResolvedValueOnce([deliveredDay(CHILD_TWO_ID)]);

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
    // Withheld is withheld all the way down: the day-by-day sheet reads these
    // points, and a zero there would present Shopify data that was never
    // attributed as a measured nothing.
    const withheld = (result.campaigns as { data: { rows: Array<{ timeline: Array<Record<string, unknown>> }> } }).data.rows;
    expect(withheld.length).toBe(2);
    for (const row of withheld) {
      expect(row.timeline.length).toBeGreaterThan(0);
      for (const point of row.timeline) {
        expect(point).toMatchObject({
          shopifyRevenue: null,
          shopifySessions: null,
          addedToCart: null,
          shopifyOrders: null,
          units: null,
        });
      }
    }
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
      data: {
        daily: expect.arrayContaining([
          { day: "2026-08-14", bucket: "2026-08-14", spend: 250 },
        ]),
      },
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

describe("concurrencyLimiter", () => {
  it("keeps at most the limit in flight, in call order, and reports every outcome", async () => {
    const limit = concurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const task = (index: number, fail = false) => () => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(index);
      return new Promise<number>((resolve, reject) => {
        releases.push(() => {
          active -= 1;
          if (fail) reject(new Error(`task ${index} failed`));
          else resolve(index);
        });
      });
    };

    const settled = Promise.allSettled([
      limit(task(0)),
      limit(task(1, true)),
      limit(task(2)),
      limit(task(3)),
    ]);
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    releases[1]();
    releases[2]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2, 3]);
    releases[3]();

    expect(await settled).toEqual([
      { status: "fulfilled", value: 0 },
      { status: "rejected", reason: new Error("task 1 failed") },
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 3 },
    ]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("turns a synchronous throw into a rejection and frees the slot", async () => {
    const limit = concurrencyLimiter(1);
    await expect(limit(() => {
      throw new Error("sync");
    })).rejects.toThrow("sync");
    await expect(limit(async () => "next")).resolves.toBe("next");
    expect(() => concurrencyLimiter(0)).toThrow("positive integer");
  });
});

describe("collection spend allocation", () => {
  it("splits an exact collection URL campaign equally between products (Demand Gen default)", () => {
    const family = {
      state: "ready" as const,
      data: {
        granularity: "day" as const,
        rows: [{
          collectionId: "gid://shopify/Collection/20",
          handle: "best-sellers",
          title: "Best sellers",
          revenue: 100,
          units: 4,
          spend: null,
          roas: null,
          timeline: [{ bucket: "2026-08-14", revenue: 100, units: 4, spend: 0, roas: null }],
          products: [
            {
              productId: "gid://shopify/Product/10",
              title: "Lamp",
              revenue: 75,
              units: 3,
              spend: null,
              roas: null,
              timeline: [{ bucket: "2026-08-14", revenue: 75, units: 3, spend: 0, roas: null }],
            },
            {
              productId: "gid://shopify/Product/11",
              title: "Shade",
              revenue: 25,
              units: 1,
              spend: null,
              roas: null,
              timeline: [{ bucket: "2026-08-14", revenue: 25, units: 1, spend: 0, roas: null }],
            },
          ],
        }],
      },
    };
    const campaign = {
      ...googleCampaign(),
      name: "SK - TOTTEBAGS",
      status: "active" as const,
      finalUrls: ["https://northwind.example/collections/best-sellers"],
    };
    const result = attributeCollectionSpend(
      family,
      {
        ok: true,
        value: {
          rows: [campaign],
          granularity: "day",
          timeline: [{
            accountId: STORE_ID,
            campaignId: campaign.providerCampaignId,
            bucket: "2026-08-14",
            granularity: "day",
            spend: 40,
            impressions: 100,
            clicks: 10,
            conversions: 2,
            googleRevenue: 120,
          }],
        },
      },
      { ok: true, value: [] },
    );

    if (!("data" in result)) throw new Error("Expected allocated collection data");
    expect(result.data.rows[0]).toMatchObject({ spend: 40, roas: 2.5 });
    // Equal split (owner rule): €40 over two products = €20 each, so each
    // product's Real ROAS is its own revenue over the equal share.
    expect(result.data.rows[0].products[0]).toMatchObject({ spend: 20, roas: 3.75 });
    expect(result.data.rows[0].products[1]).toMatchObject({ spend: 20, roas: 1.25 });
    expect(result.data.rows[0].timeline).toEqual([
      { bucket: "2026-08-14", revenue: 100, units: 4, spend: 40, roas: 2.5 },
    ]);
  });
});
