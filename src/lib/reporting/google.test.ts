import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import {
  fetchGoogleReportingCampaignBreakdowns,
  fetchGoogleReportingCampaigns,
  fetchGoogleReportingDailyMetrics,
  fetchGoogleReportingDemandGenAds,
  fetchGoogleReportingPmaxProducts,
} from "./google";

const source: CanonicalReportingSource = {
  bindingId: "70000000-0000-4000-8000-000000000001",
  clientId: "70000000-0000-4000-8000-000000000002",
  adAccountId: "70000000-0000-4000-8000-000000000003",
  kind: "google_ads",
  group: {
    id: "70000000-0000-4000-8000-000000000001",
    shopifyAnchorBindingId: null,
    shopifyAnchorAdAccountId: null,
  },
  shopify: null,
  googleAds: {
    connectionId: "70000000-0000-4000-8000-000000000004",
    windsorAccountId: "111-222-3333",
    accountId: "111-222-3333",
    customerId: "1112223333",
    accountName: "Main Ads",
    currency: "EUR",
    timeZone: "Europe/Lisbon",
    dataSourceId: "source",
    healthError: null,
  },
};

const row = {
  date: "2026-08-13",
  accountId: "111-222-3333",
  customerId: "1112223333",
  currency: "EUR",
  timeZone: "Europe/Lisbon",
  spend: 12.5,
  impressions: 100,
  clicks: 10,
  conversions: 2,
  conversionValue: 40,
};

/** One exact Windsor campaign row for the verified source, without URL evidence. */
function campaignRow(campaignId: string) {
  return {
    accountId: "111-222-3333",
    customerId: "1112223333",
    currency: "EUR",
    timeZone: "Europe/Lisbon",
    campaignId,
    name: `Campaign ${campaignId}`,
    status: "ENABLED" as const,
    advertisingChannelType: "SEARCH",
    shoppingFeed: false,
    biddingStrategyType: null,
    startDate: null,
    dailyBudget: 10,
    spend: 100,
    impressions: 1_000,
    clicks: 50,
    conversions: 4,
    conversionValue: 320,
  };
}

/** A Google child source anchored to a store with two domain aliases, so the owner rule has hosts to check. */
const anchoredSource: CanonicalReportingSource = {
  ...source,
  anchorShopifyDomains: { domain: "shop.myshopify.com", primaryDomain: "https://www.shop.example/" },
};

describe("Google V2 reporting adapter", () => {
  it("projects the exact Windsor account into the Google metric family", async () => {
    const fetcher = vi.fn(async () => [row]);

    await expect(
      fetchGoogleReportingDailyMetrics(
        source,
        "2026-08-13",
        "2026-08-13",
        fetcher,
      ),
    ).resolves.toEqual([
      {
        day: "2026-08-13",
        ad_spend: 12.5,
        impressions: 100,
        clicks: 10,
        conversions: 2,
        conversion_value: 40,
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "111-222-3333",
      "2026-08-13",
      "2026-08-13",
    );
  });

  it.each([
    ["customer", { customerId: "9998887777" }],
    ["currency", { currency: "USD" }],
    ["timezone", { timeZone: "America/New_York" }],
  ])("fails closed on a different %s identity", async (_label, mismatch) => {
    const fetcher = vi.fn(async () => [{ ...row, ...mismatch }]);

    await expect(
      fetchGoogleReportingDailyMetrics(
        source,
        "2026-08-13",
        "2026-08-13",
        fetcher,
      ),
    ).rejects.toThrow(/different Google Ads reporting identity/);
  });

  it("refuses a source without Google Ads", async () => {
    await expect(
      fetchGoogleReportingDailyMetrics(
        { ...source, kind: "shopify", googleAds: null },
        "2026-08-13",
        "2026-08-13",
      ),
    ).rejects.toThrow(/no Google Ads account/);
  });

  it("projects Windsor campaigns with derived Google metrics and explicit type", async () => {
    const fetcher = vi.fn(async () => [
      {
        accountId: "111-222-3333",
        customerId: "1112223333",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        campaignId: "42",
        name: "PMax — Best sellers",
        status: "ENABLED" as const,
        advertisingChannelType: "PERFORMANCE_MAX",
        shoppingFeed: true,
        biddingStrategyType: "MAXIMIZE_CONVERSIONS",
        startDate: "2026-07-01",
        dailyBudget: 35,
        spend: 100,
        impressions: 1_000,
        clicks: 50,
        conversions: 4,
        conversionValue: 320,
      },
    ]);

    await expect(
      fetchGoogleReportingCampaigns(
        source,
        "2026-08-01",
        "2026-08-13",
        null,
        fetcher,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: `windsor-${source.adAccountId}-42`,
        ad_account_id: source.adAccountId,
        name: "PMax — Best sellers",
        status: "active",
        spend: 100,
        ctr: 0.05,
        cpc: 2,
        daily_budget: 35,
        conversions: 4,
        advertisingChannelType: "PERFORMANCE_MAX",
        shoppingFeed: true,
        conversionValue: 320,
        googleRoas: 3.2,
      }),
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "111-222-3333",
      "2026-08-01",
      "2026-08-13",
    );
  });

  it("fails closed when campaign rows do not match the verified source", async () => {
    const fetcher = vi.fn(async () => [
      {
        accountId: "111-222-3333",
        customerId: "1112223333",
        currency: "USD",
        timeZone: "Europe/Lisbon",
        campaignId: "42",
        name: "Campaign",
        status: "PAUSED" as const,
        advertisingChannelType: "PERFORMANCE_MAX",
        shoppingFeed: false,
        biddingStrategyType: null,
        startDate: null,
        dailyBudget: null,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValue: 0,
      },
    ]);

    await expect(
      fetchGoogleReportingCampaigns(
        source,
        "2026-08-13",
        "2026-08-13",
        null,
        fetcher,
        async () => [],
      ),
    ).rejects.toThrow(/different Google Ads reporting identity/);
  });

  /** One Windsor campaign-hour row for the verified source. */
  function hourRow(campaignId: string, hour: number, spend: number) {
    return {
      date: "2026-09-15",
      bucket: `2026-09-15T${String(hour).padStart(2, "0")}:00:00`,
      granularity: "hour" as const,
      accountId: "111-222-3333",
      customerId: "1112223333",
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      campaignId,
      spend,
      impressions: 10,
      clicks: 2,
      conversions: 0.5,
      conversionValue: spend * 3,
    };
  }

  it("reads today's campaigns from whichever Windsor table is fresher", async () => {
    // Measured 2026-09-15: Windsor filled the two tables at different paces
    // and answered the same query from replicas hours apart (118.61 daily and
    // 118.40 hours at 09:55 UTC, nothing at 10:02, 118.99 at 10:03). Campaign
    // 42 is ahead in the hours, campaign 43 in the daily table; each keeps the
    // five metrics of the table its spend came from, never a mix.
    const fetcher = vi.fn(async () => [
      { ...campaignRow("42"), spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 },
      campaignRow("43"),
    ]);
    const timelineFetcher = vi.fn(async () => [
      hourRow("42", 8, 60.2),
      hourRow("42", 9, 58.2),
      // Hours behind the daily table for this campaign: the daily row stands.
      hourRow("43", 8, 40),
      // A campaign the daily table does not name has no row to refresh.
      hourRow("99", 8, 500),
    ]);

    const campaigns = await fetchGoogleReportingCampaigns(
      source,
      "2026-09-15",
      "2026-09-15",
      null,
      fetcher,
      timelineFetcher,
    );

    expect(timelineFetcher).toHaveBeenCalledWith("111-222-3333", "2026-09-15", "2026-09-15");
    expect(campaigns).toEqual([
      expect.objectContaining({
        providerCampaignId: "42",
        spend: 118.4,
        impressions: 20,
        clicks: 4,
        conversions: 1,
        conversionValue: 355.2,
        ctr: 0.2,
        cpc: 29.6,
        googleRoas: expect.closeTo(3, 9),
      }),
      expect.objectContaining({
        providerCampaignId: "43",
        spend: 100,
        impressions: 1_000,
        clicks: 50,
        conversions: 4,
        conversionValue: 320,
      }),
    ]);
  });

  it("never reads the hours for a multi-day range", async () => {
    const fetcher = vi.fn(async () => [campaignRow("42")]);
    const timelineFetcher = vi.fn(async () => [hourRow("42", 8, 500)]);

    const campaigns = await fetchGoogleReportingCampaigns(
      source,
      "2026-09-14",
      "2026-09-15",
      null,
      fetcher,
      timelineFetcher,
    );

    expect(timelineFetcher).not.toHaveBeenCalled();
    expect(campaigns[0]).toMatchObject({ providerCampaignId: "42", spend: 100 });
  });

  it("keeps the daily-table figures when the hour read fails, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn(async () => [campaignRow("42")]);
    const timelineFetcher = vi.fn(async () => {
      throw new Error("Windsor is rate limiting requests.");
    });

    const campaigns = await fetchGoogleReportingCampaigns(
      source,
      "2026-09-15",
      "2026-09-15",
      null,
      fetcher,
      timelineFetcher,
    );

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ providerCampaignId: "42", spend: 100, clicks: 50 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("campaign hours could not be read");
    warn.mockRestore();
  });

  it("fails closed when the hour rows carry another reporting identity", async () => {
    const fetcher = vi.fn(async () => [campaignRow("42")]);
    const timelineFetcher = vi.fn(async () => [{ ...hourRow("42", 8, 500), currency: "USD" }]);

    await expect(
      fetchGoogleReportingCampaigns(
        source,
        "2026-09-15",
        "2026-09-15",
        null,
        fetcher,
        timelineFetcher,
      ),
    ).rejects.toThrow(/different Google Ads reporting identity/);
  });

  it("reads no landing pages unless asked, so the portal and the snapshots never carry them", async () => {
    // The store analytics sheet is the one reader of where the clicks landed.
    // Every other caller (the portal's campaign table, the admin campaign
    // snapshot) gets the campaigns alone: no second provider request, and no
    // list of thousands of URLs in a client payload or a stored row.
    const fetcher = vi.fn(async () => [campaignRow("42")]);

    const campaigns = await fetchGoogleReportingCampaigns(
      source,
      "2026-08-01",
      "2026-08-13",
      undefined,
      fetcher,
    );

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ providerCampaignId: "42", spend: 100 });
    expect(campaigns[0]).not.toHaveProperty("landingPages");
  });

  it("keeps only the landing pages on the store's own domain, as the final URLs are kept", async () => {
    // A reused Google account: this store's PMax campaign and the previous
    // store's, neither with a final URL, so both stay attributed by the owner
    // rule. The previous store's clicks landed on its own domain, and its
    // collection handle exists here too (cloned stores share handles), so
    // that page must not name a collection in this store.
    const fetcher = vi.fn(async () => [
      { ...campaignRow("84"), name: "PMax - Bags", advertisingChannelType: "PERFORMANCE_MAX" },
      { ...campaignRow("85"), name: "PMax - Old store", advertisingChannelType: "PERFORMANCE_MAX" },
    ]);
    const landingRows = [
      { campaignId: "84", url: "https://shop.example/collections/bags", clicks: 30 },
      // Both aliases of the store, and a subdomain of one, are the store.
      { campaignId: "84", url: "https://www.shop.example/collections/bags?gad_source=1", clicks: 20 },
      { campaignId: "84", url: "https://eu.shop.example/collections/bags", clicks: 10 },
      { campaignId: "84", url: "https://shop.myshopify.com/", clicks: 5 },
      // No host evidence: kept, as a final URL without a host would be.
      { campaignId: "84", url: "/collections/bags", clicks: 1 },
      { campaignId: "85", url: "https://old-store.example/collections/best-sellers", clicks: 900 },
      { campaignId: "85", url: "https://old-store.example/", clicks: 100 },
      // Even a page of this store's makes up no majority of that campaign.
      { campaignId: "85", url: "https://shop.example/collections/best-sellers", clicks: 3 },
    ];

    const anchored = await fetchGoogleReportingCampaigns(
      anchoredSource,
      "2026-08-01",
      "2026-08-13",
      async () => landingRows,
      fetcher,
    );
    expect(anchored.map((campaign) => [campaign.providerCampaignId, campaign.landingPages])).toEqual([
      ["84", [
        { url: "https://shop.example/collections/bags", clicks: 30 },
        { url: "https://www.shop.example/collections/bags?gad_source=1", clicks: 20 },
        { url: "https://eu.shop.example/collections/bags", clicks: 10 },
        { url: "https://shop.myshopify.com/", clicks: 5 },
        { url: "/collections/bags", clicks: 1 },
      ]],
      ["85", [{ url: "https://shop.example/collections/best-sellers", clicks: 3 }]],
    ]);

    // A source with no verifiable store domain cannot disprove any page, so
    // every page stays, exactly as every campaign does.
    const unanchored = await fetchGoogleReportingCampaigns(
      source,
      "2026-08-01",
      "2026-08-13",
      async () => landingRows,
      fetcher,
    );
    expect(unanchored.map((campaign) => campaign.landingPages?.length)).toEqual([5, 3]);
  });

  it("attaches where each campaign's clicks landed, summed per page, next to its final URLs", async () => {
    const fetcher = vi.fn(async () => [
      { ...campaignRow("42"), finalUrls: ["https://shop.example/collections/summer"] },
      // A Performance Max campaign: no ad-level final URL at all.
      { ...campaignRow("84"), name: "PMax - Total Feed", advertisingChannelType: "PERFORMANCE_MAX" },
      campaignRow("99"),
    ]);
    const landingFetcher = vi.fn(async () => [
      { campaignId: "42", url: "https://shop.example/collections/summer?gad_source=1", clicks: 100 },
      { campaignId: "84", url: "https://shop.example/collections/bags", clicks: 30 },
      { campaignId: "84", url: "https://shop.example/", clicks: 5 },
      // The same page twice over: one entry with the clicks summed.
      { campaignId: "84", url: "https://shop.example/collections/bags", clicks: 20 },
    ]);

    const campaigns = await fetchGoogleReportingCampaigns(
      source,
      "2026-08-01",
      "2026-08-13",
      landingFetcher,
      fetcher,
    );

    expect(landingFetcher).toHaveBeenCalledWith("111-222-3333", "2026-08-01", "2026-08-13");
    expect(campaigns.map((campaign) => [campaign.providerCampaignId, campaign.finalUrls, campaign.landingPages])).toEqual([
      ["42", ["https://shop.example/collections/summer"], [
        { url: "https://shop.example/collections/summer?gad_source=1", clicks: 100 },
      ]],
      ["84", undefined, [
        { url: "https://shop.example/collections/bags", clicks: 50 },
        { url: "https://shop.example/", clicks: 5 },
      ]],
      // Landed nothing in the range: no field, rather than an empty list.
      ["99", undefined, undefined],
    ]);
  });

  it("keeps the campaigns when the landing-page read fails, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn(async () => [campaignRow("42")]);
    const landingFetcher = vi.fn(async () => {
      throw new Error("Windsor is rate limiting requests.");
    });

    const campaigns = await fetchGoogleReportingCampaigns(
      source,
      "2026-08-01",
      "2026-08-13",
      landingFetcher,
      fetcher,
    );

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({ providerCampaignId: "42", spend: 100 });
    expect(campaigns[0]).not.toHaveProperty("landingPages");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("landing pages could not be read");
    warn.mockRestore();
  });

  it("still fails the campaign read when the campaign fetch itself rejects", async () => {
    // Best effort is for the landing pages only: the campaign rows stay exact.
    const failure = new Error("campaign read failed");
    const fetcher = vi.fn(async () => {
      throw failure;
    });
    await expect(
      fetchGoogleReportingCampaigns(source, "2026-08-01", "2026-08-13", null, fetcher),
    ).rejects.toBe(failure);
  });

  it("projects exact Demand Gen ads into the unified campaign detail contract", async () => {
    const fetcher = vi.fn(async () => [
      {
        accountId: "111-222-3333",
        customerId: "1112223333",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        campaignId: "42",
        adId: "9001",
        name: "Summer creative",
        type: "DEMAND_GEN_MULTI_ASSET_AD",
        status: "ENABLED" as const,
        spend: 25,
        impressions: 2_000,
        clicks: 80,
        conversions: 3,
        conversionValue: 120,
      },
      {
        accountId: "111-222-3333",
        customerId: "1112223333",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        campaignId: "42",
        adId: "9002",
        name: "Square",
        type: "SQUARE_MARKETING_IMAGE",
        status: "ENABLED" as const,
        thumbnailUrl: "https://google.example/square.jpg",
        assetKind: "image" as const,
        spend: 5,
        impressions: 400,
        clicks: 16,
        conversions: 1,
        conversionValue: 20,
      },
    ]);

    await expect(
      fetchGoogleReportingDemandGenAds(
        source,
        "2026-08-08",
        "2026-08-14",
        fetcher,
      ),
    ).resolves.toEqual([
      {
        accountId: source.adAccountId,
        campaignId: "42",
        provider: "google_ads",
        kind: "creative",
        id: "9001",
        name: "Summer creative",
        detail: null,
        spend: 25,
        impressions: 2_000,
        clicks: 80,
        conversions: 3,
        googleRevenue: 120,
        // A row without creative-asset metadata projects explicit nulls.
        thumbnailUrl: null,
        assetKind: null,
      },
      {
        accountId: source.adAccountId,
        campaignId: "42",
        provider: "google_ads",
        kind: "creative",
        id: "9002",
        name: "Square",
        detail: null,
        spend: 5,
        impressions: 400,
        clicks: 16,
        conversions: 1,
        googleRevenue: 20,
        // Asset metadata passes through the unified contract untouched.
        thumbnailUrl: "https://google.example/square.jpg",
        assetKind: "image",
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "111-222-3333",
      "2026-08-08",
      "2026-08-14",
    );
  });

  it("projects exact PMax products with a collision-safe Merchant identity", async () => {
    const fetcher = vi.fn(async () => [
      {
        accountId: "111-222-3333",
        customerId: "1112223333",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        campaignId: "84",
        merchantId: "123456789",
        feedLabel: "PT",
        language: "languageConstants/1014",
        country: "geoTargetConstants/2620",
        channel: "ONLINE",
        itemId: "shopify_PT_123_456",
        title: "Linen dress",
        brand: "Northwind",
        spend: 25.25,
        impressions: 2_000,
        clicks: 80,
        conversions: 3.5,
        conversionValue: 120,
      },
    ]);

    const [product] = await fetchGoogleReportingPmaxProducts(
      source,
      "2026-08-08",
      "2026-08-14",
      fetcher,
    );
    expect(product).toEqual({
      accountId: source.adAccountId,
      campaignId: "84",
      provider: "google_ads",
      kind: "product",
      id: expect.stringContaining("shopify_PT_123_456"),
      name: "Linen dress",
      detail: "Northwind",
      spend: 25.25,
      impressions: 2_000,
      clicks: 80,
      conversions: 3.5,
      googleRevenue: 120,
    });
  });

  it("fails detail closed on source identity mismatch and preserves provider errors", async () => {
    const mismatchFetcher = vi.fn(async () => [
      {
        accountId: "111-222-3333",
        customerId: "1112223333",
        currency: "USD",
        timeZone: "Europe/Lisbon",
        campaignId: "42",
        adId: "9001",
        name: null,
        type: "DEMAND_GEN_CAROUSEL_AD",
        status: "PAUSED" as const,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValue: 0,
      },
    ]);
    await expect(
      fetchGoogleReportingDemandGenAds(
        source,
        "2026-08-14",
        "2026-08-14",
        mismatchFetcher,
      ),
    ).rejects.toThrow(/different Google Ads reporting identity/);

    const providerFailure = new Error("provider-specific failure");
    const demandGenFetcher = vi.fn(async () => {
      throw providerFailure;
    });
    const productFetcher = vi.fn(async () => []);
    await expect(
      fetchGoogleReportingCampaignBreakdowns(
        source,
        "2026-08-14",
        "2026-08-14",
        demandGenFetcher,
        productFetcher,
      ),
    ).rejects.toBe(providerFailure);
  });
});
