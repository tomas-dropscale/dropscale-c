import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fxDailyRates: vi.fn(),
  rateOn: vi.fn(),
}));

vi.mock("@/lib/shopify/fx", () => ({
  fxDailyRates: mocks.fxDailyRates,
  rateOn: mocks.rateOn,
}));

import { addHstTariffs, applyHstOrderCosts, type CostByDay } from "./hst-tariff";

const ACCOUNT = "cc000000-0000-4000-8000-000000000001";

type Charge = { order_day: string; tariff: number; currency: string };

/** A Supabase double narrowed to the one query this module makes. */
function service(rows: Charge[] | { error: string }) {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.gte = () => query;
  query.lte = () =>
    Array.isArray(rows)
      ? Promise.resolve({ data: rows, error: null })
      : Promise.resolve({ data: null, error: { message: rows.error } });
  const from = vi.fn(() => query);
  return { client: { from } as never, from };
}

function days(entries: Record<string, number>): CostByDay {
  return new Map(
    Object.entries(entries).map(([day, product]) => [day, { product, fees: 0, shipping: 0 }]),
  );
}

describe("HST import tariffs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateOn.mockReturnValue(1);
  });

  it("adds the order's duty to that day's product cost", async () => {
    const costByDay = days({ "2026-08-27": 40 });
    const { client } = service([{ order_day: "2026-08-27", tariff: 3, currency: "EUR" }]);

    const applied = await addHstTariffs({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-01",
      to: "2026-08-31",
      reportingCurrency: "EUR",
      costByDay,
    });

    expect(applied).toBe(1);
    expect(costByDay.get("2026-08-27")?.product).toBe(43);
  });

  it("sums every order's duty onto the same day", async () => {
    const costByDay = days({ "2026-08-27": 0 });
    const { client } = service([
      { order_day: "2026-08-27", tariff: 3, currency: "EUR" },
      { order_day: "2026-08-27", tariff: 3, currency: "EUR" },
      { order_day: "2026-08-27", tariff: 4.3, currency: "EUR" },
    ]);

    await addHstTariffs({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-01",
      to: "2026-08-31",
      reportingCurrency: "EUR",
      costByDay,
    });

    expect(costByDay.get("2026-08-27")?.product).toBeCloseTo(10.3, 4);
  });

  it("never invents a day the report says nothing about", async () => {
    // A charge whose order never reached the Shopify rollup has no revenue to
    // sit beside. Adding the day would put a cost on a date with no sales.
    const costByDay = days({ "2026-08-27": 40 });
    const { client } = service([{ order_day: "2026-08-20", tariff: 3, currency: "EUR" }]);

    const applied = await addHstTariffs({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-01",
      to: "2026-08-31",
      reportingCurrency: "EUR",
      costByDay,
    });

    expect(applied).toBe(0);
    expect([...costByDay.keys()]).toEqual(["2026-08-27"]);
  });

  it("converts the supplier's euros into the store's own currency", async () => {
    mocks.fxDailyRates.mockResolvedValue([{ day: "2026-08-27", rate: 390 }]);
    mocks.rateOn.mockReturnValue(390);
    const costByDay = days({ "2026-08-27": 0 });
    const { client } = service([{ order_day: "2026-08-27", tariff: 3, currency: "EUR" }]);

    await addHstTariffs({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-01",
      to: "2026-08-31",
      reportingCurrency: "HUF",
      costByDay,
    });

    expect(mocks.fxDailyRates).toHaveBeenCalledWith("EUR", "HUF", "2026-08-01", "2026-08-31");
    expect(costByDay.get("2026-08-27")?.product).toBe(1170);
  });

  it("drops a charge it could not convert rather than booking it at face value", async () => {
    // Three euros added to a forint-reporting store as "3" understates the cost
    // by two orders of magnitude, and the difference reads as margin.
    mocks.fxDailyRates.mockRejectedValue(new Error("ECB unavailable"));
    const costByDay = days({ "2026-08-27": 40 });
    const { client } = service([{ order_day: "2026-08-27", tariff: 3, currency: "EUR" }]);

    const applied = await addHstTariffs({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-01",
      to: "2026-08-31",
      reportingCurrency: "HUF",
      costByDay,
    });

    expect(applied).toBe(0);
    expect(costByDay.get("2026-08-27")?.product).toBe(40);
  });

  it("asks nothing at all when there are no days to charge", async () => {
    const { client, from } = service([]);

    const applied = await addHstTariffs({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-01",
      to: "2026-08-31",
      reportingCurrency: "EUR",
      costByDay: new Map(),
    });

    expect(applied).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("lets the rest of the sync stand when the charges cannot be read", async () => {
    // 0087 may not be applied yet. A few euros of duty must not cost a store
    // its whole daily rollup.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const costByDay = days({ "2026-08-27": 40 });
    const { client } = service({ error: 'relation "hst_order_charges" does not exist' });

    const applied = await addHstTariffs({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-01",
      to: "2026-08-31",
      reportingCurrency: "EUR",
      costByDay,
    });

    expect(applied).toBe(0);
    expect(costByDay.get("2026-08-27")?.product).toBe(40);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

type OrderCharge = {
  order_day: string;
  paid_at: string | null;
  our_cost: number | null;
  currency: string;
};

/** A Supabase double for applyHstOrderCosts, whose query ends in `.not(...)`. */
function orderCostService(rows: OrderCharge[] | { error: string }) {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.gte = () => query;
  query.lte = () => query;
  query.not = () =>
    Array.isArray(rows)
      ? Promise.resolve({ data: rows, error: null })
      : Promise.resolve({ data: null, error: { message: rows.error } });
  const from = vi.fn(() => query);
  return { client: { from } as never, from };
}

describe("HST per-order actual costs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateOn.mockReturnValue(1);
  });

  it("overwrites the per-product estimate with the supplier's actual per-order cost", async () => {
    // The estimate over-counted the day; the actuals sum to what HST billed.
    const costByDay = days({ "2026-08-26": 1113.11 });
    const { client } = orderCostService([
      { order_day: "2026-08-26", paid_at: "2026-08-26T10:00:00.000Z", our_cost: 500, currency: "EUR" },
      { order_day: "2026-08-26", paid_at: "2026-08-26T12:00:00.000Z", our_cost: 330.86, currency: "EUR" },
    ]);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-20",
      to: "2026-08-29",
      reportingCurrency: "EUR",
      timeZone: "UTC",
      costByDay,
    });

    expect(applied).toBe(1);
    expect(costByDay.get("2026-08-26")?.product).toBeCloseTo(830.86, 2);
  });

  it("buckets by the store zone from paid_at, not the stored UTC order_day", async () => {
    // Paid 23:00 UTC on the 26th is the 27th in Europe/Stockholm (UTC+2).
    const costByDay = days({ "2026-08-26": 100, "2026-08-27": 100 });
    const { client } = orderCostService([
      { order_day: "2026-08-26", paid_at: "2026-08-26T23:00:00.000Z", our_cost: 50, currency: "EUR" },
    ]);

    await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-20",
      to: "2026-08-29",
      reportingCurrency: "EUR",
      timeZone: "Europe/Stockholm",
      costByDay,
    });

    expect(costByDay.get("2026-08-27")?.product).toBe(50);
    expect(costByDay.get("2026-08-26")?.product).toBe(100);
  });

  it("leaves a day the supplier has not priced on its per-product estimate", async () => {
    const costByDay = days({ "2026-08-28": 44 });
    const { client } = orderCostService([]);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-20",
      to: "2026-08-29",
      reportingCurrency: "EUR",
      timeZone: "UTC",
      costByDay,
    });

    expect(applied).toBe(0);
    expect(costByDay.get("2026-08-28")?.product).toBe(44);
  });
});
