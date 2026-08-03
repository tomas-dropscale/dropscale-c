/**
 * Pure arithmetic for the agency's manual weekly billing flow.
 *
 * The client pays Google directly. Dropscale therefore invoices exactly one
 * thing: the agency fee over the Google Ads spend recorded for a closed
 * Monday-to-Sunday week. The list fee is 10%; an immutable, admin-approved
 * referral term can reduce it by 0.5 percentage points per referral, down to
 * 0%. Spend is evidence only and is never itself added to the amount owed.
 */

import type { InvoiceLine } from "@/lib/supabase/types";

/** How long a client has to pay a manually issued invoice. */
export const DAYS_UNTIL_DUE = 7;

/** Weeks offered to the admin for review, newest first. */
export const BACKFILL_WEEKS = 8;

/** Standard list fee before an approved manual-referral term. */
export const AGENCY_FEE_RATE = 10;
export const REFERRAL_STEP_RATE = 0.5;
export const BILLING_CURRENCY = "EUR" as const;
export const CALCULATION_VERSION =
  "agency-fee-eur-v3-manual-referrals-google-boundaries";
export const LEGACY_MANUAL_CALCULATION_VERSION =
  "agency-fee-eur-10-v2-google-baseline";

export function isManualAgencyCalculationVersion(value: string): boolean {
  return value === CALCULATION_VERSION || value === LEGACY_MANUAL_CALCULATION_VERSION;
}
const BILLING_TIME_ZONE = "Europe/Lisbon";

/**
 * Round to euro cents with the same half-away-from-zero rule as PostgreSQL
 * `round(numeric, 2)`. Scaling a decimal such as 10.075 can land one binary ULP
 * below the half-cent in JavaScript, so compensate only for that representation
 * error; values genuinely below the half-cent remain below it.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value * 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const cents =
    scaled < 0
      ? Math.ceil(scaled - tolerance - 0.5)
      : Math.floor(scaled + tolerance + 0.5);
  return cents / 100;
}

/**
 * Google reports cost as integer micros. Rebuild that integer representation
 * before summing so seven binary floating-point additions cannot move an exact
 * half-cent across PostgreSQL's rounding boundary.
 */
export function sumGoogleSpend(values: number[]): number {
  let totalMicros = 0;
  for (const value of values) {
    const micros = Math.round(Math.max(0, value) * 1_000_000);
    if (!Number.isSafeInteger(micros) || !Number.isSafeInteger(totalMicros + micros)) {
      throw new RangeError("Google spend exceeds the safe integer-micros range.");
    }
    totalMicros += micros;
  }
  return totalMicros / 1_000_000;
}

// ---------------------------------------------------------------------------
// Week maths - Monday is day 1
// ---------------------------------------------------------------------------

export function isoDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BILLING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday of the week `date` falls in. */
export function mondayOf(date: Date): string {
  const localDay = isoDay(date);
  const copy = new Date(`${localDay}T00:00:00.000Z`);
  const weekday = (copy.getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(localDay, -weekday);
}

/**
 * Every fully closed Monday-to-Sunday week, newest first. The current week is
 * intentionally absent: its Google spend can still move.
 */
export function closedWeeks(
  now = new Date(),
  count = BACKFILL_WEEKS,
): { start: string; end: string }[] {
  const thisMonday = mondayOf(now);
  return Array.from({ length: count }, (_, index) => {
    const start = addDays(thisMonday, -7 * (index + 1));
    return { start, end: addDays(start, 6) };
  });
}

/**
 * Validate any fully closed Monday-to-Sunday week. The dashboard may show a
 * compact recent picker, but an operational delay must never make older
 * unbilled evidence impossible to refresh or settle.
 */
export function closedWeekStarting(
  periodStart: string,
  now = new Date(),
): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return null;
  const [year, month, day] = periodStart.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== periodStart || parsed.getUTCDay() !== 1) {
    return null;
  }
  const end = addDays(periodStart, 6);
  return end < isoDay(now) ? { start: periodStart, end } : null;
}

// ---------------------------------------------------------------------------
// Fee lines
// ---------------------------------------------------------------------------

export type StoreTotals = {
  /** Post-boundary Google spend paid directly by the client. Fee base only. */
  spend: number;
  /** Raw Google total before excluding either same-day counter. */
  sourceSpend?: number;
  /** Opening counter excluded in the account's first partial week. */
  baselineDeduction?: number;
  /** True in the one invoice period that contains the account's start day. */
  openingBaselineApplied?: boolean;
  billingStart?: {
    id: string;
    date: string;
    capturedAt: string;
    timeZone: string;
    baselineAmount: number;
  };
  /** Spend after the closing counter, excluded in the final partial week. */
  endDeduction?: number;
  /** True in the one invoice period that contains the account's end day. */
  endingCapApplied?: boolean;
  billingEnd?: {
    id: string;
    date: string;
    capturedAt: string;
    timeZone: string;
    counterAmount: number;
  };
  /** Monday/Sunday labels used by first/final partial invoice evidence. */
  periodStart?: string;
  periodEnd?: string;
  /** Count sealed into the effective manual-referral term for this week. */
  referralCount: number;
  currency: string | null;
};

export function emptyTotals(): StoreTotals {
  return { spend: 0, referralCount: 0, currency: null };
}

/** The sealed fee rate represented by an approved referral count. */
export function referralFeeTerms(referralCount: number): {
  referralCount: number;
  referralDiscountRate: number;
  feeRate: number;
} {
  if (!Number.isSafeInteger(referralCount) || referralCount < 0) {
    throw new RangeError("Referral count must be a non-negative whole number.");
  }
  const referralDiscountRate = Math.min(
    AGENCY_FEE_RATE,
    referralCount * REFERRAL_STEP_RATE,
  );
  return {
    referralCount,
    referralDiscountRate,
    feeRate: AGENCY_FEE_RATE - referralDiscountRate,
  };
}

/** A sealed percentage of Google spend, rounded once per store to euro cents. */
export function agencyFee(spend: number, rate = AGENCY_FEE_RATE): number {
  if (!Number.isFinite(rate) || rate < 0 || rate > AGENCY_FEE_RATE) {
    throw new RangeError(`Agency fee rate must be between 0 and ${AGENCY_FEE_RATE}.`);
  }
  return round2((Math.max(0, spend) * rate) / 100);
}

function exactRate(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

function capturedAt(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new RangeError("Invalid billing boundary time.");
  return parsed.toISOString();
}

/**
 * Build the single billable line for a store.
 *
 * `baseAmount` preserves the informational Google spend in the immutable
 * snapshot without turning it into a payable line. Older portal code can
 * ignore that optional field and still render the fee normally.
 */
export function storeLines(accountId: string, store: string, totals: StoreTotals): InvoiceLine[] {
  if (totals.currency?.toUpperCase() !== BILLING_CURRENCY) {
    throw new RangeError("Agency invoice lines require EUR Google spend.");
  }
  if (totals.openingBaselineApplied && (!totals.billingStart || !totals.periodEnd)) {
    throw new RangeError("Opening-boundary evidence is incomplete.");
  }
  if (totals.endingCapApplied && (!totals.billingEnd || !totals.periodStart)) {
    throw new RangeError("Closing-boundary evidence is incomplete.");
  }

  const preciseSpend = Math.max(0, totals.spend);
  const spend = round2(preciseSpend);
  const sourceSpendExact = Math.max(0, totals.sourceSpend ?? preciseSpend);
  const sourceSpend = round2(sourceSpendExact);
  const baselineDeduction = round2(
    Math.max(0, Math.min(sourceSpend, totals.baselineDeduction ?? 0)),
  );
  const baselineDeductionExact = Math.max(
    0,
    Math.min(sourceSpendExact, totals.baselineDeduction ?? 0),
  );
  const remainingAfterOpening = Math.max(0, sourceSpendExact - baselineDeductionExact);
  const endDeductionExact = Math.max(
    0,
    Math.min(remainingAfterOpening, totals.endDeduction ?? 0),
  );
  const endDeduction = round2(endDeductionExact);
  const expectedSpend = Math.max(
    0,
    sourceSpendExact - baselineDeductionExact - endDeductionExact,
  );
  if (Math.abs(expectedSpend - preciseSpend) > 0.0000005) {
    throw new RangeError("Billable spend does not match its Google boundary deductions.");
  }

  // A raw Google day that is consumed entirely by the immutable opening or
  // closing boundary is evidence, but it is not billable spend. Keep that
  // evidence on the boundary records and do not manufacture a settlement
  // line. Positive billable spend can still produce a zero-value line when a
  // manual referral term reduces the agency rate to 0%.
  if (preciseSpend <= 0) return [];

  const { referralCount, referralDiscountRate, feeRate } = referralFeeTerms(
    totals.referralCount,
  );
  const fee = agencyFee(preciseSpend, feeRate);

  const billingStartedAt = capturedAt(totals.billingStart?.capturedAt, "unknown time");
  const billingEndedAt = capturedAt(totals.billingEnd?.capturedAt, "unknown time");
  const referralEvidence =
    `; manual referral term: approved referral count ${referralCount}` +
    `; ${AGENCY_FEE_RATE}% - ${exactRate(referralDiscountRate)} percentage points = ${exactRate(feeRate)}%`;
  let boundaryEvidence = "";
  if (totals.openingBaselineApplied && totals.endingCapApplied) {
    boundaryEvidence =
      `; billing started ${billingStartedAt}` +
      `; billing ended ${billingEndedAt}` +
      ` at Google day counter EUR ${(totals.billingEnd?.counterAmount ?? 0).toFixed(6)}` +
      `; billable period ${totals.billingStart?.date ?? "unknown"}` +
      ` to ${totals.billingEnd?.date ?? "unknown"}` +
      ` in ${totals.billingEnd?.timeZone ?? "unknown timezone"}` +
      `; Google-reported spend EUR ${sourceSpendExact.toFixed(6)}` +
      ` minus opening baseline EUR ${baselineDeductionExact.toFixed(6)}` +
      ` minus post-service spend EUR ${endDeductionExact.toFixed(6)}`;
  } else if (totals.openingBaselineApplied) {
    boundaryEvidence =
      `; billing started ${billingStartedAt}` +
      `; first billable period ${totals.billingStart?.date ?? "unknown"}` +
      ` to ${totals.periodEnd ?? "unknown"}` +
      ` in ${totals.billingStart?.timeZone ?? "unknown timezone"}` +
      `; Google-reported spend EUR ${sourceSpendExact.toFixed(6)}` +
      ` minus opening baseline EUR ${baselineDeductionExact.toFixed(6)}`;
  } else if (totals.endingCapApplied) {
    boundaryEvidence =
      `; billing ended ${billingEndedAt}` +
      ` at Google day counter EUR ${(totals.billingEnd?.counterAmount ?? 0).toFixed(6)}` +
      `; final billable period ${totals.periodStart ?? "unknown"}` +
      ` to ${totals.billingEnd?.date ?? "unknown"}` +
      ` in ${totals.billingEnd?.timeZone ?? "unknown timezone"}` +
      `; Google-reported spend EUR ${sourceSpendExact.toFixed(6)}` +
      ` minus post-service spend EUR ${endDeductionExact.toFixed(6)}`;
  }

  return [
    {
      accountId,
      kind: "fee",
      store,
      rate: feeRate,
      listRate: AGENCY_FEE_RATE,
      referralDiscountRate,
      referralCount,
      baseAmount: spend,
      sourceGrossAmount: sourceSpend,
      ...(totals.openingBaselineApplied
        ? { baselineDeductionAmount: baselineDeduction }
        : {}),
      ...(totals.billingStart
        ? {
            billingStartId: totals.billingStart.id,
            billingStartDate: totals.billingStart.date,
            // Preserve PostgreSQL's full timestamp precision in the immutable
            // evidence field; only the human label is normalised to millis.
            billingStartedAt: totals.billingStart.capturedAt,
            billingTimeZone: totals.billingStart.timeZone,
            billingStartBaselineAmount: round2(totals.billingStart.baselineAmount),
          }
        : {}),
      ...(totals.endingCapApplied && totals.billingEnd
        ? {
            endDeductionAmount: endDeduction,
            endingCapApplied: true,
            billingEndCounterAmount: round2(totals.billingEnd.counterAmount),
            billingEndId: totals.billingEnd.id,
            billingEndDate: totals.billingEnd.date,
            billingEndedAt: totals.billingEnd.capturedAt,
            billingEndTimeZone: totals.billingEnd.timeZone,
          }
        : {}),
      label:
        `${store} - Google Ads agency fee (${exactRate(feeRate)}% of captured Google-reported billable spend: ` +
        `EUR ${preciseSpend.toFixed(6)}${referralEvidence}${boundaryEvidence})`,
      amount: fee,
    },
  ];
}

/** EUR is mandatory; a fallback would silently relabel foreign spend. */
export function billingCurrency(currencies: Set<string>): typeof BILLING_CURRENCY | null {
  const normalised = new Set([...currencies].map((currency) => currency.toUpperCase()));
  return normalised.size === 1 && normalised.has(BILLING_CURRENCY) ? BILLING_CURRENCY : null;
}
