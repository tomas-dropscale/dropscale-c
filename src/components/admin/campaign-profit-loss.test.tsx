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
    expect(html).toContain("Profit on /collections/kenyelmes-ruhak, split between the 4 campaigns that land there");
    // The client's own definition, word for word, so the reader can hold the
    // sheet against the one they keep: items in every order, any channel.
    expect(html).toContain(
      "Revenue is the collection items in every order, after discounts and refunds, from any channel; " +
        "Orders are the orders holding at least one of them; " +
        "ATC is Google sessions that landed on the collection page and added to cart.",
    );
    expect(html).toContain("COGS");
    expect(html).toContain("EUR 90.00");
    expect(html).toContain("the product costs of those items");

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
    expect(noCosts).not.toContain("the product costs of those items");
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
    expect(quiet).toContain("Profit on /collections/kenyelmes-ruhak");
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
    expect(landed).toContain("Profit on /collections/handgjorda-vaskor");
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
      expect(named).toContain("Profit on /collections/handgjorda-vaskor");
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

  it("reads “—” for the fees without settings and counts them 0 in profit, and says so", () => {
    const sheet = buildCampaignProfitLoss({ timeline: days }, "2026-09-11");
    expect(sheet.rows[0]).toMatchObject({ paymentFees: null, shipping: null, agencyFee: null });
    expect(sheet.rows[0]!.profit).toBeCloseTo(450 - 104.2 - 90, 6);
    expect(sheet.total).toMatchObject({ paymentFees: null, shipping: null, agencyFee: null });

    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="BOHO - HU - 30/07"
        currency="EUR"
        today="2026-09-11"
        campaign={{ attributionState: "unmatched", collectionHandle: "kenyelmes-ruhak", timeline: days }}
      />,
    );
    expect(html).toContain(
      "fee settings could not be read, so Shopify fees, shipping and the agency fee read “—” and count 0 in profit",
    );
    expect(html).toContain("Shopify fees");
    expect(html).toContain("Shipping");
    expect(html).toContain("Agency fee");
    expect(html).toContain("EUR 255.80");
  });

  it("states the rates it applies in the caption and prints the fees in their columns", () => {
    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="BOHO - HU - 30/07"
        currency="EUR"
        today="2026-09-11"
        campaign={{ attributionState: "unmatched", collectionHandle: "kenyelmes-ruhak", timeline: days }}
        fees={FEES}
      />,
    );
    expect(html).toContain(
      "Shopify fees are EUR 0.25 per order plus 1.7% of revenue, shipping EUR 1.50 per order and the agency fee 10% of ad spend",
    );
    expect(html).toContain("Shopify fees, shipping and the agency fee");
    expect(html).toContain("EUR 8.15");
    expect(html).toContain("EUR 3.00");
    expect(html).toContain("EUR 10.42");
    expect(html).toContain("EUR 22.20");
    expect(html).not.toContain("could not be read");
  });

  it("prices the fees on Shopify's own orders on the UTM basis, and only the agency fee on Google's", () => {
    const shopify = buildCampaignProfitLoss(
      { timeline: [point({ bucket: "2026-08-29", spend: 120.06, addedToCart: 35, shopifyRevenue: 164.8, shopifyOrders: 1, units: 4 })] },
      "2026-09-11",
      FEES,
    );
    expect(shopify.revenueBasis).toBe("shopify");
    expect(shopify.rows[0]!.paymentFees).toBeCloseTo(0.25 + 164.8 * 0.017, 6);
    expect(shopify.rows[0]!.shipping).toBeCloseTo(1.5, 6);
    expect(shopify.rows[0]!.agencyFee).toBeCloseTo(12.006, 6);
    expect(shopify.rows[0]!.profit).toBeCloseTo(164.8 - 120.06 - (0.25 + 164.8 * 0.017) - 1.5 - 12.006, 6);

    // Google's basis knows no orders, so nothing per order can be priced;
    // the agency fee is on spend and always can.
    const timeline = [
      point({ bucket: "2026-09-01", spend: 99.84, googleRevenue: 150, addedToCart: null, shopifyRevenue: null, shopifyOrders: null, units: null }),
    ];
    const google = buildCampaignProfitLoss({ timeline }, "2026-09-11", FEES);
    expect(google.revenueBasis).toBe("google");
    expect(google.rows[0]).toMatchObject({ paymentFees: null, shipping: null });
    expect(google.rows[0]!.agencyFee).toBeCloseTo(9.984, 6);
    expect(google.rows[0]!.profit).toBeCloseTo(150 - 99.84 - 9.984, 6);
    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="Orphan"
        currency="EUR"
        today="2026-09-11"
        campaign={{ attributionState: "unmatched", timeline }}
        fees={FEES}
      />,
    );
    expect(html).toContain("Revenue (Google)");
    expect(html).toContain("EUR 150.00");
    expect(html).toContain("minus ad spend and the agency fee");
    expect(html).toContain("EUR 9.98");
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

  it("names the visit it is talking about, and shares only the lines that are part of the total", () => {
    const html = sheetOf(days);

    expect(html).toContain("Where the sales came from");
    // "First visit" and not "Landed": Shopify reports the first session of a
    // journey, so a buyer who arrived from Instagram and clicked the ad onto
    // the page a week later is on the second line, not the first. The sheet
    // has to say so, because the block exists to answer that very question.
    expect(html).toContain("First visit landed on /collections/kenyelmes-ruhak");
    expect(html).toContain("Shopify reports only the first session of a customer");
    // 300 of the 400 the sheet's Revenue column already shows, on 3 orders.
    expect(html).toContain("EUR 300.00");
    expect(html).toContain("3 orders · 75.0%");
    expect(html).toContain("First visit landed elsewhere");
    expect(html).toContain("1 order · 25.0%");
    // Beside the total, so no share: the brought money is whole orders,
    // shipping and all, and dividing it by a collection line total would put
    // a third slice under two that already make 100%.
    expect(html).toContain("First visit landed on the page, bought none of the collection");
    expect(html).toContain("EUR 200.00");
    expect(html).not.toContain("2 orders · 50.0%");
    expect(html).toContain(
      "Every line but the last adds up to the Revenue column. The page also brought 2 orders worth EUR 200.00 that bought nothing from the collection",
    );
    // Nothing went unmeasured here, so no line claims it did.
    expect(html).not.toContain("First visit not reported");
    // The captions the sheet already carried are still there.
    expect(html).toContain("Profit on /collections/kenyelmes-ruhak");
    expect(html).toContain("Revenue is the collection items in every order");
    expect(html).toContain("fee settings could not be read");
  });

  it("gives the sales Shopify reported no journey for their own line", () => {
    // 100 of the 300 has no customer journey at all. Folded into the second
    // line the sheet would print "First visit landed elsewhere EUR 160.00
    // (53.3%)" and say the advertised page lost sales nobody measured.
    const html = sheetOf([
      collectionDay("2026-09-05", {
        spend: 100,
        collectionRevenue: 300, collectionUnits: 3, collectionOrders: 5, collectionAddedToCart: 40, cogs: 60,
        collectionLandedRevenue: 140, collectionLandedUnits: 2, collectionLandedOrders: 2,
        collectionUnknownRevenue: 100, collectionUnknownOrders: 2,
        collectionBroughtRevenue: null, collectionBroughtOrders: null,
      }),
    ]);

    expect(html).toContain("First visit not reported by Shopify");
    // Landed 140 (46.7%), never measured 100 (33.3%), and the 60 left over
    // is the only part actually seen to arrive some other way.
    expect(html).toContain("2 orders · 46.7%");
    expect(html).toContain("EUR 100.00");
    expect(html).toContain("2 orders · 33.3%");
    expect(html).toContain("1 order · 20.0%");
    expect(html).toContain("EUR 60.00");
    // Nothing is known about what the page brought in, so nothing is said.
    expect(html).not.toContain("bought none of the collection");
    expect(html).toContain("The lines above add up to the Revenue column.");
  });

  it("reads a page that sold the lot as nothing left over, never a negative sale", () => {
    // The two parts are carried as spend shares, so their sum can miss the
    // total by a float's width; 0.1 + 0.2 is the classic one.
    const html = sheetOf([
      collectionDay("2026-09-05", {
        spend: 10,
        collectionRevenue: 0.3, collectionUnits: 1, collectionOrders: 1, collectionAddedToCart: 2, cogs: 0,
        collectionLandedRevenue: 0.1 + 0.2, collectionLandedUnits: 1, collectionLandedOrders: 1,
        collectionUnknownRevenue: 0, collectionUnknownOrders: 0,
        collectionBroughtRevenue: 0, collectionBroughtOrders: 0,
      }),
    ]);

    expect(html).toContain("First visit landed elsewhere");
    expect(html).not.toContain("-EUR 0.00");
    expect(html).toContain("0 orders · 0.0%");
  });

  it("says nothing when the split is not known", () => {
    const html = sheetOf(withoutSplit);

    expect(html).toContain("Profit on /collections/kenyelmes-ruhak");
    expect(html).toContain("EUR 400.00");
    expect(html).not.toContain("Where the sales came from");
    expect(html).not.toContain("First visit landed");
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

    // And the caption names the collection, not Shopify's match.
    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="Mintás kardigánok (collection)"
        currency="EUR"
        today="2026-09-11"
        campaign={collection}
        fees={FEES}
      />,
    );
    expect(html).toContain("Profit on /collections/mintas-kardiganok, the 2 campaigns that land there summed");
    expect(html).not.toContain("Profit on Shopify");
    expect(html).toContain("EUR 450.00");
    expect(html).not.toContain("EUR 40.00");
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

  it("captions the collection sheet as the sum, not a share", () => {
    const collection = buildCollectionCampaign([
      member({ timeline: [collectionDay("2026-09-05", { spend: 60, collectionRevenue: 300, collectionUnits: 2, collectionOrders: 1.5, collectionAddedToCart: 30, cogs: 60 })] }),
      member({ timeline: [collectionDay("2026-09-05", { spend: 40, collectionRevenue: 150, collectionUnits: 1, collectionOrders: 0.5, collectionAddedToCart: 20, cogs: 30 })] }),
    ])!;
    const html = renderToStaticMarkup(
      <CampaignProfitLossSheet
        title="Mintás kardigánok (collection)"
        currency="EUR"
        today="2026-09-11"
        campaign={collection}
        fees={FEES}
      />,
    );
    expect(html).toContain("Profit on /collections/mintas-kardiganok, the 2 campaigns that land there summed");
    expect(html).not.toContain("split between");
    expect(html).toContain("EUR 450.00");
    // Two whole orders, not two half-shares.
    expect(html).toContain(">2<");
  });
});
