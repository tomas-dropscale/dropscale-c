import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import type { AdAccount } from "@/lib/supabase/types";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  hasGoogleAdsEnv: vi.fn(),
  hasWindsorEnv: vi.fn(),
  decryptToken: vi.fn(),
  fetchLiveCampaignsDetailed: vi.fn(),
  markIfAuthRevoked: vi.fn(),
  fetchHstClientKeys: vi.fn(),
  googleProfit: vi.fn(),
  googleRoas: vi.fn(),
  fetchDailyMetrics: vi.fn(),
  sumMetrics: vi.fn(),
  resolveReportingSources: vi.fn(),
  fetchGoogleReportingCampaigns: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/google-ads/env", () => ({ hasGoogleAdsEnv: mocks.hasGoogleAdsEnv }));
vi.mock("@/lib/windsor/client", () => ({ hasWindsorEnv: mocks.hasWindsorEnv }));
vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decryptToken }));
vi.mock("@/lib/google-ads/portal", () => ({
  fetchLiveCampaignsDetailed: mocks.fetchLiveCampaignsDetailed,
}));
vi.mock("@/lib/google-ads/revoked", () => ({
  markIfAuthRevoked: mocks.markIfAuthRevoked,
}));
vi.mock("@/lib/admin/hst", () => ({ fetchHstClientKeys: mocks.fetchHstClientKeys }));
vi.mock("@/lib/admin/google-attribution", () => ({
  googleProfit: mocks.googleProfit,
  googleRoas: mocks.googleRoas,
}));
vi.mock("@/lib/metrics/queries", () => ({
  fetchDailyMetrics: mocks.fetchDailyMetrics,
  sumMetrics: mocks.sumMetrics,
}));
vi.mock("@/lib/portal/data", () => ({ ACCOUNT_COLUMNS: "columns" }));
vi.mock("@/lib/reporting/sources", () => ({
  resolveReportingSources: mocks.resolveReportingSources,
}));
vi.mock("@/lib/reporting/google", () => ({
  fetchGoogleReportingCampaigns: mocks.fetchGoogleReportingCampaigns,
}));

import { fetchAdminCampaigns } from "./campaigns";

function account(id: string, clientId: string, overrides: Partial<AdAccount> = {}): AdAccount {
  return {
    id,
    client_id: clientId,
    store_name: id,
    google_ads_customer_id: null,
    status: "pending",
    reporting_role: "legacy_hybrid",
    currency: "EUR",
    breakeven_roas: null,
    lifetime_ads_budget_usd: null,
    shopify_url: null,
    shopify_connected: false,
    shopify_client_id: null,
    shopify_scopes: null,
    color_dot: "#fff",
    created_at: `2026-01-0${id === "anchor" ? "1" : "2"}T00:00:00Z`,
    google_ads_refresh_token: null,
    google_ads_connected_email: null,
    google_ads_connected: false,
    commission_rate: 10,
    list_commission_rate: 10,
    shopify_admin_token: null,
    shopify_token_last4: null,
    shopify_connected_at: null,
    default_product_cost_pct: 30,
    payment_fee_pct: 2.9,
    payment_fee_fixed: 0.3,
    shipping_cost_per_order: 5,
    revenue_share_enabled: false,
    ...overrides,
  };
}

function source(
  adAccountId: string,
  options: { anchor?: boolean; child?: boolean } = {},
): CanonicalReportingSource {
  const anchor = options.anchor === true;
  return {
    bindingId: `binding-${adAccountId}`,
    clientId: "client-1",
    adAccountId,
    kind: anchor ? "shopify_google" : "google_ads",
    group: {
      id: "binding-anchor",
      shopifyAnchorBindingId: "binding-anchor",
      shopifyAnchorAdAccountId: "anchor",
    },
    shopify: anchor
      ? {
          connectionId: "shopify-1",
          shopId: "gid://shopify/Shop/1",
          shopifyName: "Projected Store",
          domain: "store.myshopify.com",
          primaryDomain: "store.example",
          currency: "EUR",
          credential: null,
        }
      : null,
    googleAds: {
      connectionId: `google-${adAccountId}`,
      windsorAccountId: options.child ? "222-222-2222" : "111-111-1111",
      accountId: options.child ? "222-222-2222" : "111-111-1111",
      customerId: options.child ? "2222222222" : "1111111111",
      accountName: `${adAccountId} ads`,
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      dataSourceId: null,
    },
  };
}

function query(data: unknown, error: unknown = null, maybeSingle: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = {
    select: vi.fn(),
    order: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    maybeSingle: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  chain.maybeSingle.mockResolvedValue({ data: maybeSingle, error });
  chain.then = (resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject);
  return chain;
}

function supabaseFor(accounts: AdAccount[], token: string | null = null) {
  const accountQuery = query(accounts, null, token ? { google_ads_refresh_token: token } : null);
  const clientsQuery = query([
    {
      id: "client-1",
      full_name: "Client One",
      email: "client@example.com",
      crm_client_id: null,
    },
  ]);
  const profilesQuery = query([]);
  return {
    from: vi.fn((table: string) => {
      if (table === "ad_accounts") return accountQuery;
      if (table === "portal_clients") return clientsQuery;
      if (table === "profiles") return profilesQuery;
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

const emptyRollup = {
  attributedRevenue: 0,
  revenue: 0,
  refunds: 0,
  productCost: 0,
  paymentFees: 0,
  shippingCost: 0,
  adSpend: 0,
};

describe("admin V2 campaign inventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasGoogleAdsEnv.mockReturnValue(true);
    mocks.hasWindsorEnv.mockReturnValue(true);
    mocks.fetchHstClientKeys.mockResolvedValue({ crmIds: new Set(), names: new Set() });
    mocks.fetchDailyMetrics.mockResolvedValue([]);
    mocks.sumMetrics.mockReturnValue(emptyRollup);
    mocks.googleProfit.mockReturnValue(0);
    mocks.googleRoas.mockReturnValue(0);
    mocks.markIfAuthRevoked.mockResolvedValue(false);
  });

  it("projects one Shopify anchor, reads its pair and child, and counts metrics once", async () => {
    const accounts = [
      account("anchor", "client-1", { reporting_role: "shopify_anchor" }),
      account("child", "client-1", { reporting_role: "google_spend" }),
    ];
    mocks.createClient.mockResolvedValue(supabaseFor(accounts));
    const rolloutQuery = query([
      {
        client_id: "client-1",
        operational_surface: "v2_active",
        reporting_cutover_at: "2026-08-14T01:00:00.000Z",
      },
    ]);
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() => rolloutQuery),
    });
    const pair = source("anchor", { anchor: true });
    const child = source("child", { child: true });
    mocks.resolveReportingSources.mockResolvedValue([pair, child]);
    mocks.fetchGoogleReportingCampaigns.mockImplementation(async (reportingSource) => [
      {
        id: `campaign-${reportingSource.adAccountId}`,
        ad_account_id: reportingSource.adAccountId,
        name: reportingSource.adAccountId,
        status: "active",
        spend: reportingSource.adAccountId === "anchor" ? 10 : 30,
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
        cpc: 1,
        daily_budget: 20,
        updated_at: "2026-08-14T00:00:00.000Z",
        startDate: "2026-08-01",
        conversions: 2,
      },
    ]);

    const overview = await fetchAdminCampaigns({
      key: "custom",
      from: "2026-08-01",
      to: "2026-08-14",
    });

    expect(overview.clients).toHaveLength(1);
    expect(overview.clients[0].accounts).toEqual([
      expect.objectContaining({
        account: expect.objectContaining({
          id: "anchor",
          store_name: "Projected Store",
          shopify_url: "store.example",
        }),
        campaigns: [
          expect.objectContaining({ id: "campaign-child", spend: 30 }),
          expect.objectContaining({ id: "campaign-anchor", spend: 10 }),
        ],
        spend: 40,
        commission: 4,
        connected: true,
        failed: false,
      }),
    ]);
    expect(mocks.fetchGoogleReportingCampaigns).toHaveBeenCalledTimes(2);
    expect(mocks.fetchDailyMetrics).toHaveBeenCalledWith(
      ["anchor", "child"],
      "2026-08-01",
      "2026-08-14",
    );
    expect(mocks.fetchLiveCampaignsDetailed).not.toHaveBeenCalled();
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });

  it("keeps a client with no rollout row on the legacy token reader", async () => {
    const legacy = account("legacy", "client-1", {
      status: "active",
      google_ads_connected: true,
      google_ads_customer_id: "1234567890",
    });
    mocks.createClient.mockResolvedValue(supabaseFor([legacy], "ciphertext"));
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() => query([])),
    });
    mocks.decryptToken.mockResolvedValue("refresh-token");
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([
      {
        id: "gads-legacy-1",
        ad_account_id: "legacy",
        name: "Legacy campaign",
        status: "active",
        spend: 25,
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
        cpc: 2.5,
        daily_budget: 20,
        updated_at: "2026-08-14T00:00:00.000Z",
        startDate: "2026-08-01",
        conversions: 2,
      },
    ]);

    const overview = await fetchAdminCampaigns({
      key: "custom",
      from: "2026-08-01",
      to: "2026-08-14",
    });

    expect(overview.clients[0].accounts[0]).toEqual(
      expect.objectContaining({ spend: 25, commission: 2.5, connected: true }),
    );
    expect(mocks.fetchLiveCampaignsDetailed).toHaveBeenCalledWith(
      "1234567890",
      "refresh-token",
      "legacy",
      { key: "custom", from: "2026-08-01", to: "2026-08-14" },
    );
    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
  });

  it("keeps a historical V2-active lifecycle on legacy until reporting is cut over", async () => {
    const legacy = account("legacy", "client-1", {
      status: "active",
      google_ads_connected: true,
      google_ads_customer_id: "1234567890",
    });
    mocks.createClient.mockResolvedValue(supabaseFor([legacy], "ciphertext"));
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() =>
        query([
          {
            client_id: "client-1",
            operational_surface: "v2_active",
            reporting_cutover_at: null,
          },
        ]),
      ),
    });
    mocks.decryptToken.mockResolvedValue("refresh-token");
    mocks.fetchLiveCampaignsDetailed.mockResolvedValue([]);

    await fetchAdminCampaigns({
      key: "custom",
      from: "2026-08-01",
      to: "2026-08-14",
    });

    expect(mocks.fetchLiveCampaignsDetailed).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy when rollout authority is unavailable", async () => {
    const legacyLooking = account("legacy", "client-1", {
      status: "active",
      google_ads_connected: true,
      google_ads_customer_id: "1234567890",
    });
    mocks.createClient.mockResolvedValue(supabaseFor([legacyLooking], "ciphertext"));
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() => query(null, { code: "database_error" })),
    });

    await expect(
      fetchAdminCampaigns({ key: "today", from: "2026-08-14", to: "2026-08-14" }),
    ).rejects.toThrow("Admin reporting inventory is unavailable.");
    expect(mocks.fetchLiveCampaignsDetailed).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
  });
});
