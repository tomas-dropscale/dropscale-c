import { describe, expect, it } from "vitest";

import type { DailyMetricRow } from "@/lib/metrics/queries";
import {
  mergeDailyMetricFamilies,
  ReportingMetricMergeError,
} from "./daily-metrics";

const ACCOUNT = "70000000-0000-4000-8000-000000000001";
const COMPUTED_AT = "2026-08-14T12:00:00.000Z";

function row(day: string, overrides: Partial<DailyMetricRow> = {}): DailyMetricRow {
  return {
    ad_account_id: ACCOUNT,
    day,
    ad_spend: 10,
    impressions: 100,
    clicks: 20,
    conversions: 2,
    conversion_value: 30,
    revenue: 50,
    orders_count: 4,
    units_sold: 5,
    attributed_orders: 3,
    attributed_revenue: 40,
    refunds_amount: 1,
    product_cost: 12,
    payment_fees: 2,
    shipping_cost: 3,
    revenue_share_base: 8,
    revenue_share_amount: 1,
    computed_at: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("daily reporting family merge", () => {
  it("preserves Shopify when Google succeeds and Shopify fails", () => {
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-13",
      to: "2026-08-13",
      existing: [row("2026-08-13")],
      google: {
        state: "succeeded",
        rows: [
          {
            day: "2026-08-13",
            ad_spend: 22,
            impressions: 200,
            clicks: 40,
            conversions: 4,
            conversion_value: 60,
          },
        ],
      },
      shopify: { state: "failed" },
      computedAt: COMPUTED_AT,
    });

    expect(result[0]).toMatchObject({
      ad_spend: 22,
      revenue: 50,
      product_cost: 12,
      computed_at: "2026-08-13T12:00:00.000Z",
    });
  });

  it("preserves Google when Shopify succeeds and Google fails", () => {
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-13",
      to: "2026-08-13",
      existing: [row("2026-08-13")],
      google: { state: "failed" },
      shopify: {
        state: "succeeded",
        rows: [{ ...row("2026-08-13"), revenue: 90 }],
      },
      computedAt: COMPUTED_AT,
    });

    expect(result[0]).toMatchObject({
      ad_spend: 10,
      revenue: 90,
      computed_at: "2026-08-13T12:00:00.000Z",
    });
  });

  it("materializes the full calendar and treats successful missing days as real zero", () => {
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-12",
      to: "2026-08-14",
      existing: [row("2026-08-13", { ad_spend: 99, revenue: 99 })],
      google: { state: "succeeded", rows: [] },
      shopify: { state: "not_applicable" },
      computedAt: COMPUTED_AT,
    });

    expect(result.map((entry) => entry.day)).toEqual([
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
    expect(result.every((entry) => entry.ad_spend === 0)).toBe(true);
    // The stored 08-13 Shopify values are carried: not_applicable means the
    // binding has no such source NOW, never a licence to erase what was
    // measured. The surrounding days never had a row and stay zero.
    expect(result.map((entry) => entry.revenue)).toEqual([0, 99, 0]);
    expect(result.every((entry) => entry.computed_at === COMPUTED_AT)).toBe(true);
  });

  const shopifyOnly = (day: string, revenue: number) => ({
    day,
    revenue,
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
  });

  it("carries stored Google history after a store handover removes the source", () => {
    // A handover moves the Google source to another store: the old account's
    // binding becomes Shopify-only, so the google family turns not_applicable
    // while the window still covers days with real recorded spend.
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-12",
      to: "2026-08-13",
      existing: [row("2026-08-12", { ad_spend: 218.64, revenue: 183.07 })],
      google: { state: "not_applicable" },
      shopify: {
        state: "succeeded",
        // Only Shopify-family fields, as the real adapter sends them: a full
        // row here would smuggle google columns into the spread and mask the
        // carry this test exists to prove.
        rows: [shopifyOnly("2026-08-12", 200), shopifyOnly("2026-08-13", 50)],
      },
      computedAt: COMPUTED_AT,
    });

    // Spend history survives; revenue keeps refreshing; the day that never
    // had a row gets zero spend, not an invented carry.
    expect(result[0]).toMatchObject({ day: "2026-08-12", ad_spend: 218.64, revenue: 200 });
    expect(result[1]).toMatchObject({ day: "2026-08-13", ad_spend: 0, revenue: 50 });
  });

  it("keeps refreshing stored days when a family fails and the newest day has no value yet", () => {
    // Every hourly window ends on today, and today's row does not exist until
    // this sync writes it. Failing the whole window there would freeze the
    // HEALTHY family too, from the first midnight after a family started
    // failing — the exact freeze a latched health error used to cause.
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-13",
      to: "2026-08-14",
      existing: [row("2026-08-13")],
      google: { state: "failed" },
      shopify: {
        state: "succeeded",
        rows: [
          { ...row("2026-08-13"), revenue: 90 },
          { ...row("2026-08-14"), revenue: 70 },
        ],
      },
      computedAt: COMPUTED_AT,
    });

    // The stored day refreshes with fresh Shopify and carried Google figures;
    // the day with nothing to carry is skipped rather than invented as zero.
    expect(result.map((entry) => entry.day)).toEqual(["2026-08-13"]);
    expect(result[0]).toMatchObject({ revenue: 90, ad_spend: 10 });
  });

  it("refuses a partial first write when an applicable source failed", () => {
    expect(() =>
      mergeDailyMetricFamilies({
        adAccountId: ACCOUNT,
        from: "2026-08-13",
        to: "2026-08-13",
        existing: [],
        google: { state: "succeeded", rows: [] },
        shopify: { state: "failed" },
        computedAt: COMPUTED_AT,
      }),
    ).toThrowError(ReportingMetricMergeError);
  });

  it("rejects duplicate provider days instead of summing them", () => {
    const google = {
      day: "2026-08-13",
      ad_spend: 1,
      impressions: 1,
      clicks: 1,
      conversions: 1,
      conversion_value: 1,
    };
    expect(() =>
      mergeDailyMetricFamilies({
        adAccountId: ACCOUNT,
        from: "2026-08-13",
        to: "2026-08-13",
        existing: [],
        google: { state: "succeeded", rows: [google, google] },
        shopify: { state: "not_applicable" },
        computedAt: COMPUTED_AT,
      }),
    ).toThrowError(/duplicate day/);
  });

  it("rejects calendar dates that JavaScript would otherwise roll forward", () => {
    expect(() =>
      mergeDailyMetricFamilies({
        adAccountId: ACCOUNT,
        from: "2026-02-31",
        to: "2026-03-01",
        existing: [],
        google: { state: "not_applicable" },
        shopify: { state: "not_applicable" },
        computedAt: COMPUTED_AT,
      }),
    ).toThrowError(/date range is invalid/);
  });
});
