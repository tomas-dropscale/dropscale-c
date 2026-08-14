import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import {
  fetchGoogleReportingCampaigns,
  fetchGoogleReportingDailyMetrics,
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
        fetcher,
      ),
    ).rejects.toThrow(/different Google Ads reporting identity/);
  });
});
