import { describe, expect, it } from "vitest";
import { closedWeeks, mondayOf, storeLines, type StoreTotals } from "./weekly";

/**
 * The weekly invoice is the ad spend the agency fronted PLUS the fee on it, so
 * these tests pin the two things that decide what a client is charged: which
 * week is billable, and how a week's ledger totals become invoice lines.
 */

function totals(over: Partial<StoreTotals> = {}): StoreTotals {
  return { spend: 0, fee: 0, revShare: 0, revShareBase: 0, currency: "EUR", ...over };
}

describe("mondayOf", () => {
  it.each([
    ["a Monday is its own week start", "2026-07-20", "2026-07-20"],
    ["mid-week rolls back", "2026-07-23", "2026-07-20"],
    ["Sunday belongs to the week that began six days earlier", "2026-07-26", "2026-07-20"],
  ])("%s", (_label, day, expected) => {
    const [y, m, d] = day.split("-").map(Number);
    expect(mondayOf(new Date(y, m - 1, d))).toBe(expected);
  });
});

describe("closedWeeks", () => {
  // Sunday 2026-07-26: the week starting the 20th is still running, and must
  // not be billed — commission for it is still moving.
  const weeks = closedWeeks(new Date(2026, 6, 26), 3);

  it("never includes the week in progress", () => {
    expect(weeks.map((week) => week.start)).not.toContain("2026-07-20");
  });

  it("returns whole Monday→Sunday windows, newest first", () => {
    expect(weeks).toEqual([
      { start: "2026-07-13", end: "2026-07-19" },
      { start: "2026-07-06", end: "2026-07-12" },
      { start: "2026-06-29", end: "2026-07-05" },
    ]);
  });
});

describe("storeLines", () => {
  it("bills the spend at cost and the fee on top, as separate lines", () => {
    const lines = storeLines("acc-1", "Velas", totals({ spend: 4000, fee: 400 }));

    expect(lines).toEqual([
      {
        accountId: "acc-1",
        kind: "spend",
        store: "Velas",
        rate: null,
        label: "Velas — Google Ads spend",
        amount: 4000,
      },
      {
        accountId: "acc-1",
        kind: "fee",
        store: "Velas",
        rate: 10,
        label: "Velas — management fee (10%)",
        amount: 400,
      },
    ]);
  });

  it("adds a rev-share line only when the store has one", () => {
    const withShare = storeLines(
      "acc-1",
      "Velas",
      totals({ spend: 1000, fee: 100, revShareBase: 2200, revShare: 110 }),
    );
    expect(withShare.map((line) => line.kind)).toEqual(["spend", "fee", "rev_share"]);
    expect(withShare[2]).toMatchObject({ rate: 5, amount: 110 });

    const withoutShare = storeLines("acc-1", "Velas", totals({ spend: 1000, fee: 100 }));
    expect(withoutShare.map((line) => line.kind)).toEqual(["spend", "fee"]);
  });

  it("blends the rate over the week rather than assuming it never changed", () => {
    // 3 days at 10% of 1000, then 4 days at 15% of 1000 → 1250 on 7000.
    const lines = storeLines("acc-1", "Velas", totals({ spend: 7000, fee: 1250 }));
    expect(lines[1]).toMatchObject({ rate: 17.9, label: "Velas — management fee (17.9%)" });
  });

  it("drops sub-cent lines, which Stripe would finalise at zero", () => {
    const lines = storeLines("acc-1", "Velas", totals({ spend: 50, fee: 0.004 }));
    expect(lines.map((line) => line.kind)).toEqual(["spend"]);
  });

  it("rounds money to cents", () => {
    const lines = storeLines("acc-1", "Velas", totals({ spend: 33.333, fee: 3.3333 }));
    expect(lines[0].amount).toBe(33.33);
    expect(lines[1].amount).toBe(3.33);
  });

  it("returns nothing for a store with no activity", () => {
    expect(storeLines("acc-1", "Velas", totals())).toEqual([]);
  });

  it("keeps the store name it was billed under, for the snapshot", () => {
    const lines = storeLines("acc-1", "Old Name", totals({ spend: 100, fee: 10 }));
    expect(lines.every((line) => line.store === "Old Name")).toBe(true);
    expect(lines[0].label).toContain("Old Name");
  });
});
