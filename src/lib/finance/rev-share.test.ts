import { describe, expect, it } from "vitest";
import {
  collectionHandleFromUrl,
  dealsFromCampaigns,
  normalizeDecodedPath,
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

/**
 * The same read, applied to a bare collection link a client typed into a
 * creative submission (migration 0018). It has to agree with the campaign-name
 * parse above, or the agency validates one thing and bills on another.
 */
describe("collectionHandleFromUrl", () => {
  it("reads the handle, ignoring case, trailing slash and query", () => {
    expect(collectionHandleFromUrl("https://shop.myshopify.com/collections/velas")).toBe("velas");
    expect(collectionHandleFromUrl("https://loja.com/Collections/Summer-Sale/?page=2")).toBe(
      "summer-sale",
    );
  });

  it("decodes percent-escapes, like the campaign-name parse", () => {
    expect(collectionHandleFromUrl("https://l.com/collections/v%C3%A9las")).toBe("vélas");
    // Decoded before lower-casing: the escaped capital sigma reads as a small one.
    expect(collectionHandleFromUrl("https://l.com/collections/%CE%A3%CE%B1")).toBe("σα");
  });

  it("agrees with the campaign-name parse on the same URL", () => {
    const url = "https://shop.myshopify.com/collections/velas";
    expect(collectionHandleFromUrl(url)).toBe(parseRevShareCampaign(`Ad ${url} 5%`)?.handle);
  });

  it("null when there is no /collections/ segment — a link that bills nothing", () => {
    expect(collectionHandleFromUrl("https://loja.com/products/vela-grande")).toBeNull();
    expect(collectionHandleFromUrl("https://loja.com")).toBeNull();
    expect(collectionHandleFromUrl("")).toBeNull();
    expect(collectionHandleFromUrl(null)).toBeNull();
  });
});

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
    ["HTTPS://Shop.com/collections/Velas", "/collections/velas"],
    // The billing rule keeps percent-escapes as they came: a percent-encoded
    // landing page never equals the plain handle a deal's path holds, so the
    // whole-order rule does not fire on it. Decoding here would be a change
    // to what those clients are billed; see the function's own comment.
    ["/collections/%E3%83%8F%E3%83%B3%E3%83%89?utm_source=google", "/collections/%e3%83%8f%e3%83%b3%e3%83%89"],
    ["/collections/100%25-cotton", "/collections/100%25-cotton"],
    ["", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe("normalizeDecodedPath", () => {
  it.each([
    ["https://shop.com/collections/velas?utm=x", "/collections/velas"],
    ["/collections/Velas/", "/collections/velas"],
    ["shop.com/collections/velas#top", "/collections/velas"],
    // A landing path arrives percent-encoded; the handle it names does not,
    // and a capital hidden in an escape lower-cases once decoded.
    ["/collections/%E3%83%8F%E3%83%B3%E3%83%89?utm_source=google", "/collections/ハンド"],
    ["https://shop.com/collections/%CE%A3%CE%B1/", "/collections/σα"],
    ["https://shop.com/collections/ハンド", "/collections/ハンド"],
    // Not valid escapes: kept as they came.
    ["/collections/100%25-cotton", "/collections/100%-cotton"],
    ["/collections/%E3", "/collections/%e3"],
    ["", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDecodedPath(input)).toBe(expected);
  });

  it("agrees with normalizePath wherever nothing is percent-encoded", () => {
    for (const input of ["/collections/Velas/?page=2", "https://shop.com/Collections/x#top", "/", "shop.com"]) {
      expect(normalizeDecodedPath(input)).toBe(normalizePath(input));
    }
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

  it("a percent-encoded landing path does not fire the landing rule; the lines still count", () => {
    // A Japanese store: the deal's handle is plain, the order's landing page
    // arrives percent-encoded. The billing rule compares them as they came,
    // so this order bills by its lines, not whole. This pins the rule as it
    // is billed today; making the landing rule decode is the owner's call
    // (normalizePath explains), and this test is where it would show.
    const hand: AttributionDeal = {
      handle: "ハンド",
      path: "/collections/ハンド",
      rate: 5,
      productKeys: new Set(["HAND-1"]),
    };
    const order = {
      total: 100,
      landingPath: "/collections/%E3%83%8F%E3%83%B3%E3%83%89?utm_source=google",
      lines: [
        { productKey: "HAND-1", revenue: 40 },
        { productKey: "OTHER-1", revenue: 60 },
      ],
    };
    expect(orderRevShare(order, [hand])).toEqual({ base: 40, amount: 2 });
    // The same page spelled plain is the landing rule as always.
    expect(orderRevShare({ ...order, landingPath: "/collections/ハンド" }, [hand])).toEqual({ base: 100, amount: 5 });
  });
});
