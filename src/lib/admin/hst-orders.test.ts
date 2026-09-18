import { describe, expect, it } from "vitest";

import { decideFamilies, parseHstOrderPage } from "./hst-orders";

const SHOP = "2021639129";

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
    const result = parseHstOrderPage(page(), { shopId: SHOP });

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
    const result = parseHstOrderPage(page(), { shopId: SHOP });

    expect(result.orders[0].items[0].keys).toEqual([
      "DBAD4-GZ871158",
      "Handgjord väska med blommor",
    ]);
  });

  it("dates the order by the day the ERP writes its payment time with", () => {
    // Measured 2026-09-18 against Shopify's createdAt for 840 of 840 orders of
    // three stores: the ERP writes paidTime in the store's own zone (Lisbon
    // stores read 7.00 h, Madrid 6.00 h behind a UTC+8 reading). An order paid
    // at 03:00 store time belongs to that day — subtracting the ERP's eight
    // hours, as this parser once did, filed it and its cost on the day before.
    const result = parseHstOrderPage(
      page({ data: [{ ...page().data.data[0], paidTime: "2026-08-28 03:00:00" }] }),
      { shopId: SHOP },
    );

    expect(result.orders[0].orderDay).toBe("2026-08-28");
  });

  it("leaves a row with no readable payment time for a later page, never dating it by ingestion", () => {
    // createDate is the ERP's own clock (UTC+8) and says when HST took the
    // order in, hours after it was paid. Filing the order by it put the cost
    // on a day that may not be the order's; the row waits instead.
    const result = parseHstOrderPage(
      page({ data: [{ ...page().data.data[0], paidTime: "" }] }),
      { shopId: SHOP },
    );

    expect(result.orders).toEqual([]);
    expect(result.undated).toBe(1);
    expect(result.oldestOrderDay).toBeNull();
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
      { shopId: SHOP },
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
      { shopId: SHOP },
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
      { shopId: SHOP },
    );

    expect(result.orders.map((o) => o.platformOrderId)).toEqual(["8004536729939"]);
    expect(result.otherShops).toBe(1);
  });

  it("hands back the shop list so a store can be mapped to one", () => {
    const result = parseHstOrderPage(page(), { shopId: SHOP });

    expect(result.shops).toEqual([
      { id: "2021639129", name: "AWU92655-STOCKHOLM SLOJD-B2B3A3" },
      { id: "2021635417", name: "AWU92655-EVA LISBOA-B2B3A3" },
    ]);
  });

  it("reports how far back the page reached, so paging can stop", () => {
    const result = parseHstOrderPage(page(), { shopId: SHOP });

    expect(result.lastPage).toBe(221);
    expect(result.oldestOrderDay).toBe("2026-08-27");
  });

  it("treats a destination with no tariff as zero, not as a broken row", () => {
    // UK and Japan orders come back with "-". That is a real answer.
    const result = parseHstOrderPage(
      page({ data: [{ ...page().data.data[0], g_tariff: "-" }] }),
      { shopId: SHOP },
    );

    expect(result.orders[0].tariff).toBe(0);
  });

  it("survives a payload shaped like nothing at all", () => {
    for (const junk of [null, undefined, {}, { data: {} }, { data: { data: "nope" } }]) {
      const result = parseHstOrderPage(junk, { shopId: SHOP });
      expect(result.orders).toEqual([]);
      expect(result.lastPage).toBe(1);
    }
  });

  it("reads the order's currency off its quoted lines when the ERP states none", () => {
    // Elena Granada, 2026-09-09, order #1031: g_currency blank, one line quoted
    // at 18.11 USD, tariff 3.44, g_cost 21.55. Defaulting to EUR booked the
    // dollars as euros — 13.7% over for the month. The lines are the same
    // money as the total, so they name it.
    const result = parseHstOrderPage(
      page({
        data: [
          {
            ...page().data.data[0],
            g_cost: "21.55",
            g_currency: "",
            g_tariff: "3.44",
            items: [
              {
                platformSku: "MIRA-1",
                originTitle: "Mira - Mocasines con borlas",
                baojia_price: "18.11",
                baojia_currency: "USD",
                quantity: 1,
              },
            ],
          },
        ],
      }),
      { shopId: SHOP },
    );

    expect(result.orders[0].currency).toBe("USD");
    expect(result.orders[0].totalCost).toBe(21.55);
    expect(result.currencyInferred).toBe(1);
  });

  it("gives an unquoted order the shop's currency as the rest of the page states it", () => {
    // The unpriced order has no line to read; its shop settles in one currency
    // and every other quoted line on the page says which.
    const priced = {
      ...page().data.data[0],
      g_currency: "",
      items: [{ ...page().data.data[0].items[0], baojia_currency: "USD" }],
    };
    const unpriced = {
      ...page().data.data[0],
      platformOrderId: "8143432483155",
      g_cost: "-",
      g_currency: "",
      g_tariff: "-",
      items: [{ ...page().data.data[0].items[0], baojia_price: "-", baojia_currency: "-" }],
    };
    const result = parseHstOrderPage(page({ data: [priced, unpriced] }), { shopId: SHOP });

    expect(result.orders.map((order) => order.currency)).toEqual(["USD", "USD"]);
    expect(result.orders[1].totalCost).toBe(0);
    expect(result.currencyInferred).toBe(2);
  });

  it("believes a currency the ERP does state over what the lines say", () => {
    const result = parseHstOrderPage(page(), { shopId: SHOP });

    expect(result.orders[0].currency).toBe("EUR");
    expect(result.currencyInferred).toBe(0);
  });

  it("believes the currency the ERP writes beside the total over everything else", () => {
    // "112.8 USD" is the figure's own declared currency; it wins over a blank
    // g_currency and over what the lines say.
    const result = parseHstOrderPage(
      page({
        data: [
          {
            ...page().data.data[0],
            g_cost: "112.80",
            g_cost_text: "112.8 USD",
            g_currency: undefined,
          },
        ],
      }),
      { shopId: SHOP },
    );

    expect(result.orders[0].currency).toBe("USD");
    expect(result.currencyInferred).toBe(0);
  });

  it("tells a package the parent's bill covers from one it does not, by the family's arithmetic", () => {
    // Two shapes coexist in one store. Split off AFTER the parent's cost was
    // set, a package's lines are in the parent's g_cost and it is settled at
    // nothing (Elena Granada, 8110621458771: 45.16 + 15.58 + 48.62 + 3.44 =
    // 112.80 across three rows). Split off BEFORE, or in Stockholm Slojd's
    // multi-package families, the package carries cost the parent does not.
    // The suffix cannot tell them apart; parent goods = family lines can.
    const base = page().data.data[0];
    const lines = (...prices: string[]) =>
      prices.map((price, index) => ({
        platformSku: `SKU-${index}`,
        originTitle: `Item ${index}`,
        baojia_price: price,
        baojia_currency: "EUR",
        quantity: 1,
      }));
    // Covered: parent goods 17.99 + 15.58 = 33.57; g_cost = 33.57 + 3 tariff.
    const coveredParent = { ...base, platformOrderId: "A", g_cost: "36.57", items: lines("8.37", "9.62") };
    const coveredPackage = { ...base, platformOrderId: "A_1", g_cost: "18.58", items: lines("15.58") };
    // Not covered: the parent's g_cost holds only its own lines.
    const bareParent = { ...base, platformOrderId: "B", g_cost: "20.99", items: lines("8.37", "9.62") };
    const ownPackage = { ...base, platformOrderId: "B_1", g_cost: "18.58", items: lines("15.58") };
    // Alone: the parent is not on this page, so nothing can be decided.
    const orphanPackage = { ...base, platformOrderId: "C_1", g_cost: "18.58", items: lines("15.58") };

    const result = parseHstOrderPage(
      page({ data: [coveredParent, coveredPackage, bareParent, ownPackage, orphanPackage] }),
      { shopId: SHOP },
    );
    decideFamilies(result.orders);

    expect(
      result.orders.map((order) => [order.platformOrderId, order.baseOrderId, order.split, order.coveredByParent]),
    ).toEqual([
      ["A", "A", false, null],
      ["A_1", "A", true, true],
      ["B", "B", false, null],
      ["B_1", "B", true, false],
      ["C_1", "C", true, null],
    ]);
  });

  it("counts a row's own unquoted lines, so a package still waiting for a quote is not booked", () => {
    // 8015506997587: four items sold, three quoted on the parent, the fourth
    // waiting in "_1" with no quote. The parent's goods equal the family's
    // quoted lines — the package IS covered by arithmetic — and yet it is not
    // settled: its line has no price yet. The count is what says so.
    const base = page().data.data[0];
    // The fixture's two quoted lines (8.37 + 9.62) plus the tariff: the
    // parent's goods equal the family's quoted lines, as in the real order.
    const parent = { ...base, platformOrderId: "8015506997587", g_cost: "21.43", g_tariff: "3.44" };
    const waiting = {
      ...base,
      platformOrderId: "8015506997587_1",
      g_cost: "0.00",
      g_tariff: "0",
      items: [{ ...base.items[0], baojia_price: "-", baojia_currency: "-" }],
    };
    const result = parseHstOrderPage(page({ data: [parent, waiting] }), { shopId: SHOP });
    decideFamilies(result.orders);

    expect(result.orders[0]).toMatchObject({ unquotedLines: 0, linesTotal: 17.99 });
    expect(result.orders[1]).toMatchObject({ unquotedLines: 1, linesTotal: 0, coveredByParent: true });
    expect(result.unquotedLines).toBe(1);
  });

  it("reads the discount the ERP took off the total", () => {
    // #1055: lines 29.30, tariff 3.44, discount 3 → g_cost 29.74.
    const result = parseHstOrderPage(
      page({
        data: [
          { ...page().data.data[0], g_cost: "29.74", g_tariff: "3.44", g_discount: "3" },
        ],
      }),
      { shopId: SHOP },
    );

    expect(result.orders[0].totalCost).toBe(29.74);
    expect(result.orders[0].discount).toBe(3);
  });
});
