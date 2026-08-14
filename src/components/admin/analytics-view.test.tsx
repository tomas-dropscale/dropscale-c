import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdminClientOverview } from "@/lib/admin/client-overview";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";

vi.mock("@/components/portal/range-picker", () => ({
  RangePicker: () => <span>Range picker</span>,
}));

vi.mock("@/components/portal/daily-performance-chart", () => ({
  DailyPerformanceChart: () => <div>Client daily performance chart</div>,
}));

vi.mock("@/components/admin/performance-charts", () => ({
  SpendDevelopmentChart: () => <div>Store spend development chart</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
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

describe("AnalyticsView", () => {
  it("renders store-scoped real metrics, daily spend and newest-first activity", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        overview={overview()}
        selectedStoreId="store-gbp"
        range={{ key: "custom", from: "2026-08-01", to: "2026-08-07" }}
        activity={[
          activity("older", "2026-08-02T10:00:00Z", "campaign_paused"),
          activity("newest", "2026-08-07T10:00:00Z", "budget_changed"),
        ]}
        activityTruncated
      />,
    );

    expect(html).toContain("Northwind UK");
    expect(html).toContain("Store spend development chart");
    expect(html).toContain("only verified Google spend by day");
    expect(html).toContain("Campaign and budget changes for Northwind UK.");
    expect(html).toContain("Budget updated");
    expect(html).toContain("1,000 most recent verified changes");
    expect(html.indexOf("Campaign newest")).toBeLessThan(html.indexOf("Campaign older"));
    expect(html.indexOf("Return by Collection")).toBeLessThan(
      html.indexOf("Store Activity Log"),
    );
    expect(html).not.toContain("Campaign launched");
  });

  it("preserves client and range query keys and labels the aggregate activity scope", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        overview={overview()}
        selectedStoreId={null}
        range={{ key: "d7", from: "2026-08-01", to: "2026-08-07" }}
        activity={[]}
        activityTruncated={false}
      />,
    );

    expect(html).toContain('name="client" value="client-1"');
    expect(html).toContain('name="store"');
    expect(html).toContain('name="range" value="d7"');
    expect(html).toContain('name="from" value="2026-08-01"');
    expect(html).toContain('name="to" value="2026-08-07"');
    expect(html).toContain("Client daily performance chart");
    expect(html).toContain("across all stores in this client");
    expect(html).toContain("Mixed currencies (EUR, GBP)");
    expect(html).toContain("Collection attribution is not materialised");
  });

  it("labels unavailable rollup data instead of presenting zero as verified", () => {
    const empty = overview();
    empty.updatedAt = null;
    empty.stores[0].updatedAt = null;
    const html = renderToStaticMarkup(
      <AnalyticsView
        overview={empty}
        selectedStoreId="store-gbp"
        range={{ key: "d7", from: "2026-08-01", to: "2026-08-07" }}
        activity={[]}
        activityTruncated={false}
      />,
    );

    expect(html).toContain("Reporting data is unavailable for this scope");
    expect(html).toContain("No verified rollup rows are available for this scope");
  });
});
