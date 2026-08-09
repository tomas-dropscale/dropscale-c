import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../google-ads/client", () => ({ searchGoogleAdsAsAgency: vi.fn() }));

import {
  backfilledWindowStart,
  billableGoogleMicros,
  billableGoogleSpendWindow,
  billingBoundaryMicros,
  canonicalEuroMicros,
  completeGoogleMicrosWindow,
  eurosToMicros,
  matchesAuthoritativeGoogleSpend,
  manualReferralRateForDate,
  microsToEuroNumber,
  needsGoogleLedgerRewrite,
} from "./commission-sync-logic";

describe("manual referral rates", () => {
  const base = {
    effectiveFrom: "2026-08-03",
    revision: 1,
    referralCount: 2,
    listRate: 10,
    stepRate: 0.5,
    discountRate: 1,
    feeRate: 9,
  };

  it("uses 10% before the effective Monday and the manual rate from Monday onward", () => {
    expect(manualReferralRateForDate("2026-08-02", [base])).toBe(10);
    expect(manualReferralRateForDate("2026-08-03", [base])).toBe(9);
    expect(manualReferralRateForDate("2026-08-09", [base])).toBe(9);
  });

  it("uses the latest revision without applying a future Monday early", () => {
    const revision = {
      ...base,
      revision: 2,
      referralCount: 3,
      discountRate: 1.5,
      feeRate: 8.5,
    };
    const future = {
      ...base,
      effectiveFrom: "2026-08-10",
      referralCount: 4,
      discountRate: 2,
      feeRate: 8,
    };

    expect(manualReferralRateForDate("2026-08-09", [base, revision, future])).toBe(8.5);
    expect(manualReferralRateForDate("2026-08-10", [base, revision, future])).toBe(8);
  });

  it("fails closed on a term whose stored arithmetic is inconsistent", () => {
    expect(() =>
      manualReferralRateForDate("2026-08-03", [{ ...base, feeRate: 8.99 }]),
    ).toThrow("Invalid sealed manual referral term");
  });
});

describe("completeGoogleMicrosWindow", () => {
  it("fills omitted Google Ads days with an exact zero", () => {
    expect(
      completeGoogleMicrosWindow("2026-07-20", "2026-07-22", [
        { date: "2026-07-20", costMicros: "125400000" },
        { date: "2026-07-22", costMicros: "90000000" },
      ]),
    ).toEqual([
      { date: "2026-07-20", costMicros: "125400000" },
      { date: "2026-07-21", costMicros: "0" },
      { date: "2026-07-22", costMicros: "90000000" },
    ]);
  });

  it("crosses month boundaries without the server timezone", () => {
    expect(completeGoogleMicrosWindow("2026-07-31", "2026-08-01", [])).toEqual([
      { date: "2026-07-31", costMicros: "0" },
      { date: "2026-08-01", costMicros: "0" },
    ]);
  });
});

describe("immutable billing baseline", () => {
  const start = {
    googleLocalDate: "2026-07-21",
    baselineCostMicros: "100000001",
  };

  it("bills only Thursday's post-signup delta, then Friday through Sunday in full", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-03",
        "2026-08-09",
        [
          { date: "2026-08-03", costMicros: "11000000" },
          { date: "2026-08-04", costMicros: "22000000" },
          { date: "2026-08-05", costMicros: "33000000" },
          { date: "2026-08-06", costMicros: "125000000" },
          { date: "2026-08-07", costMicros: "41000000" },
          { date: "2026-08-08", costMicros: "52000000" },
          { date: "2026-08-09", costMicros: "63000000" },
        ],
        {
          googleLocalDate: "2026-08-06",
          baselineCostMicros: "100000000",
        },
      ),
    ).toEqual([
      {
        date: "2026-08-06",
        rawCostMicros: "125000000",
        billableCostMicros: "25000000",
      },
      {
        date: "2026-08-07",
        rawCostMicros: "41000000",
        billableCostMicros: "41000000",
      },
      {
        date: "2026-08-08",
        rawCostMicros: "52000000",
        billableCostMicros: "52000000",
      },
      {
        date: "2026-08-09",
        rawCostMicros: "63000000",
        billableCostMicros: "63000000",
      },
    ]);
  });

  it("bills only Sunday's post-signup delta when tracking starts on Sunday", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-03",
        "2026-08-09",
        [
          { date: "2026-08-03", costMicros: "11000000" },
          { date: "2026-08-08", costMicros: "52000000" },
          { date: "2026-08-09", costMicros: "63000000" },
        ],
        {
          googleLocalDate: "2026-08-09",
          baselineCostMicros: "58000000",
        },
      ),
    ).toEqual([
      {
        date: "2026-08-09",
        rawCostMicros: "63000000",
        billableCostMicros: "5000000",
      },
    ]);
  });

  it("excludes earlier days, subtracts only the first day and keeps later days whole", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-20",
        "2026-07-23",
        [
          { date: "2026-07-20", costMicros: "90000000" },
          { date: "2026-07-21", costMicros: "125000003" },
          { date: "2026-07-22", costMicros: "50000007" },
        ],
        start,
      ),
    ).toEqual([
      {
        date: "2026-07-21",
        rawCostMicros: "125000003",
        billableCostMicros: "25000002",
      },
      {
        date: "2026-07-22",
        rawCostMicros: "50000007",
        billableCostMicros: "50000007",
      },
      { date: "2026-07-23", rawCostMicros: "0", billableCostMicros: "0" },
    ]);
  });

  it("keeps the raw restated counter but floors a below-baseline fee base at zero", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-21",
        "2026-07-21",
        [{ date: "2026-07-21", costMicros: "99000000" }],
        start,
      ),
    ).toEqual([
      {
        date: "2026-07-21",
        rawCostMicros: "99000000",
        billableCostMicros: "0",
      },
    ]);
  });

  it("returns no financial days for a period wholly before the start", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-13",
        "2026-07-19",
        [{ date: "2026-07-19", costMicros: "1000000" }],
        start,
      ),
    ).toEqual([]);
  });

  it("preserves a huge raw counter and delta without floating-point loss", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-21",
        "2026-07-21",
        [{ date: "2026-07-21", costMicros: "9007199254740993123" }],
        {
          googleLocalDate: "2026-07-21",
          baselineCostMicros: "9007199254740993000",
        },
      ),
    ).toEqual([
      {
        date: "2026-07-21",
        rawCostMicros: "9007199254740993123",
        billableCostMicros: "123",
      },
    ]);
  });

  it("keeps the raw final-day spend but caps its billable base at the end counter", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-03",
        "2026-08-09",
        [
          { date: "2026-08-05", costMicros: "30000000" },
          { date: "2026-08-06", costMicros: "150000000" },
          { date: "2026-08-07", costMicros: "90000000" },
        ],
        { googleLocalDate: "2026-08-05", baselineCostMicros: "10000000" },
        { googleLocalDate: "2026-08-06", endCostMicros: "100000000" },
      ),
    ).toEqual([
      {
        date: "2026-08-05",
        rawCostMicros: "30000000",
        billableCostMicros: "20000000",
      },
      {
        date: "2026-08-06",
        rawCostMicros: "150000000",
        billableCostMicros: "100000000",
      },
    ]);
  });

  it("subtracts the opening counter after applying a same-day end cap", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-06",
        "2026-08-09",
        [{ date: "2026-08-06", costMicros: "150000000" }],
        { googleLocalDate: "2026-08-06", baselineCostMicros: "40000000" },
        { googleLocalDate: "2026-08-06", endCostMicros: "100000000" },
      ),
    ).toEqual([
      {
        date: "2026-08-06",
        rawCostMicros: "150000000",
        billableCostMicros: "60000000",
      },
    ]);
  });

  it("keeps raw weekly spend and records the closing cap as a separate deduction", () => {
    expect(
      billingBoundaryMicros({
        sourceMicros: BigInt(180_000_000),
        startDayMicros: BigInt(30_000_000),
        baselineMicros: "10000000",
        openingApplied: true,
        endDayMicros: BigInt(150_000_000),
        endCostMicros: "100000000",
        endingApplied: true,
      }),
    ).toEqual({
      openingDeductionMicros: BigInt(10_000_000),
      endDeductionMicros: BigInt(50_000_000),
      billableMicros: BigInt(120_000_000),
    });
  });

  it("uses the capped value before the baseline when start and end share a day", () => {
    expect(
      billingBoundaryMicros({
        sourceMicros: BigInt(150_000_000),
        startDayMicros: BigInt(150_000_000),
        baselineMicros: "40000000",
        openingApplied: true,
        endDayMicros: BigInt(150_000_000),
        endCostMicros: "100000000",
        endingApplied: true,
        sameBoundaryDay: true,
      }),
    ).toEqual({
      openingDeductionMicros: BigInt(40_000_000),
      endDeductionMicros: BigInt(50_000_000),
      billableMicros: BigInt(60_000_000),
    });
  });

  it("exposes stable exact helpers to the invoice path", () => {
    expect(eurosToMicros("1.045001")).toBe(BigInt(1_045_001));
    expect(canonicalEuroMicros(1.045)).toBe("1.045000");
    expect(microsToEuroNumber("1045000")).toBe(1.045);
    expect(billableGoogleMicros("90", "2026-07-20", "2026-07-21", "100")).toBe(BigInt(0));
    expect(billableGoogleMicros("125", "2026-07-21", "2026-07-21", "100")).toBe(BigInt(25));
    expect(billableGoogleMicros("125", "2026-07-22", "2026-07-21", "100")).toBe(BigInt(125));
  });
});

describe("needsGoogleLedgerRewrite", () => {
  const next = {
    grossAmount: "100.000001",
    amount: "10.000000",
    rate: 10,
    currency: "EUR",
  };

  it("re-confirms a row even when its arithmetic is unchanged", () => {
    expect(needsGoogleLedgerRewrite({ ...next, status: "pending" }, next)).toBe(true);
  });

  it("leaves an already-confirmed exact row untouched", () => {
    expect(needsGoogleLedgerRewrite({ ...next, status: "confirmed" }, next)).toBe(false);
  });

  it("detects a one-micro raw restatement or a first-day fee-base change", () => {
    expect(
      needsGoogleLedgerRewrite(
        { ...next, status: "confirmed" },
        { ...next, grossAmount: "100.000002" },
      ),
    ).toBe(true);
    expect(
      needsGoogleLedgerRewrite(
        { ...next, status: "confirmed" },
        { ...next, amount: "0.000000" },
      ),
    ).toBe(true);
  });
});

describe("matchesAuthoritativeGoogleSpend", () => {
  const google = [
    {
      date: "2026-07-20",
      rawCostMicros: "1045001",
      billableCostMicros: "1",
    },
    { date: "2026-07-21", rawCostMicros: "0", billableCostMicros: "0" },
  ];

  it("compares the raw first-day counter, not its much smaller billable delta", () => {
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [{ occurred_on: "2026-07-20", gross_amount: "1.045001", currency: "EUR" }],
        "EUR",
      ),
    ).toBe(true);
  });

  it("allows an omitted zero day but requires every positive raw day", () => {
    expect(matchesAuthoritativeGoogleSpend(google, [], "EUR")).toBe(false);
    expect(
      matchesAuthoritativeGoogleSpend(
        [{ date: "2026-07-21", rawCostMicros: "0", billableCostMicros: "0" }],
        [],
        "EUR",
      ),
    ).toBe(true);
  });

  it("rejects a one-micro stale value, foreign currency or unexpected day", () => {
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [{ occurred_on: "2026-07-20", gross_amount: "1.045000", currency: "EUR" }],
        "EUR",
      ),
    ).toBe(false);
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [{ occurred_on: "2026-07-20", gross_amount: "1.045001", currency: "USD" }],
        "EUR",
      ),
    ).toBe(false);
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [{ occurred_on: "2026-07-22", gross_amount: "1.045001", currency: "EUR" }],
        "EUR",
      ),
    ).toBe(false);
  });
});

describe("backfilledWindowStart", () => {
  const rollingFrom = "2026-08-03";

  it("reaches back to the immutable start when nothing has been proven yet", () => {
    // An account onboarded a week before its first successful sync: the
    // rolling window alone would never ask for those days again.
    expect(
      backfilledWindowStart({
        rollingFrom,
        coveredFrom: null,
        billingStart: "2026-07-23",
        maxBackfillDays: 21,
      }),
    ).toBe("2026-07-23");
  });

  it("stops at the budget instead of asking for an unbounded history", () => {
    expect(
      backfilledWindowStart({
        rollingFrom,
        coveredFrom: null,
        billingStart: "2026-01-01",
        maxBackfillDays: 21,
      }),
    ).toBe("2026-07-13");
  });

  it("closes the hole in front of proven coverage", () => {
    expect(
      backfilledWindowStart({
        rollingFrom,
        coveredFrom: "2026-07-27",
        billingStart: "2026-07-23",
        maxBackfillDays: 21,
      }),
    ).toBe("2026-07-23");
  });

  it("leaves the rolling window alone once the start is already covered", () => {
    expect(
      backfilledWindowStart({
        rollingFrom,
        coveredFrom: "2026-07-20",
        billingStart: "2026-07-23",
        maxBackfillDays: 21,
      }),
    ).toBe(rollingFrom);
  });

  it("never reads before the immutable start", () => {
    // Nothing before the start is billable, so asking would only spend
    // requests and invite pre-start rows back into the ledger.
    expect(
      backfilledWindowStart({
        rollingFrom,
        coveredFrom: "2026-07-25",
        billingStart: "2026-08-05",
        maxBackfillDays: 21,
      }),
    ).toBe(rollingFrom);
  });

  it("rejects a nonsensical budget rather than guessing", () => {
    expect(() =>
      backfilledWindowStart({
        rollingFrom,
        billingStart: "2026-07-23",
        maxBackfillDays: -1,
      }),
    ).toThrow(/whole number of days/i);
  });
});
