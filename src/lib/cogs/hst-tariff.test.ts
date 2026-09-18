import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fxDailyRates: vi.fn(),
  rateOn: vi.fn(),
}));

vi.mock("@/lib/shopify/fx", () => ({
  fxDailyRates: mocks.fxDailyRates,
  rateOn: mocks.rateOn,
}));

import {
  addHstTariffs,
  applyHstOrderCosts,
  type CostByDay,
  type HstOrderEstimates,
} from "./hst-tariff";

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
  platform_order_id: string;
  tariff: number;
  our_cost: number | null;
  currency: string;
};

/**
 * A Supabase double for applyHstOrderCosts. Its query reads every charge in
 * the window, priced or not, split packages included — what the composition
 * does with each is the thing under test.
 */
function orderCostService(rows: OrderCharge[] | { error: string }) {
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

/** The store's own orders: id → the day its revenue sits on and its estimate. */
function estimates(entries: Record<string, [day: string, product: number]>): HstOrderEstimates {
  return new Map(Object.entries(entries).map(([id, [day, product]]) => [id, { day, product }]));
}

const WINDOW = { from: "2026-09-01", to: "2026-09-18", reportingCurrency: "EUR" };

describe("HST per-order actual costs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateOn.mockReturnValue(1);
  });

  it("replaces each priced order's estimate with what the supplier billed for it", async () => {
    // Two orders on the day, both quoted: the day is the supplier's figures,
    // not the estimate's 1113.11.
    const costByDay = days({ "2026-09-06": 1113.11 });
    const { client } = orderCostService([
      { platform_order_id: "A", tariff: 3.44, our_cost: 500, currency: "EUR" },
      { platform_order_id: "B", tariff: 3.44, our_cost: 330.86, currency: "EUR" },
    ]);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({ A: ["2026-09-06", 600], B: ["2026-09-06", 513.11] }),
    });

    expect(applied).toBe(1);
    expect(costByDay.get("2026-09-06")?.product).toBeCloseTo(830.86, 2);
  });

  it("lands each charge on the day its own order's revenue sits on, whatever day the ERP filed it", async () => {
    // The charge is matched by order id; the day comes from the order, so an
    // ERP row filed under another day cannot move the cost away from the
    // revenue it belongs beside.
    const costByDay = days({ "2026-09-04": 100, "2026-09-05": 100 });
    const { client } = orderCostService([
      { platform_order_id: "A", tariff: 3.44, our_cost: 19.62, currency: "EUR" },
    ]);

    await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({ A: ["2026-09-05", 25] }),
    });

    expect(costByDay.get("2026-09-05")?.product).toBe(19.62);
    expect(costByDay.get("2026-09-04")?.product).toBe(100);
  });

  it("leaves a day with no priced order on its per-product estimate", async () => {
    const costByDay = days({ "2026-09-08": 44 });
    const { client } = orderCostService([
      { platform_order_id: "A", tariff: 0, our_cost: null, currency: "EUR" },
    ]);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({ A: ["2026-09-08", 44] }),
    });

    expect(applied).toBe(0);
    expect(costByDay.get("2026-09-08")?.product).toBe(44);
  });

  it("composes a half-priced day from the priced orders' bills and the unpriced orders' estimates", async () => {
    // Elena Granada, 2026-09-11: four orders, two quoted (34.34 + 18.67 USD)
    // and two the supplier had not priced. Booking the quoted ones alone put
    // €53.01 against four orders; parking the day on the estimate priced the
    // quoted ones at a guess. Each order keeps its own truth.
    const costByDay = days({ "2026-09-11": 118.4 });
    const { client } = orderCostService([
      { platform_order_id: "A", tariff: 3.44, our_cost: 34.34, currency: "USD" },
      { platform_order_id: "B", tariff: 3.44, our_cost: 18.67, currency: "USD" },
      { platform_order_id: "C", tariff: 0, our_cost: null, currency: "USD" },
      { platform_order_id: "D", tariff: 0, our_cost: null, currency: "USD" },
    ]);
    mocks.fxDailyRates.mockResolvedValue([{ day: "2026-09-11", rate: 0.86 }]);
    mocks.rateOn.mockReturnValue(0.86);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({
        A: ["2026-09-11", 30],
        B: ["2026-09-11", 28.4],
        C: ["2026-09-11", 31],
        D: ["2026-09-11", 29],
      }),
    });

    expect(applied).toBe(1);
    expect(costByDay.get("2026-09-11")?.product).toBeCloseTo((34.34 + 18.67) * 0.86 + 31 + 29, 2);
  });

  it("adds the tariff the ERP already knows to an order still waiting for its quote", async () => {
    const costByDay = days({ "2026-09-12": 60 });
    const { client } = orderCostService([
      { platform_order_id: "A", tariff: 0, our_cost: 20, currency: "EUR" },
      { platform_order_id: "B", tariff: 3.44, our_cost: null, currency: "EUR" },
    ]);

    await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({ A: ["2026-09-12", 25], B: ["2026-09-12", 35] }),
    });

    expect(costByDay.get("2026-09-12")?.product).toBeCloseTo(20 + 35 + 3.44, 2);
  });

  it("bills an order as the sum of its family: the parent, and each package at what it was written", async () => {
    // 8110621458771 bills 112.80 for every package's lines plus one tariff;
    // the sync wrote its packages "_1" and "_2" as known zeros. Summing the
    // ERP's own figures for the three rows charged the day 131.82. A family
    // whose package the parent does NOT cover was written at its own figure,
    // and that one counts.
    const costByDay = days({ "2026-09-08": 90 });
    const { client } = orderCostService([
      { platform_order_id: "8110621458771", tariff: 3.44, our_cost: 112.8, currency: "USD" },
      { platform_order_id: "8110621458771_1", tariff: 0, our_cost: 0, currency: "USD" },
      { platform_order_id: "8110621458771_2", tariff: 0, our_cost: 0, currency: "USD" },
      { platform_order_id: "7987533316435", tariff: 3, our_cost: 32.65, currency: "USD" },
      { platform_order_id: "7987533316435_1", tariff: 3, our_cost: 55.09, currency: "USD" },
    ]);
    mocks.fxDailyRates.mockResolvedValue([{ day: "2026-09-08", rate: 0.86 }]);
    mocks.rateOn.mockReturnValue(0.86);

    await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({
        "8110621458771": ["2026-09-08", 95],
        "7987533316435": ["2026-09-08", 70],
      }),
    });

    expect(costByDay.get("2026-09-08")?.product).toBeCloseTo((112.8 + 32.65 + 55.09) * 0.86, 2);
  });

  it("bills a family on what is known while a package still waits for its quote", async () => {
    // 8015506997587: the parent settled at 35.27 for three items; the fourth
    // waits in "_1" with no quote. The day composes on the parent's figure —
    // not on a guess for the whole order — and the waiting package adds
    // nothing until the reach-back finds it priced.
    const costByDay = days({ "2026-08-29": 52.39 });
    const { client } = orderCostService([
      { platform_order_id: "8015506997587", tariff: 3.44, our_cost: 35.27, currency: "USD" },
      { platform_order_id: "8015506997587_1", tariff: 0, our_cost: null, currency: "USD" },
    ]);
    mocks.fxDailyRates.mockResolvedValue([{ day: "2026-08-29", rate: 0.86 }]);
    mocks.rateOn.mockReturnValue(0.86);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      from: "2026-08-20",
      to: "2026-09-18",
      reportingCurrency: "EUR",
      costByDay,
      estimates: estimates({ "8015506997587": ["2026-08-29", 52.39] }),
    });

    expect(applied).toBe(1);
    expect(costByDay.get("2026-08-29")?.product).toBeCloseTo(35.27 * 0.86, 2);
  });

  it("does not take a package's known zero for a bill when the parent itself still waits", async () => {
    // The parent has no figure yet; its package was written as a covered
    // zero. Summing the zero made the family look billed — at nothing — and
    // the order lost its estimate. A zero adds nothing and bills nothing.
    const costByDay = days({ "2026-09-16": 40 });
    const { client } = orderCostService([
      { platform_order_id: "P", tariff: 3.44, our_cost: null, currency: "USD" },
      { platform_order_id: "P_1", tariff: 0, our_cost: 0, currency: "USD" },
      { platform_order_id: "Q", tariff: 3.44, our_cost: 20, currency: "USD" },
    ]);
    mocks.fxDailyRates.mockResolvedValue([{ day: "2026-09-16", rate: 0.86 }]);
    mocks.rateOn.mockReturnValue(0.86);

    await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({ P: ["2026-09-16", 25], Q: ["2026-09-16", 15] }),
    });

    expect(costByDay.get("2026-09-16")?.product).toBeCloseTo(25 + 3.44 * 0.86 + 20 * 0.86, 2);
  });

  it("converts a dollar-billed order into the store's euros at the day's rate", async () => {
    // Order #1031: 21.55 USD as HST bills it, on a day the ECB set at 0.86.
    const costByDay = days({ "2026-09-09": 30 });
    const { client } = orderCostService([
      { platform_order_id: "8120306205011", tariff: 3.44, our_cost: 21.55, currency: "USD" },
      { platform_order_id: "8120284512595", tariff: 3.44, our_cost: 15.65, currency: "USD" },
    ]);
    mocks.fxDailyRates.mockResolvedValue([{ day: "2026-09-09", rate: 0.86 }]);
    mocks.rateOn.mockReturnValue(0.86);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({
        "8120306205011": ["2026-09-09", 18],
        "8120284512595": ["2026-09-09", 12],
      }),
    });

    expect(applied).toBe(1);
    expect(mocks.fxDailyRates).toHaveBeenCalledWith("USD", "EUR", "2026-09-01", "2026-09-18");
    expect(costByDay.get("2026-09-09")?.product).toBeCloseTo((21.55 + 15.65) * 0.86, 2);
  });

  it("falls back to the estimate for a charge it cannot convert, never to face value", async () => {
    const costByDay = days({ "2026-09-10": 40 });
    const { client } = orderCostService([
      { platform_order_id: "A", tariff: 3.44, our_cost: 3000, currency: "HUF" },
      { platform_order_id: "B", tariff: 0, our_cost: 12, currency: "EUR" },
    ]);
    mocks.fxDailyRates.mockRejectedValue(new Error("no HUF series"));
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay,
      estimates: estimates({ A: ["2026-09-10", 25], B: ["2026-09-10", 15] }),
    });

    expect(costByDay.get("2026-09-10")?.product).toBeCloseTo(25 + 12, 2);
    warn.mockRestore();
  });

  it("asks nothing when the window holds none of the store's orders", async () => {
    const { client, from } = orderCostService([]);

    const applied = await applyHstOrderCosts({
      service: client,
      adAccountId: ACCOUNT,
      ...WINDOW,
      costByDay: days({ "2026-09-10": 40 }),
      estimates: new Map(),
    });

    expect(applied).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });
});
