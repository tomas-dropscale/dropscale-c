import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyMetricRow } from "@/lib/metrics/queries";
import type { Database } from "@/lib/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  fetchDailyMetrics: vi.fn(),
  refreshAccountsNow: vi.fn(),
}));

vi.mock("@/lib/metrics/queries", () => ({
  fetchDailyMetrics: mocks.fetchDailyMetrics,
}));
vi.mock("@/lib/metrics/recompute", () => ({
  refreshAccountsNow: mocks.refreshAccountsNow,
}));

import { ensureAdminCampaignRollups } from "./campaign-rollup";

const service = {} as SupabaseClient<Database>;

function row(accountId: string, day: string, overrides: Partial<DailyMetricRow> = {}): DailyMetricRow {
  return {
    ad_account_id: accountId,
    day,
    ad_spend: 10,
    impressions: 100,
    clicks: 10,
    conversions: 1,
    conversion_value: 20,
    revenue: 30,
    orders_count: 1,
    units_sold: 1,
    attributed_orders: accountId === "anchor" ? 1 : null,
    attributed_revenue: accountId === "anchor" ? 30 : null,
    refunds_amount: 0,
    product_cost: 5,
    payment_fees: 1,
    shipping_cost: 2,
    revenue_share_base: 0,
    revenue_share_amount: 0,
    computed_at: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

const scopes = [{
  id: "store",
  accountIds: ["anchor", "child"],
  revenueAccountIds: ["anchor"],
}];
const range = { from: "2026-08-13", to: "2026-08-14" };

describe("Campaigns exact rollup coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshAccountsNow.mockResolvedValue(undefined);
  });

  it("accepts one exact row per physical account and selected day", async () => {
    const rows = [
      row("anchor", "2026-08-13"),
      row("anchor", "2026-08-14"),
      row("child", "2026-08-13"),
      row("child", "2026-08-14"),
    ];
    mocks.fetchDailyMetrics.mockResolvedValue(rows);

    const result = await ensureAdminCampaignRollups(service, scopes, range);

    expect(result.completeScopeIds).toEqual(new Set(["store"]));
    expect(result.refreshed).toBe(false);
    expect(mocks.refreshAccountsNow).not.toHaveBeenCalled();
  });

  it("refreshes the same inclusive range once and accepts the completed grid", async () => {
    const complete = [
      row("anchor", "2026-08-13"),
      row("anchor", "2026-08-14"),
      row("child", "2026-08-13"),
      row("child", "2026-08-14"),
    ];
    mocks.fetchDailyMetrics
      .mockResolvedValueOnce(complete.slice(0, -1))
      .mockResolvedValueOnce(complete);

    const result = await ensureAdminCampaignRollups(service, scopes, range);

    expect(result.completeScopeIds).toEqual(new Set(["store"]));
    expect(result.refreshed).toBe(true);
    expect(mocks.refreshAccountsNow).toHaveBeenCalledWith(
      ["anchor", "child"],
      expect.objectContaining({ from: range.from, to: range.to }),
    );
  });

  it("keeps the scope incomplete after a failed materialisation without using partial totals", async () => {
    mocks.fetchDailyMetrics.mockResolvedValue([
      row("anchor", "2026-08-13"),
      row("anchor", "2026-08-14", { attributed_revenue: null }),
      row("child", "2026-08-13"),
    ]);

    const result = await ensureAdminCampaignRollups(service, scopes, range);

    expect(result.completeScopeIds).toEqual(new Set());
    expect(result.refreshed).toBe(true);
    expect(mocks.fetchDailyMetrics).toHaveBeenCalledTimes(2);
  });

  it("supports an exact Google-only standalone scope without Shopify attribution", async () => {
    mocks.fetchDailyMetrics.mockResolvedValue([
      row("standalone", "2026-08-13", {
        attributed_orders: null,
        attributed_revenue: null,
      }),
      row("standalone", "2026-08-14", {
        attributed_orders: null,
        attributed_revenue: null,
      }),
    ]);

    const result = await ensureAdminCampaignRollups(service, [{
      id: "standalone",
      accountIds: ["standalone"],
      revenueAccountIds: [],
    }], range);

    expect(result.completeScopeIds).toEqual(new Set(["standalone"]));
  });
});
