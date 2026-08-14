/**
 * Read side of daily_metrics — what every restructured dashboard page calls.
 * Pure reads over the pre-aggregated table; the ONLY paths that talk to
 * Google/Shopify live in recompute.ts.
 */

import { createClient } from "@/lib/supabase/server";
import { RECOMPUTE_INTERVAL_MS } from "@/lib/metrics/recompute";

export type DailyMetricRow = {
  ad_account_id: string;
  day: string;
  ad_spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
  revenue: number;
  orders_count: number;
  units_sold: number;
  /** Orders minus Meta-referred ones (0019). NULL = never computed for this day. */
  attributed_orders: number | null;
  /** Gross revenue of those orders, reporting currency (0019). */
  attributed_revenue: number | null;
  refunds_amount: number;
  product_cost: number;
  payment_fees: number;
  shipping_cost: number;
  revenue_share_base: number;
  revenue_share_amount: number;
  computed_at: string;
};

export async function fetchDailyMetrics(
  accountIds: string[],
  from: string,
  to: string,
): Promise<DailyMetricRow[]> {
  if (accountIds.length === 0) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("daily_metrics")
    .select("*")
    .in("ad_account_id", accountIds)
    .gte("day", from)
    .lte("day", to)
    .order("day", { ascending: true });

  return (data as DailyMetricRow[] | null) ?? [];
}

export type MetricTotals = {
  revenue: number;
  refunds: number;
  netRevenue: number;
  orders: number;
  /** Line-item quantities sold — one order can be five units. */
  units: number;
  adSpend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  productCost: number;
  paymentFees: number;
  shippingCost: number;
  /** revenue − refunds − adSpend, BEFORE COGS/fees — kept for charts. */
  grossProfit: number;
  /** The real chain: net − COGS − payment fees − shipping − ad spend. */
  profit: number;
  /** profit / netRevenue — the number COGS edits actually move. */
  margin: number;
  roas: number;
  ctr: number;
  cpc: number;
  /** Google-attributed CPA: ad spend / Google conversions. The Google views. */
  costPerConversion: number;
  aov: number;
  /** Marketing Efficiency Ratio: net revenue / ad spend. */
  mer: number;
  /** Google-attributed CR: Google conversions / clicks. The Google views. */
  conversionRate: number;
  /**
   * Store-wide conversion figures — the dashboard's. A conversion there is a
   * real order in the shop (Shopify orders_count), not a Google-attributed
   * one: the client's store sells through channels Google never sees, so the
   * Google number understates what the store actually converted.
   *
   * Shopify's Admin API gives no sessions, so the rate's denominator stays ad
   * clicks — read it as "store orders per ad click", not as a site-wide CR.
   */
  costPerOrder: number;
  orderConversionRate: number;
  /**
   * The store's CONVERSIONS: real orders minus the ones Instagram or Facebook
   * referred (migration 0019). This is what belongs beside Google ad spend —
   * Google's own count is almost always 0 for want of conversion tracking, and
   * total orders would credit the ads with Meta's sales.
   *
   * Null when NO day in the window has been computed yet, so the UI can fall
   * back to Google's figure instead of asserting zero conversions. Days that
   * genuinely converted nothing contribute 0 and keep the total non-null.
   */
  attributedOrders: number | null;
  /** Ad spend / attributedOrders — the CPA that matches the figure above. */
  costPerAttributedOrder: number;
  /**
   * What those conversions were worth: gross revenue of the same orders. Google's
   * conversion_value is 0 wherever its conversion count is, which is what left
   * the CONV. VALUE card dead beside a working conversions figure. Null follows
   * attributedOrders — either the window has been computed or it hasn't.
   */
  attributedRevenue: number | null;
};

export function sumMetrics(rows: DailyMetricRow[]): MetricTotals {
  const total = rows.reduce(
    (sum, row) => ({
      revenue: sum.revenue + Number(row.revenue),
      refunds: sum.refunds + Number(row.refunds_amount),
      orders: sum.orders + row.orders_count,
      units: sum.units + (row.units_sold ?? 0),
      adSpend: sum.adSpend + Number(row.ad_spend),
      impressions: sum.impressions + row.impressions,
      clicks: sum.clicks + row.clicks,
      conversions: sum.conversions + Number(row.conversions),
      conversionValue: sum.conversionValue + Number(row.conversion_value),
      productCost: sum.productCost + Number(row.product_cost ?? 0),
      paymentFees: sum.paymentFees + Number(row.payment_fees ?? 0),
      shippingCost: sum.shippingCost + Number(row.shipping_cost ?? 0),
    }),
    {
      revenue: 0,
      refunds: 0,
      orders: 0,
      units: 0,
      adSpend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversionValue: 0,
      productCost: 0,
      paymentFees: 0,
      shippingCost: 0,
    },
  );

  const netRevenue = total.revenue - total.refunds;
  const profit =
    netRevenue - total.productCost - total.paymentFees - total.shippingCost - total.adSpend;

  // Summed separately from the reduce above because "no day computed yet" has to
  // survive as null rather than collapsing into 0 — a dashboard asserting zero
  // conversions over real orders is the failure this column exists to avoid.
  const computed = rows.filter((row) => row.attributed_orders !== null);
  const attributedOrders =
    computed.length > 0
      ? computed.reduce((sum, row) => sum + Number(row.attributed_orders), 0)
      : null;
  const attributedRevenue =
    computed.length > 0
      ? computed.reduce((sum, row) => sum + Number(row.attributed_revenue ?? 0), 0)
      : null;

  return {
    ...total,
    attributedOrders,
    attributedRevenue,
    costPerAttributedOrder:
      attributedOrders && attributedOrders > 0 ? total.adSpend / attributedOrders : 0,
    netRevenue,
    grossProfit: netRevenue - total.adSpend,
    profit,
    margin: netRevenue > 0 ? profit / netRevenue : 0,
    roas: total.adSpend > 0 ? total.conversionValue / total.adSpend : 0,
    ctr: total.impressions > 0 ? total.clicks / total.impressions : 0,
    cpc: total.clicks > 0 ? total.adSpend / total.clicks : 0,
    costPerConversion: total.conversions > 0 ? total.adSpend / total.conversions : 0,
    aov: total.orders > 0 ? netRevenue / total.orders : 0,
    mer: total.adSpend > 0 ? netRevenue / total.adSpend : 0,
    conversionRate: total.clicks > 0 ? total.conversions / total.clicks : 0,
    costPerOrder: total.orders > 0 ? total.adSpend / total.orders : 0,
    orderConversionRate: total.clicks > 0 ? total.orders / total.clicks : 0,
  };
}

// ---------------------------------------------------------------------------
// Bridges to the MetricsGrid cards (MetricSet shape)
// ---------------------------------------------------------------------------

import type { MetricSet } from "@/lib/portal/mock";

/**
 * One account's daily_metrics rows → the MetricSet the metric cards render.
 * A number is retained for demo/legacy callers. Financial portal pages pass a
 * resolver so each row uses the sealed manual term in force on that day; a
 * Monday grant must never reprice earlier dashboard history.
 */
export function metricSetFromRows(
  rows: DailyMetricRow[],
  feeRate: number | ((row: DailyMetricRow) => number),
): MetricSet {
  const totals = sumMetrics(rows);
  const fee = rows.reduce((sum, row) => {
    const rate = typeof feeRate === "function" ? feeRate(row) : feeRate;
    return sum + (Number(row.ad_spend) * rate) / 100;
  }, 0);
  return {
    spend: totals.adSpend,
    impressions: totals.impressions,
    clicks: totals.clicks,
    conversions: totals.conversions,
    ctr: totals.ctr,
    fee,
    cpc: totals.cpc,
    costPerConversion: totals.costPerConversion,
    roas: totals.roas,
    conversionValue: totals.conversionValue,
  };
}

/**
 * Cross-account combine that respects per-account fees: sums are summed
 * (including each account's own fee), ratios re-derived from the sums.
 */
export function combineMetricSets(sets: MetricSet[]): MetricSet {
  const total = sets.reduce(
    (sum, set) => ({
      spend: sum.spend + set.spend,
      impressions: sum.impressions + set.impressions,
      clicks: sum.clicks + set.clicks,
      conversions: sum.conversions + set.conversions,
      fee: sum.fee + set.fee,
      conversionValue: sum.conversionValue + set.conversionValue,
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, fee: 0, conversionValue: 0 },
  );

  return {
    ...total,
    ctr: total.impressions > 0 ? total.clicks / total.impressions : 0,
    cpc: total.clicks > 0 ? total.spend / total.clicks : 0,
    costPerConversion: total.conversions > 0 ? total.spend / total.conversions : 0,
    roas: total.spend > 0 ? total.conversionValue / total.spend : 0,
  };
}

/** Rows grouped per account — comparison tables consume this. */
export function groupByAccount(rows: DailyMetricRow[]): Map<string, DailyMetricRow[]> {
  const byAccount = new Map<string, DailyMetricRow[]>();
  for (const row of rows) {
    const bucket = byAccount.get(row.ad_account_id);
    if (bucket) bucket.push(row);
    else byAccount.set(row.ad_account_id, [row]);
  }
  return byAccount;
}

/** Projects physical V2 metric rows back onto their public store anchors. */
export function rekeyDailyMetricRows(
  rows: readonly DailyMetricRow[],
  metricIdsByAccount: ReadonlyMap<string, readonly string[]>,
): DailyMetricRow[] {
  const accountByMetricId = new Map<string, string>();
  for (const [accountId, metricIds] of metricIdsByAccount) {
    for (const metricId of metricIds) accountByMetricId.set(metricId, accountId);
  }
  return rows.map((row) => ({
    ...row,
    ad_account_id: accountByMetricId.get(row.ad_account_id) ?? row.ad_account_id,
  }));
}

/** Rows grouped per day across accounts — the shape charts consume. */
export function groupByDay(rows: DailyMetricRow[]): Map<string, DailyMetricRow[]> {
  const byDay = new Map<string, DailyMetricRow[]>();
  for (const row of rows) {
    const bucket = byDay.get(row.day);
    if (bucket) bucket.push(row);
    else byDay.set(row.day, [row]);
  }
  return byDay;
}

/** Freshness for the "Updated … · next update at …" header line. */
export function freshness(rows: DailyMetricRow[]): { updatedAt: string | null; nextUpdateAt: string | null } {
  if (rows.length === 0) return { updatedAt: null, nextUpdateAt: null };
  const newest = rows.reduce(
    (max, row) => (row.computed_at > max ? row.computed_at : max),
    rows[0].computed_at,
  );
  return {
    updatedAt: newest,
    nextUpdateAt: new Date(new Date(newest).getTime() + RECOMPUTE_INTERVAL_MS).toISOString(),
  };
}
