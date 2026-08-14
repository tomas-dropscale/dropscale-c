import type { DailyMetricRow } from "@/lib/metrics/queries";

export type GoogleDailyMetric = Pick<
  DailyMetricRow,
  "day" | "ad_spend" | "impressions" | "clicks" | "conversions" | "conversion_value"
>;

export type ShopifyDailyMetric = Pick<
  DailyMetricRow,
  | "day"
  | "revenue"
  | "orders_count"
  | "units_sold"
  | "attributed_orders"
  | "attributed_revenue"
  | "refunds_amount"
  | "product_cost"
  | "payment_fees"
  | "shipping_cost"
  | "revenue_share_base"
  | "revenue_share_amount"
>;

export type ReportingFamilyResult<T> =
  | { state: "succeeded"; rows: T[] }
  | { state: "failed" }
  | { state: "not_applicable" };

export class ReportingMetricMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportingMetricMergeError";
  }
}

const GOOGLE_ZERO: Omit<GoogleDailyMetric, "day"> = {
  ad_spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  conversion_value: 0,
};

const SHOPIFY_ZERO: Omit<ShopifyDailyMetric, "day"> = {
  revenue: 0,
  orders_count: 0,
  units_sold: 0,
  attributed_orders: 0,
  attributed_revenue: 0,
  refunds_amount: 0,
  product_cost: 0,
  payment_fees: 0,
  shipping_cost: 0,
  revenue_share_base: 0,
  revenue_share_amount: 0,
};

function calendar(from: string, to: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new ReportingMetricMergeError("The reporting date range is invalid.");
  }
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (
    Number.isNaN(cursor.getTime()) ||
    Number.isNaN(end.getTime()) ||
    cursor.toISOString().slice(0, 10) !== from ||
    end.toISOString().slice(0, 10) !== to
  ) {
    throw new ReportingMetricMergeError("The reporting date range is invalid.");
  }
  const days: string[] = [];
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function keyed<T extends { day: string }>(rows: T[], allowed: Set<string>, label: string) {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!allowed.has(row.day) || result.has(row.day)) {
      throw new ReportingMetricMergeError(`${label} returned an invalid or duplicate day.`);
    }
    result.set(row.day, row);
  }
  return result;
}

function googleFrom(row: DailyMetricRow) {
  return {
    ad_spend: Number(row.ad_spend),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    conversions: Number(row.conversions),
    conversion_value: Number(row.conversion_value),
  };
}

function shopifyFrom(row: DailyMetricRow) {
  return {
    revenue: Number(row.revenue),
    orders_count: Number(row.orders_count),
    units_sold: Number(row.units_sold),
    attributed_orders: row.attributed_orders == null ? null : Number(row.attributed_orders),
    attributed_revenue:
      row.attributed_revenue == null ? null : Number(row.attributed_revenue),
    refunds_amount: Number(row.refunds_amount),
    product_cost: Number(row.product_cost),
    payment_fees: Number(row.payment_fees),
    shipping_cost: Number(row.shipping_cost),
    revenue_share_base: Number(row.revenue_share_base),
    revenue_share_amount: Number(row.revenue_share_amount),
  };
}

/**
 * Merges independently authoritative Google and Shopify families into the
 * existing compatibility row. A failed source never turns unknown data into
 * zero; first-write windows wait until every applicable source can answer.
 */
export function mergeDailyMetricFamilies({
  adAccountId,
  from,
  to,
  existing,
  google,
  shopify,
  computedAt,
}: {
  adAccountId: string;
  from: string;
  to: string;
  existing: DailyMetricRow[];
  google: ReportingFamilyResult<GoogleDailyMetric>;
  shopify: ReportingFamilyResult<ShopifyDailyMetric>;
  computedAt: string;
}): DailyMetricRow[] {
  const days = calendar(from, to);
  const allowed = new Set(days);
  const prior = keyed(existing, allowed, "Stored metrics");
  const googleRows = google.state === "succeeded" ? keyed(google.rows, allowed, "Google") : null;
  const shopifyRows =
    shopify.state === "succeeded" ? keyed(shopify.rows, allowed, "Shopify") : null;
  const hasFailedFamily = google.state === "failed" || shopify.state === "failed";

  if (
    hasFailedFamily &&
    days.some((day) => !prior.has(day))
  ) {
    throw new ReportingMetricMergeError(
      "A reporting source failed before the window had a value to preserve.",
    );
  }

  return days.map((day) => {
    const stored = prior.get(day);
    const googleFamily =
      google.state === "succeeded"
        ? googleRows?.get(day) ?? GOOGLE_ZERO
        : google.state === "failed"
          ? googleFrom(stored!)
          : GOOGLE_ZERO;
    const shopifyFamily =
      shopify.state === "succeeded"
        ? shopifyRows?.get(day) ?? SHOPIFY_ZERO
        : shopify.state === "failed"
          ? shopifyFrom(stored!)
          : SHOPIFY_ZERO;

    return {
      ad_account_id: adAccountId,
      day,
      ...googleFamily,
      ...shopifyFamily,
      // A compatibility row is only as fresh as its stalest applicable
      // family. Per-family receipts carry the more precise success evidence.
      computed_at: hasFailedFamily ? stored!.computed_at : computedAt,
    };
  });
}
