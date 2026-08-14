import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdminAnalyticsClient } from "@/lib/admin/analytics";
import type { AdminClientOverview } from "@/lib/admin/client-overview";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/portal/range-picker", () => ({
  RangePicker: () => <span>Range picker</span>,
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

describe("AnalyticsView", () => {
  it("renders store-scoped real metrics, daily spend and newest-first activity", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
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
    expect(html).toContain("1,000 most recent verified changes");
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
    expect(html).toContain("Per-campaign Shopify revenue");
    expect(html).toContain("Collection attribution is not materialised");
    expect(html).not.toContain("Campaign launched");
  });

  it("renders immediate scope controls and the approved all-stores table", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        clients={clients}
        overview={overview()}
        selectedStoreId={null}
        range={{ key: "d7", from: "2026-08-01", to: "2026-08-07" }}
        activity={[]}
        activityTruncated={false}
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
    expect(html).toContain("Mixed currencies (EUR, GBP)");
    expect(html.match(/title="Unavailable across mixed currencies/g)).toHaveLength(5);
    expect(html).toContain("GBP 5000.00");
    expect(html).toContain("GBP 2000.00");
    expect(html).not.toContain("Store Activity Log");
    expect(html).not.toContain("Campaign Performance");
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
        activity={[]}
        activityTruncated={false}
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
        activity={[]}
        activityTruncated={false}
      />,
    );

    expect(html).toContain("Reporting data is unavailable for this scope");
    expect(html).toContain("No verified rollup rows are available for this scope");
  });
});
