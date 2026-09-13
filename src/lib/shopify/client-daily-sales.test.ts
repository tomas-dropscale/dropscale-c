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

function order(
  id: number,
  createdAt: string,
  total: Money,
  refund: Money | null,
  line: Money,
) {
  return {
    id: `gid://shopify/Order/${id}`,
    createdAt,
    test: false,
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    customerJourneySummary: null,
    totalPriceSet: { shopMoney: total },
    totalRefundedSet: refund === null ? null : { shopMoney: refund },
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
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
