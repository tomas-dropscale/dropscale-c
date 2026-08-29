import { describe, expect, it } from "vitest";

import { parseHstOrderPage } from "./hst-orders";

const SHOP = "2021639129";
const LISBON = "Europe/Lisbon";

/**
 * Rows copied down from a live Order List response, keeping only the fields
 * this parser reads. The two-line order below is the one that proves the
 * arithmetic: 8.37 + 9.62 + 3 tariff = 20.99, the g_cost the ERP shows.
 */
function page(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    success: true,
    data: {
      current_page: 1,
      last_page: 221,
      shop_list: [
        { id: 2021639129, name: "AWU92655-STOCKHOLM SLOJD-B2B3A3", status: 1 },
        { id: 2021635417, name: "AWU92655-EVA LISBOA-B2B3A3", status: 1 },
      ],
      data: [
        {
          platformOrderId: "8004536729939",
          shopId: "2021639129",
          shopName: "AWU92655-STOCKHOLM SLOJD-B2B3A3",
          g_cost: "20.99",
          g_currency: "EUR",
          g_tariff: "3",
          paidTime: "2026-08-27 22:50:04",
          createDate: "2026-08-28 05:50:18",
          items: [
            {
              platformSku: "DBAD4-GZ871158",
              originTitle: "Handgjord väska med blommor",
              baojia_price: "8.37",
              baojia_currency: "EUR",
              quantity: 1,
            },
            {
              platformSku: "DBAD4-GZ871056",
              originTitle: "Handgjord väska med blomstertryck",
              baojia_price: "9.62",
              baojia_currency: "EUR",
              quantity: 1,
            },
          ],
        },
      ],
      ...overrides,
    },
  };
}

describe("HST order list", () => {
  it("reads a cost per line and one tariff per order", () => {
    const result = parseHstOrderPage(page(), { shopId: SHOP, timeZone: LISBON });

    expect(result.orders).toHaveLength(1);
    const [order] = result.orders;
    expect(order.platformOrderId).toBe("8004536729939");
    expect(order.tariff).toBe(3);
    // g_cost is the ERP's own total for the order — what an HST store reconciles to.
    expect(order.totalCost).toBe(20.99);
    expect(order.currency).toBe("EUR");
    expect(order.items.map((item) => item.unitCost)).toEqual([8.37, 9.62]);
    // What the supplier says the whole order cost, rebuilt from the parts.
    const total = order.items.reduce((sum, i) => sum + i.unitCost * i.quantity, 0) + order.tariff;
    expect(total).toBeCloseTo(20.99, 2);
  });

  it("offers the SKU and the title, in that order", () => {
    // Which one matches is the store's choice — the Shopify sync keys products
    // on `sku || title` and cannot know in advance which a merchant sets.
    const result = parseHstOrderPage(page(), { shopId: SHOP, timeZone: LISBON });

    expect(result.orders[0].items[0].keys).toEqual([
      "DBAD4-GZ871158",
      "Handgjord väska med blommor",
    ]);
  });

  it("reads the ERP's clock as UTC+8, not as UTC", () => {
    // The ERP renders everything in UTC+8 and documents it nowhere. An order
    // paid at 03:00 there was paid at 19:00 UTC the PREVIOUS day, and its
    // tariff belongs to that day's costs. Reading the string as UTC would file
    // it a day late, against revenue that is not there.
    const result = parseHstOrderPage(
      page({
        data: [
          {
            ...page().data.data[0],
            paidTime: "2026-08-28 03:00:00",
          },
        ],
      }),
      { shopId: SHOP, timeZone: LISBON },
    );

    expect(result.orders[0].paidAt).toBe("2026-08-27T19:00:00.000Z");
    expect(result.orders[0].orderDay).toBe("2026-08-27");
  });

  it("dates the order in the account's reporting zone, not the supplier's", () => {
    const auckland = parseHstOrderPage(page(), { shopId: SHOP, timeZone: "Pacific/Auckland" });
    const lisbon = parseHstOrderPage(page(), { shopId: SHOP, timeZone: LISBON });

    // Same instant, two stores, two calendars — each order lands on the day its
    // own store's revenue did.
    expect(lisbon.orders[0].orderDay).toBe("2026-08-27");
    expect(auckland.orders[0].orderDay).toBe("2026-08-28");
  });

  it("skips a line the supplier has not quoted instead of pricing it at zero", () => {
    // Shipping-protection upsells come back with baojia_currency "-" and a
    // price of "0", and so does a real product still awaiting a quote. Zero is
    // not a cost we know; it is a cost we do not have yet, and writing it would
    // read as pure margin.
    const result = parseHstOrderPage(
      page({
        data: [
          {
            ...page().data.data[0],
            items: [
              {
                platformSku: "54706881200467",
                originTitle: "Fraktskydd",
                baojia_price: "0",
                baojia_currency: "-",
                quantity: 1,
              },
              ...page().data.data[0].items,
            ],
          },
        ],
      }),
      { shopId: SHOP, timeZone: LISBON },
    );

    expect(result.unquotedLines).toBe(1);
    expect(result.orders[0].items).toHaveLength(2);
    expect(result.orders[0].items.map((i) => i.unitCost)).toEqual([8.37, 9.62]);
  });

  it("keeps a genuinely free line that carries a real currency", () => {
    const result = parseHstOrderPage(
      page({
        data: [
          {
            ...page().data.data[0],
            items: [
              {
                platformSku: "GIFT-1",
                originTitle: "Gift",
                baojia_price: "0",
                baojia_currency: "EUR",
                quantity: 1,
              },
            ],
          },
        ],
      }),
      { shopId: SHOP, timeZone: LISBON },
    );

    expect(result.unquotedLines).toBe(0);
    expect(result.orders[0].items[0].unitCost).toBe(0);
  });

  it("takes only the shop this store is, never the neighbours'", () => {
    // One HST login sees ten shops. Costs from another client's store would be
    // written against this one's products without a word.
    const result = parseHstOrderPage(
      page({
        data: [
          page().data.data[0],
          { ...page().data.data[0], platformOrderId: "999", shopId: "2021635417" },
        ],
      }),
      { shopId: SHOP, timeZone: LISBON },
    );

    expect(result.orders.map((o) => o.platformOrderId)).toEqual(["8004536729939"]);
    expect(result.otherShops).toBe(1);
  });

  it("hands back the shop list so a store can be mapped to one", () => {
    const result = parseHstOrderPage(page(), { shopId: SHOP, timeZone: LISBON });

    expect(result.shops).toEqual([
      { id: "2021639129", name: "AWU92655-STOCKHOLM SLOJD-B2B3A3" },
      { id: "2021635417", name: "AWU92655-EVA LISBOA-B2B3A3" },
    ]);
  });

  it("reports how far back the page reached, so paging can stop", () => {
    const result = parseHstOrderPage(page(), { shopId: SHOP, timeZone: LISBON });

    expect(result.lastPage).toBe(221);
    expect(result.oldestPaidAt).toBe("2026-08-27T14:50:04.000Z");
  });

  it("falls back to the ingestion date when the payment time is missing", () => {
    const result = parseHstOrderPage(
      page({ data: [{ ...page().data.data[0], paidTime: "" }] }),
      { shopId: SHOP, timeZone: LISBON },
    );

    expect(result.orders[0].paidAt).toBe("2026-08-27T21:50:18.000Z");
  });

  it("treats a destination with no tariff as zero, not as a broken row", () => {
    // UK and Japan orders come back with "-". That is a real answer.
    const result = parseHstOrderPage(
      page({ data: [{ ...page().data.data[0], g_tariff: "-" }] }),
      { shopId: SHOP, timeZone: LISBON },
    );

    expect(result.orders[0].tariff).toBe(0);
  });

  it("survives a payload shaped like nothing at all", () => {
    for (const junk of [null, undefined, {}, { data: {} }, { data: { data: "nope" } }]) {
      const result = parseHstOrderPage(junk, { shopId: SHOP, timeZone: LISBON });
      expect(result.orders).toEqual([]);
      expect(result.lastPage).toBe(1);
    }
  });
});
