import { afterEach, describe, expect, it, vi } from "vitest";
import { fxDailyRates, rateOn } from "./fx";

/**
 * FX is the load-bearing helper behind the spec's non-negotiable rule
 * (§10/§11①②): currency is converted PER ACCOUNT, never with one shared rate.
 * These tests pin both halves — the pure day-lookup (rateOn) and the series
 * fetch (fxDailyRates) — and prove that summing two accounts in two currencies
 * uses each account's own rate.
 */

/** An ECB-style /from..to response body, matching frankfurter.app's shape. */
function seriesBody(quote: string, byDay: Record<string, number>) {
  return {
    ok: true,
    json: async () => ({
      rates: Object.fromEntries(
        Object.entries(byDay).map(([day, rate]) => [day, { [quote]: rate }]),
      ),
    }),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rateOn — the rate in force on a calendar day", () => {
  // Business days only; the weekend has no ECB fixing.
  const pairs: [string, number][] = [
    ["2026-07-17", 0.00258], // Friday
    ["2026-07-20", 0.00260], // Monday
    ["2026-07-21", 0.00261], // Tuesday
  ];

  it("exact day → that day's rate", () => {
    expect(rateOn(pairs, "2026-07-20")).toBe(0.0026);
  });

  it("weekend/holiday → the latest PRIOR fixing (Saturday uses Friday)", () => {
    expect(rateOn(pairs, "2026-07-18")).toBe(0.00258);
    expect(rateOn(pairs, "2026-07-19")).toBe(0.00258);
  });

  it("a day after the series → the last known rate", () => {
    expect(rateOn(pairs, "2026-08-01")).toBe(0.00261);
  });

  it("a day before any fixing → the earliest known rate, never zero", () => {
    expect(rateOn(pairs, "2026-01-01")).toBe(0.00258);
  });
});

describe("fxDailyRates — parses and sorts an ECB series", () => {
  it("returns sorted [day, rate] pairs for the requested pair", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        seriesBody("EUR", {
          "2026-06-03": 0.0026,
          "2026-06-01": 0.00258, // out of order on the wire
          "2026-06-02": 0.00259,
        }),
      ),
    );

    const pairs = await fxDailyRates("HUF", "EUR", "2026-06-01", "2026-06-03");
    expect(pairs).toEqual([
      ["2026-06-01", 0.00258],
      ["2026-06-02", 0.00259],
      ["2026-06-03", 0.0026],
    ]);
  });

  it("an all-weekend window comes back empty → falls back to /latest", async () => {
    // Distinct currency+dates so this doesn't collide with other tests' cache.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/latest")) {
          return {
            ok: true,
            json: async () => ({ date: "2026-05-08", rates: { EUR: 0.00257 } }),
          } as Response;
        }
        return { ok: true, json: async () => ({ rates: {} }) } as Response; // empty series
      }),
    );

    const pairs = await fxDailyRates("HUF", "EUR", "2026-05-09", "2026-05-10");
    expect(pairs).toEqual([["2026-05-08", 0.00257]]);
    expect(rateOn(pairs, "2026-05-10")).toBe(0.00257);
  });
});

describe("per-account conversion — two currencies never share one rate (§10)", () => {
  it("HUF→EUR and USD→EUR resolve to DIFFERENT rates on the same day", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("from=HUF")) return seriesBody("EUR", { "2026-07-20": 0.0026 });
        if (url.includes("from=USD")) return seriesBody("EUR", { "2026-07-20": 0.92 });
        throw new Error(`unexpected pair: ${url}`);
      }),
    );

    const huf = await fxDailyRates("HUF", "EUR", "2026-07-20", "2026-07-20");
    const usd = await fxDailyRates("USD", "EUR", "2026-07-20", "2026-07-20");

    const day = "2026-07-20";
    expect(rateOn(huf, day)).toBe(0.0026);
    expect(rateOn(usd, day)).toBe(0.92);
    expect(rateOn(huf, day)).not.toBe(rateOn(usd, day));
  });

  it("account A (EUR) + account B (HUF): the total converts B by HUF's rate, not by 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => seriesBody("EUR", { "2026-07-20": 0.0026 })),
    );

    const day = "2026-07-20";

    // Account A reports in EUR — its rollup is already in EUR (rate 1).
    const accountA_profitEur = 66.22;

    // Account B reports in HUF — 130 171 HUF profit on the same day.
    const accountB_profitHuf = 130_171;
    const hufToEur = await fxDailyRates("HUF", "EUR", day, day);
    const accountB_profitEur = accountB_profitHuf * rateOn(hufToEur, day);

    const totalEur = accountA_profitEur + accountB_profitEur;

    // Converting per account: B ≈ 338.44 EUR, total ≈ 404.66 EUR.
    expect(accountB_profitEur).toBeCloseTo(338.44, 2);
    expect(totalEur).toBeCloseTo(404.66, 2);

    // Pitfall ①/②: had we summed HUF onto EUR with a single rate of 1, B's
    // 130 171 would swamp the total — the wrong answer this rule exists to stop.
    const wrongSingleRate = accountA_profitEur + accountB_profitHuf * 1;
    expect(wrongSingleRate).not.toBeCloseTo(totalEur, 0);
  });
});
