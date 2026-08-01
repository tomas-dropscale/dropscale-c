import { describe, expect, it } from "vitest";

import { clientNameFromShop, normalizeDay } from "./hst-parse";

describe("clientNameFromShop", () => {
  it("takes the last segment, past a code and a merchant name", () => {
    expect(clientNameFromShop("AZL90266-РАЯ НИКОЛОВА-Tomas")).toBe("Tomas");
    expect(clientNameFromShop("AYW98711-椿工房-Caio")).toBe("Caio");
  });

  it("handles a plain two-part shop string", () => {
    expect(clientNameFromShop("AZL90266-Tomas")).toBe("Tomas");
  });

  it("trims whitespace around the separator", () => {
    expect(clientNameFromShop("AZL90266 - Tomas ")).toBe("Tomas");
  });

  it("ignores a trailing separator instead of returning empty", () => {
    expect(clientNameFromShop("AZL90266-Tomas-")).toBe("Tomas");
    expect(clientNameFromShop("AZL90266--Tomas")).toBe("Tomas");
  });

  it("splits on en and em dashes, not only the ASCII hyphen", () => {
    // The regression: ERP text is pasted by humans, and these substitutions are
    // routine. Splitting on "-" alone returned the WHOLE string as the client,
    // which is why some clients appeared to be missing from the list.
    expect(clientNameFromShop("AZL90266–Tomas")).toBe("Tomas");
    expect(clientNameFromShop("AZL90266—Tomas")).toBe("Tomas");
    expect(clientNameFromShop("AZL90266－Tomas")).toBe("Tomas");
    expect(clientNameFromShop("AZL90266‑Tomas")).toBe("Tomas");
  });

  it("returns null when there is nothing usable, rather than a fake name", () => {
    // Callers must label these; folding them into one "Unknown" bucket merged
    // several real clients into a single line.
    expect(clientNameFromShop("")).toBeNull();
    expect(clientNameFromShop(null)).toBeNull();
    expect(clientNameFromShop(undefined)).toBeNull();
    expect(clientNameFromShop("   ")).toBeNull();
    expect(clientNameFromShop("---")).toBeNull();
  });

  it("returns the whole string when there is no separator at all", () => {
    // A shop string with no client tag is still SOMETHING; the caller can see
    // it and recognise it, which a null would deny them.
    expect(clientNameFromShop("AZL90266")).toBe("AZL90266");
  });

  it("reads the real shop strings from the ERP's commission table", () => {
    // Copied from the Personnel Commission Table, so the rule is pinned against
    // production data rather than invented examples. Note the last two: a store
    // name that itself contains a space, and one in Japanese — neither may
    // disturb the client tag at the end.
    expect(clientNameFromShop("AYE19866-Daphne Rhodes-Lourenço")).toBe("Lourenço");
    expect(clientNameFromShop("AXD19877-Stoffwerk Munchen-NBA")).toBe("NBA");
    expect(clientNameFromShop("AYB89166-Zátiší Morava-Diogo")).toBe("Diogo");
    expect(clientNameFromShop("AXX17899-Olivia London-Daniel")).toBe("Daniel");
    expect(clientNameFromShop("AXX17899-Casa Rosita-Daniel")).toBe("Daniel");
    expect(clientNameFromShop("AXX17899-あかり京都-Daniel")).toBe("Daniel");
    expect(clientNameFromShop("AYG98166-Juwelier Elena-Bruno")).toBe("Bruno");
  });

  it("keeps a name that is only part of a hyphenated word", () => {
    // Known limitation, asserted so it is a decision and not a surprise: a
    // client actually called "Ana-Maria" is read as "Maria".
    expect(clientNameFromShop("AZL90266-Ana-Maria")).toBe("Maria");
  });
});

describe("normalizeDay", () => {
  it("accepts an ISO day", () => {
    expect(normalizeDay("2026-07-25")).toBe("2026-07-25");
  });

  it("accepts the ERP's slash form", () => {
    expect(normalizeDay("2026/07/25")).toBe("2026-07-25");
  });

  it("drops the time part", () => {
    expect(normalizeDay("2026-07-25 20:57:52")).toBe("2026-07-25");
    expect(normalizeDay("2026-07-25T20:57:52Z")).toBe("2026-07-25");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDay("  2026-07-25 ")).toBe("2026-07-25");
  });

  it("returns null for anything it cannot read", () => {
    // These rows are counted as dropped rather than sent to Postgres, where one
    // bad date used to fail the whole booking.
    expect(normalizeDay("")).toBeNull();
    expect(normalizeDay("25/07/2026")).toBeNull();
    expect(normalizeDay("not a date")).toBeNull();
    expect(normalizeDay("2026-7-5")).toBeNull();
  });
});
