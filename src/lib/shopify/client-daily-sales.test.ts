import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shopify/referrer", () => ({ isMetaReferral: () => false }));

import { fetchDailySales, ShopifyError, type ShopifyGraphqlExecutor } from "./client";

/**
 * Daily sales in a store that changed its currency.
 *
 * Shopify keeps every order in the currency it was placed in. After a
 * merchant switches the store from CZK to GBP, one window holds both: the
 * GBP orders are summed as they are, the CZK ones priced into GBP at their
 * own day's rate through the normalizer - or refused, never summed blind.
 */

const SHOP = "northwind-demo.myshopify.com";
const TOKEN = "shpat_test";

type Money = { amount: string; currencyCode?: string };

type Line = { id: string; title: string; sku: string | null; quantity: number; originalUnitPriceSet: { shopMoney: Money } };
type RefundLine = { quantity: number; subtotalSet: { shopMoney: { amount: string } }; totalTaxSet: { shopMoney: { amount: string } }; lineItem: { id: string } | null };
type Refund = { totalRefundedSet: { shopMoney: { amount: string } }; refundLineItems: { pageInfo: { hasNextPage: boolean }; nodes: RefundLine[] } };

/**
 * An order as Shopify lists it: `total` is totalPriceSet, and unless
 * `balance` says otherwise the customer paid all of it (received = total,
 * nothing outstanding).
 */
function order(
  id: number,
  createdAt: string,
  total: Money,
  refund: Money | null,
  line: Money,
  lines?: Line[],
  refunds: Refund[] = [],
  balance?: { received: string; outstanding: string },
  taxesIncluded = true,
) {
  const currencyCode = total.currencyCode;
  return {
    id: `gid://shopify/Order/${id}`,
    createdAt,
    test: false,
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    customerJourneySummary: null,
    taxesIncluded,
    totalPriceSet: { shopMoney: total },
    totalReceivedSet: { shopMoney: { amount: balance?.received ?? total.amount, currencyCode } },
    totalOutstandingSet: { shopMoney: { amount: balance?.outstanding ?? "0.00", currencyCode } },
    totalRefundedSet: refund === null ? null : { shopMoney: refund },
    refunds,
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: lines ?? [
        {
          id: "gid://shopify/LineItem/1",
          title: "Linen dress",
          sku: "DRESS-1",
          quantity: 2,
          originalUnitPriceSet: { shopMoney: line },
        },
      ],
    },
  };
}

/** A shop reporting in GBP, answering the metadata and the orders queries. */
function executor(nodes: unknown[], currencyCode = "GBP"): ShopifyGraphqlExecutor {
  return (async (_domain: string, _token: string, query: string) => {
    if (query.includes("DropscaleDailySalesShop")) {
      return { shop: { currencyCode, ianaTimezone: "Europe/London" } };
    }
    return { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
  }) as ShopifyGraphqlExecutor;
}

const GBP_ORDER = order(
  1,
  "2026-09-08T10:00:00Z",
  { amount: "100.00", currencyCode: "GBP" },
  { amount: "10.00", currencyCode: "GBP" },
  { amount: "50.00", currencyCode: "GBP" },
);
const CZK_ORDER = order(
  2,
  "2026-09-03T10:00:00Z",
  { amount: "2500.00", currencyCode: "CZK" },
  null,
  { amount: "1250.00", currencyCode: "CZK" },
);

describe("daily sales across a store currency change", () => {
  it("prices the former-currency orders into the shop's currency at their day's rate", async () => {
    const normalize = vi.fn(async (foreign: string, shop: string) => {
      expect([foreign, shop]).toEqual(["CZK", "GBP"]);
      return (day: string, amount: number) => amount * (day === "2026-09-03" ? 0.034 : 0);
    });

    const result = await fetchDailySales(SHOP, TOKEN, "2026-09-01", "2026-09-10", executor([GBP_ORDER, CZK_ORDER]), {
      normalize,
    });

    expect(result.currency).toBe("GBP");
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledWith("CZK", "GBP", "2026-09-01", "2026-09-10");
    expect(result.days).toEqual([
      expect.objectContaining({ date: "2026-09-03", revenue: 85, refunds: 0, orders: 1, units: 2 }),
      expect.objectContaining({ date: "2026-09-08", revenue: 100, refunds: 10, orders: 1, units: 2 }),
    ]);
    const czk = result.orders.find((row) => row.date === "2026-09-03")!;
    expect(czk.total).toBe(85);
    expect(czk.lines[0].unitPrice).toBeCloseTo(42.5, 6);
    const gbp = result.orders.find((row) => row.date === "2026-09-08")!;
    expect(gbp).toMatchObject({ total: 100, refunded: 10 });
    expect(gbp.lines[0].unitPrice).toBe(50);
  });

  it("refuses a former-currency order when nothing can price it", async () => {
    await expect(
      fetchDailySales(SHOP, TOKEN, "2026-09-01", "2026-09-10", executor([GBP_ORDER, CZK_ORDER])),
    ).rejects.toThrow("Shopify returned an order in CZK, but the store now reports in GBP.");
  });

  it("needs no rate at all while every order is in the shop's currency", async () => {
    const normalize = vi.fn();

    const result = await fetchDailySales(SHOP, TOKEN, "2026-09-01", "2026-09-10", executor([GBP_ORDER]), {
      normalize,
    });

    expect(normalize).not.toHaveBeenCalled();
    expect(result.days[0].revenue).toBe(100);
  });

  it.each([
    [
      "an order whose refund is in another currency",
      order(3, "2026-09-08T10:00:00Z", { amount: "100.00", currencyCode: "GBP" }, { amount: "1.00", currencyCode: "CZK" }, { amount: "50.00", currencyCode: "GBP" }),
      "Shopify returned an order refund in another currency.",
    ],
    [
      "an order whose line is in another currency",
      order(4, "2026-09-08T10:00:00Z", { amount: "100.00", currencyCode: "GBP" }, null, { amount: "50.00", currencyCode: "CZK" }),
      "Shopify returned an order line in another currency.",
    ],
    [
      "an order whose balance is in another currency",
      {
        ...order(6, "2026-09-08T10:00:00Z", { amount: "100.00", currencyCode: "GBP" }, null, { amount: "50.00", currencyCode: "GBP" }),
        totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "CZK" } },
      },
      "Shopify returned an order balance in another currency.",
    ],
    [
      "an order with no currency at all",
      order(5, "2026-09-08T10:00:00Z", { amount: "100.00" }, null, { amount: "50.00" }),
      "Shopify returned a missing order total currency.",
    ],
  ])("rejects %s", async (_label, node, message) => {
    const attempt = fetchDailySales(SHOP, TOKEN, "2026-09-01", "2026-09-10", executor([node]), {
      normalize: async () => (_day, amount) => amount,
    });
    await expect(attempt).rejects.toBeInstanceOf(ShopifyError);
    await expect(attempt).rejects.toThrow(message);
  });
});

/**
 * An order counts as the customer paid for it. Shapes below are real ones
 * (amounts as Shopify reported them, currency swapped to the test shop's).
 */
describe("daily sales as the customer paid for the order", () => {
  const gbp = (amount: string): Money => ({ amount, currencyCode: "GBP" });
  const L = (id: string, title: string, quantity: number, unit: string): Line => ({
    id: `gid://shopify/LineItem/${id}`, title, sku: id, quantity, originalUnitPriceSet: { shopMoney: gbp(unit) },
  });
  /** A refund of `total` money over the given lines (id, quantity, subtotal, tax). */
  const refund = (total: string, items: [string, number, string, string?][] = [], hasNextPage = false): Refund => ({
    totalRefundedSet: { shopMoney: { amount: total } },
    refundLineItems: {
      pageInfo: { hasNextPage },
      nodes: items.map(([id, quantity, subtotal, tax]) => ({
        quantity,
        subtotalSet: { shopMoney: { amount: subtotal } },
        totalTaxSet: { shopMoney: { amount: tax ?? "0.00" } },
        lineItem: { id: `gid://shopify/LineItem/${id}` },
      })),
    },
  });
  const sales = (node: unknown) => fetchDailySales(SHOP, TOKEN, "2026-09-01", "2026-09-10", executor([node]));

  it("counts neither the revenue nor the unit of an upsell the customer never paid", async () => {
    // STS#1332: AfterSell added a 233.40 bag after checkout, its charge
    // failed, and the app took it off again - a refund of ZERO money with
    // one refund line. totalPriceSet still says 855.80; the customer paid
    // 622.40 and owes nothing, Shopify's own sales say 622.40, and the bag
    // was never sold.
    const node = order(9, "2026-09-08T10:00:00Z", gbp("855.80"), gbp("0.0"), gbp("0"), [
      L("BAG-1", "Handgjord väska", 2, "311.20"),
      L("BAG-2", "Upsell bag", 1, "233.40"),
    ], [refund("0.0", [["BAG-2", 1, "233.40"]])], { received: "622.40", outstanding: "0.00" });

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 622.4, refunds: 0, orders: 1, units: 2 });
    expect(result.orders[0]).toMatchObject({ total: 622.4, refunded: 0, paid: true });
    expect(result.orders[0].lines).toEqual([
      { productKey: "BAG-1", title: "Handgjord väska", quantity: 2, unitPrice: 311.2 },
    ]);
  });

  it("keeps a refunded item as sold: gross before the refund, its unit and its cost", async () => {
    // #AmeliaBristol1012: 101.91 received, one pair refunded for 42.49.
    // Gross is still 101.91, net 59.42, and the pair still counts as a unit
    // with a cost: it was paid for.
    const node = order(10, "2026-09-08T10:00:00Z", gbp("101.91"), gbp("42.49"), gbp("0"), [
      L("HON", "Honora", 1, "42.49"),
      L("KAT", "Katherine", 2, "29.71"),
    ], [refund("42.49", [["HON", 1, "42.49"]])]);

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 101.91, refunds: 42.49, units: 3 });
    expect(result.orders[0].lines).toEqual([
      { productKey: "HON", title: "Honora", quantity: 1, unitPrice: 42.49 },
      { productKey: "KAT", title: "Katherine", quantity: 2, unitPrice: 29.71 },
    ]);
  });

  it("reads a money-only refund as before: the total stands, the money comes off", async () => {
    // #ROSADOURO2122: 41.97 refunded as a custom amount, no lines touched.
    // Shopify's currentTotalPriceSet stays 59.95 - nothing was returned.
    const node = order(11, "2026-09-08T10:00:00Z", gbp("59.95"), gbp("41.97"), gbp("0"), [
      L("SET", "Conjunto", 1, "59.95"),
    ], [refund("41.97")]);

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 59.95, refunds: 41.97, units: 1 });
  });

  it("keeps an item taken off at zero and refunded separately: it was paid for", async () => {
    // #DAPHNERHODES1176: 113.99 received; one dress taken off the order by
    // a zero-money refund line, then 54 refunded as a custom amount. The
    // customer paid for it and got the money back: gross 113.99, refunds
    // 54, net 59.99, and the dress keeps its unit and cost.
    const node = order(12, "2026-09-08T10:00:00Z", gbp("113.99"), gbp("54.00"), gbp("0"), [
      L("NAT", "Natalia", 1, "54.00"),
      L("GAB", "Gabriela", 1, "59.99"),
    ], [refund("0.0", [["NAT", 1, "54.00"]]), refund("54.00")]);

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 113.99, refunds: 54, units: 2 });
    expect(result.orders[0].lines.map((line) => line.productKey)).toEqual(["NAT", "GAB"]);
  });

  it("tells the two apart inside one order by the money that never came", async () => {
    // #DAPHNERHODES1285: 119.90 listed, 59.95 received - the upsell dress
    // was taken off unpaid - then 29.95 refunded on the dress that stayed.
    // Gross 59.95 (the upsell never sold), refunds 29.95, one unit.
    const node = order(13, "2026-09-08T10:00:00Z", gbp("119.90"), gbp("29.95"), gbp("0"), [
      L("ELE", "Elena", 1, "59.95"),
      L("MID", "Midi", 1, "59.95"),
    ], [refund("0.0", [["ELE", 1, "59.95"]]), refund("29.95")], { received: "59.95", outstanding: "0.00" });

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 59.95, refunds: 29.95, units: 1 });
    expect(result.orders[0].lines).toEqual([
      { productKey: "MID", title: "Midi", quantity: 1, unitPrice: 59.95 },
    ]);
  });

  it("still counts an order the customer has not paid yet - it is all outstanding", async () => {
    const node = {
      ...order(14, "2026-09-08T10:00:00Z", gbp("34.95"), null, gbp("34.95"), [L("TOP", "Top", 1, "34.95")], [], {
        received: "0.00",
        outstanding: "34.95",
      }),
      displayFinancialStatus: "EXPIRED",
    };

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 34.95, refunds: 0, units: 1 });
    expect(result.orders[0]).toMatchObject({ total: 34.95, paid: false });
  });

  it("adds the tax to a removed line's value where the store prices exclude it", async () => {
    // 60 listed = 50 + 10 tax for the upsell; the customer paid the other
    // 100. With taxes on top, the line's subtotal alone would not fill the
    // gap and the unit would wrongly stay.
    const node = order(15, "2026-09-08T10:00:00Z", gbp("160.00"), gbp("0.0"), gbp("0"), [
      L("MAIN", "Main", 1, "100.00"),
      L("UP", "Upsell", 1, "50.00"),
    ], [refund("0.0", [["UP", 1, "50.00", "10.00"]])], { received: "100.00", outstanding: "0.00" }, false);

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 100, units: 1 });
    expect(result.orders[0].lines.map((line) => line.productKey)).toEqual(["MAIN"]);
  });

  it("never counts less than the customer paid, whatever the balance says", async () => {
    // received + outstanding above the listed total: the gap is not negative
    // revenue, the listed total stands.
    const node = order(16, "2026-09-08T10:00:00Z", gbp("100.00"), null, gbp("100.00"), [L("A", "A", 1, "100.00")], [], {
      received: "100.00",
      outstanding: "5.00",
    });

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 100, units: 1 });
  });

  it("matches an unpaid line booked inside a refund that also returned the shipping", async () => {
    // 100 main + 60 upsell + 5 shipping listed; the customer paid 105. One
    // refund carries both the upsell's removal and the shipping money (5),
    // so it is not a zero-money refund - yet the upsell fits the gap.
    const node = order(20, "2026-09-08T10:00:00Z", gbp("165.00"), gbp("5.00"), gbp("0"), [
      L("MAIN", "Main", 1, "100.00"),
      L("UP", "Upsell", 1, "60.00"),
    ], [refund("5.00", [["UP", 1, "60.00"]])], { received: "105.00", outstanding: "0.00" });

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 105, refunds: 5, units: 1 });
    expect(result.orders[0].lines.map((line) => line.productKey)).toEqual(["MAIN"]);
  });

  it("keeps an item taken off a paid order at zero and never refunded: no gap, nothing unpaid", async () => {
    // #ROSADOURO2694: 72.17 paid, one dress taken off by a zero-money refund
    // line and the money never returned through Shopify. Nothing went
    // unpaid, so it counts as it always did - unit, cost and revenue.
    const node = order(21, "2026-09-08T10:00:00Z", gbp("72.17"), gbp("0.0"), gbp("0"), [
      L("FLO", "Flora", 1, "33.95"),
      L("VIV", "Viviana", 1, "38.22"),
    ], [refund("0.0", [["FLO", 1, "33.95"]])]);

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 72.17, refunds: 0, units: 2 });
  });

  it("reads a negative outstanding balance as nothing owed, not as revenue lost", async () => {
    const node = order(22, "2026-09-08T10:00:00Z", gbp("100.00"), null, gbp("100.00"), [L("A", "A", 1, "100.00")], [], {
      received: "100.00",
      outstanding: "-5.00",
    });

    const result = await sales(node);

    expect(result.days[0]).toMatchObject({ revenue: 100, units: 1 });
  });

  it.each([
    [
      "a refund line that removes more than the line held",
      order(17, "2026-09-08T10:00:00Z", gbp("100.00"), gbp("0.0"), gbp("0"), [L("A", "A", 1, "50.00")], [refund("0.0", [["A", 2, "100.00"]])], { received: "0.00", outstanding: "0.00" }),
      "Shopify returned an invalid refund line.",
    ],
    [
      "a refund with more lines than one page",
      order(18, "2026-09-08T10:00:00Z", gbp("100.00"), gbp("0.0"), gbp("0"), [L("A", "A", 1, "100.00")], [refund("0.0", [], true)]),
      "A Shopify refund has too many lines for an exact report.",
    ],
    [
      "an order whose received balance is missing",
      { ...order(19, "2026-09-08T10:00:00Z", gbp("100.00"), null, gbp("100.00")), totalReceivedSet: null },
      "Shopify returned a missing order balance.",
    ],
  ])("refuses %s", async (_label, node, message) => {
    const attempt = sales(node);
    await expect(attempt).rejects.toBeInstanceOf(ShopifyError);
    await expect(attempt).rejects.toThrow(message);
  });
});
