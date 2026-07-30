import { describe, expect, it } from "vitest";
import { buildPnlSheet, monthDays } from "./pnl";
import type { DailyMetricRow } from "@/lib/metrics/queries";

/**
 * The sheet is what a client reads to decide whether the month worked, so the
 * arithmetic is pinned here — including the two ways a P&L usually goes wrong:
 * ratios averaged instead of re-derived, and a running total that resets.
 */

function row(over: Partial<DailyMetricRow> & { day: string }): DailyMetricRow {
  return {
    ad_account_id: "a1",
    ad_spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
    revenue: 0,
    orders_count: 0,
    units_sold: 0,
    attributed_orders: 0,
    refunds_amount: 0,
    product_cost: 0,
    payment_fees: 0,
    shipping_cost: 0,
    revenue_share_base: 0,
    revenue_share_amount: 0,
    computed_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

const rates = new Map([["a1", 10]]);

describe("monthDays", () => {
  it("covers the whole month", () => {
    expect(monthDays(2026, 7)).toHaveLength(31);
    expect(monthDays(2026, 7)[0]).toBe("2026-07-01");
    expect(monthDays(2026, 7).at(-1)).toBe("2026-07-31");
  });

  it("knows February, leap year included", () => {
    expect(monthDays(2026, 2)).toHaveLength(28);
    expect(monthDays(2028, 2)).toHaveLength(29);
  });
});

describe("buildPnlSheet", () => {
  const days = monthDays(2026, 7).slice(0, 3);

  it("derives the whole cost chain and the profit left over", () => {
    const sheet = buildPnlSheet(
      [
        row({
          day: "2026-07-01",
          revenue: 510.59,
          refunds: 0,
          refunds_amount: 54.61,
          orders_count: 14,
          product_cost: 175,
          ad_spend: 158.97,
          payment_fees: 16.96,
        } as Partial<DailyMetricRow> & { day: string }),
      ],
      days,
      rates,
    );

    const first = sheet.days[0];
    expect(first.netRevenue).toBe(455.98); // 510.59 − 54.61
    expect(first.agencyFee).toBe(15.9); // 10% of 158.97
    // 175 + 158.97 + 15.90 + 16.96
    expect(first.totalCosts).toBe(366.83);
    expect(first.profit).toBe(89.15);
    expect(first.margin).toBeCloseTo(0.1955, 4);
    expect(first.cogsPct).toBeCloseTo(0.3838, 4);
    expect(first.roas).toBeCloseTo(2.868, 3);
  });

  it("keeps a running profit across days, negatives included", () => {
    const sheet = buildPnlSheet(
      [
        row({ day: "2026-07-01", revenue: 100 }),
        row({ day: "2026-07-02", ad_spend: 300 }), // a loss
        row({ day: "2026-07-03", revenue: 250 }),
      ],
      days,
      rates,
    );

    expect(sheet.days.map((day) => day.cumulativeProfit)).toEqual([100, -230, 20]);
    expect(sheet.totals.profit).toBe(20);
  });

  it("emits a row for every day, including ones with no activity", () => {
    const sheet = buildPnlSheet([row({ day: "2026-07-02", revenue: 50 })], days, rates);

    expect(sheet.days).toHaveLength(3);
    expect(sheet.days[0]).toMatchObject({ day: "2026-07-01", netRevenue: 0, profit: 0 });
    // A quiet day must not break the running total.
    expect(sheet.days.map((day) => day.cumulativeProfit)).toEqual([0, 50, 50]);
  });

  it("bills each store at its own rate rather than a blended one", () => {
    const sheet = buildPnlSheet(
      [
        row({ day: "2026-07-01", ad_account_id: "a1", ad_spend: 100 }), // 10%
        row({ day: "2026-07-01", ad_account_id: "a2", ad_spend: 100 }), // 25%
      ],
      days,
      new Map([
        ["a1", 10],
        ["a2", 25],
      ]),
    );

    expect(sheet.days[0].agencyFee).toBe(35); // 10 + 25, not 200 × some average
  });

  it("re-derives total ratios from the sums, not by averaging the days", () => {
    const sheet = buildPnlSheet(
      [
        // A tiny day at a wild margin, next to the day that actually matters.
        row({ day: "2026-07-01", revenue: 10, product_cost: 1 }),
        row({ day: "2026-07-02", revenue: 1000, product_cost: 600 }),
      ],
      days,
      rates,
    );

    // Averaging the two days' cogsPct would give ~35%; the truth is
    // 601/1010 = 0.59505.
    expect(sheet.totals.cogsPct).toBeCloseTo(601 / 1010, 6);
  });

  it("never divides by zero", () => {
    const sheet = buildPnlSheet([], days, rates);
    expect(sheet.totals).toMatchObject({ margin: 0, cogsPct: 0, roas: 0, profit: 0 });
  });
});
