import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ searchGoogleAds: vi.fn() }));

vi.mock("@/lib/google-ads/client", () => ({
  searchGoogleAds: mocks.searchGoogleAds,
}));
vi.mock("@/lib/portal/mock", () => ({ DROPSCALE_FEE_RATE: 0.1 }));

import {
  fetchLiveDailyBreakdown,
  fetchLiveCampaignsDetailed,
  fetchLiveDemandGenAdPerformance,
  fetchLiveGoogleCampaignBreakdowns,
  fetchLiveGoogleDemandGenBreakdowns,
  fetchLiveGooglePmaxProductBreakdowns,
  fetchLivePmaxProductPerformance,
} from "./portal";

describe("fetchLiveCampaignsDetailed", () => {
  beforeEach(() => mocks.searchGoogleAds.mockReset());

  it("uses the current Google Ads campaign start field and keeps its local day", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      {
        ...providerIdentity(),
        campaign: {
          id: "42",
          name: "Summer",
          status: "ENABLED",
          startDateTime: "2026-07-01 09:30:00",
          advertisingChannelType: "PERFORMANCE_MAX",
          shoppingSetting: { merchantId: "123456789" },
        },
        campaignBudget: { amountMicros: "35000000" },
        metrics: {
          costMicros: "125500000",
          impressions: "1000",
          clicks: "50",
          ctr: 0.05,
          averageCpc: "2510000",
          conversions: 4,
          conversionsValue: 490,
        },
      },
    ]);

    await expect(
      fetchLiveCampaignsDetailed("1234567890", "refresh", "account", {
        key: "d7",
        from: "2026-08-08",
        to: "2026-08-14",
      }, "EUR"),
    ).resolves.toMatchObject([
      {
        startDate: "2026-07-01",
        providerCampaignId: "42",
        shoppingFeed: true,
      },
    ]);

    const query = mocks.searchGoogleAds.mock.calls[0]?.[2] as string;
    expect(query).toContain("campaign.start_date_time");
    expect(query).toContain("campaign.shopping_setting.merchant_id");
    expect(query).toContain("customer.currency_code");
    expect(query).toContain("customer.time_zone");
    expect(query).toContain("LIMIT 1001");
    expect(query).not.toMatch(/campaign\.start_date(?:,|\s)/);
  });

  it("fails closed instead of inventing zero metrics from missing provider data", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      {
        ...providerIdentity(),
        campaign: {
          id: "42",
          name: "Summer",
          status: "PAUSED",
          startDateTime: "not-a-date",
          advertisingChannelType: "PERFORMANCE_MAX",
        },
        campaignBudget: { amountMicros: "1000000" },
        metrics: {},
      },
    ]);

    await expect(
      fetchLiveCampaignsDetailed(
        "1234567890",
        "refresh",
        "account",
        { key: "today", from: "2026-08-14", to: "2026-08-14" },
        "EUR",
      ),
    ).rejects.toThrow(/missing spend/);
  });

  it("fails closed on a malformed non-null campaign start date", async () => {
    mocks.searchGoogleAds.mockResolvedValue([{
      ...providerIdentity(),
      campaign: {
        id: "42",
        name: "Summer",
        status: "PAUSED",
        startDateTime: "not-a-date",
        advertisingChannelType: "PERFORMANCE_MAX",
      },
      campaignBudget: { amountMicros: "1000000" },
      metrics: campaignMetrics(),
    }]);

    await expect(
      fetchLiveCampaignsDetailed(
        "1234567890",
        "refresh",
        "account",
        { key: "today", from: "2026-08-14", to: "2026-08-14" },
        "EUR",
      ),
    ).rejects.toThrow(/invalid campaign start date/);
  });

  it("fails closed on malformed Merchant Center metadata", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      {
        ...providerIdentity(),
        campaign: {
          id: "42",
          name: "Summer",
          status: "ENABLED",
          advertisingChannelType: "PERFORMANCE_MAX",
          shoppingSetting: { merchantId: "not-a-merchant-id" },
        },
        campaignBudget: {},
        metrics: campaignMetrics(),
      },
    ]);

    await expect(
      fetchLiveCampaignsDetailed("1234567890", "refresh", "account", {
        key: "today",
        from: "2026-08-14",
        to: "2026-08-14",
      }, "EUR"),
    ).rejects.toThrow(/invalid shopping metadata/);
  });

  it.each([
    {
      label: "customer",
      customer: { id: "9999999999", currencyCode: "EUR", timeZone: "Europe/Lisbon" },
      expectedCurrency: "EUR",
    },
    {
      label: "currency",
      customer: { id: "1234567890", currencyCode: "USD", timeZone: "Europe/Lisbon" },
      expectedCurrency: "EUR",
    },
    {
      label: "time zone",
      customer: { id: "1234567890", currencyCode: "EUR", timeZone: "Not/A_Zone" },
      expectedCurrency: "EUR",
    },
  ])("fails closed on a mismatched $label", async ({ customer, expectedCurrency }) => {
    mocks.searchGoogleAds.mockResolvedValue([{
      customer,
      campaign: {
        id: "42",
        name: "Summer",
        status: "ENABLED",
        advertisingChannelType: "SEARCH",
      },
      campaignBudget: {},
      metrics: campaignMetrics(),
    }]);

    await expect(
      fetchLiveCampaignsDetailed(
        "1234567890",
        "refresh",
        "account",
        { key: "today", from: "2026-08-14", to: "2026-08-14" },
        expectedCurrency,
      ),
    ).rejects.toThrow(/different customer identity|different campaign currency/);
  });

  it("fails closed at the campaign row sentinel", async () => {
    mocks.searchGoogleAds.mockResolvedValue(
      Array.from({ length: 1001 }, () => ({})),
    );

    await expect(
      fetchLiveCampaignsDetailed(
        "1234567890",
        "refresh",
        "account",
        { key: "ytd", from: "2026-01-01", to: "2026-08-14" },
        "EUR",
      ),
    ).rejects.toThrow(/too many campaign rows/);
  });
});

describe("fetchLiveDailyBreakdown", () => {
  beforeEach(() => mocks.searchGoogleAds.mockReset());

  it("loads a strict bounded day in the exact Google identity and currency", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      dailyMetricRow({
        segments: { date: "2026-08-14" },
        metrics: {
          costMicros: "1250000",
          impressions: "100",
          clicks: "5",
          conversions: "1.5",
          conversionsValue: "12",
        },
      }),
    ]);

    await expect(
      fetchLiveDailyBreakdown(
        "1234567890",
        "refresh",
        "2026-08-13",
        "2026-08-14",
        "EUR",
      ),
    ).resolves.toEqual([{
      date: "2026-08-14",
      spend: 1.25,
      impressions: 100,
      clicks: 5,
      conversions: 1.5,
      conversionValue: 12,
    }]);

    const query = mocks.searchGoogleAds.mock.calls[0]?.[2] as string;
    expect(query).toContain("customer.id");
    expect(query).toContain("customer.currency_code");
    expect(query).toContain("customer.time_zone");
    expect(query).toContain("segments.date BETWEEN '2026-08-13' AND '2026-08-14'");
    expect(query).toContain("LIMIT 3");
  });

  it.each([
    ["customer", dailyMetricRow({ customer: { ...providerIdentity().customer, id: "9999999999" } })],
    ["currency", dailyMetricRow({ customer: { ...providerIdentity().customer, currencyCode: "USD" } })],
    ["time zone", dailyMetricRow({ customer: { ...providerIdentity().customer, timeZone: "Not/A_Zone" } })],
    ["out-of-range day", dailyMetricRow({ segments: { date: "2026-08-12" } })],
    ["missing metric", dailyMetricRow({ metrics: { ...campaignMetrics(), clicks: null } })],
  ])("fails closed on an invalid daily %s", async (_label, row) => {
    mocks.searchGoogleAds.mockResolvedValue([row]);

    await expect(
      fetchLiveDailyBreakdown(
        "1234567890",
        "refresh",
        "2026-08-13",
        "2026-08-14",
        "EUR",
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate days and sentinel equality before filling zeros", async () => {
    const row = dailyMetricRow();
    mocks.searchGoogleAds
      .mockResolvedValueOnce([row, row])
      .mockResolvedValueOnce([row, row]);

    await expect(
      fetchLiveDailyBreakdown(
        "1234567890",
        "refresh",
        "2026-08-13",
        "2026-08-14",
        "EUR",
      ),
    ).rejects.toThrow(/invalid daily reporting day/);
    await expect(
      fetchLiveDailyBreakdown(
        "1234567890",
        "refresh",
        "2026-08-14",
        "2026-08-14",
        "EUR",
      ),
    ).rejects.toThrow(/too many daily metric rows/);
  });

  it("rejects a range over 366 days before contacting Google", async () => {
    await expect(
      fetchLiveDailyBreakdown(
        "1234567890",
        "refresh",
        "2025-01-01",
        "2026-01-02",
        "EUR",
      ),
    ).rejects.toThrow(/daily reporting range/);
    expect(mocks.searchGoogleAds).not.toHaveBeenCalled();
  });
});

const DETAIL_RANGE = { from: "2026-08-08", to: "2026-08-14" };

function providerIdentity() {
  return {
    customer: {
      id: "1234567890",
      currencyCode: "EUR",
      timeZone: "Europe/Lisbon",
    },
  };
}

function campaignMetrics() {
  return {
    costMicros: "0",
    impressions: "0",
    clicks: "0",
    conversions: "0",
    conversionsValue: "0",
  };
}

function dailyMetricRow(overrides: Record<string, unknown> = {}) {
  return {
    ...providerIdentity(),
    segments: { date: "2026-08-14" },
    metrics: campaignMetrics(),
    ...overrides,
  };
}

describe("exact Google campaign breakdowns", () => {
  beforeEach(() => mocks.searchGoogleAds.mockReset());

  it("maps every Demand Gen image asset to its own provider metrics", async () => {
    mocks.searchGoogleAds
      .mockResolvedValueOnce([
        {
          ...providerIdentity(),
          campaign: { id: "42", advertisingChannelType: "DEMAND_GEN" },
          asset: { id: "9001" },
          adGroupAdAssetView: { fieldType: "MARKETING_IMAGE" },
          metrics: {
            costMicros: "125500000",
            impressions: "10000",
            clicks: "250",
            conversions: "12",
            conversionsValue: "490",
          },
        },
        {
          ...providerIdentity(),
          campaign: { id: "42", advertisingChannelType: "DEMAND_GEN" },
          asset: { id: "9002" },
          adGroupAdAssetView: { fieldType: "SQUARE_MARKETING_IMAGE" },
          metrics: {
            costMicros: "25000000",
            impressions: "2000",
            clicks: "50",
            conversions: "3",
            conversionsValue: "100",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          ...providerIdentity(),
          asset: {
            id: "9001",
            name: "Landscape",
            type: "IMAGE",
            imageAsset: { fullSize: { url: "https://google.example/landscape.jpg" } },
          },
        },
        {
          ...providerIdentity(),
          asset: {
            id: "9002",
            name: "Square",
            type: "IMAGE",
            imageAsset: { fullSize: { url: "https://google.example/square.jpg" } },
          },
        },
      ]);

    await expect(
      fetchLiveGoogleDemandGenBreakdowns(
        "123-456-7890",
        "refresh",
        "70000000-0000-4000-8000-000000000003",
        DETAIL_RANGE,
      ),
    ).resolves.toEqual([
      {
        accountId: "70000000-0000-4000-8000-000000000003",
        campaignId: "42",
        provider: "google_ads",
        kind: "creative",
        id: "9001",
        name: "Landscape",
        detail: "MARKETING_IMAGE",
        spend: 125.5,
        impressions: 10000,
        clicks: 250,
        conversions: 12,
        googleRevenue: 490,
        thumbnailUrl: "https://google.example/landscape.jpg",
        assetKind: "image",
      },
      {
        accountId: "70000000-0000-4000-8000-000000000003",
        campaignId: "42",
        provider: "google_ads",
        kind: "creative",
        id: "9002",
        name: "Square",
        detail: "SQUARE_MARKETING_IMAGE",
        spend: 25,
        impressions: 2000,
        clicks: 50,
        conversions: 3,
        googleRevenue: 100,
        thumbnailUrl: "https://google.example/square.jpg",
        assetKind: "image",
      },
    ]);

    const query = mocks.searchGoogleAds.mock.calls[0]?.[2] as string;
    expect(query).toContain("FROM ad_group_ad_asset_view");
    expect(query).toContain("campaign.advertising_channel_type = 'DEMAND_GEN'");
    expect(query).toContain("segments.date BETWEEN '2026-08-08' AND '2026-08-14'");
    expect(query).toContain("LIMIT 1001");
    expect(query).not.toContain("segments.date,");
    expect(mocks.searchGoogleAds.mock.calls[1]?.[2]).toContain(
      "asset.id IN (9001, 9002)",
    );
  });

  it("reads only PMax products with spend and preserves the full Merchant tuple", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      {
        ...providerIdentity(),
        campaign: { id: "84", advertisingChannelType: "PERFORMANCE_MAX" },
        segments: {
          productMerchantId: "123456789",
          productFeedLabel: "PT",
          productLanguage: "languageConstants/1014",
          productCountry: "geoTargetConstants/2620",
          productChannel: "ONLINE",
          productItemId: "shopify_PT_123_456",
          productTitle: "Linen dress",
          productBrand: "Northwind",
        },
        metrics: {
          costMicros: "25250000",
          impressions: "2000",
          clicks: "80",
          conversions: "3.5",
          conversionsValue: "120",
        },
      },
    ]);

    await expect(
      fetchLivePmaxProductPerformance(
        "1234567890",
        "refresh",
        "70000000-0000-4000-8000-000000000003",
        DETAIL_RANGE,
      ),
    ).resolves.toMatchObject([
      {
        providerCampaignId: "84",
        merchantId: "123456789",
        feedLabel: "PT",
        language: "languageConstants/1014",
        country: "geoTargetConstants/2620",
        channel: "ONLINE",
        itemId: "shopify_PT_123_456",
        title: "Linen dress",
        brand: "Northwind",
        spend: 25.25,
        conversions: 3.5,
        conversionValue: 120,
      },
    ]);

    const query = mocks.searchGoogleAds.mock.calls[0]?.[2] as string;
    expect(query).toContain("FROM shopping_performance_view");
    expect(query).toContain("campaign.advertising_channel_type = 'PERFORMANCE_MAX'");
    expect(query).toContain("metrics.cost_micros > 0");
    expect(query).toContain("segments.product_merchant_id");
    expect(query).toContain("segments.product_feed_label");
    expect(query).toContain("segments.date BETWEEN '2026-08-08' AND '2026-08-14'");
    expect(query).toContain("LIMIT 10001");
    expect(query).not.toContain("segments.date,");
  });

  it("fails closed on a different provider customer and on the sentinel row", async () => {
    mocks.searchGoogleAds.mockResolvedValueOnce([
      {
        ...providerIdentity(),
        customer: {
          ...providerIdentity().customer,
          id: "9876543210",
        },
        campaign: { id: "42", advertisingChannelType: "DEMAND_GEN" },
        adGroupAd: {
          status: "ENABLED",
          ad: { id: "1", type: "DEMAND_GEN_MULTI_ASSET_AD" },
        },
        metrics: {},
      },
    ]);
    await expect(
      fetchLiveDemandGenAdPerformance("1234567890", "refresh", "account", DETAIL_RANGE),
    ).rejects.toThrow(/different customer identity/);

    mocks.searchGoogleAds.mockResolvedValueOnce(
      Array.from({ length: 10_001 }, () => ({})),
    );
    await expect(
      fetchLivePmaxProductPerformance("1234567890", "refresh", "account", DETAIL_RANGE),
    ).rejects.toThrow(/too many Performance Max product rows/);
  });

  it("fails closed on missing metrics and a non-unique stable Merchant tuple", async () => {
    mocks.searchGoogleAds.mockResolvedValueOnce([
      {
        ...providerIdentity(),
        campaign: { id: "42", advertisingChannelType: "DEMAND_GEN" },
        asset: { id: "9001" },
        adGroupAdAssetView: { fieldType: "MARKETING_IMAGE" },
        metrics: {
          costMicros: "0",
          impressions: "0",
          clicks: "0",
          conversions: "0",
        },
      },
    ]);
    await expect(
      fetchLiveDemandGenAdPerformance("1234567890", "refresh", "account", DETAIL_RANGE),
    ).rejects.toThrow(/missing conversion value/);

    const product = (title: string, brand: string) => ({
      ...providerIdentity(),
      campaign: { id: "84", advertisingChannelType: "PERFORMANCE_MAX" },
      segments: {
        productMerchantId: "123456789",
        productFeedLabel: "PT",
        productLanguage: "languageConstants/1014",
        productCountry: "geoTargetConstants/2620",
        productChannel: "ONLINE",
        productItemId: "shopify_PT_123_456",
        productTitle: title,
        productBrand: brand,
      },
      metrics: {
        costMicros: "1000000",
        impressions: "10",
        clicks: "2",
        conversions: "1",
        conversionsValue: "5",
      },
    });
    mocks.searchGoogleAds.mockResolvedValueOnce([
      product("Old title", "Old brand"),
      product("New title", "New brand"),
    ]);
    await expect(
      fetchLivePmaxProductPerformance("1234567890", "refresh", "account", DETAIL_RANGE),
    ).rejects.toThrow(/non-unique PMax product identity/);
  });

  it("projects both provider families into the unified Analytics contract", async () => {
    mocks.searchGoogleAds
      .mockResolvedValueOnce([
        {
          ...providerIdentity(),
          campaign: { id: "42", advertisingChannelType: "DEMAND_GEN" },
          asset: { id: "9001" },
          adGroupAdAssetView: { fieldType: "SQUARE_MARKETING_IMAGE" },
          metrics: {
            costMicros: "1000000",
            impressions: "10",
            clicks: "2",
            conversions: "1",
            conversionsValue: "5",
          },
        },
      ])
      // PMax products start concurrently, so they claim the second call.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...providerIdentity(),
          asset: {
            id: "9001",
            name: "Square",
            type: "IMAGE",
            imageAsset: { fullSize: { url: "https://google.example/square.jpg" } },
          },
        },
      ]);

    await expect(
      fetchLiveGoogleCampaignBreakdowns(
        "1234567890",
        "refresh",
        "70000000-0000-4000-8000-000000000003",
        DETAIL_RANGE,
      ),
    ).resolves.toEqual([
      {
        accountId: "70000000-0000-4000-8000-000000000003",
        campaignId: "42",
        provider: "google_ads",
        kind: "creative",
        id: "9001",
        name: "Square",
        detail: "SQUARE_MARKETING_IMAGE",
        spend: 1,
        impressions: 10,
        clicks: 2,
        conversions: 1,
        googleRevenue: 5,
        thumbnailUrl: "https://google.example/square.jpg",
        assetKind: "image",
      },
    ]);
    expect(mocks.searchGoogleAds).toHaveBeenCalledTimes(3);
  });

  it("keeps the legacy creative and product reads independently settleable", async () => {
    const demandGenFailure = new Error("Demand Gen is unavailable");
    mocks.searchGoogleAds
      .mockRejectedValueOnce(demandGenFailure)
      .mockResolvedValueOnce([]);

    await expect(
      fetchLiveGoogleDemandGenBreakdowns(
        "1234567890",
        "refresh",
        "70000000-0000-4000-8000-000000000003",
        DETAIL_RANGE,
      ),
    ).rejects.toBe(demandGenFailure);
    await expect(
      fetchLiveGooglePmaxProductBreakdowns(
        "1234567890",
        "refresh",
        "70000000-0000-4000-8000-000000000003",
        DETAIL_RANGE,
      ),
    ).resolves.toEqual([]);
    expect(mocks.searchGoogleAds).toHaveBeenCalledTimes(2);
  });
});
