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

import type {
  AdminAnalyticsCampaign,
  AdminAnalyticsCampaignTimelinePoint,
  CampaignSheetFees,
} from "@/lib/admin/store-analytics";

import { buildCampaignProfitLoss, buildCollectionCampaign, CampaignProfitLossSheet } from "./campaign-profit-loss";

/** The settings the Emma Gyor sheet applies: Shopify Payments' 0.25 + 1.7%, a flat shipping cost, the 10% agency fee. */
const FEES: CampaignSheetFees = { paymentFeePct: 1.7, paymentFeeFixed: 0.25, shippingCostPerOrder: 1.5, agencyFeeRate: 10 };

/** A collection-basis day, as the producer writes it for a campaign with no UTM match. */
function collectionDay(
  bucket: string,
  over: Partial<AdminAnalyticsCampaignTimelinePoint>,
): AdminAnalyticsCampaignTimelinePoint {
  return point({
    bucket,
    shopifyRevenue: null,
    shopifyOrders: null,
    addedToCart: null,
    units: null,
    ...over,
  });
}

function member(
  over: Partial<AdminAnalyticsCampaign> & { timeline: AdminAnalyticsCampaignTimelinePoint[] },
): Pick<AdminAnalyticsCampaign, "timeline" | "attributionState" | "collectionHandle" | "collectionSource"> {
  return {
    attributionState: "unmatched",
    collectionHandle: "mintas-kardiganok",
    collectionSource: "final_url",
    ...over,
  };
}

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
  it("withholds an individual ROAS when Google collection sales cannot be assigned, including zero spend shares", () => {
    const timeline = [point({ bucket: "2026-09-20", spend: 20, firstLanding: { collection: { revenue: 120, orders: 3, units: 3, cogs: 15 }, campaign: { revenue: 30, orders: 1, units: 1, cogs: 5 }, unassignedGoogleRevenue: 90, campaignComplete: false } })];
    expect(buildCampaignProfitLoss({ timeline }, "2026-09-25", FEES, true).total.roas).toBeNull();
    expect(buildCampaignProfitLoss({ timeline, members: 2 }, "2026-09-25", FEES, true).total.roas).toBe(6);
    const html = renderToStaticMarkup(<CampaignProfitLossSheet title="Summer" currency="EUR" today="2026-09-25" campaign={{ timeline, collectionHandle: "summer", attributionState: "unmatched" }} />);
    expect(html).toContain("Individual campaign ROAS and conversion value reported by Google");
    expect(html).toContain("0.00x");
    expect(html).not.toContain("utm_campaign={campaignid}");
    const zeroShare = { ...timeline[0], firstLanding: { ...timeline[0].firstLanding!, unassignedGoogleRevenue: 0 } };
    expect(buildCampaignProfitLoss({ timeline: [zeroShare] }, "2026-09-25", FEES, true).total.roas).toBeNull();
  });
  it("uses first-landing collection items across channels for overall, but exact Google campaign items individually", () => {
    const timeline = [point({ bucket: "2026-09-20", spend: 20, googleRevenue: 500, shopifyRevenue: 900, collectionRevenue: 1000,
      firstLanding: { collection: { revenue: 120, orders: 3, units: 4, cogs: 30 }, campaign: { revenue: 60, orders: 1, units: 2, cogs: 15 }, unassignedGoogleRevenue: 0 },
    })];
    const own = buildCampaignProfitLoss({ timeline }, "2026-09-25", FEES, true);
    const overall = buildCampaignProfitLoss({ timeline, members: 2 }, "2026-09-25", FEES, true);
    expect(own.total).toMatchObject({ revenue: 60, roas: 3, orders: 1, units: 2, cogs: 15, addedToCart: null, cvr: null });
    expect(own.total.paymentFees).toBeCloseTo(1.27);
    expect(own.total.profit).toBeCloseTo(60 - 20 - 15 - 1.27 - 1.5 - 2);
    expect(overall.total).toMatchObject({ revenue: 120, roas: 6, orders: 3, units: 4, cogs: 30 });
    const html = renderToStaticMarkup(<CampaignProfitLossSheet title="Summer" currency="EUR" today="2026-09-25" campaign={{ timeline, collectionHandle: "summer", attributionState: "matched" }} fees={FEES} />);
    expect(html).toContain("Individual campaign ROAS and conversion value reported by Google");
    expect(html).toContain("EUR 500.00");
    expect(html).toContain("25.00x");
    expect(html).not.toContain("Where the sales came from");
  });

  it("does not substitute Google or product revenue for old and incomplete first-visit snapshots", () => {
    const known = point({ bucket: "2026-09-20", spend: 20, firstLanding: { collection: { revenue: 60, orders: 1, units: 1, cogs: 10 }, campaign: { revenue: 30, orders: 1, units: 1, cogs: 10 }, unassignedGoogleRevenue: 0 } });
    const old = point({ bucket: "2026-09-21", spend: 40, googleRevenue: 900, collectionRevenue: 500, shopifyRevenue: 700 });
    const sheet = buildCampaignProfitLoss({ timeline: [known, old] }, "2026-09-25", FEES, true);
    expect(sheet.rows[1]).toMatchObject({ revenue: null, profit: null, roas: null });
    expect(sheet.total).toMatchObject({ revenue: null, roas: null, profit: null });
    expect(sheet.predatesSheet).toBe(true);
    const collection = buildCollectionCampaign([member({ timeline: [known] }), member({ timeline: [{ ...old, bucket: known.bucket }] })])!;
    expect(buildCampaignProfitLoss(collection, "2026-09-25", FEES, true).total.roas).toBeNull();
  });

  it("folds first-visit figures only once per day and distinguishes measured zero from unavailable", () => {
    const zero = { revenue: 0, orders: 0, units: 0, cogs: 0 };
    const timeline = [point({ bucket: "2026-09-20T10:00:00", spend: 10, firstLanding: { collection: { ...zero, revenue: 60 }, campaign: { ...zero, revenue: 30 }, unassignedGoogleRevenue: 0 } }), point({ bucket: "2026-09-20T11:00:00", spend: 10, firstLanding: { collection: zero, campaign: zero, unassignedGoogleRevenue: 0 } })];
    const sheet = buildCampaignProfitLoss({ timeline }, "2026-09-25", null, true);
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.total).toMatchObject({ revenue: 30, spend: 20, roas: 1.5 });
    expect(buildCampaignProfitLoss({ timeline: [timeline[1]] }, "2026-09-25", null, true).total.roas).toBe(0);
  });
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
    expect(sheet.total).toMatchObject({ revenue: null, orders: null });
    expect(sheet.total.roas).toBeCloseTo(210 / 213.28);
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
    expect(html).toContain("Individual campaign ROAS and conversion value reported by Google");
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
    // Shopify fields stay unknown; Google's measured zero is still a fact.
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
      roas: 0,
      cpa: null,
    });
    expect(sheet.rows[0]!.ctr).toBeCloseTo(0.1, 6);
    expect(sheet.total).toMatchObject({ addedToCart: null, revenue: null, orders: null, units: null });
  });


});

describe("the fee columns", () => {
  // BOHO - HU, two days: one that sold, one that did not.
  const days = [
    collectionDay("2026-09-05", {
      spend: 104.2, googleRevenue: 300,
      collectionRevenue: 450, collectionUnits: 3, collectionOrders: 2, collectionAddedToCart: 40, cogs: 90,
    }),
    collectionDay("2026-09-06", {
      spend: 117.81, googleRevenue: 100,
      collectionRevenue: 0, collectionUnits: 0, collectionOrders: 0, collectionAddedToCart: 12, cogs: 0,
    }),
  ];

  it("prices Shopify fees, shipping and the agency fee from the store's settings and takes them off the profit", () => {
    // The client's sheet: payment fee = orders × 0.25 + net sales × 1.7%,
    // shipping per order, agency fee 10% of ad spend, and profit after all
    // of them and COGS. Day by day, then the running total, then the foot.
    const sheet = buildCampaignProfitLoss({ timeline: days }, "2026-09-11", FEES);
    const [first, second] = sheet.rows;
    expect(first!.paymentFees).toBeCloseTo(2 * 0.25 + 450 * 0.017, 6);
    expect(first!.shipping).toBeCloseTo(3, 6);
    expect(first!.agencyFee).toBeCloseTo(10.42, 6);
    const firstProfit = 450 - 90 - 104.2 - 8.15 - 3 - 10.42;
    expect(first!.profit).toBeCloseTo(firstProfit, 6);
    // No orders: nothing per order, but the agency still bills the spend.
    expect(second).toMatchObject({ paymentFees: 0, shipping: 0 });
    expect(second!.agencyFee).toBeCloseTo(11.781, 6);
    expect(second!.profit).toBeCloseTo(-117.81 - 11.781, 6);
    expect(second!.cumulative).toBeCloseTo(firstProfit - 117.81 - 11.781, 6);
    expect(sheet.total.paymentFees).toBeCloseTo(8.15, 6);
    expect(sheet.total.shipping).toBeCloseTo(3, 6);
    expect(sheet.total.agencyFee).toBeCloseTo(22.201, 6);
    expect(sheet.total.profit).toBeCloseTo(firstProfit - 117.81 - 11.781, 6);
  });




  it("leaves a day whose revenue is unknown without a profit, fees or not", () => {
    const sheet = buildCampaignProfitLoss(
      {
        timeline: [
          collectionDay("2026-09-05", { spend: 10, collectionRevenue: 100, collectionUnits: 1, collectionOrders: 1, collectionAddedToCart: 5, cogs: 20 }),
          collectionDay("2026-09-06", { spend: 10, collectionRevenue: null, collectionUnits: null, collectionOrders: null, collectionAddedToCart: null, cogs: null }),
        ],
      },
      "2026-09-11",
      FEES,
    );
    expect(sheet.revenueBasis).toBe("collection");
    expect(sheet.rows[1]).toMatchObject({ paymentFees: null, shipping: null, agencyFee: 1, profit: null, cumulative: null });
    // The foot sums the rows: the unknown day's agency fee is a fact and
    // counts, its profit is not and does not.
    expect(sheet.total.agencyFee).toBeCloseTo(2, 6);
    expect(sheet.total.profit).toBeCloseTo(100 - 10 - 20 - (0.25 + 1.7) - 1.5 - 1, 6);
  });
});

describe("where the collection's sales came from", () => {
  /**
   * The Emma Gyor shape, rounded: most of the page's revenue is bought by
   * people who landed on it, a little by people who found the items some
   * other way, and the page separately brings in orders that buy nothing of
   * the collection at all, which the client's own sheet counts as zero.
   */
  const days = [
    collectionDay("2026-09-05", {
      spend: 100, googleRevenue: 300,
      collectionRevenue: 300, collectionUnits: 3, collectionOrders: 3, collectionAddedToCart: 40, cogs: 60,
      collectionLandedRevenue: 240, collectionLandedUnits: 2, collectionLandedOrders: 2,
      collectionUnknownRevenue: 0, collectionUnknownOrders: 0,
      collectionBroughtRevenue: 150, collectionBroughtOrders: 1,
    }),
    collectionDay("2026-09-06", {
      spend: 50, googleRevenue: 100,
      collectionRevenue: 100, collectionUnits: 1, collectionOrders: 1, collectionAddedToCart: 12, cogs: 20,
      collectionLandedRevenue: 60, collectionLandedUnits: 1, collectionLandedOrders: 1,
      collectionUnknownRevenue: 0, collectionUnknownOrders: 0,
      collectionBroughtRevenue: 50, collectionBroughtOrders: 1,
    }),
  ];

  /** The same days before the split was computed: the total is there, its arrival is not. */
  const withoutSplit = days.map((day) =>
    collectionDay(day.bucket, {
      ...day,
      collectionLandedRevenue: null, collectionLandedUnits: null, collectionLandedOrders: null,
      collectionUnknownRevenue: null, collectionUnknownOrders: null,
      collectionBroughtRevenue: null, collectionBroughtOrders: null,
    }),
  );

  const sheetOf = (timeline: AdminAnalyticsCampaignTimelinePoint[], over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="BOHO - HU - 30/07"
        currency="EUR"
        today="2026-09-11"
        campaign={{
          attributionState: "unmatched",
          collectionHandle: "kenyelmes-ruhak",
          collectionSharedWith: 1,
          timeline,
          ...over,
        }}
      />,
    );

  it("folds the split into the total, and leaves the daily rows the width they were", () => {
    const sheet = buildCampaignProfitLoss({ timeline: days }, "2026-09-11");

    expect(sheet.revenueBasis).toBe("collection");
    expect(sheet.total).toMatchObject({
      revenue: 400,
      orders: 4,
      landedRevenue: 300,
      landedUnits: 3,
      landedOrders: 3,
      broughtRevenue: 200,
      broughtOrders: 2,
    });
    // The landed part is inside the total; what the page brought in is not.
    expect(sheet.total.landedRevenue! + (sheet.total.revenue! - sheet.total.landedRevenue!)).toBe(400);
    expect(sheet.rows[0]).not.toHaveProperty("landedRevenue");
  });

  it("withholds the split when a day whose revenue is in the total never measured its arrival", () => {
    // Summed permissively this reads 240 landed of 400, and the other day's
    // 100 falls into the line that says the page did nothing for it - a
    // measurement that day never made. Unknown is the only honest answer.
    const mixed = buildCampaignProfitLoss({ timeline: [days[0]!, withoutSplit[1]!] }, "2026-09-11");
    expect(mixed.total).toMatchObject({
      revenue: 400,
      landedRevenue: null,
      unknownRevenue: null,
      broughtRevenue: null,
    });
    expect(sheetOf([days[0]!, withoutSplit[1]!])).not.toContain("Where the sales came from");

    // A day the orders could not be read for at all is in neither sum: the
    // revenue total is the days that answered, and so is their split.
    const unread = collectionDay("2026-09-06", {
      spend: 50, collectionRevenue: null, collectionUnits: null, collectionOrders: null,
      collectionAddedToCart: null, cogs: null,
      collectionLandedRevenue: null, collectionLandedUnits: null, collectionLandedOrders: null,
      collectionUnknownRevenue: null, collectionUnknownOrders: null,
      collectionBroughtRevenue: null, collectionBroughtOrders: null,
    });
    expect(buildCampaignProfitLoss({ timeline: [days[0]!, unread] }, "2026-09-11").total).toMatchObject({
      revenue: 300,
      landedRevenue: 240,
      broughtRevenue: 150,
    });

    const none = buildCampaignProfitLoss({ timeline: withoutSplit }, "2026-09-11");
    expect(none.total).toMatchObject({
      revenue: 400,
      landedRevenue: null,
      landedUnits: null,
      landedOrders: null,
      unknownRevenue: null,
      unknownOrders: null,
      broughtRevenue: null,
      broughtOrders: null,
    });
  });

  it("says nothing about arrival on the Shopify or the Google basis", () => {
    // Shopify matched this campaign's own UTMs, so the sheet's revenue is not
    // the collection's and a share of it would divide two different measures.
    const shopify = buildCampaignProfitLoss(
      {
        timeline: [
          point({
            bucket: "2026-09-05", spend: 10, addedToCart: 5, shopifyRevenue: 40, shopifyOrders: 1, units: 1,
            collectionRevenue: 300, collectionUnits: 3, collectionOrders: 3, collectionAddedToCart: 40, cogs: 60,
            collectionLandedRevenue: 240, collectionLandedUnits: 2, collectionLandedOrders: 2,
            collectionBroughtRevenue: 150, collectionBroughtOrders: 1,
          }),
        ],
      },
      "2026-09-11",
    );
    expect(shopify.revenueBasis).toBe("shopify");
    expect(shopify.total).toMatchObject({ landedRevenue: null, landedOrders: null, broughtRevenue: null });
    expect(
      renderToStaticMarkup(
        <CampaignProfitLossSheet
          title="Matched"
          currency="EUR"
          today="2026-09-11"
          campaign={{
            attributionState: "matched",
            collectionHandle: "kenyelmes-ruhak",
            timeline: [
              point({
                bucket: "2026-09-05", spend: 10, addedToCart: 5, shopifyRevenue: 40, shopifyOrders: 1, units: 1,
                collectionRevenue: 300, collectionUnits: 3, collectionOrders: 3, collectionAddedToCart: 40, cogs: 60,
                collectionLandedRevenue: 240, collectionLandedUnits: 2, collectionLandedOrders: 2,
                collectionBroughtRevenue: 150, collectionBroughtOrders: 1,
              }),
            ],
          }}
        />,
      ),
    ).not.toContain("Where the sales came from");

    // Nothing was read from the orders at all, so the basis is Google's
    // conversion value and there is no collection total to split.
    const unknown = { collectionRevenue: null, collectionUnits: null, collectionOrders: null, collectionAddedToCart: null, cogs: null };
    const google = buildCampaignProfitLoss(
      {
        timeline: [
          collectionDay("2026-09-05", {
            spend: 10, googleRevenue: 30, ...unknown,
            collectionLandedRevenue: 240, collectionLandedUnits: 2, collectionLandedOrders: 2,
            collectionBroughtRevenue: 150, collectionBroughtOrders: 1,
          }),
        ],
      },
      "2026-09-11",
    );
    expect(google.revenueBasis).toBe("google");
    expect(google.total).toMatchObject({ landedRevenue: null, broughtRevenue: null });
    expect(
      sheetOf([
        collectionDay("2026-09-05", {
          spend: 10, googleRevenue: 30, ...unknown,
          collectionLandedRevenue: 240, collectionLandedUnits: 2, collectionLandedOrders: 2,
          collectionBroughtRevenue: 150, collectionBroughtOrders: 1,
        }),
      ]),
    ).not.toContain("Where the sales came from");
  });





  it("carries the split through the sum of the campaigns landing on one page", () => {
    // Each campaign holds its spend share of the same day; the collection's
    // sheet adds the shares back to the page's whole, arrival included.
    const first = member({
      timeline: [
        collectionDay("2026-09-05", {
          spend: 60, collectionRevenue: 300, collectionUnits: 2, collectionOrders: 1.5, collectionAddedToCart: 30, cogs: 60,
          collectionLandedRevenue: 240, collectionLandedUnits: 1.5, collectionLandedOrders: 1,
          collectionUnknownRevenue: 30, collectionUnknownOrders: 0.5,
          collectionBroughtRevenue: 90, collectionBroughtOrders: 0.5,
        }),
      ],
    });
    const second = member({
      timeline: [
        collectionDay("2026-09-05", {
          spend: 40, collectionRevenue: 150, collectionUnits: 1, collectionOrders: 0.5, collectionAddedToCart: 20, cogs: 30,
          collectionLandedRevenue: 60, collectionLandedUnits: 0.5, collectionLandedOrders: 1,
          collectionUnknownRevenue: 10, collectionUnknownOrders: 0.5,
          collectionBroughtRevenue: 60, collectionBroughtOrders: 0.5,
        }),
      ],
    });
    const collection = buildCollectionCampaign([first, second])!;
    expect(collection.timeline[0]).toMatchObject({
      collectionRevenue: 450,
      collectionLandedRevenue: 300,
      collectionLandedUnits: 2,
      collectionLandedOrders: 2,
      collectionUnknownRevenue: 40,
      collectionUnknownOrders: 1,
      collectionBroughtRevenue: 150,
      collectionBroughtOrders: 1,
    });
    const sheet = buildCampaignProfitLoss(collection, "2026-09-11");
    expect(sheet.total).toMatchObject({ revenue: 450, landedRevenue: 300, unknownRevenue: 40, broughtRevenue: 150 });
  });

  it("will not build one member's split over every member's money", () => {
    // A member whose day measured the collection's revenue but not how it
    // arrived would otherwise contribute its 150 to the sum and nothing to
    // the split, printing the other member's 240 as the landed part of 450.
    const measured = member({
      timeline: [
        collectionDay("2026-09-05", {
          spend: 60, collectionRevenue: 300, collectionUnits: 2, collectionOrders: 1.5, collectionAddedToCart: 30, cogs: 60,
          collectionLandedRevenue: 240, collectionLandedUnits: 1.5, collectionLandedOrders: 1,
          collectionUnknownRevenue: 0, collectionUnknownOrders: 0,
          collectionBroughtRevenue: 90, collectionBroughtOrders: 0.5,
        }),
      ],
    });
    const older = member({
      timeline: [
        collectionDay("2026-09-05", {
          spend: 40, collectionRevenue: 150, collectionUnits: 1, collectionOrders: 0.5, collectionAddedToCart: 20, cogs: 30,
        }),
      ],
    });

    const collection = buildCollectionCampaign([measured, older])!;
    expect(collection.timeline[0]).toMatchObject({
      collectionRevenue: 450,
      collectionLandedRevenue: null,
      collectionUnknownRevenue: null,
      collectionBroughtRevenue: null,
    });
    expect(buildCampaignProfitLoss(collection, "2026-09-11").total).toMatchObject({
      revenue: 450,
      landedRevenue: null,
      broughtRevenue: null,
    });
  });
});

describe("buildCollectionCampaign", () => {
  it("sums the campaigns sharing a collection to the collection's whole figures", () => {
    // Two BLUSAS campaigns, each holding its spend share of the day's sales.
    const first = member({
      timeline: [
        collectionDay("2026-09-05", {
          spend: 60, clicks: 100, impressions: 1_000, conversions: 1, googleRevenue: 100,
          collectionRevenue: 300, collectionUnits: 2, collectionOrders: 1.5, collectionAddedToCart: 30, cogs: 60,
        }),
      ],
    });
    const second = member({
      timeline: [
        collectionDay("2026-09-05", {
          spend: 40, clicks: 50, impressions: 500, conversions: 0, googleRevenue: 50,
          collectionRevenue: 150, collectionUnits: 1, collectionOrders: 0.5, collectionAddedToCart: 20, cogs: 30,
        }),
      ],
    });
    const collection = buildCollectionCampaign([first, second]);
    expect(collection).toMatchObject({
      collectionHandle: "mintas-kardiganok",
      members: 2,
      collectionSharedWith: 2,
      attributionState: "unmatched",
    });
    expect(collection!.timeline).toEqual([
      expect.objectContaining({
        bucket: "2026-09-05",
        spend: 100, clicks: 150, impressions: 1_500, conversions: 1, googleRevenue: 150,
        shopifyRevenue: null,
        collectionRevenue: 450, collectionUnits: 3, collectionOrders: 2, collectionAddedToCart: 50, cogs: 90,
        realRoas: null, googleRoas: 1.5,
      }),
    ]);
    // The shares add back up: the collection sheet's foot is the sum of the
    // members' feet, fees included.
    const whole = buildCampaignProfitLoss(collection!, "2026-09-11", FEES).total;
    const parts = [first, second].map((campaign) => buildCampaignProfitLoss(campaign, "2026-09-11", FEES).total);
    expect(whole.revenue).toBeCloseTo(parts[0]!.revenue! + parts[1]!.revenue!, 6);
    expect(whole.orders).toBeCloseTo(2, 6);
    expect(whole.paymentFees).toBeCloseTo(parts[0]!.paymentFees! + parts[1]!.paymentFees!, 6);
    expect(whole.profit).toBeCloseTo(parts[0]!.profit! + parts[1]!.profit!, 6);
    expect(whole.roas).toBeCloseTo(4.5, 6);
  });

  it("keeps a day unknown only when every member left it unknown", () => {
    const unknown = { collectionRevenue: null, collectionUnits: null, collectionOrders: null, collectionAddedToCart: null, cogs: null };
    const first = member({
      timeline: [collectionDay("2026-09-05", { spend: 10, ...unknown }), collectionDay("2026-09-06", { spend: 10, ...unknown })],
    });
    const second = member({
      timeline: [
        collectionDay("2026-09-05", { spend: 5, ...unknown }),
        collectionDay("2026-09-06", { spend: 5, collectionRevenue: 20, collectionUnits: 1, collectionOrders: 1, collectionAddedToCart: 2, cogs: 4 }),
      ],
    });
    const timeline = buildCollectionCampaign([first, second])!.timeline;
    expect(timeline[0]).toMatchObject({ spend: 15, shopifyRevenue: null, collectionRevenue: null, collectionOrders: null, cogs: null });
    expect(timeline[1]).toMatchObject({ spend: 15, collectionRevenue: 20, collectionUnits: 1, collectionOrders: 1, collectionAddedToCart: 2, cogs: 4 });
  });

  it("keeps a day only one member has, at that member's value", () => {
    const first = member({
      timeline: [collectionDay("2026-09-05", { spend: 10, clicks: 4, collectionRevenue: 100, collectionUnits: 1, collectionOrders: 1, collectionAddedToCart: 3, cogs: 20 })],
    });
    const second = member({
      timeline: [collectionDay("2026-09-06", { spend: 7, clicks: 2, collectionRevenue: 50, collectionUnits: 1, collectionOrders: 1, collectionAddedToCart: 1, cogs: 10 })],
    });
    expect(buildCollectionCampaign([first, second])!.timeline).toEqual([
      expect.objectContaining({ bucket: "2026-09-05", spend: 10, clicks: 4, collectionRevenue: 100, collectionOrders: 1, cogs: 20 }),
      expect.objectContaining({ bucket: "2026-09-06", spend: 7, clicks: 2, collectionRevenue: 50, collectionOrders: 1, cogs: 10 }),
    ]);
  });

  it("does not invent the fields a pre-sheet snapshot never carried", () => {
    // Points written before the sheet existed carry no orders field; a sum
    // that wrote null for them would turn their revenue of 0 into a fact and
    // print every day of the collection as a loss.
    const stale: AdminAnalyticsCampaignTimelinePoint = {
      bucket: "2026-09-05", spend: 62.76, shopifyRevenue: 0, googleRevenue: 159.8, realRoas: 0, googleRoas: 2.55,
    };
    const collection = buildCollectionCampaign([member({ timeline: [stale] }), member({ timeline: [stale] })])!;
    expect("shopifyOrders" in collection.timeline[0]!).toBe(false);
    expect("collectionRevenue" in collection.timeline[0]!).toBe(false);
    const sheet = buildCampaignProfitLoss(collection, "2026-09-11");
    expect(sheet.predatesSheet).toBe(true);
    expect(sheet.revenueBasis).toBe("google");
  });

  it("reads the sum as matched when any member matched, unavailable when none could be read", () => {
    const matched = member({
      attributionState: "matched",
      timeline: [point({ bucket: "2026-09-05", spend: 10, shopifyRevenue: 40, shopifyOrders: 1 })],
    });
    const unmatched = member({ timeline: [collectionDay("2026-09-05", { spend: 5 })] });
    const mixed = buildCollectionCampaign([unmatched, matched])!;
    expect(mixed.attributionState).toBe("matched");
    expect(mixed.timeline[0]).toMatchObject({ spend: 15, shopifyRevenue: 40, shopifyOrders: 1 });
    expect(mixed.timeline[0]!.realRoas).toBeCloseTo(40 / 15, 6);

    const unavailable = member({ attributionState: "unavailable", timeline: [collectionDay("2026-09-05", { spend: 5 })] });
    expect(buildCollectionCampaign([unavailable, unavailable])!.attributionState).toBe("unavailable");
    expect(buildCollectionCampaign([unavailable, unmatched])!.attributionState).toBe("unmatched");
  });

  it("keeps the collection's items as the basis when a member campaign is UTM-matched", () => {
    // One of the two campaigns landing on the page carries utm_campaign, so
    // Shopify matched its own sales: 40 on one order. Those are that
    // campaign's, not the collection's, and the collection's sheet stays the
    // client's: the collection items in every order, whatever the members'
    // tagging. Read on the UTM basis it would print 40 and one order for a
    // page that sold 450 on two.
    const matched = member({
      attributionState: "matched",
      timeline: [
        point({
          bucket: "2026-09-05",
          spend: 60, clicks: 100, impressions: 1_000, googleRevenue: 100,
          addedToCart: 12, shopifyRevenue: 40, shopifyOrders: 1, units: 1,
          collectionRevenue: 300, collectionUnits: 2, collectionOrders: 1.5, collectionAddedToCart: 30, cogs: 60,
        }),
      ],
    });
    const unmatched = member({
      timeline: [
        collectionDay("2026-09-05", {
          spend: 40, clicks: 50, impressions: 500, googleRevenue: 50,
          collectionRevenue: 150, collectionUnits: 1, collectionOrders: 0.5, collectionAddedToCart: 20, cogs: 30,
        }),
      ],
    });
    const collection = buildCollectionCampaign([matched, unmatched])!;
    expect(collection.attributionState).toBe("matched");
    expect(collection.timeline[0]).toMatchObject({ shopifyRevenue: 40, shopifyOrders: 1, collectionRevenue: 450 });

    const sheet = buildCampaignProfitLoss(collection, "2026-09-11", FEES);
    expect(sheet.revenueBasis).toBe("collection");
    expect(sheet.total).toMatchObject({ revenue: 450, orders: 2, units: 3, addedToCart: 50, cogs: 90 });
    expect(sheet.total.paymentFees).toBeCloseTo(2 * 0.25 + 450 * 0.017, 6);
    expect(sheet.total.profit).toBeCloseTo(450 - 100 - 90 - (2 * 0.25 + 450 * 0.017) - 3 - 10, 6);

    // The matched campaign's own sheet still reads its own sales: the rule
    // is the collection sheet's, not the member's.
    const own = buildCampaignProfitLoss(matched, "2026-09-11", FEES);
    expect(own.revenueBasis).toBe("shopify");
    expect(own.total).toMatchObject({ revenue: 40, orders: 1 });


  });

  it("falls to Google's conversion value, never a member's UTM sales, when the collection's orders could not be read", () => {
    // The orders were unreadable, so the collection's items are unknown on
    // every day. The sheet says so with Google's number, as a single
    // campaign's would; it does not borrow the matched member's sales and
    // call them the collection's.
    const unknown = { collectionRevenue: null, collectionUnits: null, collectionOrders: null, collectionAddedToCart: null, cogs: null };
    const matched = member({
      attributionState: "matched",
      timeline: [point({ bucket: "2026-09-05", spend: 60, googleRevenue: 100, shopifyRevenue: 40, shopifyOrders: 1, ...unknown })],
    });
    const unmatched = member({ timeline: [collectionDay("2026-09-05", { spend: 40, googleRevenue: 50, ...unknown })] });
    const sheet = buildCampaignProfitLoss(buildCollectionCampaign([matched, unmatched])!, "2026-09-11", FEES);
    expect(sheet.revenueBasis).toBe("google");
    expect(sheet.total).toMatchObject({ revenue: null, orders: null, googleRevenue: 150 });
    expect(sheet.total.profit).toBeCloseTo(150 - 100 - 10, 6);
  });

  it("says the collection came from the clicks only when no member's ads named it", () => {
    const landed = member({ collectionSource: "landing", timeline: [collectionDay("2026-09-05", { spend: 5 })] });
    const named = member({ collectionSource: "final_url", timeline: [collectionDay("2026-09-05", { spend: 5 })] });
    expect(buildCollectionCampaign([landed, landed])!.collectionSource).toBe("landing");
    expect(buildCollectionCampaign([landed, named])!.collectionSource).toBeUndefined();
  });

  it("has nothing to sum without members or a collection", () => {
    expect(buildCollectionCampaign([])).toBeNull();
    expect(buildCollectionCampaign([member({ collectionHandle: null, timeline: [] })])).toBeNull();
  });

});


it("keeps Google campaign ROAS independent of Shopify coverage, and weights totals by spend", () => {
  const timeline = [point({ bucket: "2026-09-20", spend: 20, googleRevenue: 60, shopifyRevenue: 900, collectionRevenue: 1000 }), point({ bucket: "2026-09-21", spend: 40, googleRevenue: 0 })];
  const sheet = buildCampaignProfitLoss({ timeline }, "2026-09-25", FEES, "google");
  expect(sheet.revenueBasis).toBe("google");
  expect(sheet.rows.map((row) => row.roas)).toEqual([3, 0]);
  expect(sheet.total).toMatchObject({ googleRevenue: 60, revenue: null, roas: 1, cogs: null, orders: null, paymentFees: null, shipping: null, agencyFee: 6, profit: -6 });
  expect(sheet.predatesSheet).toBe(false);
  expect(buildCampaignProfitLoss({ timeline: [point({ bucket: "2026-09-20", spend: 0, googleRevenue: 60 })] }, "2026-09-25", null, "google").total.roas).toBeNull();
});
