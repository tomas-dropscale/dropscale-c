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

// A Google-only account HAS no Shopify family — its attribution columns must
// stay null ("never computed"), not 0 ("computed, zero conversions"): a 0 here
// would defeat the store group's null sentinel and let dashboards assert zero
// conversions for an anchor whose attribution never ran.
const SHOPIFY_NOT_APPLICABLE: Omit<ShopifyDailyMetric, "day"> = {
  ...SHOPIFY_ZERO,
  attributed_orders: null,
  attributed_revenue: null,
};

/** The zone every sync window is keyed on (presetSelection in portal/range). */
const REPORTING_TIME_ZONE = "Europe/Lisbon";

/**
 * The calendar day it is right now in a zone. A Google account's zone is
 * whatever Google reported for it and nothing validates it before a sync, so
 * a zone Intl does not know falls back to the reporting zone rather than
 * failing every window of that account, which would freeze both families.
 */
function currentDay(timeZone: string | null | undefined, now = new Date()): string {
  const dayIn = (zone: string) => {
    const parts = new Map(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  };
  try {
    return dayIn(timeZone?.trim() || REPORTING_TIME_ZONE);
  } catch {
    return dayIn(REPORTING_TIME_ZONE);
  }
}

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

/**
 * The Google family to write for a day the Google source answered.
 *
 * On the day in progress Windsor answers the same query with different
 * states within seconds, from backend replicas at different ingestion
 * points, and a cache-busting parameter does not change which one answers.
 * Measured 2026-09-15 on account 385-546-6298, today in the account-daily
 * table: 118.19 at 09:20 UTC, no row at 09:50 (this sync wrote 0), 118.61 at
 * 09:55, no row at 10:02 (0 again), 118.99 at 10:03, no row at 10:05:30 (the
 * cron today leg wrote 0), then 118.99 stably across eight samples. Account
 * 310-375-0707 read 185.93 at 09:55, 51.90 at 10:05:30 and 206.25 at
 * 10:06:43. Every hourly leg rewrote today with whatever state it hit, so
 * today regressed from a good value to 0 several times that morning for
 * several accounts. Closed days were identical in every sample.
 *
 * Truth for a day in progress only grows (spend, impressions, clicks,
 * conversions, conversion value) and neither Windsor table overshoots, so the
 * larger of the stored spend and the answer just read is always at least as
 * true as the smaller, and it converges on the final figure as fresh answers
 * arrive. A smaller answer, a missing row that would write GOOGLE_ZERO
 * included, therefore keeps the stored family whole: the five metrics travel
 * together, never mixed across two reads. A larger answer is written. An
 * equal one is written only when none of the other four metrics fell: a day
 * whose budget is spent plateaus (118.99 sat unchanged across those eight
 * samples) while Google keeps attributing conversions hours after their
 * clicks, so a replica behind another answers the same spend with fewer
 * conversions, and spend alone cannot tell the older state from the newer.
 * A closed day is Windsor final and always writes the answer, which is what
 * the daily close and the next day's rolling legs rely on to finalise it.
 *
 * Shopify has no such rule: orders are read exactly and a smaller answer can
 * be legitimate (a cancelled order), so the merge keeps writing whatever the
 * store reports.
 */
function googleForDay(
  fresh: Omit<GoogleDailyMetric, "day">,
  stored: DailyMetricRow | undefined,
  inProgress: boolean,
): Omit<GoogleDailyMetric, "day"> {
  if (!inProgress || !stored) return fresh;
  const kept = googleFrom(stored);
  const spend = Number(fresh.ad_spend);
  if (spend !== kept.ad_spend) return spend < kept.ad_spend ? kept : fresh;
  return GOOGLE_COUNTS.some((key) => Number(fresh[key]) < kept[key]) ? kept : fresh;
}

/** The Google metrics that break a tie on spend, each one growing with the day. */
const GOOGLE_COUNTS = ["impressions", "clicks", "conversions", "conversion_value"] as const;

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
 * zero; first-write windows wait until every applicable source can answer,
 * and the day in progress never regresses its Google family (googleForDay).
 */
export function mergeDailyMetricFamilies({
  adAccountId,
  from,
  to,
  existing,
  google,
  shopify,
  computedAt,
  timeZone,
  today = currentDay(timeZone),
}: {
  adAccountId: string;
  from: string;
  to: string;
  existing: DailyMetricRow[];
  google: ReportingFamilyResult<GoogleDailyMetric>;
  shopify: ReportingFamilyResult<ShopifyDailyMetric>;
  computedAt: string;
  /**
   * The Google account's own zone, the one its row days are keyed in: Windsor
   * reports segments.date in the account's zone, and several bound accounts
   * keep another zone than the Lisbon day the sync windows are cut on. An
   * account on New York time is still filling Lisbon's yesterday until about
   * 05:00 Lisbon, when a Lisbon clock would already call that day closed and
   * let a replica with no row for it write zero; one on Hong Kong time has
   * closed Lisbon's today by the afternoon, when a Lisbon clock would still
   * hold a downward correction back. The day in progress is therefore read on
   * this clock. Absent or unknown: the reporting zone, which is also every
   * Shopify-only account's answer.
   */
  timeZone?: string | null;
  /**
   * The current day on that clock. Every day of the window from it onwards
   * is still being filled; the days before it are closed. Tests pass it;
   * every sync leg takes the default.
   */
  today?: string;
}): DailyMetricRow[] {
  const days = calendar(from, to);
  const allowed = new Set(days);
  const prior = keyed(existing, allowed, "Stored metrics");
  const googleRows = google.state === "succeeded" ? keyed(google.rows, allowed, "Google") : null;
  const shopifyRows =
    shopify.state === "succeeded" ? keyed(shopify.rows, allowed, "Shopify") : null;
  const hasFailedFamily = google.state === "failed" || shopify.state === "failed";

  // A failed family can only be carried on a day that already has a stored
  // value. Days without one are SKIPPED, not invented: writing a zero there
  // would be indistinguishable from a real zero and would then be carried
  // forward for ever as if it had been measured.
  //
  // Skipping rather than failing the whole window is what keeps a degraded
  // account alive: the hourly window always contains today, and today's row
  // does not exist until this sync writes it, so failing the window would
  // freeze EVERY family — the healthy one included — from the first midnight
  // after a family started failing.
  const writable = hasFailedFamily ? days.filter((day) => prior.has(day)) : days;
  if (hasFailedFamily && writable.length === 0) {
    throw new ReportingMetricMergeError(
      "A reporting source failed before the window had a value to preserve.",
    );
  }

  return writable.map((day) => {
    const stored = prior.get(day);
    // "Not applicable" means the binding has no such source TODAY — it says
    // nothing about yesterday. An account that loses a family (a store handover
    // moves its Google source to another store) keeps measured history: zeroing
    // it here would silently erase the window's recorded spend on the first
    // sync after the swap. Carry the stored values; zeros are only for days
    // that never had a row.
    const googleFamily =
      google.state === "succeeded"
        ? googleForDay(googleRows?.get(day) ?? GOOGLE_ZERO, stored, day >= today)
        : google.state === "failed"
          ? googleFrom(stored!)
          : stored
            ? googleFrom(stored)
            : GOOGLE_ZERO;
    const shopifyFamily =
      shopify.state === "succeeded"
        ? shopifyRows?.get(day) ?? SHOPIFY_ZERO
        : shopify.state === "failed"
          ? shopifyFrom(stored!)
          : stored
            ? shopifyFrom(stored)
            : SHOPIFY_NOT_APPLICABLE;

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
