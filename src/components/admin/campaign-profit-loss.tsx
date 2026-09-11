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
  /** The reporting day has not closed: the figures are still moving. */
  inProgress: boolean;
};

export type CampaignProfitLoss = {
  rows: CampaignProfitLossRow[];
  total: Omit<CampaignProfitLossRow, "day" | "inProgress">;
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

export function buildCampaignProfitLoss(
  campaign: Pick<AdminAnalyticsCampaign, "timeline">,
  today: string,
): CampaignProfitLoss {
  const byDay = new Map<string, CampaignProfitLossRow>();
  for (const point of campaign.timeline) {
    const day = dayOf(point.bucket);
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
      inProgress: day >= today,
    };
    row.spend += point.spend;
    row.clicks += point.clicks ?? 0;
    row.impressions += point.impressions ?? 0;
    row.addedToCart = sumNullable([row.addedToCart, point.addedToCart ?? null]);
    row.revenue = sumNullable([row.revenue, point.shopifyRevenue]);
    row.orders = sumNullable([row.orders, point.shopifyOrders ?? null]);
    row.units = sumNullable([row.units, point.units ?? null]);
    byDay.set(day, row);
  }

  const rows = [...byDay.values()]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((row) => ({
      ...row,
      ctr: ratio(row.clicks, row.impressions),
      cvr: ratio(row.orders, row.addedToCart),
      roas: ratio(row.revenue, row.spend > 0 ? row.spend : null),
      cpa: row.orders !== null && row.orders > 0 ? row.spend / row.orders : null,
    }));

  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const addedToCart = sumNullable(rows.map((row) => row.addedToCart));
  const revenue = sumNullable(rows.map((row) => row.revenue));
  const orders = sumNullable(rows.map((row) => row.orders));
  const units = sumNullable(rows.map((row) => row.units));
  return {
    rows,
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
  { label: "Orders", align: "right" },
  { label: "Units", align: "right" },
  { label: "CVR (cart → order)", align: "right" },
  { label: "ROAS", align: "right" },
  { label: "CPA", align: "right" },
];

export function CampaignProfitLossSheet({
  campaign,
  currency,
  today,
  title,
}: {
  campaign: Pick<AdminAnalyticsCampaign, "timeline" | "attributionState">;
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
              dash the cells do not print. */}
          {sheet.total.revenue !== null
            ? "Google delivery · Shopify last-non-direct-click sales for this campaign"
            : campaign.attributionState === "unmatched"
              ? "Google delivery only · no Shopify UTM match for this campaign, so sales read “—”"
              : "Google delivery only · Shopify attribution unavailable, so sales read “—”"}
        </p>
      </div>
      {sheet.rows.length === 0 ? (
        <p className="px-4 py-3 text-[11px] text-[var(--text-muted)]">No days were returned for this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-[11.5px]">
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
                  <td className={cell}>{count(row.orders)}</td>
                  <td className={cell}>{count(row.units)}</td>
                  <td className={cell}>{percent(row.cvr)}</td>
                  <td className={cell}>{times(row.roas)}</td>
                  <td className={cell}>{amount(row.cpa, currency)}</td>
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
                <td className={cell}>{count(sheet.total.orders)}</td>
                <td className={cell}>{count(sheet.total.units)}</td>
                <td className={cell}>{percent(sheet.total.cvr)}</td>
                <td className={cell}>{times(sheet.total.roas)}</td>
                <td className={cell}>{amount(sheet.total.cpa, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
