"use client";

import * as React from "react";

import type { AdminAnalyticsCampaign } from "@/lib/admin/store-analytics";
import { integer, money, multiplier } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A campaign's day-by-day profit and loss: what Google delivered next to what
 * Shopify really sold, one row per day, totals at the foot.
 *
 * Every figure is one the store already reports. Spend, clicks and
 * impressions are Google's; sessions that added to cart, orders and revenue
 * are Shopify's own last-non-direct-click attribution for this campaign's UTM;
 * units are the net items sold across the campaign's products. The ratios are
 * derived here and nowhere else, so the sheet and its totals can never
 * disagree: CTR is clicks over impressions, CVR is orders over cart additions,
 * ROAS is Shopify revenue over spend, CPA is spend over orders.
 *
 * A day Shopify has not answered for reads "—", never 0: a zero is a fact, a
 * dash is the absence of one, and a P&L that prints the two alike is wrong.
 *
 * Profit and its running total are the point of the sheet, and they need a
 * revenue to subtract the spend from. Three bases, tried in order and stated
 * once in the caption, never mixed day by day:
 *  - "shopify": Shopify matched the campaign's own utm_campaign - the real
 *    sales of this campaign, last non-direct click.
 *  - "collection": the ads carry no utm_campaign (every visit lands as plain
 *    Google traffic, which Shopify labels "google" or "alphabet"), but the
 *    campaign sends people to one collection page. Its sales are read from
 *    the orders by the rule the revenue share already applies - an order that
 *    landed on the page counts whole, any other order counts the lines whose
 *    product is in the collection - from any channel, not only this
 *    campaign's ads, split between the campaigns landing there by spend; cart
 *    additions are the Google visits that landed on the page; and the store's
 *    product costs price those same lines order by order, so profit is
 *    revenue minus spend minus COGS. A collection that sold nothing in the
 *    period is still this basis, with zeros, as long as the store has it.
 *  - "google": neither is known, so Google's own conversion value stands in.
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
  /** Revenue on the sheet's basis minus ad spend and COGS; null when the basis has no answer. */
  profit: number | null;
  /** Running sum of profit up to and including this day. */
  cumulative: number | null;
  /** The reporting day has not closed: the figures are still moving. */
  inProgress: boolean;
};

export type CampaignRevenueBasis = "shopify" | "collection" | "google";

export type CampaignProfitLoss = {
  rows: CampaignProfitLossRow[];
  total: Omit<CampaignProfitLossRow, "day" | "inProgress" | "cumulative">;
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

export function buildCampaignProfitLoss(
  campaign: Pick<AdminAnalyticsCampaign, "timeline">,
  today: string,
): CampaignProfitLoss {
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
  // Shopify's own match first, the landing collection next, Google last. A day
  // left unanswered on a Shopify or collection basis keeps its dash rather
  // than borrowing the next basis's number.
  const allFacts = [...facts.values()];
  const revenueBasis: CampaignRevenueBasis = allFacts.some((fact) => fact.utm.revenue !== null)
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
      const profit = revenue === null ? null : revenue - row.spend - (row.cogs ?? 0);
      if (profit !== null) running = (running ?? 0) + profit;
      return {
        ...row,
        ctr: ratio(row.clicks, row.impressions),
        cvr: ratio(row.orders, row.addedToCart),
        roas: ratio(row.revenue, row.spend > 0 ? row.spend : null),
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
  const revenue = sumNullable(rows.map((row) => row.revenue));
  const orders = sumNullable(rows.map((row) => row.orders));
  const units = sumNullable(rows.map((row) => row.units));
  const cogs = sumNullable(rows.map((row) => row.cogs));
  const predatesSheet =
    campaign.timeline.length > 0 &&
    campaign.timeline.every(
      (point) => point.shopifyOrders === undefined && point.collectionRevenue === undefined,
    );

  // The total is the sum of the rows it stands under - not basis revenue
  // minus every day's spend, which would charge the spend of a day whose
  // revenue is unknown and end the column on a number the rows never reach.
  const rowProfits = rows.map((row) => row.profit);
  const totalProfit = sumNullable(rowProfits);
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
      roas: ratio(revenue, spend > 0 ? spend : null),
      cpa: orders !== null && orders > 0 ? spend / orders : null,
      googleRevenue,
      cogs,
      profit: totalProfit,
    },
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

function count(value: number | null): string {
  return value === null ? "—" : integer(value);
}

function amount(value: number | null, currency: string): string {
  return value === null ? "—" : money(value, currency);
}

function times(value: number | null): string {
  return value === null ? "—" : multiplier(value);
}

const HEADERS: Array<{ label: string; align: "left" | "right" }> = [
  { label: "Day", align: "left" },
  { label: "Ad spend", align: "right" },
  { label: "Clicks", align: "right" },
  { label: "Impressions", align: "right" },
  { label: "CTR", align: "right" },
  { label: "Add to cart", align: "right" },
  { label: "Revenue (Shopify)", align: "right" },
  { label: "Revenue (Google)", align: "right" },
  { label: "Orders", align: "right" },
  { label: "Units", align: "right" },
  { label: "CVR (cart → order)", align: "right" },
  { label: "ROAS", align: "right" },
  { label: "CPA", align: "right" },
  { label: "COGS", align: "right" },
  { label: "Profit", align: "right" },
  { label: "Cumulative", align: "right" },
];

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

export function CampaignProfitLossSheet({
  campaign,
  currency,
  today,
  title,
}: {
  campaign: Pick<
    AdminAnalyticsCampaign,
    "timeline" | "attributionState" | "collectionHandle" | "collectionSource" | "collectionSharedWith"
  >;
  currency: string;
  today: string;
  title: string;
}) {
  const sheet = React.useMemo(() => buildCampaignProfitLoss(campaign, today), [campaign, today]);
  const cell = "px-2.5 py-2 text-right tabular-nums";

  return (
    <div
      className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
      role="region"
      aria-label={`${title} profit and loss by day`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <p className="text-[12px] font-semibold text-[var(--text-primary)]">Profit &amp; loss by day</p>
        <p className="text-[10.5px] text-[var(--text-muted)]">
          {/* Said from the sheet itself, so the caption can never promise a
              basis the cells do not use. */}
          {sheet.predatesSheet
            ? "This period's snapshot was taken before the sheet existed, so the Shopify columns and COGS are not computed yet. Snapshots refresh every hour; profit reads Google's conversion value until then."
            : sheet.revenueBasis === "shopify"
            ? "Profit on Shopify's real sales for this campaign (last non-direct click) · Google delivery"
            : sheet.revenueBasis === "collection"
              ? `Profit on every order that landed on /collections/${campaign.collectionHandle ?? ""} or a page under it (the whole order, net of refunds) or bought its items elsewhere (those lines), from any channel, not only this campaign's ads${
                  (campaign.collectionSharedWith ?? 1) > 1
                    ? `, split between the ${campaign.collectionSharedWith} campaigns that land there in proportion to spend, so orders and units are shares and need not be whole`
                    : ""
                } - minus ad spend${
                  sheet.total.cogs !== null
                    ? " and the product costs of those lines"
                    : " · product costs could not be read, so COGS reads “—” and is not subtracted"
                }${
                  sheet.total.addedToCart !== null
                    ? " · cart additions are Google visits that landed there"
                    : " · landing sessions could not be read, so cart additions read “—”"
                }${
                  // The clicks named the collection because nothing else did.
                  // That is the whole of what is known: a Performance Max or
                  // Shopping campaign has no final URL at all, but a Search or
                  // Demand Gen ad may point at a page that is not a collection,
                  // or at a product Shopify redirects to one, and the caption
                  // must not claim its ads name no URL when they do.
                  campaign.collectionSource === "landing"
                    ? " · the collection was read from where its clicks landed, as neither the campaign's final URLs nor its name names one"
                    : ""
                }`
              : campaign.attributionState === "unmatched"
                ? `Profit on Google's reported conversion value · Shopify sees no utm_campaign on this campaign's traffic${
                    campaign.collectionHandle ? "" : " and it lands on no single collection the store has"
                  }, so its sales read “—”. Tag the ads with utm_campaign={campaignid} to measure real sales.`
                : "Profit on Google's reported conversion value · Shopify attribution unavailable, so its sales read “—”"}
        </p>
      </div>
      {sheet.rows.length === 0 ? (
        <p className="px-4 py-3 text-[11px] text-[var(--text-muted)]">No days were returned for this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1400px] text-[11.5px]">
            <thead>
              <tr className="label-caps border-b border-[var(--border-subtle)]">
                {HEADERS.map((header) => (
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
                  <td className={cell}>{amount(row.revenue, currency)}</td>
                  <td className={cn(cell, "text-[var(--text-secondary)]")}>{money(row.googleRevenue, currency)}</td>
                  <td className={cell}>{count(row.orders)}</td>
                  <td className={cell}>{count(row.units)}</td>
                  <td className={cell}>{percent(row.cvr)}</td>
                  <td className={cell}>{times(row.roas)}</td>
                  <td className={cell}>{amount(row.cpa, currency)}</td>
                  <td className={cn(cell, "text-[var(--text-secondary)]")}>{amount(row.cogs, currency)}</td>
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
                <td className={cell}>{amount(sheet.total.revenue, currency)}</td>
                <td className={cn(cell, "text-[var(--text-secondary)]")}>{money(sheet.total.googleRevenue, currency)}</td>
                <td className={cell}>{count(sheet.total.orders)}</td>
                <td className={cell}>{count(sheet.total.units)}</td>
                <td className={cell}>{percent(sheet.total.cvr)}</td>
                <td className={cell}>{times(sheet.total.roas)}</td>
                <td className={cell}>{amount(sheet.total.cpa, currency)}</td>
                <td className={cn(cell, "text-[var(--text-secondary)]")}>{amount(sheet.total.cogs, currency)}</td>
                <ProfitCell value={sheet.total.profit} currency={currency} />
                <ProfitCell value={sheet.total.profit} currency={currency} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
