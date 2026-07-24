import { describe, expect, it } from "vitest";
import {
  dealsFromCampaigns,
  normalizePath,
  orderRevShare,
  parseRevShareCampaign,
  type AttributionDeal,
} from "./rev-share";

/**
 * The rev-share rate + collection are read off the Google Ads campaign name:
 * "<free text> <.../collections/HANDLE...> N%". These tests pin the parse and
 * the "only when it clearly encodes a deal" rule.
 */

describe("parseRevShareCampaign", () => {
  it("reads the handle from the /collections/ URL and the trailing rate", () => {
    expect(
      parseRevShareCampaign("Summer Velas https://shop.myshopify.com/collections/velas 5%"),
    ).toEqual({ handle: "velas", path: "/collections/velas", rate: 5 });
  });

  it("handles a query string on the URL and a decimal rate", () => {
    expect(
      parseRevShareCampaign("Brand https://loja.com/collections/summer-sale?page=2 7,5%"),
    ).toEqual({ handle: "summer-sale", path: "/collections/summer-sale", rate: 7.5 });
  });

  it("is case-insensitive and tolerates a trailing slash on the handle", () => {
    expect(parseRevShareCampaign("X https://l.com/Collections/Velas/ 10 %")?.handle).toBe("velas");
  });

  it.each([
    ["no /collections/ URL", "Generic Search Campaign 5%"],
    ["no trailing rate", "Velas https://loja.com/collections/velas"],
    ["rate not at the end", "10% off https://loja.com/collections/velas"],
    ["rate out of range", "Velas https://loja.com/collections/velas 150%"],
    ["empty", ""],
  ])("returns null when %s", (_label, name) => {
    expect(parseRevShareCampaign(name)).toBeNull();
  });
});

describe("dealsFromCampaigns", () => {
  it("keys deals by handle and keeps the higher rate on a duplicate", () => {
    const deals = dealsFromCampaigns([
      "A https://x.com/collections/velas 5%",
      "B https://x.com/collections/velas 7%", // renamed, higher — wins
      "C https://x.com/collections/pods 3%",
      "Not a deal campaign",
      null,
    ]);

    expect(deals.size).toBe(2);
    expect(deals.get("velas")?.rate).toBe(7);
    expect(deals.get("pods")?.rate).toBe(3);
  });
});

describe("normalizePath", () => {
  it.each([
    ["https://shop.com/collections/velas?utm=x", "/collections/velas"],
    ["/collections/Velas/", "/collections/velas"],
    ["shop.com/collections/velas#top", "/collections/velas"],
    ["", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe("orderRevShare — the agreed attribution rule", () => {
  const velas: AttributionDeal = {
    handle: "velas",
    path: "/collections/velas",
    rate: 5,
    productKeys: new Set(["SKU-A", "SKU-B"]),
  };
  const pods: AttributionDeal = {
    handle: "pods",
    path: "/collections/pods",
    rate: 10,
    productKeys: new Set(["SKU-A"]), // A is in both — higher rate (pods) should win
  };

  it("landing on the advertised collection → the WHOLE order counts", () => {
    const order = {
      total: 100,
      landingPath: "https://shop.com/collections/velas?utm=fb",
      lines: [{ productKey: "SKU-Z", revenue: 100 }], // not in any collection
    };
    expect(orderRevShare(order, [velas])).toEqual({ base: 100, amount: 5 });
  });

  it("no landing match → only the collection's line items count", () => {
    const order = {
      total: 100,
      landingPath: "/products/random",
      lines: [
        { productKey: "SKU-B", revenue: 40 }, // in velas
        { productKey: "SKU-Z", revenue: 60 }, // not in any collection
      ],
    };
    expect(orderRevShare(order, [velas])).toEqual({ base: 40, amount: 2 });
  });

  it("a product in two collections bills at the higher rate", () => {
    const order = {
      total: 50,
      landingPath: null,
      lines: [{ productKey: "SKU-A", revenue: 50 }],
    };
    // A is in velas (5%) and pods (10%) → 10% wins.
    expect(orderRevShare(order, [velas, pods])).toEqual({ base: 50, amount: 5 });
  });

  it("no deals or no match → nothing", () => {
    const order = { total: 100, landingPath: "/collections/other", lines: [{ productKey: "X", revenue: 100 }] };
    expect(orderRevShare(order, [])).toEqual({ base: 0, amount: 0 });
    expect(orderRevShare(order, [velas])).toEqual({ base: 0, amount: 0 });
  });
});
