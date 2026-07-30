import { describe, expect, it } from "vitest";
import { isMetaReferral } from "./referrer";

/**
 * The store's CONVERSIONS figure is "orders minus the ones Instagram/Facebook
 * sent", so these tests pin both halves: what counts as Meta, and — just as
 * important — what must NOT, since every false positive silently removes a real
 * conversion from a number the agency is judged on.
 */

describe("isMetaReferral", () => {
  it("recognises Shopify's channel names", () => {
    expect(isMetaReferral({ source: "instagram" })).toBe(true);
    expect(isMetaReferral({ source: "Facebook" })).toBe(true);
    expect(isMetaReferral({ source: " IG " })).toBe(true);
    expect(isMetaReferral({ source: "instagram_facebook" })).toBe(true);
  });

  it("recognises the referring URLs Meta actually sends", () => {
    expect(isMetaReferral({ referrerUrl: "https://l.instagram.com/?u=https%3A%2F%2Fshop.com" })).toBe(
      true,
    );
    expect(isMetaReferral({ referrerUrl: "https://m.facebook.com/" })).toBe(true);
    expect(isMetaReferral({ referrerUrl: "https://lm.facebook.com/l.php?u=x" })).toBe(true);
    expect(isMetaReferral({ referrerUrl: "http://fb.me/abc" })).toBe(true);
    expect(isMetaReferral({ referrerUrl: "https://www.instagram.com/p/xyz/" })).toBe(true);
  });

  it("recognises utm tagging", () => {
    expect(isMetaReferral({ utmSource: "ig" })).toBe(true);
    expect(isMetaReferral({ utmSource: "fb" })).toBe(true);
    expect(isMetaReferral({ source: "direct", utmSource: "instagram" })).toBe(true);
  });

  it("takes a host-shaped source with no scheme", () => {
    expect(isMetaReferral({ source: "l.instagram.com" })).toBe(true);
  });

  it("is false for every other channel", () => {
    expect(isMetaReferral({ source: "google" })).toBe(false);
    expect(isMetaReferral({ source: "tiktok" })).toBe(false);
    expect(isMetaReferral({ referrerUrl: "https://www.google.com/" })).toBe(false);
    expect(isMetaReferral({ referrerUrl: "https://www.tiktok.com/@x" })).toBe(false);
    expect(isMetaReferral({ utmSource: "newsletter" })).toBe(false);
  });

  it("does not match a lookalike domain", () => {
    // The suffix rule must be host-boundary aware, or a squatter counts as Meta
    // and a real order disappears from the conversions figure.
    expect(isMetaReferral({ referrerUrl: "https://notinstagram.com/" })).toBe(false);
    expect(isMetaReferral({ referrerUrl: "https://myfacebook.com.br/" })).toBe(false);
    expect(isMetaReferral({ source: "facebookads.net" })).toBe(false);
  });

  it("unknown or absent referrer is NOT Meta — it stays a conversion", () => {
    expect(isMetaReferral(null)).toBe(false);
    expect(isMetaReferral(undefined)).toBe(false);
    expect(isMetaReferral({})).toBe(false);
    expect(isMetaReferral({ source: "", referrerUrl: null, utmSource: undefined })).toBe(false);
    expect(isMetaReferral({ source: "direct" })).toBe(false);
  });
});
