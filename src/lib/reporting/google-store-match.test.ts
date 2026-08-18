import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import {
  fetchGoogleReportingCampaignTimeline,
  fetchGoogleReportingCampaigns,
  fetchGoogleReportingDemandGenAds,
} from "./google";

const pairedSource: CanonicalReportingSource = {
  bindingId: "80000000-0000-4000-8000-000000000001",
  clientId: "80000000-0000-4000-8000-000000000002",
  adAccountId: "80000000-0000-4000-8000-000000000003",
  kind: "google_ads",
  group: {
    id: "80000000-0000-4000-8000-000000000001",
    shopifyAnchorBindingId: null,
    shopifyAnchorAdAccountId: null,
  },
  shopify: {
    connectionId: "80000000-0000-4000-8000-000000000005",
    shopId: "1",
    shopifyName: "Aki Nikko",
    domain: "pbfvnb-em.myshopify.com",
    primaryDomain: "akinikko.com",
    currency: "EUR",
    credential: null,
  },
  googleAds: {
    connectionId: "80000000-0000-4000-8000-000000000004",
    windsorAccountId: "630-287-6795",
    accountId: "630-287-6795",
    customerId: "6302876795",
    accountName: "Daniel Azevedo-Casa Luna",
    currency: "EUR",
    timeZone: "Europe/Lisbon",
    dataSourceId: "source",
  },
} as CanonicalReportingSource;

const identity = {
  accountId: "630-287-6795",
  customerId: "6302876795",
  currency: "EUR",
  timeZone: "Europe/Lisbon",
};

const campaignRow = (
  campaignId: string,
  name: string,
  finalUrls: string[] | undefined,
) => ({
  ...identity,
  campaignId,
  name,
  status: "ENABLED" as const,
  advertisingChannelType: "DEMAND_GEN",
  shoppingFeed: false,
  biddingStrategyType: null,
  startDate: null,
  dailyBudget: 24,
  spend: 50,
  impressions: 1_000,
  clicks: 100,
  conversions: 2,
  conversionValue: 80,
  ...(finalUrls ? { finalUrls } : {}),
});

describe("Destination-URL attribution in the V2 Google adapter", () => {
  it("drops campaigns whose final URLs point at another store's domain", async () => {
    const campaigns = await fetchGoogleReportingCampaigns(
      pairedSource,
      "2026-08-10",
      "2026-08-16",
      async () => [
        campaignRow("1", "JP - TOTTEBAGS", [
          "https://akinikko.com/collections/bags",
        ]),
        campaignRow("2", "25-07 - Lamparas Artesanales", [
          "https://casa-luna-artesanias.com/en/collections/lamparas-artesanales",
        ]),
        campaignRow("3", "Sem URL", undefined),
      ],
    );
    expect(campaigns.map((campaign) => campaign.name)).toEqual([
      "JP - TOTTEBAGS",
      "Sem URL",
    ]);
  });

  it("keeps every campaign for a source without a Shopify domain", async () => {
    const googleOnly = { ...pairedSource, shopify: null };
    const campaigns = await fetchGoogleReportingCampaigns(
      googleOnly,
      "2026-08-10",
      "2026-08-16",
      async () => [
        campaignRow("2", "25-07 - Lamparas Artesanales", [
          "https://casa-luna-artesanias.com/x",
        ]),
      ],
    );
    expect(campaigns).toHaveLength(1);
  });

  it("filters timeline buckets through the campaign→URL read", async () => {
    const bucket = (campaignId: string, date: string) => ({
      ...identity,
      campaignId,
      date,
      bucket: date,
      granularity: "day" as const,
      spend: 10,
      impressions: 100,
      clicks: 5,
      conversions: 1,
      conversionValue: 20,
    });
    const urlsFetcher = vi.fn(async () =>
      new Map([
        ["1", ["https://akinikko.com/collections/bags"]],
        ["2", ["https://casa-luna-artesanias.com/x"]],
      ]),
    );
    const points = await fetchGoogleReportingCampaignTimeline(
      pairedSource,
      "2026-08-10",
      "2026-08-11",
      async () => [
        bucket("1", "2026-08-10"),
        bucket("2", "2026-08-10"),
        bucket("1", "2026-08-11"),
      ],
      urlsFetcher,
    );
    expect(points.map((point) => point.campaignId)).toEqual(["1", "1"]);
    expect(urlsFetcher).toHaveBeenCalledWith(
      "630-287-6795",
      "2026-08-10",
      "2026-08-11",
    );
  });

  it("filters Demand Gen ad detail by its campaign's destination", async () => {
    const ad = (campaignId: string, adId: string) => ({
      ...identity,
      campaignId,
      adId,
      name: `ad-${adId}`,
      type: "DEMAND_GEN_MULTI_ASSET_AD",
      spend: 5,
      impressions: 50,
      clicks: 2,
      conversions: 0,
      conversionValue: 0,
    });
    const rows = await fetchGoogleReportingDemandGenAds(
      pairedSource,
      "2026-08-10",
      "2026-08-16",
      async () => [ad("1", "11"), ad("2", "22")],
      async () =>
        new Map([
          ["1", ["https://akinikko.com/collections/bags"]],
          ["2", ["https://casa-luna-artesanias.com/x"]],
        ]),
    );
    expect(rows.map((row) => row.id)).toEqual(["11"]);
  });
});
