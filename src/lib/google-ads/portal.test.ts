import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ searchGoogleAds: vi.fn() }));

vi.mock("@/lib/google-ads/client", () => ({
  searchGoogleAds: mocks.searchGoogleAds,
}));
vi.mock("@/lib/portal/mock", () => ({ DROPSCALE_FEE_RATE: 0.1 }));

import { fetchLiveCampaignsDetailed } from "./portal";

describe("fetchLiveCampaignsDetailed", () => {
  beforeEach(() => mocks.searchGoogleAds.mockReset());

  it("uses the current Google Ads campaign start field and keeps its local day", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      {
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
      }),
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
    expect(query).not.toMatch(/campaign\.start_date(?:,|\s)/);
  });

  it("does not invent a start day from malformed provider data", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      {
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

    const [campaign] = await fetchLiveCampaignsDetailed(
      "1234567890",
      "refresh",
      "account",
      { key: "today", from: "2026-08-14", to: "2026-08-14" },
    );
    expect(campaign.startDate).toBeNull();
    expect(campaign.shoppingFeed).toBe(false);
  });

  it("fails closed on malformed Merchant Center metadata", async () => {
    mocks.searchGoogleAds.mockResolvedValue([
      {
        campaign: {
          id: "42",
          name: "Summer",
          status: "ENABLED",
          advertisingChannelType: "PERFORMANCE_MAX",
          shoppingSetting: { merchantId: "not-a-merchant-id" },
        },
        campaignBudget: {},
        metrics: {},
      },
    ]);

    await expect(
      fetchLiveCampaignsDetailed("1234567890", "refresh", "account", {
        key: "today",
        from: "2026-08-14",
        to: "2026-08-14",
      }),
    ).rejects.toThrow(/invalid shopping metadata/);
  });
});
