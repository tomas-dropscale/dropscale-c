import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AdminAnalyticsCampaign,
  AdminProviderFreshness,
  AdminStoreAnalytics,
} from "@/lib/admin/store-analytics";

vi.mock("@/components/admin/performance-charts", () => ({
  SpendDevelopmentChart: () => <div>Spend chart</div>,
  FunnelDevelopmentChart: () => <div>Funnel chart</div>,
  RoasEvolutionHover: () => <span>ROAS hover</span>,
}));

vi.mock("./campaign-profit-loss", () => ({
  CampaignProfitLossSheet: () => <div>P&amp;L sheet</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <span {...props}>{children}</span>
  ),
}));

vi.mock("@/lib/format", () => ({
  integer: (value: number) => String(value),
  money: (value: number, currency: string) => `${currency} ${value.toFixed(2)}`,
  multiplier: (value: number) => `${value.toFixed(2)}x`,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

import { CampaignPerformanceSection, snapshotFreshnessLine } from "./store-analytics-sections";

function campaign(): AdminAnalyticsCampaign {
  return {
    accountId: "google-child",
    campaignId: "123456789",
    name: "PMax · Best sellers",
    status: "active",
    type: "PERFORMANCE_MAX",
    shoppingFeed: true,
    budget: 90,
    spend: 250,
    impressions: 10_000,
    clicks: 400,
    conversions: 12,
    googleRevenue: 800,
    shopifySessions: null,
    shopifyOrders: null,
    shopifyRevenue: null,
    ctr: 0.04,
    cpc: 0.625,
    cpm: 25,
    cpa: 20.83,
    googleRoas: 3.2,
    realRoas: null,
    attributionState: "unavailable",
    timeline: [],
    breakdown: {
      state: "unavailable",
      reason: "Asset detail is not available for this reporting source.",
      rows: [],
      sources: [],
    },
  };
}

function campaigns(
  overrides: Partial<Extract<AdminStoreAnalytics["campaigns"], { data: unknown }>> = {},
): AdminStoreAnalytics["campaigns"] {
  return {
    state: "ready",
    data: { granularity: "day", rows: [campaign()], storeToday: "2026-08-07" },
    ...overrides,
  } as AdminStoreAnalytics["campaigns"];
}

const KEPT: AdminProviderFreshness = {
  state: "partial",
  refreshedAt: "2026-08-07T09:03:00.000Z",
  lastAttemptAt: "2026-08-07T10:01:00.000Z",
  lastErrorCode: "provider_partial",
  stale: false,
};

const KEPT_MESSAGE =
  "Last failure: Google metrics are ready; Shopify last-non-direct-click UTM attribution matched to Google campaign IDs is unavailable. The last refresh failed (provider_partial); showing the last successful snapshot.";

function render(section: AdminStoreAnalytics["campaigns"], freshness?: AdminProviderFreshness | null) {
  return renderToStaticMarkup(
    <CampaignPerformanceSection
      campaigns={section}
      currency="GBP"
      rangeEnd="2026-08-07"
      freshness={freshness}
    />,
  );
}

describe("snapshotFreshnessLine", () => {
  it("says when the kept snapshot was taken and what the failed refresh said", () => {
    expect(snapshotFreshnessLine(KEPT_MESSAGE, KEPT)).toBe(
      "Snapshot from 7 Aug 2026, 10:03 · last refresh 7 Aug 2026, 11:01 failed: " +
        "Google metrics are ready; Shopify last-non-direct-click UTM attribution matched to Google campaign IDs is unavailable. " +
        "The last refresh failed (provider_partial); showing the last successful snapshot.",
    );
  });

  it("dates a persisted partial without calling it a failure", () => {
    expect(snapshotFreshnessLine(
      "Google metrics are ready; Shopify attribution is unavailable.",
      { ...KEPT, lastAttemptAt: "2026-08-07T09:03:00.000Z", lastErrorCode: null },
    )).toBe(
      "Snapshot from 7 Aug 2026, 10:03 · Google metrics are ready; Shopify attribution is unavailable.",
    );
  });

  it("falls back to the error code when the row kept no message", () => {
    expect(snapshotFreshnessLine(null, KEPT)).toBe(
      "Snapshot from 7 Aug 2026, 10:03 · last refresh 7 Aug 2026, 11:01 failed (provider_partial); showing the last good data.",
    );
  });

  it("renders a live family's message alone and nothing for a clean ready family", () => {
    expect(snapshotFreshnessLine("Shopify attribution was withheld.", null)).toBe(
      "Shopify attribution was withheld.",
    );
    expect(snapshotFreshnessLine(null, { ...KEPT, lastErrorCode: null })).toBeNull();
    expect(snapshotFreshnessLine("  ", null)).toBeNull();
  });
});

describe("CampaignPerformanceSection", () => {
  it("heads a populated table with the snapshot notice when the last refresh failed", () => {
    const html = render(campaigns({ message: KEPT_MESSAGE }), KEPT);

    expect(html).toContain('role="status"');
    expect(html).toContain("Snapshot from 7 Aug 2026, 10:03 · last refresh 7 Aug 2026, 11:01 failed: Google metrics are ready");
    expect(html).toContain("warning-orange");
    // The rows themselves are still the kept sheet.
    expect(html).toContain("PMax · Best sellers");
    expect(html.indexOf("Snapshot from")).toBeLessThan(html.indexOf("PMax · Best sellers"));
    expect(html).not.toContain('role="alert"');
  });

  it("shows a ready family's caption above the rows in the muted style", () => {
    const html = render(
      campaigns({ message: "Shopify attribution was withheld for campaign IDs repeated across Google accounts." }),
      { ...KEPT, lastErrorCode: null, state: "ready" },
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Snapshot from 7 Aug 2026, 10:03 · Shopify attribution was withheld");
    expect(html).not.toContain("warning-orange");
    expect(html).not.toContain("failed");
  });

  it("renders no notice for a clean ready family with rows", () => {
    const html = render(campaigns(), { ...KEPT, lastErrorCode: null, state: "ready" });

    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("Snapshot from");
    expect(html).toContain("PMax · Best sellers");
  });

  it("keeps the family notice when there are no rows", () => {
    const html = render(
      campaigns({
        state: "partial",
        message: KEPT_MESSAGE,
        data: { granularity: "day", rows: [] },
      }),
      KEPT,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("last refresh failed (provider_partial)");
    expect(html).not.toContain("Snapshot from");
    expect(html).not.toContain("<table");
  });

  it("keeps the failed family notice when the family has no data", () => {
    const html = render(
      { state: "failed", message: "Campaign performance could not be loaded for this store." },
      KEPT,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Campaign performance could not be loaded for this store.");
    expect(html).not.toContain("Snapshot from");
  });
});
