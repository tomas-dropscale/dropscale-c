import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import type { AdAccount } from "@/lib/supabase/types";

const mocks = vi.hoisted(() => ({
  activeWorkspaceId: vi.fn(),
  clientReportingAuthority: vi.fn(),
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  resolveReportingSources: vi.fn(),
  fetchGoogleReportingCampaigns: vi.fn(),
  hasGoogleAdsEnv: vi.fn(),
  decryptToken: vi.fn(),
  fetchLiveCampaigns: vi.fn(),
}));

vi.mock("@/lib/portal/workspace", () => ({
  activeWorkspaceId: mocks.activeWorkspaceId,
}));
vi.mock("@/lib/portal/client-rollout", () => ({
  clientReportingAuthority: mocks.clientReportingAuthority,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/reporting/sources", () => ({
  resolveReportingSources: mocks.resolveReportingSources,
}));
vi.mock("@/lib/reporting/google", () => ({
  fetchGoogleReportingCampaigns: mocks.fetchGoogleReportingCampaigns,
}));
vi.mock("@/lib/portal/mock", () => ({
  aggregateMetrics: vi.fn(),
  mockCampaigns: vi.fn(),
  mockDeliveries: vi.fn(),
  mockMetrics: vi.fn(),
}));
vi.mock("@/lib/google-ads/env", () => ({ hasGoogleAdsEnv: mocks.hasGoogleAdsEnv }));
vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decryptToken }));
vi.mock("@/lib/google-ads/portal", () => ({
  fetchLiveCampaigns: mocks.fetchLiveCampaigns,
  fetchLiveCreatives: vi.fn(),
  fetchLiveMetrics: vi.fn(),
}));
vi.mock("@/lib/google-ads/revoked", () => ({ markIfAuthRevoked: vi.fn() }));

import {
  fetchAccount,
  fetchAccounts,
  fetchCampaigns,
  reportingMetricAccountIds,
  reportingMetricScope,
} from "./data";

function account(overrides: Partial<AdAccount> = {}): AdAccount {
  return {
    id: "anchor-1",
    client_id: "client-1",
    store_name: "Legacy name",
    google_ads_customer_id: null,
    status: "pending",
    reporting_role: "shopify_anchor",
    currency: "USD",
    breakeven_roas: null,
    lifetime_ads_budget_usd: null,
    shopify_url: "legacy.myshopify.com",
    shopify_connected: false,
    shopify_client_id: null,
    shopify_scopes: null,
    color_dot: "#fff",
    created_at: "2026-01-01T00:00:00Z",
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

function googleAccount(id: string, overrides: Partial<AdAccount> = {}): AdAccount {
  return account({
    id,
    reporting_role: "google_spend",
    store_name: "Google account",
    google_ads_customer_id: "1234567890",
    google_ads_connected: true,
    shopify_url: null,
    shopify_connected: false,
    ...overrides,
  });
}

function shopifySource(
  overrides: Partial<CanonicalReportingSource> = {},
): CanonicalReportingSource {
  return {
    bindingId: "binding-anchor-1",
    clientId: "client-1",
    adAccountId: "anchor-1",
    kind: "shopify",
    group: {
      id: "binding-anchor-1",
      shopifyAnchorBindingId: "binding-anchor-1",
      shopifyAnchorAdAccountId: "anchor-1",
    },
    shopify: {
      connectionId: "shopify-1",
      shopId: "gid://shopify/Shop/1",
      shopifyName: "V2 Store",
      domain: "v2-store.myshopify.com",
      primaryDomain: "shop.example",
      currency: "EUR",
      credential: null,
    },
    googleAds: null,
    ...overrides,
  };
}

function googleSource(
  adAccountId: string,
  anchorAdAccountId: string | null = "anchor-1",
): CanonicalReportingSource {
  const anchored = anchorAdAccountId !== null;
  return {
    bindingId: `binding-${adAccountId}`,
    clientId: "client-1",
    adAccountId,
    kind: "google_ads",
    group: {
      id: anchored ? "binding-anchor-1" : `binding-${adAccountId}`,
      shopifyAnchorBindingId: anchored ? "binding-anchor-1" : null,
      shopifyAnchorAdAccountId: anchorAdAccountId,
    },
    shopify: null,
    googleAds: {
      connectionId: `google-${adAccountId}`,
      windsorAccountId: "123-456-7890",
      accountId: "123-456-7890",
      customerId: "1234567890",
      accountName: "Google account",
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      dataSourceId: null,
    },
  };
}

function queryClient(data: AdAccount[], error: unknown = null) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = {
    select: vi.fn(),
    in: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockResolvedValue({ data, error });
  query.maybeSingle.mockResolvedValue({ data: data[0] ?? null, error });
  query.then = (resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject);
  const from = vi.fn().mockReturnValue(query);
  return { client: { from }, from, query };
}

describe("portal V2 store projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeWorkspaceId.mockResolvedValue("client-1");
    mocks.clientReportingAuthority.mockResolvedValue("v2");
    mocks.resolveReportingSources.mockResolvedValue([]);
  });

  it.each([
    "legacy_only",
    "v2_onboarding",
    "v2_ready_for_cutover",
    "rollback_legacy",
  ])("keeps the exact legacy account read for %s", async () => {
    const legacy = account();
    const { client, query } = queryClient([legacy]);
    mocks.clientReportingAuthority.mockResolvedValue("legacy");
    mocks.createClient.mockResolvedValue(client);

    await expect(fetchAccounts()).resolves.toEqual([legacy]);
    expect(query.eq).toHaveBeenCalledWith("client_id", "client-1");
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    await expect(reportingMetricAccountIds([legacy, legacy])).resolves.toEqual([
      "anchor-1",
    ]);
  });

  it("keeps legacy campaign reads on the existing client token path", async () => {
    const legacy = account({
      status: "active",
      google_ads_connected: true,
      google_ads_customer_id: "1234567890",
      google_ads_refresh_token: "ciphertext",
    });
    const { client } = queryClient([legacy]);
    mocks.clientReportingAuthority.mockResolvedValue("legacy");
    mocks.createClient.mockResolvedValue(client);
    mocks.hasGoogleAdsEnv.mockReturnValue(true);
    mocks.decryptToken.mockResolvedValue("refresh-token");
    mocks.fetchLiveCampaigns.mockResolvedValue([
      {
        id: "gads-anchor-1-42",
        ad_account_id: "anchor-1",
        name: "Legacy campaign",
        status: "active",
        spend: 10,
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
        cpc: 1,
        daily_budget: 20,
        updated_at: "2026-08-14T00:00:00.000Z",
      },
    ]);

    const range = {
      key: "custom" as const,
      from: "2026-08-01",
      to: "2026-08-14",
    };
    await expect(fetchCampaigns(legacy, range)).resolves.toEqual([
      expect.objectContaining({ id: "gads-anchor-1-42" }),
    ]);
    expect(mocks.fetchLiveCampaigns).toHaveBeenCalledWith(
      "1234567890",
      "refresh-token",
      "anchor-1",
      range,
    );
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
  });

  it("projects one operational store with all of its Google metric children", async () => {
    const base = account();
    const source = shopifySource();
    const childOne = googleSource("google-child-1");
    const childTwo = googleSource("google-child-2");
    const { client } = queryClient([
      base,
      googleAccount("google-child-1"),
      googleAccount("google-child-2"),
    ]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([source, childOne, childTwo]);

    const accounts = await fetchAccounts();

    expect(accounts).toEqual([
      expect.objectContaining({
        id: "anchor-1",
        store_name: "V2 Store",
        shopify_url: "shop.example",
        // daily_metrics is canonical in the physical account currency. The
        // Shopify source reports EUR, but the normalized base is USD.
        currency: "USD",
        status: "active",
        shopify_connected: true,
        google_ads_connected: true,
        // The child is a reporting input, never the store's public account id.
        google_ads_customer_id: null,
      }),
    ]);
    await expect(reportingMetricAccountIds(accounts)).resolves.toEqual([
      "anchor-1",
      "google-child-1",
      "google-child-2",
    ]);
    expect(mocks.resolveReportingSources).toHaveBeenCalledWith({
      service: client,
      clientIds: ["client-1"],
      includeShopifyCredentials: false,
    });
  });

  it("reads every Google source grouped under the selected V2 Shopify anchor", async () => {
    const pair = shopifySource({
      kind: "shopify_google",
      googleAds: googleSource("ignored").googleAds,
    });
    const child = googleSource("google-child-1");
    const { client } = queryClient([account(), googleAccount("google-child-1")]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([pair, child]);
    mocks.fetchGoogleReportingCampaigns.mockImplementation(async (source) => [
      {
        id: `campaign-${source.adAccountId}`,
        ad_account_id: source.adAccountId,
        name: source.adAccountId,
        status: "active",
        spend: source.adAccountId === "anchor-1" ? 10 : 30,
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

    await expect(
      fetchCampaigns(account(), {
        key: "custom",
        from: "2026-08-01",
        to: "2026-08-14",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "campaign-google-child-1", spend: 30 }),
      expect.objectContaining({ id: "campaign-anchor-1", spend: 10 }),
    ]);
    expect(mocks.fetchGoogleReportingCampaigns).toHaveBeenCalledTimes(2);
    expect(mocks.fetchGoogleReportingCampaigns).toHaveBeenCalledWith(
      pair,
      "2026-08-01",
      "2026-08-14",
    );
    expect(mocks.fetchGoogleReportingCampaigns).toHaveBeenCalledWith(
      child,
      "2026-08-01",
      "2026-08-14",
    );
    expect(mocks.fetchLiveCampaigns).not.toHaveBeenCalled();
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });

  it("fails the whole V2 store closed when one grouped campaign source fails", async () => {
    const pair = shopifySource({
      kind: "shopify_google",
      googleAds: googleSource("ignored").googleAds,
    });
    const child = googleSource("google-child-1");
    const { client } = queryClient([account(), googleAccount("google-child-1")]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([pair, child]);
    mocks.fetchGoogleReportingCampaigns
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("credential-adjacent upstream detail"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      fetchCampaigns(account(), {
        key: "custom",
        from: "2026-08-01",
        to: "2026-08-14",
      }),
    ).resolves.toEqual([]);
    expect(consoleError).toHaveBeenCalledWith("portal V2 campaign reporting failed");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("credential-adjacent");
    expect(mocks.fetchLiveCampaigns).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("refuses a V2 account that is not a projected Shopify anchor", async () => {
    const { client } = queryClient([account()]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([shopifySource()]);

    await expect(
      fetchCampaigns(account({ id: "google-child-1" }), {
        key: "custom",
        from: "2026-08-01",
        to: "2026-08-14",
      }),
    ).resolves.toEqual([]);
    expect(mocks.fetchGoogleReportingCampaigns).not.toHaveBeenCalled();
    expect(mocks.fetchLiveCampaigns).not.toHaveBeenCalled();
  });

  it("keeps only a paired Google id on the store projection", async () => {
    const base = account({ google_ads_customer_id: "9999999999" });
    const pair = shopifySource({
      kind: "shopify_google",
      googleAds: googleSource("ignored").googleAds,
    });
    const child = googleSource("google-child-1");
    const { client } = queryClient([base, googleAccount("google-child-1")]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([pair, child]);

    await expect(fetchAccounts()).resolves.toEqual([
      expect.objectContaining({
        google_ads_connected: true,
        google_ads_customer_id: "1234567890",
      }),
    ]);
  });

  it("omits a standalone Google-only source instead of creating a fake store", async () => {
    const anchor = shopifySource();
    const standalone = googleSource("google-standalone", null);
    const standaloneAccount = googleAccount("google-standalone", {
      commission_rate: 12,
      list_commission_rate: 12,
    });
    const { client } = queryClient([account(), standaloneAccount]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([anchor, standalone]);

    const accounts = await fetchAccounts();
    expect(accounts.map(({ id }) => id)).toEqual(["anchor-1"]);
    await expect(reportingMetricAccountIds(accounts)).resolves.toEqual(["anchor-1"]);

    const storeScope = await reportingMetricScope(accounts);
    expect(storeScope.metricAccountIds).toEqual(["anchor-1"]);
    expect(storeScope.unallocatedGoogleAccountIds).toEqual([]);

    const clientScope = await reportingMetricScope(accounts, { includeUnallocated: true });
    expect(clientScope.metricAccountIds).toEqual(["anchor-1", "google-standalone"]);
    expect(clientScope.unallocatedGoogleAccountIds).toEqual(["google-standalone"]);
    expect(clientScope.metricIdsByStore.get("anchor-1")).toEqual(["anchor-1"]);
    expect(clientScope.metricAccountsById.get("google-standalone")).toEqual(
      standaloneAccount,
    );
  });

  it("preserves an existing suspended anchor", async () => {
    const { client } = queryClient([account({ status: "suspended" })]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([shopifySource()]);

    await expect(fetchAccounts()).resolves.toEqual([
      expect.objectContaining({ status: "suspended" }),
    ]);
  });

  it("fails closed on a cross-client source", async () => {
    const { client } = queryClient([account()]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([
      shopifySource({ clientId: "client-2" }),
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(fetchAccounts()).resolves.toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "portal V2 reporting projection failed:",
      "invalid_sources",
    );
    consoleError.mockRestore();
  });

  it("fails closed instead of double-counting a second Shopify source in one group", async () => {
    const secondShopify = shopifySource({
      bindingId: "binding-shopify-2",
      adAccountId: "shopify-child-2",
      group: {
        id: "binding-anchor-1",
        shopifyAnchorBindingId: "binding-anchor-1",
        shopifyAnchorAdAccountId: "anchor-1",
      },
      shopify: {
        ...shopifySource().shopify!,
        connectionId: "shopify-2",
        shopId: "gid://shopify/Shop/2",
      },
    });
    const { client } = queryClient([account(), account({ id: "shopify-child-2" })]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([shopifySource(), secondShopify]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(fetchAccounts()).resolves.toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "portal V2 reporting projection failed:",
      "invalid_sources",
    );
    consoleError.mockRestore();
  });

  it("fails closed with a sanitized log when V2 resolution fails", async () => {
    const { client } = queryClient([account()]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockRejectedValue(
      new Error("do-not-log client or credential-adjacent details"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(fetchAccounts()).resolves.toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "portal V2 reporting projection failed:",
      "source_resolution_error",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("do-not-log");
    consoleError.mockRestore();
  });

  it("404s direct legacy ids after V2 activation", async () => {
    const { client } = queryClient([account()]);
    mocks.createServiceClient.mockReturnValue(client);
    mocks.resolveReportingSources.mockResolvedValue([shopifySource()]);

    await expect(fetchAccount("unbound-legacy-id")).resolves.toBeNull();
    await expect(fetchAccount("anchor-1")).resolves.toEqual(
      expect.objectContaining({ id: "anchor-1", status: "active" }),
    );
  });

  it("fails closed when the reporting authority cannot be established", async () => {
    mocks.clientReportingAuthority.mockResolvedValue("unavailable");

    await expect(fetchAccounts()).resolves.toEqual([]);
    await expect(fetchAccount("anchor-1")).resolves.toBeNull();
    await expect(reportingMetricAccountIds("anchor-1")).resolves.toEqual([]);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
  });
});
