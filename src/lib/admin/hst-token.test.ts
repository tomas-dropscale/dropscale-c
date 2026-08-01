import { describe, expect, it } from "vitest";

import { EXPIRY_MARGIN_MS, parseExpiry, tokenFault, tokenIsFresh } from "./hst-token";

const NOW = Date.parse("2026-08-01T12:00:00Z");

describe("tokenIsFresh", () => {
  it("accepts a token with time left beyond the margin", () => {
    expect(tokenIsFresh(NOW + EXPIRY_MARGIN_MS + 60_000, NOW)).toBe(true);
  });

  it("rejects one already expired", () => {
    expect(tokenIsFresh(NOW - 1, NOW)).toBe(false);
  });

  it("rejects one inside the renewal margin", () => {
    // Still technically valid, but not for long enough to start a sync on.
    expect(tokenIsFresh(NOW + EXPIRY_MARGIN_MS - 1, NOW)).toBe(false);
  });

  it("rejects an UNKNOWN expiry so the caller renews", () => {
    // The regression this module exists for. HST's refresh response often has
    // no `expires`, the column is stored null, and parseExpiry returns 0. The
    // old rule read 0 as "never expires" and the session was used until HST
    // refused it — which is why it had to be re-pasted from F12 by hand.
    expect(tokenIsFresh(0, NOW)).toBe(false);
  });

  it("rejects a negative or nonsense expiry rather than trusting it", () => {
    expect(tokenIsFresh(-1, NOW)).toBe(false);
  });
});

describe("parseExpiry", () => {
  it("reads the ERP's slash format", () => {
    expect(parseExpiry("2026/07/26 20:57:52")).toBe(
      new Date("2026/07/26 20:57:52").getTime(),
    );
  });

  it("reads ISO", () => {
    expect(parseExpiry("2026-07-26T20:57:52Z")).toBe(Date.parse("2026-07-26T20:57:52Z"));
  });

  it("returns 0 for missing or unparseable values", () => {
    // 0 means "unknown", which tokenIsFresh now treats as needing renewal.
    expect(parseExpiry(null)).toBe(0);
    expect(parseExpiry(undefined)).toBe(0);
    expect(parseExpiry("")).toBe(0);
    expect(parseExpiry("not a date")).toBe(0);
  });

  it("does not mangle a dashed date into an invalid one", () => {
    // The replace(/-/g, "/") only fires when there's no "T" — an ISO string
    // must survive intact.
    expect(parseExpiry("2026-07-26T00:00:00.000Z")).toBeGreaterThan(0);
  });
});

describe("tokenFault", () => {
  it("passes a plain ASCII token", () => {
    expect(tokenFault("eyJhbGciOiJIUzI1NiJ9.abc.def")).toBeNull();
  });

  it("catches the DevTools Preview ellipsis and says where it came from", () => {
    const fault = tokenFault("eyJhbGciOi…");
    expect(fault).toContain("truncated");
    expect(fault).toContain("Response tab");
  });

  it("catches any other character that cannot travel in a header", () => {
    // Above U+00FF. Accented Latin like "é" (U+00E9) is NOT a fault — it fits
    // in a byte and a header carries it fine, so the check must let it pass.
    expect(tokenFault("abcd€")).toContain("can't travel in an HTTP header");
  });

  it("allows accented Latin, which does fit in a byte", () => {
    expect(tokenFault("abcdé")).toBeNull();
  });

  it("reports the position of the first bad character", () => {
    expect(tokenFault("abc…def")).toContain("position 3");
  });
});
