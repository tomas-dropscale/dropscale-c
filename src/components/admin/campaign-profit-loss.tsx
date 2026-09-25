"use client";

import * as React from "react";
import { firstLandingCampaignSales, sumFirstLanding } from "../../lib/admin/campaign-first-landing";

import type {
  AdminAnalyticsCampaign,
  AdminAnalyticsCampaignTimelinePoint,
  CampaignSheetFees,
} from "@/lib/admin/store-analytics";
import { integer, money, multiplier } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A campaign's day-by-day profit and loss: what Google delivered next to what
 * the store really sold, one row per day, totals at the foot, laid out as the
 * sheet the client keeps by hand: ad spend, clicks, impressions, CTR, ATC,
 * revenue, orders, units, CVR, ROAS, CPA, COGS, Shopify fees, shipping, the
 * agency fee, profit and its running total.
 *
 * Every figure is one the store already reports. Spend, clicks and
 * impressions are Google's; the sales columns are Shopify's, on the basis
 * below; the fees are estimated from the store's own per-order settings, the
 * ones its rollup applies to every order (see cogs/engine's paymentFee):
 * Shopify fees are orders × fixed fee + revenue × percent, shipping is orders
 * × cost per order, the agency fee is spend × rate. The ratios are derived
 * here and nowhere else, so the sheet and its totals can never disagree: CTR
 * is clicks over impressions, CVR is orders over cart additions, ROAS is
 * revenue over spend, CPA is spend over orders.
 *
 * A day Shopify has not answered for reads "—", never 0: a zero is a fact, a
 * dash is the absence of one, and a P&L that prints the two alike is wrong.
 * A fee the day cannot price (no settings, or no orders to count) reads "—"
 * too, and counts 0 in profit, which the caption says; a day whose revenue is
 * unknown has no profit at all.
 *
 * Profit and its running total are the point of the sheet, and they need a
 * revenue to subtract the costs from. Three bases, tried in order and stated
 * once in the caption, never mixed day by day:
 *  - "shopify": Shopify matched the campaign's own utm_campaign - the real
 *    sales of this campaign, last non-direct click.
 *  - "collection": the ads carry no utm_campaign (every visit lands as plain
 *    Google traffic, which Shopify labels "google" or "alphabet"), but the
 *    campaign sends people to one collection page. Its sales are read from
 *    the orders the way the client's own per-collection sheet reads them:
 *    revenue is the collection's items in every order, after discounts and
 *    refunds, from any channel, not only this campaign's ads; orders are the
 *    orders holding at least one of them; units are those items less the
 *    ones refunded; all split between the campaigns landing there by spend.
 *    Cart additions are the Google visits that landed on the page, and the
 *    store's product costs price those same items order by order. A
 *    collection that sold nothing in the period is still this basis, with
 *    zeros, as long as the store has it.
 *  - "google": neither is known, so Google's own conversion value stands in.
 *    Orders are unknown here, so only the agency fee can be priced.
 *
 * One sheet per collection is the same sheet fed with the campaigns landing
 * there summed day by day (buildCollectionCampaign): the shares add back up
 * to the collection's whole figures, which is what the client's sheet holds.
 * That sheet never takes the "shopify" basis: a member campaign Shopify
 * matched by its utm_campaign has sales of its own, but they are that
 * campaign's, not the collection's items, and the collection's sheet stays
 * the one the client keeps whatever its members' tagging.
 */

export type CampaignProfitLossRow = {
  day: string;
  spend: number;
  clicks: number;
  impressions: number;
  ctr: number | null;
  addedToCart: number | null;
  revenue: number | null;
  orders: number | null;
  units: number | null;
  cvr: number | null;
  roas: number | null;
  cpa: number | null;
  /** Google's own reported conversion value for the day. */
  googleRevenue: number;
  /** Cost of the units sold, from the store's product costs; only on the collection basis. */
  cogs: number | null;
  /** Shopify's payment fees on the day's orders, orders × fixed + revenue × percent; null without the settings or the orders. */
  paymentFees: number | null;
  /** Shipping cost of the day's orders, orders × the store's cost per order; null without the settings or the orders. */
  shipping: number | null;
  /** The agency's fee on the day's spend, spend × rate; null without the settings. */
  agencyFee: number | null;
  /** Revenue on the sheet's basis minus ad spend, COGS and the fees the day could price; null when the basis has no answer. */
  profit: number | null;
  /** Running sum of profit up to and including this day. */
  cumulative: number | null;
  /** The reporting day has not closed: the figures are still moving. */
  inProgress: boolean;
};

export type CampaignRevenueBasis = "shopify" | "collection" | "google";

/**
 * How the collection's sales arrived, on the collection basis: the campaign
 * advertises a collection PAGE, so the sheet's own total is split by whether
 * the buyer came in through it.
 *
 * landed* is the part of the total bought by customers whose FIRST visit
 * landed on the page, unknown* is the part Shopify reports no journey for at
 * all, and the rest of the total is what customers measured to have arrived
 * some other way bought. All three are inside the sheet's revenue, so they
 * add back up to it.
 *
 * brought* is money the sheet's total never sees: orders that landed on the
 * page and bought nothing of the collection, counted whole. The page made it
 * and the client's per-collection sheet does not count it, so it is shown
 * apart and never added in.
 *
 * Only the collection basis has these: on the Shopify or the Google basis the
 * revenue is not the collection's, and a share of it would put two different
 * measures over one another. Null when the split was not measured on every
 * day whose revenue the total holds - see the arrival sum in the builder.
 */
export type CampaignCollectionArrival = {
  landedRevenue: number | null;
  landedUnits: number | null;
  landedOrders: number | null;
  unknownRevenue: number | null;
  unknownOrders: number | null;
  broughtRevenue: number | null;
  broughtOrders: number | null;
};

export type CampaignProfitLoss = {
  rows: CampaignProfitLossRow[];
  /**
   * The foot of the sheet, plus the arrival split, which lives in the total
   * alone: the daily table is already eighteen columns wide, and where a sale
   * came from is a fact about the period the reader asks once, not a column
   * they scan day by day.
   */
  total: Omit<CampaignProfitLossRow, "day" | "inProgress" | "cumulative"> & CampaignCollectionArrival;
  /** Which revenue profit is measured against - Shopify's real sales when the campaign has them, else Google's conversion value. */
  revenueBasis: CampaignRevenueBasis;
  /**
   * The timeline was written before the sheet existed: no point carries the
   * fields it reads, so the dashes mean "not yet computed", not "not known".
   * Snapshots are rewritten every hour, so this clears on its own.
   */
  predatesSheet: boolean;
};

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * The rest of a whole after a part of it, with the float residue of a share
 * read as the zero it is. What landed on the page and what did not are two
 * sums of the same orders, each carried as a spend share, so their difference
 * can miss the whole by 1e-10; printed as money that reads "-0.00", which
 * says a page sold a negative amount.
 */
export function restOf(whole: number, part: number): number {
  const left = whole - part;
  return Math.abs(left) < 1e-9 ? 0 : left;
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

/** Buckets arrive as days or as hours of one day; the sheet is by day. */
function dayOf(bucket: string): string {
  return bucket.slice(0, 10);
}

type DayFacts = {
  utm: { addedToCart: number | null; revenue: number | null; orders: number | null; units: number | null };
  collection: {
    addedToCart: number | null;
    revenue: number | null;
    orders: number | null;
    units: number | null;
    cogs: number | null;
  };
};

/**
 * The fees a day can price from the store's settings. Payment fees and
 * shipping are per order, so they need the day's orders (and the revenue the
 * percent applies to); the agency fee is on spend, which is always known.
 * Without settings nothing can be priced, and the columns read "—".
 *
 * Only what the settings hold is priced. A cost the client keeps on their
 * own sheet but the store's settings do not carry (a currency conversion
 * fee on net sales, say) is not here, and profit reads higher by it; the
 * caption lists the rates applied, so the reader can tell what was taken
 * off. Carrying such a fee is a settings change, not a sheet one.
 */
function dayFees(
  fees: CampaignSheetFees | null,
  spend: number,
  revenue: number | null,
  orders: number | null,
): Pick<CampaignProfitLossRow, "paymentFees" | "shipping" | "agencyFee"> {
  if (!fees) return { paymentFees: null, shipping: null, agencyFee: null };
  return {
    paymentFees:
      orders === null || revenue === null
        ? null
        : orders * fees.paymentFeeFixed + (revenue * fees.paymentFeePct) / 100,
    shipping: orders === null ? null : orders * fees.shippingCostPerOrder,
    agencyFee: (spend * fees.agencyFeeRate) / 100,
  };
}

export function buildCampaignProfitLoss(
  /** `members` is set on a collection's sheet (see CollectionCampaign), and rules the "shopify" basis out. */
  campaign: Pick<AdminAnalyticsCampaign, "timeline"> & { members?: number },
  today: string,
  fees: CampaignSheetFees | null = null,
  mode: boolean | "google" = false,
): CampaignProfitLoss {
  const firstLanding = mode === true;
  // Real collection ROAS requires first-visit evidence. Individual Google
  // sheets use Google's own conversion value regardless of Shopify coverage.
  const originalTimeline = campaign.timeline;
  const missingDays = new Set<string>();
  if (firstLanding) {
    campaign = { ...campaign, timeline: campaign.timeline.map((point) => {
      const sales = campaign.members !== undefined ? point.firstLanding?.collection : firstLandingCampaignSales(point.firstLanding);
      if (!sales) missingDays.add(dayOf(point.bucket));
      return {
        ...point,
        shopifyRevenue: null, shopifyOrders: null, units: null,
        collectionRevenue: sales?.revenue ?? null,
        collectionOrders: sales?.orders ?? null,
        collectionUnits: sales?.units ?? null,
        cogs: sales?.cogs ?? null,
        // Cart sessions are a different attribution model; do not invent a matching CVR.
        collectionAddedToCart: null,
      };
    }) };
  }
  const byDay = new Map<string, CampaignProfitLossRow>();
  const facts = new Map<string, DayFacts>();
  for (const point of campaign.timeline) {
    const day = dayOf(point.bucket);
    const fact = facts.get(day) ?? {
      utm: { addedToCart: null, revenue: null, orders: null, units: null },
      collection: { addedToCart: null, revenue: null, orders: null, units: null, cogs: null },
    };
    fact.collection.revenue = sumNullable([fact.collection.revenue, point.collectionRevenue ?? null]);
    fact.collection.units = sumNullable([fact.collection.units, point.collectionUnits ?? null]);
    fact.collection.orders = sumNullable([fact.collection.orders, point.collectionOrders ?? null]);
    fact.collection.addedToCart = sumNullable([
      fact.collection.addedToCart,
      point.collectionAddedToCart ?? null,
    ]);
    fact.collection.cogs = sumNullable([fact.collection.cogs, point.cogs ?? null]);
    facts.set(day, fact);
    const row = byDay.get(day) ?? {
      day,
      spend: 0,
      clicks: 0,
      impressions: 0,
      ctr: null,
      addedToCart: null,
      revenue: null,
      orders: null,
      units: null,
      cvr: null,
      roas: null,
      cpa: null,
      googleRevenue: 0,
      cogs: null,
      paymentFees: null,
      shipping: null,
      agencyFee: null,
      profit: null,
      cumulative: null,
      inProgress: day >= today,
    };
    row.spend += point.spend;
    row.clicks += point.clicks ?? 0;
    row.impressions += point.impressions ?? 0;
    row.googleRevenue += point.googleRevenue;
    row.addedToCart = sumNullable([row.addedToCart, point.addedToCart ?? null]);
    // A point with no orders field at all was written before this sheet
    // existed, by a producer that wrote 0 for a campaign Shopify never
    // matched. That 0 is not a fact, so it is not read as one; the point's
    // revenue counts only once the snapshot has been rewritten with the
    // orders beside it. (Snapshots refresh every hour, so this is a window.)
    const shopifyRevenue = point.shopifyOrders === undefined ? null : point.shopifyRevenue;
    fact.utm.addedToCart = row.addedToCart;
    fact.utm.revenue = sumNullable([fact.utm.revenue, shopifyRevenue]);
    fact.utm.orders = sumNullable([fact.utm.orders, point.shopifyOrders ?? null]);
    fact.utm.units = sumNullable([fact.utm.units, point.units ?? null]);
    byDay.set(day, row);
  }

  // One basis for the whole sheet, chosen by what any day could answer:
  // Shopify's own match first, the landing collection next, Google last. A
  // collection's sheet (members set) skips the first: the sum carries a
  // matched member's UTM sales, and read as a fact they would make the sheet
  // that member's, printing its sales and orders for a page that sold more
  // than that to everyone. A day left unanswered on a Shopify or collection
  // basis keeps its dash rather than borrowing the next basis's number.
  const allFacts = [...facts.values()];
  for (const day of missingDays) {
    const fact = facts.get(day);
    if (fact) fact.collection = { addedToCart: null, revenue: null, orders: null, units: null, cogs: null };
  }
  const collectionSheet = campaign.members !== undefined;
  const revenueBasis: CampaignRevenueBasis =
    mode === "google" ? "google" : firstLanding ? "collection" : !collectionSheet && allFacts.some((fact) => fact.utm.revenue !== null)
      ? "shopify"
      : allFacts.some((fact) => fact.collection.revenue !== null)
        ? "collection"
        : "google";

  let running: number | null = null;
  const rows = [...byDay.values()]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((partial) => {
      const fact = facts.get(partial.day);
      const shopify = revenueBasis === "collection" ? fact?.collection : fact?.utm;
      const row = {
        ...partial,
        addedToCart: revenueBasis === "google" ? null : shopify?.addedToCart ?? null,
        revenue: revenueBasis === "google" ? null : shopify?.revenue ?? null,
        orders: revenueBasis === "google" ? null : shopify?.orders ?? null,
        units: revenueBasis === "google" ? null : shopify?.units ?? null,
        cogs: revenueBasis === "collection" ? fact?.collection.cogs ?? null : null,
      };
      const revenue = revenueBasis === "google" ? row.googleRevenue : row.revenue;
      // The per-order fees are priced on the sheet's own orders and revenue,
      // so on the Google basis (no orders known) only the agency fee is.
      const costs = dayFees(fees, row.spend, row.revenue, row.orders);
      const profit =
        revenue === null
          ? null
          : revenue -
            row.spend -
            (row.cogs ?? 0) -
            (costs.paymentFees ?? 0) -
            (costs.shipping ?? 0) -
            (costs.agencyFee ?? 0);
      if (profit !== null) running = (running ?? 0) + profit;
      return {
        ...row,
        ...costs,
        ctr: ratio(row.clicks, row.impressions),
        cvr: ratio(row.orders, row.addedToCart),
        roas: ratio(revenueBasis === "google" ? row.googleRevenue : row.revenue, row.spend > 0 ? row.spend : null),
        cpa: row.orders !== null && row.orders > 0 ? row.spend / row.orders : null,
        profit,
        cumulative: profit === null ? null : running,
      };
    });

  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const googleRevenue = rows.reduce((sum, row) => sum + row.googleRevenue, 0);
  const addedToCart = sumNullable(rows.map((row) => row.addedToCart));
  const complete = !firstLanding || missingDays.size === 0;
  const revenue = complete ? sumNullable(rows.map((row) => row.revenue)) : null;
  const orders = complete ? sumNullable(rows.map((row) => row.orders)) : null;
  const units = complete ? sumNullable(rows.map((row) => row.units)) : null;
  const cogs = sumNullable(rows.map((row) => row.cogs));
  // Folded from the timeline rather than from the rows, which do not carry
  // these figures, and only on the basis whose revenue they describe.
  //
  // The sum fails closed, unlike every other sum on this sheet: a day that
  // measured the collection's revenue but not how it arrived would otherwise
  // be summed into the total while its arrival was not, and the rest of the
  // total - the part the sheet prints as having found the items another way -
  // would silently swallow a day nobody measured. Unknown is the honest
  // answer there, so the whole block is withheld instead.
  const contributing = campaign.timeline.filter((point) => typeof point.collectionRevenue === "number");
  const arrival = (
    field:
      | "collectionLandedRevenue"
      | "collectionLandedUnits"
      | "collectionLandedOrders"
      | "collectionUnknownRevenue"
      | "collectionUnknownOrders"
      | "collectionBroughtRevenue"
      | "collectionBroughtOrders",
  ): number | null =>
    !firstLanding && revenueBasis === "collection" &&
    contributing.length > 0 &&
    contributing.every((point) => typeof point[field] === "number")
      ? contributing.reduce((sum, point) => sum + (point[field] ?? 0), 0)
      : null;
  const predatesSheet = mode === "google" ? false : firstLanding ? originalTimeline.some((point) => !point.firstLanding) :
    campaign.timeline.length > 0 &&
    campaign.timeline.every(
      (point) => point.shopifyOrders === undefined && point.collectionRevenue === undefined,
    );

  // The total is the sum of the rows it stands under - not basis revenue
  // minus every day's spend, which would charge the spend of a day whose
  // revenue is unknown and end the column on a number the rows never reach.
  // The fee columns sum the same way, so a day that could not price a fee
  // adds nothing to the foot, exactly as it added nothing to its own profit.
  const rowProfits = rows.map((row) => row.profit);
  const totalProfit = complete ? sumNullable(rowProfits) : null;
  return {
    rows,
    revenueBasis,
    predatesSheet,
    total: {
      spend,
      clicks,
      impressions,
      ctr: ratio(clicks, impressions),
      addedToCart,
      revenue,
      orders,
      units,
      cvr: ratio(orders, addedToCart),
      roas: ratio(revenueBasis === "google" ? googleRevenue : revenue, spend > 0 ? spend : null),
      cpa: orders !== null && orders > 0 ? spend / orders : null,
      googleRevenue,
      cogs,
      paymentFees: sumNullable(rows.map((row) => row.paymentFees)),
      shipping: sumNullable(rows.map((row) => row.shipping)),
      agencyFee: sumNullable(rows.map((row) => row.agencyFee)),
      profit: totalProfit,
      landedRevenue: arrival("collectionLandedRevenue"),
      landedUnits: arrival("collectionLandedUnits"),
      landedOrders: arrival("collectionLandedOrders"),
      unknownRevenue: arrival("collectionUnknownRevenue"),
      unknownOrders: arrival("collectionUnknownOrders"),
      broughtRevenue: arrival("collectionBroughtRevenue"),
      broughtOrders: arrival("collectionBroughtOrders"),
    },
  };
}

/**
 * The campaigns that land on one collection, summed into one campaign, so the
 * collection gets the same sheet the client keeps for it: one row per day
 * with every campaign's spend, clicks and impressions added, and the
 * collection's own sales, which the producer split between those campaigns
 * by spend, added back to the whole.
 */
export type CollectionCampaign = Pick<
  AdminAnalyticsCampaign,
  "timeline" | "attributionState" | "collectionSource" | "collectionSharedWith"
> & {
  collectionHandle: string;
  /**
   * How many campaigns were summed, so the sheet says so rather than calling
   * the figures shares, and reads the collection's items rather than any
   * member's own UTM sales.
   */
  members: number;
};

/**
 * A sum that keeps the difference between "nobody knows" and "not yet
 * computed": null when every member said null, undefined when no member
 * carried the field at all (a point written before the sheet existed, whose
 * absent orders field is what tells the sheet not to trust its revenue), and
 * the sum of the members that answered otherwise. A member that did not
 * answer adds nothing; a day one member has and another lacks keeps the one
 * value.
 */
function sumOptional(values: Array<number | null | undefined>): number | null | undefined {
  let sum: number | null | undefined = undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (value === null) {
      sum ??= null;
      continue;
    }
    sum = (sum ?? 0) + value;
  }
  return sum;
}

/**
 * The per-bucket sum of the members' timelines. Google's delivery figures add
 * plainly; the Shopify and collection figures add null-aware, so a day is
 * unknown only when every member left it unknown. The ratios are recomputed
 * from the sums, never averaged.
 */
function sumTimelines(
  members: ReadonlyArray<Pick<AdminAnalyticsCampaign, "timeline">>,
): AdminAnalyticsCampaignTimelinePoint[] {
  const byBucket = new Map<string, AdminAnalyticsCampaignTimelinePoint[]>();
  for (const member of members) {
    for (const point of member.timeline) {
      const bucket = byBucket.get(point.bucket) ?? [];
      bucket.push(point);
      byBucket.set(point.bucket, bucket);
    }
  }
  return [...byBucket.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, points]) => {
      const spend = points.reduce((sum, point) => sum + point.spend, 0);
      const googleRevenue = points.reduce((sum, point) => sum + point.googleRevenue, 0);
      const shopifyRevenue = sumNullable(points.map((point) => point.shopifyRevenue));
      const summed: AdminAnalyticsCampaignTimelinePoint = {
        bucket,
        spend,
        impressions: points.reduce((sum, point) => sum + (point.impressions ?? 0), 0),
        clicks: points.reduce((sum, point) => sum + (point.clicks ?? 0), 0),
        conversions: points.reduce((sum, point) => sum + (point.conversions ?? 0), 0),
        shopifyRevenue,
        googleRevenue,
        realRoas: spend > 0 && shopifyRevenue !== null ? shopifyRevenue / spend : null,
        googleRoas: spend > 0 ? googleRevenue / spend : null,
      };
      if (points.some((point) => point.firstLanding)) {
        summed.firstLanding = sumFirstLanding(points.map((point) => point.firstLanding));
      }
      // Assigned only when some member carried the field, so a sum of points
      // written before the sheet existed still reads as one to the sheet.
      const optional = [
        "shopifySessions",
        "addedToCart",
        "shopifyOrders",
        "units",
        "collectionRevenue",
        "collectionUnits",
        "collectionOrders",
        "collectionLandedRevenue",
        "collectionLandedUnits",
        "collectionLandedOrders",
        "collectionUnknownRevenue",
        "collectionUnknownOrders",
        "collectionBroughtRevenue",
        "collectionBroughtOrders",
        "collectionAddedToCart",
        "cogs",
      ] as const;
      for (const field of optional) {
        const value = sumOptional(points.map((point) => point[field]));
        if (value !== undefined) summed[field] = value;
      }
      // The arrival fields are the exception to the permissive rule above: a
      // member that measured the day's collection revenue and not how it
      // arrived must not have its revenue added while its arrival is left
      // out, which would print one member's split against every member's
      // money. Unknown for the day, and the sheet withholds the block.
      const arrival = [
        "collectionLandedRevenue",
        "collectionLandedUnits",
        "collectionLandedOrders",
        "collectionUnknownRevenue",
        "collectionUnknownOrders",
        "collectionBroughtRevenue",
        "collectionBroughtOrders",
      ] as const;
      for (const field of arrival) {
        if (summed[field] === undefined || summed[field] === null) continue;
        const missed = points.some(
          (point) => typeof point.collectionRevenue === "number" && typeof point[field] !== "number",
        );
        if (missed) summed[field] = null;
      }
      return summed;
    });
}

/**
 * One synthetic campaign for the collection the given campaigns land on, or
 * null when there are none or the first names no collection. The members
 * are taken as given: the caller groups them by handle.
 *
 * The attribution of the sum is matched when any member matched (Shopify
 * knows that member's traffic by name, though the collection's sheet reads
 * the collection's items, not that member's sales), unavailable when no
 * member's could be read, and unmatched otherwise. The collection reads as found
 * from where the clicks landed only when that is true of every member: if
 * any member's final URLs or name named the page, the page was named.
 */
export function buildCollectionCampaign(
  rows: ReadonlyArray<
    Pick<AdminAnalyticsCampaign, "timeline" | "attributionState" | "collectionHandle" | "collectionSource">
  >,
): CollectionCampaign | null {
  const handle = rows[0]?.collectionHandle;
  if (!handle) return null;
  return {
    collectionHandle: handle,
    members: rows.length,
    collectionSharedWith: rows.length,
    attributionState: rows.some((row) => row.attributionState === "matched")
      ? "matched"
      : rows.every((row) => row.attributionState === "unavailable")
        ? "unavailable"
        : "unmatched",
    ...(rows.every((row) => row.collectionSource === "landing")
      ? { collectionSource: "landing" as const }
      : {}),
    timeline: sumTimelines(rows),
  };
}

function percent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** A stored fee rate as the settings show it: 1.7 reads "1.7%", 10 reads "10%". */
function rate(value: number): string {
  return new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 2 }).format(value / 100);
}

function count(value: number | null): string {
  return value === null ? "—" : integer(value);
}

function amount(value: number | null, currency: string): string {
  return value === null ? "—" : money(value, currency);
}

function times(value: number | null): string {
  return value === null ? "—" : multiplier(value);
}

type SheetHeader = { label: string; align: "left" | "right" };

/** On the Google basis the revenue column is Google's conversion value, and its head says so. */
function sheetHeaders(revenueBasis: CampaignRevenueBasis): SheetHeader[] {
  return [
    { label: "Day", align: "left" },
    { label: "Ad spend", align: "right" },
    { label: "Clicks", align: "right" },
    { label: "Impressions", align: "right" },
    { label: "CTR", align: "right" },
    { label: "ATC", align: "right" },
    { label: revenueBasis === "google" ? "Revenue (Google)" : "Revenue", align: "right" },
    { label: "Orders", align: "right" },
    { label: "Units", align: "right" },
    { label: "CVR (orders / ATC)", align: "right" },
    { label: revenueBasis === "google" ? "ROAS (Google)" : "Real ROAS", align: "right" },
    { label: "CPA", align: "right" },
    { label: "COGS", align: "right" },
    { label: "Shopify fees", align: "right" },
    { label: "Shipping", align: "right" },
    { label: "Agency fee", align: "right" },
    { label: revenueBasis === "google" ? "Estimated profit" : "Profit", align: "right" },
    { label: revenueBasis === "google" ? "Estimated cumulative" : "Cumulative", align: "right" },
  ];
}

/**
 * What the fee columns hold, said from the settings themselves so the
 * caption can never promise a rate the cells do not apply.
 */
function feesCaption(fees: CampaignSheetFees | null | undefined, currency: string): string {
  if (!fees) {
    return "the store's fee settings could not be read, so Shopify fees, shipping and the agency fee read “—” and count 0 in profit";
  }
  return (
    `Shopify fees are ${money(fees.paymentFeeFixed, currency)} per order plus ${rate(fees.paymentFeePct)} of revenue, ` +
    `shipping ${money(fees.shippingCostPerOrder, currency)} per order and the agency fee ${rate(fees.agencyFeeRate)} of ad spend, ` +
    "from the store's settings; a fee a day cannot price reads “—” and counts 0 in profit"
  );
}

/** Profit and its running total read green or red, as the store's own P&L does. */
function ProfitCell({ value, currency }: { value: number | null; currency: string }) {
  return (
    <td
      className={cn(
        "px-2.5 py-2 text-right tabular-nums",
        value !== null && (value >= 0 ? "font-medium text-[var(--success-green)]" : "font-medium text-[var(--danger-red)]"),
      )}
    >
      {amount(value, currency)}
    </td>
  );
}

/** An order count that reads as one when it is one; a share may be fractional. */
function orderWord(value: number): string {
  return value === 1 ? "order" : "orders";
}

/**
 * One line of the arrival block: what it is, what it made, on how many orders,
 * and - only for a line that is part of the total - its share of it.
 *
 * A line beside the total carries no share on purpose. Its money is not part
 * of the collection revenue it would be divided by, and it is not even the
 * same measure: what the page brought in is whole orders, shipping included,
 * while the total is collection line items. A percentage under two lines that
 * already partition the total would read as a third slice of one whole and
 * push the three past 100%, and the number is the thing a reader copies.
 */
function ArrivalLine({
  label,
  revenue,
  orders,
  share = null,
  currency,
  aside = false,
}: {
  label: string;
  revenue: number;
  orders: number;
  share?: number | null;
  currency: string;
  /** The line is beside the total rather than part of it, and reads muted. */
  aside?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 text-[11px]",
        aside ? "text-[var(--text-muted)]" : "text-[var(--text-secondary)]",
      )}
    >
      <span className="min-w-[200px] flex-1">{label}</span>
      <span className={cn("tabular-nums", aside ? "" : "font-medium text-[var(--text-primary)]")}>
        {money(revenue, currency)}
      </span>
      <span className="tabular-nums">
        {count(orders)} {orderWord(orders)}
        {share === null ? "" : ` · ${percent(share)}`}
      </span>
    </li>
  );
}

export type CampaignProfitLossSheetCampaign = Pick<
  AdminAnalyticsCampaign,
  "timeline" | "attributionState" | "collectionHandle" | "collectionSource" | "collectionSharedWith"
> & {
  /**
   * Set on a collection's sheet: how many campaigns were summed into it. The
   * sheet then reads the collection's items and never a member's own UTM
   * sales, whichever of its members Shopify matched.
   */
  members?: number;
};

export function CampaignProfitLossSheet({
  campaign,
  currency,
  today,
  title,
  fees = null,
}: {
  campaign: CampaignProfitLossSheetCampaign;
  currency: string;
  today: string;
  title: string;
  /** The store's per-order fee settings; null when unknown, and the fee columns read "—". */
  fees?: CampaignSheetFees | null;
}) {
  const sheet = React.useMemo(() => buildCampaignProfitLoss(campaign, today, fees, campaign.members !== undefined ? true : "google"), [campaign, today, fees]);
  const cell = "px-2.5 py-2 text-right tabular-nums";
  const muted = cn(cell, "text-[var(--text-secondary)]");
  const headers = sheetHeaders(sheet.revenueBasis);
  const members = campaign.members ?? 1;

  // Where the sales came from, on the collection basis and only once the
  // figures are known: the campaign buys a collection PAGE, and the sheet's
  // total says nothing about whether that page did the work. Every path is
  // real and the mix is a store's own: one collection takes 95% of its
  // revenue from people who landed on the page, another takes none of it.
  // The shares are taken from the sums, so the lines that are inside the
  // total always add to 100% of it.
  //
  // The unmeasured part is one of those lines rather than a silence: the
  // orders Shopify reports no journey for cannot be handed to either of the
  // other two, and printing them as sales that found the items another way
  // would be a claim about the advertised page that nobody measured.
  const arrival =
    sheet.revenueBasis === "collection" &&
    sheet.total.revenue !== null &&
    sheet.total.orders !== null &&
    sheet.total.landedRevenue !== null &&
    sheet.total.landedOrders !== null &&
    sheet.total.unknownRevenue !== null &&
    sheet.total.unknownOrders !== null
      ? {
          total: sheet.total.revenue,
          landedRevenue: sheet.total.landedRevenue,
          landedOrders: sheet.total.landedOrders,
          unknownRevenue: sheet.total.unknownRevenue,
          unknownOrders: sheet.total.unknownOrders,
          // The rest of the same total, so no order and no forint is counted
          // twice or lost between the lines.
          elsewhereRevenue: restOf(sheet.total.revenue, sheet.total.landedRevenue + sheet.total.unknownRevenue),
          elsewhereOrders: restOf(sheet.total.orders, sheet.total.landedOrders + sheet.total.unknownOrders),
          broughtRevenue: sheet.total.broughtRevenue,
          broughtOrders: sheet.total.broughtOrders,
        }
      : null;
  // Pulled out whole so the line and the sentence below it are shown on the
  // same condition: what the page brought in is a figure of its own and can
  // be unknown while the split of the total is known.
  const brought =
    arrival && arrival.broughtRevenue !== null && arrival.broughtOrders !== null
      ? { revenue: arrival.broughtRevenue, orders: arrival.broughtOrders }
      : null;

  // Said from the sheet itself, so the caption can never promise a basis the
  // cells do not use.
  const collectionSheet = campaign.members !== undefined;
  const basisCaption = !collectionSheet
    ? "Individual campaign ROAS and conversion value reported by Google. Estimated profit deducts ad spend and agency fees; product costs, payment fees and shipping are unknown. Real collection ROAS is available in the collection P&L."
    : sheet.predatesSheet
      ? "First-visit attribution has not been refreshed for this period. Refresh the report to calculate real ROAS."
      : `Collection items after discounts and refunds, only from orders whose first visit landed on /collections/${campaign.collectionHandle ?? ""}. All channels; spend from ${members} ${members === 1 ? "campaign" : "campaigns"}. Sales use the order date. Orders without a recorded first landing are excluded. Profit deducts ad spend, available product costs and the fees below; cart conversion is not measured for this model.`;

  return (
    <div
      className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
      role="region"
      aria-label={`${title} profit and loss by day`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <p className="text-[12px] font-semibold text-[var(--text-primary)]">Profit &amp; loss by day</p>
        <p className="text-[10.5px] text-[var(--text-muted)]">
          {basisCaption} · {feesCaption(fees, currency)}
        </p>
      </div>
      {sheet.rows.length === 0 ? (
        <p className="px-4 py-3 text-[11px] text-[var(--text-muted)]">No days were returned for this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1560px] text-[11.5px]">
            <thead>
              <tr className="label-caps border-b border-[var(--border-subtle)]">
                {headers.map((header) => (
                  <th
                    key={header.label}
                    className={cn("px-2.5 py-2 font-medium", header.align === "left" ? "text-left pl-4" : "text-right")}
                  >
                    {header.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr
                  key={row.day}
                  className={cn(
                    "border-t border-[var(--border-subtle)] first:border-t-0",
                    row.inProgress && "bg-[var(--accent-gold-dim)]",
                  )}
                  title={row.inProgress ? "This day has not closed yet; its figures are still moving." : undefined}
                >
                  <td className="px-2.5 py-2 pl-4 text-left tabular-nums text-[var(--text-secondary)]">
                    {row.day}
                    {row.inProgress ? <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">in progress</span> : null}
                  </td>
                  <td className={cell}>{money(row.spend, currency)}</td>
                  <td className={cell}>{integer(row.clicks)}</td>
                  <td className={cell}>{integer(row.impressions)}</td>
                  <td className={cell}>{percent(row.ctr)}</td>
                  <td className={cell}>{count(row.addedToCart)}</td>
                  {sheet.revenueBasis === "google" ? (
                    <td className={muted}>{money(row.googleRevenue, currency)}</td>
                  ) : (
                    <td className={cell}>{amount(row.revenue, currency)}</td>
                  )}
                  <td className={cell}>{count(row.orders)}</td>
                  <td className={cell}>{count(row.units)}</td>
                  <td className={cell}>{percent(row.cvr)}</td>
                  <td className={cell}>{times(row.roas)}</td>
                  <td className={cell}>{amount(row.cpa, currency)}</td>
                  <td className={muted}>{amount(row.cogs, currency)}</td>
                  <td className={muted}>{amount(row.paymentFees, currency)}</td>
                  <td className={muted}>{amount(row.shipping, currency)}</td>
                  <td className={muted}>{amount(row.agencyFee, currency)}</td>
                  <ProfitCell value={row.profit} currency={currency} />
                  <ProfitCell value={row.cumulative} currency={currency} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--border-subtle)] bg-[var(--bg-panel-hover)] font-semibold text-[var(--text-primary)]">
                <td className="px-2.5 py-2.5 pl-4 text-left">Total</td>
                <td className={cell}>{money(sheet.total.spend, currency)}</td>
                <td className={cell}>{integer(sheet.total.clicks)}</td>
                <td className={cell}>{integer(sheet.total.impressions)}</td>
                <td className={cell}>{percent(sheet.total.ctr)}</td>
                <td className={cell}>{count(sheet.total.addedToCart)}</td>
                {sheet.revenueBasis === "google" ? (
                  <td className={muted}>{money(sheet.total.googleRevenue, currency)}</td>
                ) : (
                  <td className={cell}>{amount(sheet.total.revenue, currency)}</td>
                )}
                <td className={cell}>{count(sheet.total.orders)}</td>
                <td className={cell}>{count(sheet.total.units)}</td>
                <td className={cell}>{percent(sheet.total.cvr)}</td>
                <td className={cell}>{times(sheet.total.roas)}</td>
                <td className={cell}>{amount(sheet.total.cpa, currency)}</td>
                <td className={muted}>{amount(sheet.total.cogs, currency)}</td>
                <td className={muted}>{amount(sheet.total.paymentFees, currency)}</td>
                <td className={muted}>{amount(sheet.total.shipping, currency)}</td>
                <td className={muted}>{amount(sheet.total.agencyFee, currency)}</td>
                <ProfitCell value={sheet.total.profit} currency={currency} />
                <ProfitCell value={sheet.total.profit} currency={currency} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {arrival ? (
        <div
          className="border-t border-[var(--border-subtle)] px-4 py-2.5"
          role="group"
          aria-label={`${title}: where the collection's sales came from`}
        >
          <p className="label-caps text-[10.5px] text-[var(--text-secondary)]">Where the sales came from</p>
          <ul className="mt-1.5 space-y-1">
            <ArrivalLine
              label={`First visit landed on /collections/${campaign.collectionHandle ?? ""}`}
              revenue={arrival.landedRevenue}
              orders={arrival.landedOrders}
              share={ratio(arrival.landedRevenue, arrival.total)}
              currency={currency}
            />
            <ArrivalLine
              label="First visit landed elsewhere"
              revenue={arrival.elsewhereRevenue}
              orders={arrival.elsewhereOrders}
              share={ratio(arrival.elsewhereRevenue, arrival.total)}
              currency={currency}
            />
            {arrival.unknownRevenue > 0 || arrival.unknownOrders > 0 ? (
              <ArrivalLine
                label="First visit not reported by Shopify"
                revenue={arrival.unknownRevenue}
                orders={arrival.unknownOrders}
                share={ratio(arrival.unknownRevenue, arrival.total)}
                currency={currency}
              />
            ) : null}
            {brought ? (
              <ArrivalLine
                aside
                label="First visit landed on the page, bought none of the collection"
                revenue={brought.revenue}
                orders={brought.orders}
                currency={currency}
              />
            ) : null}
          </ul>
          <p className="mt-1.5 text-[10.5px] text-[var(--text-muted)]">
            Shopify reports only the first session of a customer&apos;s journey, so someone who first arrived
            another way and clicked the ad straight onto the page later reads as having landed elsewhere. A
            product page under the collection counts as the collection&apos;s own page.
          </p>
          <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
            {brought
              ? `Every line but the last adds up to the Revenue column. The page also brought ${count(brought.orders)} ${orderWord(brought.orders)} worth ${money(brought.revenue, currency)} that bought nothing from the collection, which the client's per-collection sheet counts as zero and some other collection's revenue holds.`
              : "The lines above add up to the Revenue column."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
