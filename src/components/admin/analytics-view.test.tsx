import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdminAnalyticsClient } from "@/lib/admin/analytics";
import type { AdminClientOverview } from "@/lib/admin/client-overview";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";
import type { AdminStoreAnalytics } from "@/lib/admin/store-analytics";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/portal/range-picker", () => ({
  RangePicker: () => <span>Range picker</span>,
}));

vi.mock("./reporting-sync-button", () => ({
  ReportingSyncButton: () => <span>Sync reporting</span>,
}));

vi.mock("@/components/admin/performance-charts", () => ({
  SpendDevelopmentChart: () => <div>Store spend development chart</div>,
  FunnelDevelopmentChart: () => <div>Funnel Development chart</div>,
}));

vi.mock("@/components/admin/store-analytics-sections", async () =>
  import("./store-analytics-sections"),
);

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <span {...props}>{children}</span>
  ),
}));

vi.mock("@/components/ui/page-container", () => ({
  PageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/lib/admin/analytics-view", async () =>
  import("../../lib/admin/analytics-view"),
);

vi.mock("@/lib/format", () => ({
  integer: (value: number) => String(value),
  money: (value: number, currency: string) => `${currency} ${value.toFixed(2)}`,
  multiplier: (value: number) => `${value.toFixed(2)}x`,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

import { AnalyticsView } from "./analytics-view";

const clients: AdminAnalyticsClient[] = [
  {
    id: "client-1",
    name: "Northwind Commerce",
    email: "team@northwind.example",
    storeCount: 1,
    stores: [
      {
        id: "store-gbp",
        name: "Northwind UK",
        domain: "northwind-uk.example",
      },
    ],
  },
];

function overview(): AdminClientOverview {
  return {
    clientId: "client-1",
    clientName: "Northwind Commerce",
    clientEmail: "team@northwind.example",
    activityAccountIds: ["account-1"],
    currency: "EUR",
    mixedCurrency: true,
    currencies: ["EUR", "GBP"],
    range: { from: "2026-08-01", to: "2026-08-07" },
    totals: {
      googleRevenue: 15_000,
      googleOrders: 120,
      aov: 125,
      adSpend: 6_000,
      impressions: 80_000,
      clicks: 2_000,
      ctr: 0.025,
      cpc: 3,
      conversions: 115,
      roas: 2.5,
      estimatedCog: 1_500,
      trackedRoas: 2.2,
      commission: 900,
      revShare: 300,
      agencyRevenue: 1_200,
      profit: 4_500,
      margin: 0.3,
    },
    stores: [
      {
        accountId: "store-gbp",
        activityAccountIds: ["store-gbp", "google-child"],
        updatedAt: "2026-08-07T18:00:00Z",
        storeName: "Northwind UK",
        storeDomain: "northwind-uk.example",
        colorDot: "#6fae7a",
        currency: "GBP",
        connected: true,
        adSpend: 2_000,
        impressions: 30_000,
        clicks: 800,
        ctr: 0.0267,
        cpc: 2.5,
        googleRevenue: 5_000,
        googleOrders: 40,
        costPerGoogleOrder: 50,
        roas: 2.5,
        estimatedCog: 1_000,
        profit: 1_400,
        trackedRoas: 2.4,
        conversions: 37,
        conversionValue: 4_800,
        costPerConversion: 54.05,
        commissionRate: 15,
        commission: 300,
        revShareEnabled: true,
        revShare: 100,
        days: [
          { day: "2026-08-06", adSpend: 220, revenue: 540 },
          { day: "2026-08-07", adSpend: 250, revenue: 625 },
        ],
      },
    ],
    days: [{ day: "2026-08-07", revenue: 625, adSpend: 250, profit: 180 }],
    updatedAt: "2026-08-07T18:00:00Z",
  };
}

function activity(
  id: string,
  occurredAt: string,
  action: CampaignActionHistory["action"],
): CampaignActionHistory {
  return {
    id,
    adAccountId: "store-gbp",
    providerCampaignId: `campaign-${id}`,
    campaignName: `Campaign ${id}`,
    action,
    outcome: "succeeded",
    previousDailyBudget: action === "budget_changed" ? 90 : null,
    nextDailyBudget: action === "budget_changed" ? 110 : null,
    currency: "GBP",
    occurredAt,
    actorName: `Actor ${id}`,
  };
}

function storeAnalytics(rows: CampaignActionHistory[] = []): AdminStoreAnalytics {
  return {
    clientId: "client-1",
    storeAccountId: "store-gbp",
    currency: "GBP",
    range: { from: "2026-08-01", to: "2026-08-07" },
    funnel: {
      state: "ready",
      data: {
        daily: [
          {
            day: "2026-08-07",
            sessions: 200,
            addedToCart: 44,
            reachedCheckout: 19,
            completedCheckout: 8,
          },
        ],
        totals: {
          sessions: 200,
          addedToCart: 44,
          reachedCheckout: 19,
          completedCheckout: 8,
        },
      },
    },
    campaigns: {
      state: "ready",
      data: {
        rows: [
          {
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
            shopifySessions: 190,
            shopifyOrders: 8,
            shopifyRevenue: 625,
            ctr: 0.04,
            cpc: 0.625,
            cpm: 25,
            cpa: 20.83,
            googleRoas: 3.2,
            realRoas: 2.5,
            attributionState: "matched",
            breakdown: {
              state: "unavailable",
              reason: "Asset detail is not available for this reporting source.",
              rows: [],
              sources: [
                {
                  provider: "google_ads",
                  source: "pmax_products",
                  state: "unavailable",
                  reason: "Google asset detail is unavailable.",
                },
                {
                  provider: "shopify",
                  source: "campaign_products",
                  state: "unavailable",
                  reason: "Shopify product attribution is unavailable.",
                },
              ],
            },
          },
        ],
      },
    },
    collections: {
      state: "ready",
      data: {
        rows: [
          {
            collectionId: "collection-1",
            title: "Best sellers",
            products: [
              { productId: "product-1", title: "Lamp", revenue: 300, units: 3 },
            ],
            revenue: 625,
            units: 8,
            spend: null,
            roas: null,
          },
        ],
      },
    },
    spend: {
      state: "ready",
      data: { daily: [{ day: "2026-08-07", spend: 250 }] },
    },
    rollupCoverage: {
      state: "ready",
      data: { dayCount: 7, refreshed: false },
    },
    activity: {
      state: rows.length ? "ready" : "empty",
      data: { rows, truncated: false },
    },
  };
}

describe("AnalyticsView", () => {
  it("renders store-scoped real metrics, daily spend and newest-first activity", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={overview()}
        selectedStoreId="store-gbp"
        range={{ key: "custom", from: "2026-08-01", to: "2026-08-07" }}
        storeAnalytics={storeAnalytics([
          activity("older", "2026-08-02T10:00:00Z", "campaign_paused"),
          activity("newest", "2026-08-07T10:00:00Z", "budget_changed"),
        ])}
      />,
    );

    expect(html).toContain("Northwind UK");
    expect(html).toContain("Store spend development chart");
    expect(html).toContain("1. Client");
    expect(html).toContain("2. Store");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Search clients by name"');
    expect(html).not.toContain(">View</button>");
    expect(html).toContain("Estimated COG");
    expect(html).toContain("Estimated profit");
    expect(html).toContain("grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5");
    expect(html).toContain("Campaign and budget changes for Northwind UK.");
    expect(html).toContain("Budget updated");
    expect(html.indexOf("Campaign newest")).toBeLessThan(html.indexOf("Campaign older"));
    const orderedSections = [
      "Funnel Development",
      "Store behaviour across the selected period.",
      "Store spend development chart",
      "Campaign Performance",
      "Return by Collection",
      "Store Activity Log",
    ].map((label) => html.indexOf(label));
    expect(orderedSections.every((index) => index >= 0)).toBe(true);
    expect(orderedSections).toEqual([...orderedSections].sort((a, b) => a - b));
    expect(html).toContain("PMax · Best sellers");
    expect(html).toContain("PMAX (SF)");
    expect(html).toContain("Best sellers");
    expect(html).toContain("200");
    expect(html).not.toContain("not materialised");
    expect(html).not.toContain("Campaign launched");
  });

  it("keeps materialized KPI values when a live detail family fails", () => {
    const analytics = storeAnalytics();
    analytics.spend = {
      state: "failed",
      message: "Spend could not be loaded for the complete selected period.",
    };
    analytics.rollupCoverage = {
      state: "failed",
      message: "The complete selected-period rollup could not be verified.",
    };
    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={overview()}
        selectedStoreId="store-gbp"
        range={{ key: "custom", from: "2026-08-01", to: "2026-08-07" }}
        storeAnalytics={analytics}
      />,
    );

    expect(html).toContain("Spend could not be loaded for the complete selected period.");
    expect(html).toContain("GBP 2000.00");
    expect(html).not.toContain("Shopify revenue and Google spend coverage could not be proved");
  });

  it("shows stale provider freshness and the last failed attempt without hiding ready payload", () => {
    const analytics = storeAnalytics();
    analytics.providerFreshness = {
      state: "partial",
      refreshedAt: "2026-08-07T08:00:00.000Z",
      lastAttemptAt: "2026-08-07T11:30:00.000Z",
      lastErrorCode: "provider_failed",
      stale: true,
    };
    analytics.funnel = {
      ...analytics.funnel,
      message: "The last refresh failed (provider_failed); showing the last successful snapshot.",
    };
    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={overview()}
        selectedStoreId="store-gbp"
        range={{ key: "custom", from: "2026-08-07", to: "2026-08-07" }}
        storeAnalytics={analytics}
      />,
    );

    expect(html).toContain("Stale");
    expect(html).toContain("Refreshed");
    expect(html).toContain("Last attempt");
    expect(html).toContain("Last refresh error: provider_failed");
    expect(html).toContain("older than 90 minutes");
    expect(html).toContain("last refresh failed (provider_failed)");
    expect(html).toContain("200");
  });

  it("renders immediate scope controls and the approved all-stores table", () => {
    const running = overview();
    running.stores[0].reportingState = "running";
    running.stores[0].reportingCoverage = { rows: 14, expectedRows: 14 };
    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={running}
        selectedStoreId={null}
        range={{ key: "d7", from: "2026-08-01", to: "2026-08-07" }}
        storeAnalytics={null}
      />,
    );

    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Search clients by name"');
    expect(html).toContain('aria-label="Select store"');
    expect(html).not.toContain(">View</button>");
    expect(html).toContain("All Stores");
    expect(html).toContain("Store URL");
    expect(html).toContain("northwind-uk.example");
    expect(html).toContain("Synced");
    expect(html).toContain("Running");
    expect(html).toContain("complete selected-period grid");
    expect(html).toContain("Mixed currencies (EUR, GBP)");
    expect(html.match(/title="Unavailable across mixed currencies/g)).toHaveLength(5);
    expect(html).toContain("GBP 5000.00");
    expect(html).toContain("GBP 2000.00");
    expect(html).not.toContain("Store Activity Log");
    expect(html).not.toContain("Campaign Performance");
  });

  it("labels a partial account-day grid without calling it Running", () => {
    const partial = overview();
    partial.stores[0].reportingState = "partial";
    partial.stores[0].reportingCoverage = { rows: 10, expectedRows: 14 };

    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={partial}
        selectedStoreId="store-gbp"
        range={{ key: "d7", from: "2026-08-01", to: "2026-08-07" }}
        storeAnalytics={storeAnalytics()}
      />,
    );

    expect(html).toContain("Partial");
    expect(html).toContain("10 of 14 account-days");
    expect(html).not.toContain("Running");
  });

  it("shows a dash instead of 0.00x for a fresh spend-only scope", () => {
    const spendOnly = overview();
    spendOnly.mixedCurrency = false;
    spendOnly.currencies = ["GBP"];
    spendOnly.currency = "GBP";
    spendOnly.totals.googleRevenue = null;
    spendOnly.stores[0].googleRevenue = null;
    spendOnly.stores[0].estimatedCog = null;
    spendOnly.stores[0].profit = null;

    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={spendOnly}
        selectedStoreId="store-gbp"
        range={{ key: "d7", from: "2026-08-01", to: "2026-08-07" }}
        storeAnalytics={storeAnalytics()}
      />,
    );

    expect(html).toContain("Real ROAS");
    expect(html).toContain("—");
    expect(html).not.toContain("0.00x");
  });

  it("labels unavailable rollup data instead of presenting zero as verified", () => {
    const empty = overview();
    empty.updatedAt = null;
    empty.stores[0].updatedAt = null;
    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={empty}
        selectedStoreId="store-gbp"
        range={{ key: "d7", from: "2026-08-01", to: "2026-08-07" }}
        storeAnalytics={storeAnalytics()}
      />,
    );

    expect(html).not.toContain("Reporting data is unavailable for this scope");
    expect(html).toContain("No verified rollup rows are available for this scope");
  });
});
