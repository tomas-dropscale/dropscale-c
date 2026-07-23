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
  refunds_amount: number;
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
  adSpend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  /** revenue − refunds − adSpend. Fees/COGS come later, in the P&L phase. */
  grossProfit: number;
  roas: number;
  ctr: number;
  cpc: number;
  costPerConversion: number;
  aov: number;
  /** Marketing Efficiency Ratio: net revenue / ad spend. */
  mer: number;
  conversionRate: number;
};

export function sumMetrics(rows: DailyMetricRow[]): MetricTotals {
  const total = rows.reduce(
    (sum, row) => ({
      revenue: sum.revenue + Number(row.revenue),
      refunds: sum.refunds + Number(row.refunds_amount),
      orders: sum.orders + row.orders_count,
      adSpend: sum.adSpend + Number(row.ad_spend),
      impressions: sum.impressions + row.impressions,
      clicks: sum.clicks + row.clicks,
      conversions: sum.conversions + Number(row.conversions),
      conversionValue: sum.conversionValue + Number(row.conversion_value),
    }),
    {
      revenue: 0,
      refunds: 0,
      orders: 0,
      adSpend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversionValue: 0,
    },
  );

  const netRevenue = total.revenue - total.refunds;

  return {
    ...total,
    netRevenue,
    grossProfit: netRevenue - total.adSpend,
    roas: total.adSpend > 0 ? total.conversionValue / total.adSpend : 0,
    ctr: total.impressions > 0 ? total.clicks / total.impressions : 0,
    cpc: total.clicks > 0 ? total.adSpend / total.clicks : 0,
    costPerConversion: total.conversions > 0 ? total.adSpend / total.conversions : 0,
    aov: total.orders > 0 ? netRevenue / total.orders : 0,
    mer: total.adSpend > 0 ? netRevenue / total.adSpend : 0,
    conversionRate: total.clicks > 0 ? total.conversions / total.clicks : 0,
  };
}

// ---------------------------------------------------------------------------
// Bridges to the existing 10-card MetricsGrid (MetricSet shape)
// ---------------------------------------------------------------------------

import type { MetricSet } from "@/lib/portal/mock";

/**
 * One account's daily_metrics rows → the MetricSet the metric cards render.
 * `feeRatePct` is that account's commission_rate — the days when every store
 * paid a flat DROPSCALE_FEE_RATE are over, so fee is computed here, per
 * account, never by the generic aggregator.
 */
export function metricSetFromRows(rows: DailyMetricRow[], feeRatePct: number): MetricSet {
  const totals = sumMetrics(rows);
  return {
    spend: totals.adSpend,
    impressions: totals.impressions,
    clicks: totals.clicks,
    conversions: totals.conversions,
    ctr: totals.ctr,
    fee: (totals.adSpend * feeRatePct) / 100,
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
