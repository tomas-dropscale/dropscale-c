import { describe, expect, it } from "vitest";

import {
  analyticsBaseHref,
  analyticsClientHref,
  analyticsStoreHref,
  projectAnalyticsScope,
  sortAnalyticsActivity,
} from "./analytics-view";
import type { AdminClientOverview } from "./client-overview";
import type { CampaignActionHistory } from "./campaigns-view";

function overview(): AdminClientOverview {
  return {
    clientId: "client-1",
    clientName: "Northwind Commerce",
    clientEmail: "team@northwind.example",
    activityAccountIds: ["account-1"],
    currency: "EUR",
    mixedCurrency: false,
    currencies: ["EUR"],
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
        accountId: "store-eur",
        activityAccountIds: ["store-eur", "google-child"],
        updatedAt: "2026-08-07T18:00:00Z",
        storeName: "Northwind Home",
        storeDomain: "northwind-home.example",
        colorDot: "#d4a86a",
        currency: "EUR",
        connected: true,
        adSpend: 4_000,
        impressions: 50_000,
        clicks: 1_200,
        ctr: 0.024,
        cpc: 3.33,
        googleRevenue: 10_000,
        googleOrders: 80,
        costPerGoogleOrder: 50,
        roas: 2.5,
        estimatedCog: 500,
        profit: 1_500,
        trackedRoas: 2.1,
        conversions: 78,
        conversionValue: 8_400,
        costPerConversion: 51.28,
        commissionRate: 15,
        commission: 600,
        revShareEnabled: true,
        revShare: 200,
        days: [{ day: "2026-08-07", adSpend: 500, revenue: 1_200 }],
      },
      {
        accountId: "store-gbp",
        activityAccountIds: ["store-gbp"],
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
        days: [{ day: "2026-08-07", adSpend: 250, revenue: 625 }],
      },
    ],
    days: [{ day: "2026-08-07", revenue: 1_825, adSpend: 750, profit: 400 }],
    updatedAt: "2026-08-07T18:00:00Z",
  };
}

function history(
  id: string,
  occurredAt: string,
  adAccountId: string,
): CampaignActionHistory {
  return {
    id,
    adAccountId,
    providerCampaignId: `campaign-${id}`,
    campaignName: `Campaign ${id}`,
    action: "campaign_enabled",
    outcome: "succeeded",
    previousDailyBudget: null,
    nextDailyBudget: null,
    currency: "EUR",
    occurredAt,
    actorName: "Admin",
  };
}

describe("projectAnalyticsScope", () => {
  it("projects the real client totals and overview currency for all stores", () => {
    const scope = projectAnalyticsScope(overview(), null);

    expect(scope.selectedStore).toBeNull();
    expect(scope.currency).toBe("EUR");
    expect(scope.metrics.map(({ key, value }) => [key, value])).toEqual([
      ["revenue", 15_000],
      ["spend", 6_000],
      ["cog", 1_500],
      ["roas", 2.5],
      ["profit", 4_500],
    ]);
  });

  it("uses only the selected store's values and currency", () => {
    const scope = projectAnalyticsScope(overview(), "store-gbp");

    expect(scope.selectedStore?.storeName).toBe("Northwind UK");
    expect(scope.currency).toBe("GBP");
    expect(scope.metrics.map(({ key, value }) => [key, value])).toEqual([
      ["revenue", 5_000],
      ["spend", 2_000],
      ["cog", 1_000],
      ["roas", 2.5],
      ["profit", 1_400],
    ]);
  });

  it("fails visibly back to all stores for an unknown store", () => {
    const scope = projectAnalyticsScope(overview(), "not-this-client");

    expect(scope.selectedStore).toBeNull();
    expect(scope.invalidStoreSelection).toBe(true);
    expect(scope.label).toBe("All stores");
  });

  it("never presents empty rollup state as verified zero metrics", () => {
    const empty = overview();
    empty.updatedAt = null;
    empty.stores[0].updatedAt = null;

    expect(projectAnalyticsScope(empty, null).metrics.every((metric) => metric.value === null))
      .toBe(true);
    expect(
      projectAnalyticsScope(empty, "store-eur").metrics.every(
        (metric) => metric.value === null,
      ),
    ).toBe(true);
  });

  it("does not present Real ROAS when revenue is unknown or spend is zero", () => {
    const unknownRevenue = overview();
    unknownRevenue.totals.googleRevenue = null;
    unknownRevenue.stores[0].googleRevenue = null;

    expect(
      projectAnalyticsScope(unknownRevenue, null).metrics.find(
        (metric) => metric.key === "roas",
      )?.value,
    ).toBeNull();
    expect(
      projectAnalyticsScope(unknownRevenue, "store-eur").metrics.find(
        (metric) => metric.key === "roas",
      )?.value,
    ).toBeNull();

    const noSpend = overview();
    noSpend.totals.adSpend = 0;
    noSpend.stores[0].adSpend = 0;
    expect(
      projectAnalyticsScope(noSpend, null).metrics.find(
        (metric) => metric.key === "roas",
      )?.value,
    ).toBeNull();
    expect(
      projectAnalyticsScope(noSpend, "store-eur").metrics.find(
        (metric) => metric.key === "roas",
      )?.value,
    ).toBeNull();
  });

  it("withholds every aggregate KPI when store currencies are mixed", () => {
    const mixed = overview();
    mixed.mixedCurrency = true;
    mixed.currencies = ["EUR", "GBP"];
    const scope = projectAnalyticsScope(mixed, null);

    expect(scope.metrics).toHaveLength(5);
    expect(scope.metrics.every((metric) => metric.value === null)).toBe(true);
    expect(
      scope.metrics.every((metric) => metric.hint.includes("mixed currencies")),
    ).toBe(true);
  });
});

describe("sortAnalyticsActivity", () => {
  it("sorts newest first without filtering account IDs or mutating the input", () => {
    const entries = [
      history("old", "2026-08-01T10:00:00Z", "store-eur"),
      history("new", "2026-08-07T10:00:00Z", "another-store"),
      history("invalid", "not-a-date", "unmapped-account"),
    ];

    expect(sortAnalyticsActivity(entries).map((entry) => entry.id)).toEqual([
      "new",
      "old",
      "invalid",
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["old", "new", "invalid"]);
  });
});

it("builds the base analytics URL with the complete reporting window", () => {
  const range = { key: "custom", from: "2026-08-01", to: "2026-08-07" } as const;
  expect(analyticsBaseHref(range)).toBe(
    "/admin/analytics?range=custom&from=2026-08-01&to=2026-08-07",
  );
  expect(analyticsClientHref("client-1", range)).toBe(
    "/admin/analytics?client=client-1&range=custom&from=2026-08-01&to=2026-08-07",
  );
  expect(analyticsStoreHref("client-1", "store-1", range)).toBe(
    "/admin/analytics?client=client-1&store=store-1&range=custom&from=2026-08-01&to=2026-08-07",
  );
});
