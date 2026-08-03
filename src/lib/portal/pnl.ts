/**
 * The P&L sheet: one row per day, the way a spreadsheet would lay it out.
 *
 * Everything here already exists in `daily_metrics` — Shopify revenue and
 * refunds, the COGS the client entered, payment and shipping costs, and Google
 * spend. This module only arranges it and does the arithmetic, so the numbers
 * cannot drift from the dashboard: same source, same day, one derivation.
 *
 * Deliberately free of imports beyond a type, so the money maths is testable
 * without a database — same contract as lib/billing/weekly.
 */

import type { DailyMetricRow } from "@/lib/metrics/queries";

export type PnlDay = {
  day: string;
  orders: number;
  grossRevenue: number;
  refunds: number;
  /** What the client actually kept from the shop, before any cost. */
  netRevenue: number;
  cogs: number;
  adSpend: number;
  /** Operational estimate; exact invoices additionally apply start/end counters. */
  agencyFee: number;
  revShare: number;
  paymentFees: number;
  shipping: number;
  totalCosts: number;
  profit: number;
  /** profit ÷ net revenue. 0 when there was no revenue. */
  margin: number;
  /** COGS ÷ net revenue — the ratio a store owner watches. */
  cogsPct: number;
  /** Net revenue ÷ ad spend. Store-wide, so it counts sales Google can't see. */
  roas: number;
  /** Running profit from the first day of the period through this one. */
  cumulativeProfit: number;
};

export type PnlTotals = Omit<PnlDay, "day" | "cumulativeProfit">;

export type PnlSheet = {
  days: PnlDay[];
  totals: PnlTotals;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Every day of `year`/`month` (1-12) as ISO strings, in calendar order. */
export function monthDays(year: number, month: number): string[] {
  const count = new Date(year, month, 0).getDate();
  return Array.from({ length: count }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    return `${year}-${String(month).padStart(2, "0")}-${day}`;
  });
}

/**
 * Build the sheet for one month.
 *
 * EVERY day of the month gets a row, including days with no activity — a
 * spreadsheet with holes in it is hard to read, and a zero row is information:
 * it says nothing was spent and nothing sold.
 *
 * The resolver may vary by account and day. This is required by immutable
 * Monday-effective referral terms: applying today's cache to a past month
 * would silently rewrite the client's historical P&L.
 */
export function buildPnlSheet(
  rows: DailyMetricRow[],
  days: string[],
  feeRate: Map<string, number> | ((accountId: string, day: string) => number),
): PnlSheet {
  const byDay = new Map<string, DailyMetricRow[]>();
  for (const row of rows) {
    const bucket = byDay.get(row.day);
    if (bucket) bucket.push(row);
    else byDay.set(row.day, [row]);
  }

  let running = 0;
  const built: PnlDay[] = days.map((day) => {
    const dayRows = byDay.get(day) ?? [];

    const grossRevenue = dayRows.reduce((sum, row) => sum + Number(row.revenue), 0);
    const refunds = dayRows.reduce((sum, row) => sum + Number(row.refunds_amount), 0);
    const netRevenue = grossRevenue - refunds;

    const cogs = dayRows.reduce((sum, row) => sum + Number(row.product_cost), 0);
    const adSpend = dayRows.reduce((sum, row) => sum + Number(row.ad_spend), 0);
    const paymentFees = dayRows.reduce((sum, row) => sum + Number(row.payment_fees), 0);
    const shipping = dayRows.reduce((sum, row) => sum + Number(row.shipping_cost), 0);
    const revShare = dayRows.reduce((sum, row) => sum + Number(row.revenue_share_amount), 0);
    const agencyFee = dayRows.reduce(
      (sum, row) => {
        const rate =
          typeof feeRate === "function"
            ? feeRate(row.ad_account_id, row.day)
            : (feeRate.get(row.ad_account_id) ?? 0);
        return sum + (Number(row.ad_spend) * rate) / 100;
      },
      0,
    );

    const totalCosts = cogs + adSpend + agencyFee + revShare + paymentFees + shipping;
    const profit = netRevenue - totalCosts;
    running += profit;

    return {
      day,
      orders: dayRows.reduce((sum, row) => sum + row.orders_count, 0),
      grossRevenue: round2(grossRevenue),
      refunds: round2(refunds),
      netRevenue: round2(netRevenue),
      cogs: round2(cogs),
      adSpend: round2(adSpend),
      agencyFee: round2(agencyFee),
      revShare: round2(revShare),
      paymentFees: round2(paymentFees),
      shipping: round2(shipping),
      totalCosts: round2(totalCosts),
      profit: round2(profit),
      margin: ratio(profit, netRevenue),
      cogsPct: ratio(cogs, netRevenue),
      roas: ratio(netRevenue, adSpend),
      cumulativeProfit: round2(running),
    };
  });

  // Totals are summed from the days, then the ratios re-derived from those
  // sums. Averaging the per-day percentages would weight a €5 day the same as
  // a €5 000 one.
  const sum = (pick: (day: PnlDay) => number) => round2(built.reduce((t, d) => t + pick(d), 0));

  const netRevenue = sum((day) => day.netRevenue);
  const cogs = sum((day) => day.cogs);
  const adSpend = sum((day) => day.adSpend);
  const profit = sum((day) => day.profit);

  return {
    days: built,
    totals: {
      orders: built.reduce((total, day) => total + day.orders, 0),
      grossRevenue: sum((day) => day.grossRevenue),
      refunds: sum((day) => day.refunds),
      netRevenue,
      cogs,
      adSpend,
      agencyFee: sum((day) => day.agencyFee),
      revShare: sum((day) => day.revShare),
      paymentFees: sum((day) => day.paymentFees),
      shipping: sum((day) => day.shipping),
      totalCosts: sum((day) => day.totalCosts),
      profit,
      margin: ratio(profit, netRevenue),
      cogsPct: ratio(cogs, netRevenue),
      roas: ratio(netRevenue, adSpend),
    },
  };
}
