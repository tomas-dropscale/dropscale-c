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

    // Profit is Shopify's sales minus spend, and the running total carries
    // the loss of the second day on from the first day's gain.
    expect(sheet.revenueBasis).toBe("shopify");
    expect(first!.profit).toBeCloseTo(164.8 - 120.06, 6);
    expect(first!.cumulative).toBeCloseTo(164.8 - 120.06, 6);
    expect(second!.profit).toBeCloseTo(-80.13, 6);
    expect(second!.cumulative).toBeCloseTo(164.8 - 200.19, 6);
    expect(sheet.total.profit).toBeCloseTo(164.8 - 200.19, 6);
  });

  it("measures profit on Google's conversion value when Shopify never answered", () => {
    // The Emma Gyor case: the ads carry no utm_campaign, Shopify sees plain
    // Google traffic, and the campaign has no Shopify sales to show - but
    // Google reports a conversion value every day, and a sheet of dashes
    // helps nobody. The basis is stated once for the whole sheet.
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          point({ bucket: "2026-09-01", spend: 99.84, googleRevenue: 150, addedToCart: null, shopifyRevenue: null, shopifyOrders: null, units: null }),
          point({ bucket: "2026-09-02", spend: 113.44, googleRevenue: 60, addedToCart: null, shopifyRevenue: null, shopifyOrders: null, units: null }),
        ],
      },
      "2026-09-11",
    );

    expect(sheet.revenueBasis).toBe("google");
    expect(sheet.rows[0]).toMatchObject({ revenue: null, googleRevenue: 150 });
    expect(sheet.rows[0]!.profit).toBeCloseTo(150 - 99.84, 6);
    expect(sheet.rows[1]!.profit).toBeCloseTo(60 - 113.44, 6);
    expect(sheet.rows[1]!.cumulative).toBeCloseTo(210 - 213.28, 6);
    expect(sheet.total.profit).toBeCloseTo(210 - 213.28, 6);
    // Shopify's own columns keep their dash: the basis changed, the facts did not.
    expect(sheet.total).toMatchObject({ revenue: null, orders: null, roas: null });
  });

  it("keeps a Shopify-basis sheet honest on a day Shopify left unanswered", () => {
    // One day answered, one not: the basis is Shopify, and the unanswered day
    // does not borrow Google's number - its profit and the running total read
    // "—" for that day and pick up again after.
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          point({ bucket: "2026-09-01", spend: 10, googleRevenue: 30, shopifyRevenue: 40, shopifyOrders: 1 }),
          point({ bucket: "2026-09-02", spend: 10, googleRevenue: 30, shopifyRevenue: null, shopifyOrders: null, addedToCart: null, units: null }),
          point({ bucket: "2026-09-03", spend: 10, googleRevenue: 30, shopifyRevenue: 5, shopifyOrders: 1 }),
        ],
      },
      "2026-09-11",
    );

    expect(sheet.revenueBasis).toBe("shopify");
    expect(sheet.rows.map((row) => row.profit)).toEqual([30, null, -5]);
    expect(sheet.rows.map((row) => row.cumulative)).toEqual([30, null, 25]);
    // The total is the sum of the rows, so the column and its foot agree: the
    // unanswered day's spend is not charged against a revenue nobody knows.
    expect(sheet.total.profit).toBe(25);
  });

  it("measures profit on the landing collection, minus product costs, when there is no UTM match", () => {
    // BOHO - HU lands on /collections/kenyelmes-ruhak. Shopify never matched
    // the campaign, but it knows what that page sold and what it cost.
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          point({
            bucket: "2026-09-05",
            spend: 104.2,
            googleRevenue: 300,
            shopifyRevenue: null, shopifyOrders: null, addedToCart: null, units: null,
            collectionRevenue: 450, collectionUnits: 3, collectionOrders: 2, collectionAddedToCart: 40, cogs: 90,
          }),
          point({
            bucket: "2026-09-06",
            spend: 117.81,
            googleRevenue: 100,
            shopifyRevenue: null, shopifyOrders: null, addedToCart: null, units: null,
            collectionRevenue: 0, collectionUnits: 0, collectionOrders: 0, collectionAddedToCart: 12, cogs: 0,
          }),
        ],
      },
      "2026-09-11",
    );

    expect(sheet.revenueBasis).toBe("collection");
    expect(sheet.rows[0]).toMatchObject({ revenue: 450, units: 3, orders: 2, addedToCart: 40, cogs: 90 });
    expect(sheet.rows[0]!.cvr).toBeCloseTo(2 / 40, 6);
    expect(sheet.rows[0]!.roas).toBeCloseTo(450 / 104.2, 6);
    expect(sheet.rows[0]!.cpa).toBeCloseTo(104.2 / 2, 6);
    // Revenue minus spend minus COGS, day by day and in the running total.
    expect(sheet.rows[0]!.profit).toBeCloseTo(450 - 104.2 - 90, 6);
    expect(sheet.rows[1]!.profit).toBeCloseTo(-117.81, 6);
    expect(sheet.rows[1]!.cumulative).toBeCloseTo(450 - 104.2 - 90 - 117.81, 6);
    expect(sheet.total).toMatchObject({ revenue: 450, orders: 2, units: 3, addedToCart: 52, cogs: 90 });
    expect(sheet.total.profit).toBeCloseTo(450 - 104.2 - 90 - 117.81, 6);
  });

  it("names the collection basis in the caption", () => {
    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="BOHO - HU - 30/07"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "unmatched",
          collectionHandle: "kenyelmes-ruhak",
          collectionSharedWith: 4,
          timeline: [
            point({
              bucket: "2026-09-05",
              spend: 104.2,
              googleRevenue: 300,
              shopifyRevenue: null, shopifyOrders: null, addedToCart: null, units: null,
              collectionRevenue: 450, collectionUnits: 3, collectionOrders: 2, collectionAddedToCart: 40, cogs: 90,
            }),
          ],
        }}
      />,
    );
    expect(html).toContain("every order that landed on /collections/kenyelmes-ruhak or a page under it");
    // Said plainly: the page's orders come from any channel, and the page is
    // shared between the campaigns that land on it.
    expect(html).toContain("from any channel, not only this campaign");
    expect(html).toContain("split between the 4 campaigns that land there");
    expect(html).toContain("COGS");
    expect(html).toContain("EUR 90.00");
    expect(html).toContain("the product costs of those lines");

    // Costs unreadable: the caption says so instead of promising a subtraction.
    const noCosts = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="BOHO - HU - 30/07"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "unmatched",
          collectionHandle: "kenyelmes-ruhak",
          collectionSharedWith: 1,
          timeline: [
            point({
              bucket: "2026-09-05",
              spend: 104.2,
              googleRevenue: 300,
              shopifyRevenue: null, shopifyOrders: null, addedToCart: null, units: null,
              collectionRevenue: 450, collectionUnits: 3, collectionOrders: 2, collectionAddedToCart: 40, cogs: null,
            }),
          ],
        }}
      />,
    );
    expect(noCosts).toContain("product costs could not be read");
    expect(noCosts).not.toContain("the product costs of those lines");
    expect(noCosts).not.toContain("split between");

    // A collection that sold nothing in the period is still the basis, with
    // real zeros, so the caption keeps naming the page rather than the UTMs.
    const quiet = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="BOHO - HU - 30/07"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "unmatched",
          collectionHandle: "kenyelmes-ruhak",
          collectionSharedWith: 1,
          timeline: [
            point({
              bucket: "2026-09-11T09:00:00",
              spend: 4.2,
              googleRevenue: 0,
              shopifyRevenue: null, shopifyOrders: null, addedToCart: null, units: null,
              collectionRevenue: 0, collectionUnits: 0, collectionOrders: 0, collectionAddedToCart: 0, cogs: 0,
            }),
          ],
        }}
      />,
    );
    expect(quiet).toContain("every order that landed on /collections/kenyelmes-ruhak");
    expect(quiet).not.toContain("utm_campaign");
    expect(quiet).toContain("in progress");
    // Named by its final URLs: nothing to add about where the clicks went.
    expect(quiet).not.toContain("from where its clicks landed");
  });

  it("says when the collection was read from where the clicks landed", () => {
    // A Performance Max campaign names no final URL; its collection is the
    // page most of its clicks landed on, and the caption must say so rather
    // than let the reader assume the ads point there. The same source also
    // covers a Search campaign whose final URLs name a product page that
    // redirects to a collection, so the caption may only claim what holds
    // for both: nothing but the clicks named a collection.
    const campaign = {
      attributionState: "unmatched" as const,
      collectionHandle: "handgjorda-vaskor",
      collectionSharedWith: 1,
      timeline: [
        point({
          bucket: "2026-09-05",
          spend: 104.2,
          googleRevenue: 300,
          shopifyRevenue: null, shopifyOrders: null, addedToCart: null, units: null,
          collectionRevenue: 450, collectionUnits: 3, collectionOrders: 2, collectionAddedToCart: 40, cogs: 90,
        }),
      ],
    };
    const landed = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="Tottebags - SWE"
        currency="EUR"
        today="2026-09-11"
        campaign={{ ...campaign, collectionSource: "landing" }}
      />,
    );
    expect(landed).toContain("every order that landed on /collections/handgjorda-vaskor");
    expect(landed).toContain("from where its clicks landed");
    expect(landed).toContain("final URLs nor its name names one");
    expect(landed).not.toContain("name no final URL");

    for (const collectionSource of ["final_url", "name"] as const) {
      const named = renderToStaticMarkup(
        <CampaignProfitLossSheet
          title="Tottebags - SWE"
          currency="EUR"
          today="2026-09-11"
          campaign={{ ...campaign, collectionSource }}
        />,
      );
      expect(named).toContain("every order that landed on /collections/handgjorda-vaskor");
      expect(named).not.toContain("from where its clicks landed");
    }
  });

  it("does not trust a revenue of 0 from a point written before the sheet existed", () => {
    // Snapshots written by the earlier producer carry shopifyRevenue 0 for a
    // campaign Shopify never matched, and no orders field at all. Read as a
    // fact, that 0 would put the sheet on a Shopify basis and print every day
    // as a loss. The missing orders field is the tell.
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          {
            bucket: "2026-09-05",
            spend: 62.76,
            impressions: 5_246,
            clicks: 419,
            conversions: 2,
            shopifyRevenue: 0,
            googleRevenue: 159.8,
            realRoas: 0,
            googleRoas: 2.55,
          },
        ],
      },
      "2026-09-11",
    );

    expect(sheet.revenueBasis).toBe("google");
    expect(sheet.predatesSheet).toBe(true);
    expect(sheet.rows[0]).toMatchObject({ revenue: null, orders: null, googleRevenue: 159.8 });
    expect(sheet.rows[0]!.profit).toBeCloseTo(159.8 - 62.76, 6);

    // And the caption says why the columns are empty, rather than blaming the
    // campaign's UTMs or its landing page.
    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="BOHO - HU - 30/07"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "unmatched",
          timeline: [
            {
              bucket: "2026-09-05",
              spend: 62.76,
              impressions: 5_246,
              clicks: 419,
              conversions: 2,
              shopifyRevenue: 0,
              googleRevenue: 159.8,
              realRoas: 0,
              googleRoas: 2.55,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("before the sheet existed");
    expect(html).not.toContain("lands on no single collection");
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
    expect(html).toContain("Profit on Shopify");
    expect(html).toContain("Cumulative");
    // Two orders on 57 cart additions, and 159.80 over 62.76.
    expect(html).toContain("3.5%");
    expect(html).toContain("2.55x");
    // A gain reads green, as in the store's own P&L.
    expect(html).toContain("--success-green");
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
          timeline: [point({ bucket: "2026-09-05", spend: 10, clicks: 5, impressions: 50, googleRevenue: 12, addedToCart: null, shopifyRevenue: null, shopifyOrders: null, units: null })],
        }}
      />,
    );
    expect(unmatched).toContain("Profit on Google");
    expect(unmatched).toContain("utm_campaign={campaignid}");
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
    expect(answered).toContain("Profit on Shopify");
    expect(answered).toContain("EUR 0.00");
  });
});
