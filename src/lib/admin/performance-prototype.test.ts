import { describe, expect, it } from "vitest";

import {
  PERFORMANCE_PROTOTYPE_CLIENTS,
  campaignScaleHistory,
  clientRollup,
  estimatedProfit,
  filterPrototypeClients,
  googleMetrics,
  performancePointsForPeriod,
  periodScale,
  pmaxProductsWithSpend,
  portfolioRollup,
  prototypePeriodForDays,
  realRoas,
  storeRollup,
} from "./performance-prototype";

describe("performance prototype model", () => {
  it("filters clients by client and store identity", () => {
    const matches = (query: string) =>
      filterPrototypeClients(PERFORMANCE_PROTOTYPE_CLIENTS, query).map((client) => client.id);

    expect(matches("NORTHWIND COMMERCE")).toEqual(["northwind"]);
    expect(matches("performance@northwind.example")).toEqual(["northwind"]);
    expect(matches("Northwind Outdoor")).toEqual(["northwind"]);
    expect(matches("northwind-home.com")).toEqual(["northwind"]);
    expect(matches("no-such-client-or-store")).toEqual([]);
  });

  it("derives campaign scale history from stable campaign IDs, newest first", () => {
    const store = PERFORMANCE_PROTOTYPE_CLIENTS[0].stores[0];
    const history = campaignScaleHistory(store, "nw-pmax-bestsellers");

    expect(history.map((entry) => entry.action)).toEqual(["budget_changed"]);
    expect(history[0]).toMatchObject({ previousBudget: 250, nextBudget: 310 });
    expect(campaignScaleHistory(store, "nw-dg-summer")).toEqual([]);
  });

  it("recalculates portfolio ROAS from absolute totals", () => {
    const totals = portfolioRollup(PERFORMANCE_PROTOTYPE_CLIENTS);
    expect(totals.realRoas).toBeCloseTo(totals.revenue / totals.adSpend);
    expect(totals.realRoas).not.toBe(
      PERFORMANCE_PROTOTYPE_CLIENTS.map(clientRollup).reduce(
        (sum, client) => sum + client.realRoas,
        0,
      ) / PERFORMANCE_PROTOTYPE_CLIENTS.length,
    );
  });

  it("derives operational Google metrics safely", () => {
    expect(
      googleMetrics({
        spend: 100,
        impressions: 10_000,
        clicks: 200,
        conversions: 10,
        googleRevenue: 300,
        realRevenue: 250,
      }),
    ).toEqual({ cpc: 0.5, ctr: 0.02, cpm: 10, cpa: 10, googleRoas: 3, realRoas: 2.5 });
    expect(realRoas(500, 0)).toBe(0);
  });

  it("uses average COG per unit for the mock profit", () => {
    expect(estimatedProfit(1_000, 200, 20, 15)).toBe(500);
  });

  it("keeps Demand Gen creatives separate from PMax products", () => {
    const campaigns = PERFORMANCE_PROTOTYPE_CLIENTS.flatMap((client) =>
      client.stores.flatMap((store) => store.campaigns),
    );
    const demandGen = campaigns.find((campaign) => campaign.kind === "demand_gen");
    const pmax = campaigns.find((campaign) => campaign.kind === "performance_max");
    expect(demandGen?.kind === "demand_gen" && demandGen.creatives.length).toBeGreaterThan(0);
    expect(pmax?.kind === "performance_max" && pmaxProductsWithSpend(pmax).length).toBeGreaterThan(0);
    expect(
      pmax?.kind === "performance_max" &&
        pmaxProductsWithSpend(pmax).every((product) => product.metrics.spend > 0),
    ).toBe(true);
  });

  it("uses the requested chart density for short periods", () => {
    const store = PERFORMANCE_PROTOTYPE_CLIENTS[0].stores[0];
    expect(performancePointsForPeriod(store, "today")).toHaveLength(24);
    expect(performancePointsForPeriod(store, "d3")).toHaveLength(24);
    expect(performancePointsForPeriod(store, "d7")).toHaveLength(14);
    expect(performancePointsForPeriod(store, "d14")).toHaveLength(14);
    expect(performancePointsForPeriod(store, "d30")).toHaveLength(30);
  });

  it("maps arbitrary date ranges to the nearest prototype density", () => {
    expect([1, 2, 3, 4, 7, 8, 14, 15, 45].map(prototypePeriodForDays)).toEqual([
      "today",
      "d3",
      "d3",
      "d7",
      "d7",
      "d14",
      "d14",
      "d30",
      "d30",
    ]);
  });

  it("keeps chart totals aligned with the selected-period cards", () => {
    const store = PERFORMANCE_PROTOTYPE_CLIENTS[0].stores[0];
    const scale = periodScale("d7");
    const averageCog = 15;
    const points = performancePointsForPeriod(store, "d7", averageCog);
    const totals = points.reduce(
      (sum, point) => ({
        revenue: sum.revenue + point.revenue,
        spend: sum.spend + point.googleSpend,
        profit: sum.profit + point.estimatedProfit,
        sessions: sum.sessions + point.sessions,
        addToCarts: sum.addToCarts + point.addToCarts,
        checkouts: sum.checkouts + point.checkouts,
        conversions: sum.conversions + point.conversions,
      }),
      {
        revenue: 0,
        spend: 0,
        profit: 0,
        sessions: 0,
        addToCarts: 0,
        checkouts: 0,
        conversions: 0,
      },
    );
    const adSpend = storeRollup(store).adSpend * scale;

    expect(totals.revenue).toBeCloseTo(store.revenue * scale, 8);
    expect(totals.spend).toBeCloseTo(adSpend, 8);
    expect(totals.profit).toBeCloseTo(
      estimatedProfit(store.revenue * scale, adSpend, Math.round(store.units * scale), averageCog),
      8,
    );
    expect(totals.sessions).toBe(Math.round(store.funnel.sessions * scale));
    expect(totals.addToCarts).toBe(Math.round(store.funnel.addToCarts * scale));
    expect(totals.checkouts).toBe(Math.round(store.funnel.checkouts * scale));
    expect(totals.conversions).toBe(Math.round(store.funnel.purchases * scale));
    expect(
      points.every((point) =>
        [point.sessions, point.addToCarts, point.checkouts, point.conversions].every(
          (value) => Number.isInteger(value) && value >= 0,
        ),
      ),
    ).toBe(true);
  });
});
