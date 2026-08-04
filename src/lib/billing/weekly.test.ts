import { describe, expect, it } from "vitest";
import {
  AGENCY_FEE_RATE,
  BACKFILL_WEEKS,
  BILLING_EVIDENCE_READY_HOUR_UTC,
  BILLING_EVIDENCE_READY_MINUTE_UTC,
  BILLING_CURRENCY,
  agencyFee,
  billingEvidenceIsReady,
  billingEvidenceReadyAt,
  billingCurrency,
  CALCULATION_VERSION,
  closedWeekStarting,
  closedWeeks,
  mondayOf,
  HISTORICAL_ROLLOVER_CALCULATION_VERSION,
  isManualAgencyCalculationVersion,
  referralFeeTerms,
  round2,
  storeLines,
  sumGoogleSpend,
  type StoreTotals,
} from "./weekly";

function totals(over: Partial<StoreTotals> = {}): StoreTotals {
  return { spend: 0, referralCount: 0, currency: BILLING_CURRENCY, ...over };
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

  it("uses Lisbon's calendar day at the UTC summer boundary", () => {
    expect(mondayOf(new Date("2026-08-02T23:30:00.000Z"))).toBe("2026-08-03");
  });
});

describe("closed weeks", () => {
  const now = new Date(2026, 6, 26);
  const weeks = closedWeeks(now, 3);

  it("returns only whole closed Monday-to-Sunday windows", () => {
    expect(weeks).toEqual([
      { start: "2026-07-13", end: "2026-07-19" },
      { start: "2026-07-06", end: "2026-07-12" },
      { start: "2026-06-29", end: "2026-07-05" },
    ]);
    expect(weeks.map((week) => week.start)).not.toContain("2026-07-20");
  });

  it("exposes eight weeks to the admin by default", () => {
    expect(closedWeeks(now)).toHaveLength(BACKFILL_WEEKS);
  });

  it("accepts any fully closed Monday, including operational backfill", () => {
    expect(closedWeekStarting("2026-07-13", now)).toEqual({
      start: "2026-07-13",
      end: "2026-07-19",
    });
    expect(closedWeekStarting("2024-01-01", now)).toEqual({
      start: "2024-01-01",
      end: "2024-01-07",
    });
    expect(closedWeekStarting("2026-07-14", now)).toBeNull();
    expect(closedWeekStarting("2026-07-20", now)).toBeNull();
    expect(closedWeekStarting("2026-02-30", now)).toBeNull();
  });

  it("waits for the Monday Google-settling cutoff before certifying Sunday", () => {
    expect(BILLING_EVIDENCE_READY_HOUR_UTC).toBe(14);
    expect(BILLING_EVIDENCE_READY_MINUTE_UTC).toBe(5);
    expect(billingEvidenceReadyAt("2026-08-02").toISOString()).toBe(
      "2026-08-03T14:05:00.000Z",
    );
    expect(
      billingEvidenceIsReady(
        "2026-08-02",
        new Date("2026-08-03T14:04:59.999Z"),
      ),
    ).toBe(false);
    expect(
      billingEvidenceIsReady(
        "2026-08-02",
        new Date("2026-08-03T14:05:00.000Z"),
      ),
    ).toBe(true);
    expect(() => billingEvidenceReadyAt("2026-02-30")).toThrow(/real date/i);
  });
});

describe("the sealed agency fee", () => {
  it("treats the sealed historical rollover as a fee-only agency invoice", () => {
    expect(isManualAgencyCalculationVersion(CALCULATION_VERSION)).toBe(true);
    expect(
      isManualAgencyCalculationVersion(HISTORICAL_ROLLOVER_CALCULATION_VERSION),
    ).toBe(true);
    expect(isManualAgencyCalculationVersion("legacy")).toBe(false);
  });

  it("starts at ten percent and rounds to euro cents", () => {
    expect(AGENCY_FEE_RATE).toBe(10);
    expect(agencyFee(4_000)).toBe(400);
    expect(agencyFee(33.333)).toBe(3.33);
  });

  it("matches PostgreSQL numeric rounding at binary half-cent edges", () => {
    expect(round2(10.075)).toBe(10.08);
    expect(round2(1.049)).toBe(1.05);
    expect(round2(-10.075)).toBe(-10.08);
    expect(storeLines("acc-1", "Velas", totals({ spend: 10.075 }))).toMatchObject([
      { baseAmount: 10.08, amount: 1.01 },
    ]);
    expect(storeLines("acc-1", "Velas", totals({ spend: 1.049 }))).toMatchObject([
      {
        baseAmount: 1.05,
        amount: 0.1,
        label:
          "Velas - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 1.049000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%)",
      },
    ]);
    expect(agencyFee(10.045)).toBe(1);
    expect(round2(sumGoogleSpend([1.049, 9.026]))).toBe(10.08);
  });

  it("never makes Google spend itself payable", () => {
    const lines = storeLines("acc-1", "Velas", totals({ spend: 4_000 }));

    expect(lines).toEqual([
      {
        accountId: "acc-1",
        kind: "fee",
        store: "Velas",
        rate: 10,
        listRate: 10,
        referralDiscountRate: 0,
        referralCount: 0,
        baseAmount: 4_000,
        sourceGrossAmount: 4_000,
        label:
          "Velas - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 4000.000000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%)",
        amount: 400,
      },
    ]);
    expect(lines.some((line) => line.kind === "spend" || line.kind === "rev_share")).toBe(false);
  });

  it("puts the raw spend, opening baseline and billable delta on the first invoice", () => {
    expect(
      storeLines(
        "acc-1",
        "Velas",
        totals({
          spend: 170,
          sourceSpend: 250,
          baselineDeduction: 80,
          openingBaselineApplied: true,
          billingStart: {
            basis: "observed_google_counter",
            id: "start-1",
            date: "2026-08-06",
            capturedAt: "2026-08-06T14:30:00.123456Z",
            timeZone: "Europe/Lisbon",
            baselineAmount: 80,
          },
          periodEnd: "2026-08-09",
        }),
      ),
    ).toEqual([
      {
        accountId: "acc-1",
        kind: "fee",
        store: "Velas",
        rate: 10,
        listRate: 10,
        referralDiscountRate: 0,
        referralCount: 0,
        baseAmount: 170,
        sourceGrossAmount: 250,
        baselineDeductionAmount: 80,
        billingStartBasis: "observed_google_counter",
        billingStartId: "start-1",
        billingStartDate: "2026-08-06",
        billingStartedAt: "2026-08-06T14:30:00.123456Z",
        billingTimeZone: "Europe/Lisbon",
        billingStartBaselineAmount: 80,
        label:
          "Velas - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 170.000000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%; billing started 2026-08-06T14:30:00.123Z; first billable period 2026-08-06 to 2026-08-09 in Europe/Lisbon; Google-reported spend EUR 250.000000 minus opening baseline EUR 80.000000)",
        amount: 17,
      },
    ]);
  });

  it("records a reviewed full entry day without inventing an opening counter", () => {
    const lines = storeLines(
      "acc-reviewed",
      "Loja histórica",
      totals({
        spend: 96.2,
        sourceSpend: 96.2,
        reviewedFullDayApplied: true,
        billingStart: {
          basis: "reviewed_full_day",
          id: "start-reviewed",
          date: "2026-08-01",
          timeZone: "America/New_York",
          entryDate: "2026-08-02",
          entryTimeZone: "Europe/Lisbon",
          reviewedFullDayBoundaryId: "boundary-reviewed",
          policyVersion:
            "agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2",
          entryDayTreatment: "full-day-inclusive",
        },
        periodEnd: "2026-08-02",
      }),
    );

    expect(lines).toEqual([
      expect.objectContaining({
        billingStartBasis: "reviewed_full_day",
        billingStartId: "start-reviewed",
        billingStartDate: "2026-08-01",
        billingTimeZone: "America/New_York",
        reviewedFullDayBoundaryId: "boundary-reviewed",
        billingPolicyVersion:
          "agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2",
        entryDate: "2026-08-02",
        entryTimeZone: "Europe/Lisbon",
        entryDayTreatment: "full-day-inclusive",
        sourceGrossAmount: 96.2,
        baseAmount: 96.2,
        amount: 9.62,
        label:
          "Loja histórica - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 96.200000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%; billing began under reviewed full-day policy agency-billing-pre-v3-full-google-local-entry-day-commercial-lisbon-v2; full America/New_York Google reporting day 2026-08-01 included; commercial entry 2026-08-02 in Europe/Lisbon; first billable period 2026-08-01 to 2026-08-02; Google-reported spend EUR 96.200000)",
      }),
    ]);
    expect(lines[0]).not.toHaveProperty("billingStartedAt");
    expect(lines[0]).not.toHaveProperty("billingStartBaselineAmount");
    expect(lines[0]).not.toHaveProperty("baselineDeductionAmount");
  });

  it("derives the weekly rate only from the approved referral count", () => {
    expect(referralFeeTerms(1)).toEqual({
      referralCount: 1,
      referralDiscountRate: 0.5,
      feeRate: 9.5,
    });
    expect(referralFeeTerms(20)).toEqual({
      referralCount: 20,
      referralDiscountRate: 10,
      feeRate: 0,
    });
    expect(referralFeeTerms(21)).toEqual({
      referralCount: 21,
      referralDiscountRate: 10,
      feeRate: 0,
    });
    expect(() => referralFeeTerms(-1)).toThrow(/non-negative whole number/i);

    expect(
      storeLines("acc-1", "Velas", totals({ spend: 100, referralCount: 1 })),
    ).toMatchObject([
      {
        rate: 9.5,
        listRate: 10,
        referralDiscountRate: 0.5,
        referralCount: 1,
        amount: 9.5,
        label:
          "Velas - Google Ads agency fee (9.5% of captured Google-reported billable spend: EUR 100.000000; manual referral term: approved referral count 1; 10% - 0.5 percentage points = 9.5%)",
      },
    ]);
  });

  it("keeps zero-value lines as local evidence for a waived week", () => {
    expect(
      storeLines("acc-1", "Velas", totals({ spend: 250, referralCount: 20 })),
    ).toMatchObject([
      {
        rate: 0,
        referralDiscountRate: 10,
        referralCount: 20,
        baseAmount: 250,
        amount: 0,
      },
    ]);

    // A positive rate that rounds below one cent is also settled locally; it
    // must not become billable later after a Google restatement or rate change.
    expect(storeLines("acc-1", "Velas", totals({ spend: 0.04 }))).toMatchObject([
      { rate: 10, baseAmount: 0.04, amount: 0 },
    ]);
  });

  it("puts the raw spend, closing counter and post-service deduction on the final line", () => {
    expect(
      storeLines(
        "acc-1",
        "Velas",
        totals({
          spend: 140,
          sourceSpend: 190,
          endDeduction: 50,
          endingCapApplied: true,
          billingEnd: {
            id: "end-1",
            date: "2026-08-06",
            capturedAt: "2026-08-06T17:15:00.654321Z",
            timeZone: "Europe/Lisbon",
            counterAmount: 140,
          },
          periodStart: "2026-08-03",
          periodEnd: "2026-08-09",
          referralCount: 2,
        }),
      ),
    ).toEqual([
      {
        accountId: "acc-1",
        kind: "fee",
        store: "Velas",
        rate: 9,
        listRate: 10,
        referralDiscountRate: 1,
        referralCount: 2,
        baseAmount: 140,
        sourceGrossAmount: 190,
        endDeductionAmount: 50,
        endingCapApplied: true,
        billingEndCounterAmount: 140,
        billingEndId: "end-1",
        billingEndDate: "2026-08-06",
        billingEndedAt: "2026-08-06T17:15:00.654321Z",
        billingEndTimeZone: "Europe/Lisbon",
        label:
          "Velas - Google Ads agency fee (9% of captured Google-reported billable spend: EUR 140.000000; manual referral term: approved referral count 2; 10% - 1 percentage points = 9%; billing ended 2026-08-06T17:15:00.654Z at Google day counter EUR 140.000000; final billable period 2026-08-03 to 2026-08-06 in Europe/Lisbon; Google-reported spend EUR 190.000000 minus post-service spend EUR 50.000000)",
        amount: 12.6,
      },
    ]);
  });

  it("composes both counters when service starts and ends on the same day", () => {
    expect(
      storeLines(
        "acc-1",
        "Velas",
        totals({
          spend: 20,
          sourceSpend: 150,
          baselineDeduction: 80,
          endDeduction: 50,
          openingBaselineApplied: true,
          endingCapApplied: true,
          billingStart: {
            basis: "observed_google_counter",
            id: "start-1",
            date: "2026-08-06",
            capturedAt: "2026-08-06T09:00:00.111111Z",
            timeZone: "Europe/Lisbon",
            baselineAmount: 80,
          },
          billingEnd: {
            id: "end-1",
            date: "2026-08-06",
            capturedAt: "2026-08-06T17:00:00.222222Z",
            timeZone: "Europe/Lisbon",
            counterAmount: 100,
          },
          periodStart: "2026-08-03",
          periodEnd: "2026-08-09",
        }),
      ),
    ).toMatchObject([
      {
        baseAmount: 20,
        baselineDeductionAmount: 80,
        endDeductionAmount: 50,
        amount: 2,
        label:
          "Velas - Google Ads agency fee (10% of captured Google-reported billable spend: EUR 20.000000; manual referral term: approved referral count 0; 10% - 0 percentage points = 10%; billing started 2026-08-06T09:00:00.111Z; billing ended 2026-08-06T17:00:00.222Z at Google day counter EUR 100.000000; billable period 2026-08-06 to 2026-08-06 in Europe/Lisbon; Google-reported spend EUR 150.000000 minus opening baseline EUR 80.000000 minus post-service spend EUR 50.000000)",
      },
    ]);
  });

  it("fails closed when a line's boundary arithmetic is internally inconsistent", () => {
    expect(() =>
      storeLines(
        "acc-1",
        "Velas",
        totals({ spend: 100, sourceSpend: 120, baselineDeduction: 10 }),
      ),
    ).toThrow(/does not match/i);
  });

  it("does not turn a negative correction into a charge", () => {
    expect(agencyFee(-100)).toBe(0);
  });
});

describe("billingCurrency", () => {
  it("accepts EUR only", () => {
    expect(billingCurrency(new Set(["eur"]))).toBe("EUR");
  });

  it("never relabels foreign or mixed spend as EUR", () => {
    expect(billingCurrency(new Set(["USD"]))).toBeNull();
    expect(billingCurrency(new Set(["EUR", "USD"]))).toBeNull();
    expect(billingCurrency(new Set())).toBeNull();
  });
});
