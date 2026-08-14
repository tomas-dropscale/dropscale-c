import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/metrics/recompute", () => ({ RECOMPUTE_INTERVAL_MS: 15 * 60 * 1000 }));

import {
  fetchDailyMetrics,
  groupByAccount,
  rekeyDailyMetricRows,
  sumMetrics,
  type DailyMetricRow,
} from "./queries";

function row(adAccountId: string, adSpend: number): DailyMetricRow {
  return {
    ad_account_id: adAccountId,
    day: "2026-08-13",
    ad_spend: adSpend,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
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
    computed_at: "2026-08-13T12:00:00.000Z",
  };
}

describe("rekeyDailyMetricRows", () => {
  it("projects physical child rows onto their store anchors without mutating the input", () => {
    const input = [row("anchor-a", 10), row("child-a", 20), row("anchor-b", 30)];
    const snapshot = structuredClone(input);

    const projected = rekeyDailyMetricRows(
      input,
      new Map([
        ["anchor-a", ["anchor-a", "child-a"]],
        ["anchor-b", ["anchor-b"]],
      ]),
    );

    expect(input).toEqual(snapshot);
    expect(projected).not.toBe(input);
    expect(projected.every((metric, index) => metric !== input[index])).toBe(true);
    expect(projected.map((metric) => metric.ad_account_id)).toEqual([
      "anchor-a",
      "anchor-a",
      "anchor-b",
    ]);

    const byAccount = groupByAccount(projected);
    expect(sumMetrics(byAccount.get("anchor-a") ?? []).adSpend).toBe(30);
    expect(sumMetrics(byAccount.get("anchor-b") ?? []).adSpend).toBe(30);
  });

  it("leaves an unmapped physical id attached to itself", () => {
    const projected = rekeyDailyMetricRows(
      [row("unmapped", 5)],
      new Map([["anchor-a", ["anchor-a"]]]),
    );

    expect(projected[0].ad_account_id).toBe("unmapped");
  });
});

describe("fetchDailyMetrics", () => {
  it("fails closed instead of turning a database error into zero spend", async () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ["select", "in", "gte", "lte"]) {
      chain[name] = vi.fn(() => chain);
    }
    chain.order = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42501" },
    });
    mocks.createClient.mockResolvedValue({
      from: vi.fn(() => chain),
    });

    await expect(
      fetchDailyMetrics(["account-1"], "2026-08-01", "2026-08-07"),
    ).rejects.toThrow("Daily metrics are unavailable");
  });
});
