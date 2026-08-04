import { describe, expect, it } from "vitest";

import { currencyScope, displayCurrency } from "./currency";

describe("currencyScope", () => {
  it("uses the shared currency when every store agrees", () => {
    const scope = currencyScope([{ currency: "EUR" }, { currency: "EUR" }]);
    expect(scope).toEqual({ currency: "EUR", currencies: ["EUR"], mixed: false });
  });

  it("refuses to pick one when stores disagree", () => {
    // The whole point: a EUR shop and a GBP shop have no common total, so the
    // caller must not be handed a symbol to print against their sum.
    const scope = currencyScope([{ currency: "EUR" }, { currency: "GBP" }]);
    expect(scope.mixed).toBe(true);
    expect(scope.currency).toBeNull();
    expect(scope.currencies).toEqual(["EUR", "GBP"]);
  });

  it("is not fooled by case or padding", () => {
    // "eur" and "EUR " are the same currency; treating them as two would raise
    // a false alarm on a perfectly consistent account.
    expect(currencyScope([{ currency: "eur" }, { currency: "EUR " }]).mixed).toBe(false);
  });

  it("ignores stores with no currency set", () => {
    const scope = currencyScope([{ currency: "EUR" }, { currency: null }, { currency: "" }]);
    expect(scope.mixed).toBe(false);
    expect(scope.currency).toBe("EUR");
  });

  it("falls back for an empty set — an empty dashboard is not a mixed one", () => {
    expect(currencyScope([])).toEqual({ currency: "EUR", currencies: [], mixed: false });
    expect(currencyScope([], "USD").currency).toBe("USD");
  });

  it("reports every currency present, sorted, for the warning text", () => {
    const scope = currencyScope([
      { currency: "USD" },
      { currency: "EUR" },
      { currency: "GBP" },
      { currency: "EUR" },
    ]);
    expect(scope.currencies).toEqual(["EUR", "GBP", "USD"]);
  });

  it("treats a single store as consistent, whatever it trades in", () => {
    expect(currencyScope([{ currency: "BRL" }])).toEqual({
      currency: "BRL",
      currencies: ["BRL"],
      mixed: false,
    });
  });
});

describe("displayCurrency", () => {
  it("returns the agreed currency", () => {
    expect(displayCurrency(currencyScope([{ currency: "GBP" }]))).toBe("GBP");
  });

  it("falls back to the first currency when mixed, so nothing renders blank", () => {
    const scope = currencyScope([{ currency: "USD" }, { currency: "EUR" }]);
    expect(displayCurrency(scope)).toBe("EUR"); // sorted, so EUR is first
  });

  it("carries the scope's own fallback through, rather than a second default", () => {
    // The fallback belongs to currencyScope. displayCurrency deliberately has
    // none of its own, so there is only one place that decides what an empty
    // set means.
    expect(displayCurrency(currencyScope([], "USD"))).toBe("USD");
  });
});
