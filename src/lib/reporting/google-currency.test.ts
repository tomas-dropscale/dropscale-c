import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  fxDailyRates: vi.fn(),
}));
vi.mock("@/lib/shopify/fx", () => ({
  fxDailyRates: mocks.fxDailyRates,
  // The real helper: exact day, else the closest earlier day's rate.
  rateOn: (pairs: [string, number][], day: string) => {
    const exact = pairs.find(([d]) => d === day);
    if (exact) return exact[1];
    const earlier = pairs.filter(([d]) => d < day).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    return earlier[0]?.[1] ?? pairs[0]![1];
  },
}));

import type { LiveCampaign } from "@/lib/google-ads/portal";
import type { ReportingCampaignTimelinePoint } from "@/lib/reporting/google";
import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import {
  convertBreakdownAtParentRate,
  convertCampaignTimeline,
  convertCampaigns,
  reportingMoneyRates,
} from "./google-currency";

function source(currency: string | null): CanonicalReportingSource {
  return {
    bindingId: "binding-1",
    clientId: "client-1",
    adAccountId: "account-1",
    kind: "google_ads",
    group: { id: "binding-anchor", shopifyAnchorBindingId: "binding-anchor", shopifyAnchorAdAccountId: "anchor" },
    shopify: null,
    googleAds: {
      connectionId: "google-1",
      windsorAccountId: "923-195-6172",
      accountId: "923-195-6172",
      customerId: "9231956172",
      accountName: "David & Tiago",
      currency,
      timeZone: "America/New_York",
      dataSourceId: null,
      healthError: null,
    },
  };
}

function campaign(overrides: Partial<LiveCampaign> = {}): LiveCampaign {
  return {
    id: "windsor-account-1-77",
    providerCampaignId: "77",
    ad_account_id: "account-1",
    name: "PMax",
    status: "active",
    spend: 100,
    impressions: 1000,
    clicks: 50,
    ctr: 0.05,
    cpc: 2,
    daily_budget: "40",
    updated_at: "2026-09-04T00:00:00.000Z",
    startDate: "2026-08-01",
    conversions: 4,
    conversionValue: 300,
    advertisingChannelType: "PERFORMANCE_MAX",
    shoppingFeed: true,
    googleRoas: 3,
    ...overrides,
  } as LiveCampaign;
}

function point(bucket: string, spend: number, campaignId = "77"): ReportingCampaignTimelinePoint {
  return {
    accountId: "account-1",
    campaignId,
    bucket,
    granularity: "day",
    spend,
    impressions: 10,
    clicks: 1,
    conversions: 0,
    googleRevenue: spend * 3,
  };
}

// USD -> EUR: 0.9 on the 3rd, 0.8 on the 4th.
const RATES: [string, number][] = [
  ["2026-09-03", 0.9],
  ["2026-09-04", 0.8],
];

describe("Google campaign money in the store's currency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fxDailyRates.mockResolvedValue(RATES);
  });

  it("asks for no rates when the account already bills in the store's currency", async () => {
    await expect(reportingMoneyRates(source("EUR"), "EUR", "2026-09-03", "2026-09-04")).resolves.toBeNull();
    await expect(reportingMoneyRates(source(null), "EUR", "2026-09-03", "2026-09-04")).resolves.toBeNull();
    expect(mocks.fxDailyRates).not.toHaveBeenCalled();
  });

  it("fetches the sync's per-day rates from the Google currency into the store's", async () => {
    await expect(reportingMoneyRates(source("USD"), "EUR", "2026-09-03", "2026-09-04")).resolves.toEqual(RATES);
    expect(mocks.fxDailyRates).toHaveBeenCalledWith("USD", "EUR", "2026-09-03", "2026-09-04");
  });

  it("converts every timeline point with its own day's rate, hour buckets included", () => {
    const converted = convertCampaignTimeline(
      [point("2026-09-03", 10), point("2026-09-04T13:00", 20)],
      RATES,
    );
    expect(converted.map((p) => [p.spend, p.googleRevenue])).toEqual([
      [9, 27],
      [16, 48],
    ]);
  });

  it("converts a campaign at its spend-weighted effective rate and keeps its own totals", () => {
    // 10 on the 3rd (0.9) + 30 on the 4th (0.8) -> effective 0.825.
    const [row] = convertCampaigns(
      [campaign({ spend: 100, conversionValue: 300, clicks: 50 })],
      RATES,
      [point("2026-09-03", 10), point("2026-09-04", 30)],
      "2026-09-04",
      "USD",
    );
    expect(row.spend).toBeCloseTo(82.5, 6);
    expect(row.conversionValue).toBeCloseTo(247.5, 6);
    expect(row.cpc).toBeCloseTo(1.65, 6);
    expect(row.googleRoas).toBeCloseTo(3, 6);
    // The budget is not converted: it is set in the account's own currency.
    expect(row.daily_budget).toBe("40");
    expect(row.budgetCurrency).toBe("USD");
  });

  it("falls back to the range's last day for a campaign with no timeline point", () => {
    const [row] = convertCampaigns(
      [campaign({ providerCampaignId: "99", spend: 50, conversionValue: 0, clicks: 0 })],
      RATES,
      [point("2026-09-03", 10, "77")],
      "2026-09-04",
      "USD",
    );
    expect(row.spend).toBeCloseTo(40, 6);
    expect(row.cpc).toBe(0);
    // Spend without conversion value is a measured zero return, as the reader reports it.
    expect(row.googleRoas).toBe(0);
  });
  it("converts breakdown rows at their parent campaign's rate, and leaves them alone otherwise", () => {
    const [parent] = convertCampaigns(
      [campaign({ spend: 100 })],
      RATES,
      [point("2026-09-03", 10), point("2026-09-04", 30)],
      "2026-09-04",
      "USD",
    );
    expect(parent.fxRate).toBeCloseTo(0.825, 6);
    const rows = [{ id: "ad-1", spend: 40, googleRevenue: 120 }];
    const [child] = convertBreakdownAtParentRate(rows, parent);
    expect(child.spend).toBeCloseTo(33, 6);
    expect(child.googleRevenue).toBeCloseTo(99, 6);
    // An unconverted parent (same-currency store) has no rate: rows untouched.
    expect(convertBreakdownAtParentRate(rows, campaign())).toEqual(rows);
  });
});
