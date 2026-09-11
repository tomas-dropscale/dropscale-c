import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The project configures no "@/" alias for vitest; the formatters are given
// the same plain stand-ins the analytics view test uses.
vi.mock("@/lib/format", () => ({
  integer: (value: number) => String(value),
  money: (value: number, currency: string) => `${currency} ${value.toFixed(2)}`,
  multiplier: (value: number) => `${value.toFixed(2)}x`,
}));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

import type { AdminAnalyticsCampaignTimelinePoint } from "@/lib/admin/store-analytics";

import { buildCampaignProfitLoss, CampaignProfitLossSheet } from "./campaign-profit-loss";

function point(over: Partial<AdminAnalyticsCampaignTimelinePoint> & { bucket: string }): AdminAnalyticsCampaignTimelinePoint {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    shopifyRevenue: 0,
    shopifySessions: 0,
    addedToCart: 0,
    shopifyOrders: 0,
    units: 0,
    googleRevenue: 0,
    realRoas: null,
    googleRoas: null,
    ...over,
  };
}

describe("a campaign's profit and loss by day", () => {
  it("derives every ratio from the day's own figures, and the totals from the sum", () => {
    // The sheet the owner keeps by hand, two of its rows: 29 Aug converted,
    // 30 Aug did not. Ratios must come from the row, totals from the sums -
    // a total CPA that averaged the daily CPAs would be a different number.
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          point({ bucket: "2026-08-29", spend: 120.06, clicks: 916, impressions: 11_367, addedToCart: 35, shopifyRevenue: 164.8, shopifyOrders: 1, units: 4 }),
          point({ bucket: "2026-08-30", spend: 80.13, clicks: 725, impressions: 9_304, addedToCart: 21, shopifyRevenue: 0, shopifyOrders: 0, units: 0 }),
        ],
      },
      "2026-09-11",
    );

    expect(sheet.rows).toHaveLength(2);
    const [first, second] = sheet.rows;
    expect(first).toMatchObject({ day: "2026-08-29", inProgress: false });
    expect(first!.ctr).toBeCloseTo(916 / 11_367, 6);
    expect(first!.cvr).toBeCloseTo(1 / 35, 6);
    expect(first!.roas).toBeCloseTo(164.8 / 120.06, 6);
    expect(first!.cpa).toBeCloseTo(120.06, 6);
    expect(second).toMatchObject({ cvr: 0, roas: 0, cpa: null });

    expect(sheet.total.spend).toBeCloseTo(200.19, 6);
    expect(sheet.total).toMatchObject({ clicks: 1_641, impressions: 20_671, addedToCart: 56, orders: 1, units: 4 });
    expect(sheet.total.revenue).toBeCloseTo(164.8, 6);
    expect(sheet.total.cvr).toBeCloseTo(1 / 56, 6);
    expect(sheet.total.roas).toBeCloseTo(164.8 / 200.19, 6);
    expect(sheet.total.cpa).toBeCloseTo(200.19, 6);
  });

  it("folds an hourly timeline into days and marks the day still running", () => {
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          point({ bucket: "2026-09-11T09:00:00", spend: 10, clicks: 50, impressions: 500, addedToCart: 2, shopifyRevenue: 40, shopifyOrders: 1, units: 1 }),
          point({ bucket: "2026-09-11T10:00:00", spend: 5, clicks: 25, impressions: 250, addedToCart: 1, shopifyRevenue: 0, shopifyOrders: 0, units: 0 }),
        ],
      },
      "2026-09-11",
    );

    expect(sheet.rows).toEqual([
      expect.objectContaining({
        day: "2026-09-11",
        spend: 15,
        clicks: 75,
        impressions: 750,
        addedToCart: 3,
        revenue: 40,
        orders: 1,
        units: 1,
        inProgress: true,
      }),
    ]);
  });

  it("keeps a day Shopify has not answered for apart from a day it answered zero", () => {
    // A dash is the absence of a fact; a zero is one. Attribution unavailable
    // arrives as null, and the ratios that need it stay null with it.
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          point({ bucket: "2026-09-01", spend: 30, clicks: 100, impressions: 1_000, shopifyRevenue: null, addedToCart: null, shopifyOrders: null, units: null }),
        ],
      },
      "2026-09-11",
    );

    expect(sheet.rows[0]).toMatchObject({
      spend: 30,
      addedToCart: null,
      revenue: null,
      orders: null,
      units: null,
      cvr: null,
      roas: null,
      cpa: null,
    });
    expect(sheet.rows[0]!.ctr).toBeCloseTo(0.1, 6);
    expect(sheet.total).toMatchObject({ addedToCart: null, revenue: null, orders: null, units: null });
  });

  it("renders the sheet with a row per day, a total, and the dash where Shopify said nothing", () => {
    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="Tottebags - SWE"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "matched",
          timeline: [
            point({ bucket: "2026-09-05", spend: 62.76, clicks: 419, impressions: 5_246, addedToCart: 57, shopifyRevenue: 159.8, shopifyOrders: 2, units: 4 }),
            point({ bucket: "2026-09-11", spend: 3, clicks: 10, impressions: 100, addedToCart: null, shopifyRevenue: null, shopifyOrders: null, units: null }),
          ],
        }}
      />,
    );

    expect(html).toContain("Profit &amp; loss by day");
    expect(html).toContain("2026-09-05");
    expect(html).toContain("in progress");
    expect(html).toContain("Total");
    // Two orders on 57 cart additions, and 159.80 over 62.76.
    expect(html).toContain("3.5%");
    expect(html).toContain("2.55x");
    // The unanswered day prints a dash, not a zero, for Shopify's columns.
    expect((html.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("only promises a dash when the cells print one", () => {
    // A campaign the attribution never matched carries null all the way down,
    // and the caption says so. Had a day come back as a number, the caption
    // would have to say the sales are real - the sentence follows the sheet.
    const unmatched = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="Orphan"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "unmatched",
          timeline: [point({ bucket: "2026-09-05", spend: 10, clicks: 5, impressions: 50, addedToCart: null, shopifyRevenue: null, shopifyOrders: null, units: null })],
        }}
      />,
    );
    expect(unmatched).toContain("so sales read “—”");
    expect(unmatched).not.toContain("EUR 0.00");

    const answered = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="Answered"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "unmatched",
          timeline: [point({ bucket: "2026-09-05", spend: 10, clicks: 5, impressions: 50, addedToCart: 0, shopifyRevenue: 0, shopifyOrders: 0, units: 0 })],
        }}
      />,
    );
    expect(answered).not.toContain("so sales read “—”");
    expect(answered).toContain("EUR 0.00");
  });
});
