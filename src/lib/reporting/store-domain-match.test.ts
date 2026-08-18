import { describe, expect, it } from "vitest";

import {
  campaignBelongsToStore,
  normalizeStoreDomain,
  storeDomainsForSource,
} from "./store-domain-match";

describe("Campaign↔store destination-URL attribution", () => {
  it("normalizes hosts, URLs and myshopify domains to a bare comparable host", () => {
    expect(normalizeStoreDomain("www.Akinikko.com")).toBe("akinikko.com");
    expect(normalizeStoreDomain("https://akinikko.com/collections/x?a=1")).toBe(
      "akinikko.com",
    );
    expect(normalizeStoreDomain("pbfvnb-em.myshopify.com")).toBe(
      "pbfvnb-em.myshopify.com",
    );
    expect(normalizeStoreDomain("akinikko.com.")).toBe("akinikko.com");
    expect(normalizeStoreDomain("  ")).toBeNull();
    expect(normalizeStoreDomain(null)).toBeNull();
    expect(normalizeStoreDomain("localhost")).toBeNull();
    expect(normalizeStoreDomain("http://[not-a-url")).toBeNull();
  });

  it("collects the deduplicated domain aliases of a source's Shopify store", () => {
    expect(storeDomainsForSource({ shopify: null })).toEqual([]);
    expect(
      storeDomainsForSource({
        shopify: {
          domain: "pbfvnb-em.myshopify.com",
          primaryDomain: "www.akinikko.com",
        },
      }),
    ).toEqual(["akinikko.com", "pbfvnb-em.myshopify.com"]);
    expect(
      storeDomainsForSource({
        shopify: { domain: "akinikko.com", primaryDomain: "akinikko.com" },
      }),
    ).toEqual(["akinikko.com"]);
  });

  it("attributes a campaign only when a final URL points at the store", () => {
    const domains = ["akinikko.com", "pbfvnb-em.myshopify.com"];
    expect(
      campaignBelongsToStore(
        ["https://akinikko.com/collections/%E3%83%90%E3%83%83%E3%82%B0"],
        domains,
      ),
    ).toBe(true);
    expect(
      campaignBelongsToStore(["https://www.akinikko.com/products/x"], domains),
    ).toBe(true);
    expect(
      campaignBelongsToStore(["https://shop.akinikko.com/"], domains),
    ).toBe(true);
    expect(
      campaignBelongsToStore(
        [
          "https://casa-luna-artesanias.com/en/collections/lamparas-artesanales",
          "https://casa-luna-artesanias.com/en/collections/lamparas-artesanales{ignore}?utm_id={campaignid}",
        ],
        domains,
      ),
    ).toBe(false);
    // One matching URL among foreign ones keeps the campaign attributed.
    expect(
      campaignBelongsToStore(
        ["https://casa-luna-artesanias.com/x", "https://akinikko.com/y"],
        domains,
      ),
    ).toBe(true);
  });

  it("never excludes without positive evidence", () => {
    expect(campaignBelongsToStore(undefined, ["akinikko.com"])).toBe(true);
    expect(campaignBelongsToStore([], ["akinikko.com"])).toBe(true);
    expect(campaignBelongsToStore(["not a url"], ["akinikko.com"])).toBe(true);
    expect(
      campaignBelongsToStore(["https://casa-luna-artesanias.com/x"], []),
    ).toBe(true);
  });

  it("does not let a foreign host smuggle a matching suffix", () => {
    expect(
      campaignBelongsToStore(["https://fakeakinikko.com/x"], ["akinikko.com"]),
    ).toBe(false);
    expect(
      campaignBelongsToStore(["https://akinikko.com.evil.io/x"], ["akinikko.com"]),
    ).toBe(false);
  });
});
