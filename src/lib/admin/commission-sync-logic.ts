import {
  addIsoDays,
  billableMicrosSinceBaseline,
  decimalToMicros,
  googleLocalDate,
  microsToDecimal,
  parseGoogleMicros,
  type RawGoogleSpendDay,
} from "../google-ads/billing-start";

export type ManualReferralRateTerm = {
  effectiveFrom: string;
  revision: number;
  referralCount: number;
  listRate: number;
  stepRate: number;
  discountRate: number;
  feeRate: number;
};

/** Resolve the append-only manual term in force on an exact Google day. */
export function manualReferralRateForDate(
  date: string,
  terms: ManualReferralRateTerm[],
): number {
  const applicable = terms
    .filter((term) => term.effectiveFrom <= date)
    .sort((left, right) =>
      left.effectiveFrom === right.effectiveFrom
        ? right.revision - left.revision
        : right.effectiveFrom.localeCompare(left.effectiveFrom),
    )[0];
  if (!applicable) return 10;

  const expectedDiscount = Math.min(10, applicable.referralCount * 0.5);
  if (
    !Number.isSafeInteger(applicable.referralCount) ||
    applicable.referralCount < 0 ||
    applicable.listRate !== 10 ||
    applicable.stepRate !== 0.5 ||
    applicable.discountRate !== expectedDiscount ||
    applicable.feeRate !== 10 - expectedDiscount
  ) {
    throw new RangeError("Invalid sealed manual referral term.");
  }
  return applicable.feeRate;
}

/** Stable exact-money helpers shared by sync, preview and issue paths. */
export function eurosToMicros(value: number | string): bigint {
  return decimalToMicros(value);
}

export function microsToEuroNumber(value: bigint | string): number {
  return Number(microsToDecimal(value));
}

export function canonicalEuroMicros(value: number | string): string {
  return microsToDecimal(eurosToMicros(value));
}

export function billableGoogleMicros(
  rawMicros: bigint | string,
  date: string,
  startDate: string,
  baselineMicros: bigint | string,
  end?: { googleLocalDate: string; endCostMicros: bigint | string },
): bigint {
  if (date < startDate || (end && date > end.googleLocalDate)) return BigInt(0);
  const raw = typeof rawMicros === "bigint" ? rawMicros : parseGoogleMicros(rawMicros);
  const capped =
    end && date === end.googleLocalDate
      ? raw < parseGoogleMicros(end.endCostMicros)
        ? raw
        : parseGoogleMicros(end.endCostMicros)
      : raw;
  return date === startDate ? billableMicrosSinceBaseline(capped, baselineMicros) : capped;
}

/** Apply opening and closing counters to already-aggregated raw ledger totals. */
export function billingBoundaryMicros({
  sourceMicros,
  startDayMicros,
  baselineMicros,
  openingApplied,
  endDayMicros = BigInt(0),
  endCostMicros = BigInt(0),
  endingApplied = false,
  sameBoundaryDay = false,
}: {
  sourceMicros: bigint;
  startDayMicros: bigint;
  baselineMicros: bigint | string;
  openingApplied: boolean;
  endDayMicros?: bigint;
  endCostMicros?: bigint | string;
  endingApplied?: boolean;
  sameBoundaryDay?: boolean;
}): {
  openingDeductionMicros: bigint;
  endDeductionMicros: bigint;
  billableMicros: bigint;
} {
  const parsedEndCost = parseGoogleMicros(endCostMicros);
  const cappedEndDayMicros = endingApplied
    ? endDayMicros < parsedEndCost
      ? endDayMicros
      : parsedEndCost
    : endDayMicros;
  const endDeductionMicros = endingApplied
    ? endDayMicros - cappedEndDayMicros
    : BigInt(0);
  const effectiveStartDayMicros = sameBoundaryDay && endingApplied
    ? cappedEndDayMicros
    : startDayMicros;
  const openingDeductionMicros = openingApplied
    ? effectiveStartDayMicros -
      billableMicrosSinceBaseline(effectiveStartDayMicros, baselineMicros)
    : BigInt(0);
  const netMicros = sourceMicros - openingDeductionMicros - endDeductionMicros;

  return {
    openingDeductionMicros,
    endDeductionMicros,
    billableMicros: netMicros > BigInt(0) ? netMicros : BigInt(0),
  };
}

export function isDateAfterInTimeZone(
  date: string,
  at: Date,
  timeZone: string,
): boolean {
  return googleLocalDate(at, timeZone) > date;
}

/** Google can omit a segmented day when its final spend is zero. */
export function completeGoogleMicrosWindow(
  from: string,
  to: string,
  reported: RawGoogleSpendDay[],
): RawGoogleSpendDay[] {
  const byDate = new Map<string, bigint>();
  for (const day of reported) {
    const value = parseGoogleMicros(day.costMicros);
    byDate.set(day.date, (byDate.get(day.date) ?? BigInt(0)) + value);
  }

  const result: RawGoogleSpendDay[] = [];
  for (let date = from; date <= to; date = addIsoDays(date, 1)) {
    result.push({ date, costMicros: (byDate.get(date) ?? BigInt(0)).toString() });
  }
  return result;
}

/**
 * Compatibility helper for non-financial callers/tests that still use euros.
 * Billing itself uses completeGoogleMicrosWindow and never converts via Number.
 */
export function completeSpendWindow(
  from: string,
  to: string,
  reported: { date: string; spend: number }[],
): { date: string; spend: number }[] {
  const byDate = new Map(reported.map((day) => [day.date, day.spend]));
  const result: { date: string; spend: number }[] = [];
  for (let date = from; date <= to; date = addIsoDays(date, 1)) {
    result.push({ date, spend: byDate.get(date) ?? 0 });
  }
  return result;
}

export type BillableGoogleSpendDay = {
  date: string;
  /** Full cumulative Google amount for audit and commissions.gross_amount. */
  rawCostMicros: string;
  /** Fee base: first-day delta, then the full daily amount. */
  billableCostMicros: string;
};

/** Clip a Google window to the immutable start and apply its same-day counter. */
/**
 * Where a routine sync should start reading, given the rolling healing window
 * and what has actually been proven so far.
 *
 * The rolling window alone only ever asked for the last few days, so any day
 * already older than it when the first successful sync ran was never requested
 * again — an account onboarded a week before its first sync silently lost that
 * week. This reaches back towards the immutable start while uncovered days
 * remain, bounded per run so a long gap heals across several runs instead of
 * one oversized request.
 */
export function backfilledWindowStart(input: {
  /** Start of the ordinary rolling window (today minus the healing days). */
  rollingFrom: string;
  /** Earliest day already proven by a completed window, if any. */
  coveredFrom?: string | null;
  /** The account's immutable billing start; nothing before it is ever billable. */
  billingStart: string;
  maxBackfillDays: number;
}): string {
  const { rollingFrom, coveredFrom, billingStart, maxBackfillDays } = input;
  if (!Number.isSafeInteger(maxBackfillDays) || maxBackfillDays < 0) {
    throw new RangeError("The backfill budget must be a whole number of days.");
  }
  // Days before this are already proven; with nothing proven, only the
  // rolling window can be assumed.
  const provenFrom = coveredFrom ?? rollingFrom;
  // Coverage already reaches the immutable start: there is no billable hole.
  if (provenFrom <= billingStart) return rollingFrom;
  // Nothing billable is older than the start, and the rolling window already
  // covers everything after it.
  if (billingStart >= rollingFrom) return rollingFrom;
  const floor = addIsoDays(rollingFrom, -maxBackfillDays);
  return billingStart > floor ? billingStart : floor;
}

export function billableGoogleSpendWindow(
  from: string,
  to: string,
  reported: RawGoogleSpendDay[],
  start: { googleLocalDate: string; baselineCostMicros: string },
  end?: { googleLocalDate: string; endCostMicros: string },
): BillableGoogleSpendDay[] {
  const effectiveTo = end && end.googleLocalDate < to ? end.googleLocalDate : to;
  if (start.googleLocalDate > effectiveTo) return [];
  const effectiveFrom = start.googleLocalDate > from ? start.googleLocalDate : from;
  return completeGoogleMicrosWindow(effectiveFrom, effectiveTo, reported).map((day) => {
    const raw = parseGoogleMicros(day.costMicros);
    const billable = billableGoogleMicros(
      raw,
      day.date,
      start.googleLocalDate,
      start.baselineCostMicros,
      end,
    );
    return {
      date: day.date,
      rawCostMicros: raw.toString(),
      billableCostMicros: billable.toString(),
    };
  });
}

type GoogleLedgerFinancialState = {
  grossAmount: string | number;
  amount: string | number;
  rate: string | number;
  currency: string;
  status: string;
};

function sameDecimal(left: string | number, right: string | number): boolean {
  try {
    return decimalToMicros(left) === decimalToMicros(right);
  } catch {
    return false;
  }
}

function sameRate(left: string | number, right: string | number): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

/** A successful Google read is authoritative for status and exact arithmetic. */
export function needsGoogleLedgerRewrite(
  current: GoogleLedgerFinancialState,
  next: Omit<GoogleLedgerFinancialState, "status">,
): boolean {
  return (
    !sameDecimal(current.grossAmount, next.grossAmount) ||
    !sameDecimal(current.amount, next.amount) ||
    !sameRate(current.rate, next.rate) ||
    current.currency.toUpperCase() !== next.currency.toUpperCase() ||
    current.status !== "confirmed"
  );
}

/**
 * Verify the raw Google counter, not the net first-day fee base. Zero days may
 * be absent, but every positive raw day must have one exact ledger row.
 */
export function matchesAuthoritativeGoogleSpend(
  reported: BillableGoogleSpendDay[],
  ledger: { occurred_on: string; gross_amount: string | number; currency: string }[],
  currency: string,
): boolean {
  const expected = new Map(
    reported.map((day) => [day.date, parseGoogleMicros(day.rawCostMicros)]),
  );
  const present = new Set<string>();

  for (const row of ledger) {
    const expectedMicros = expected.get(row.occurred_on);
    let actualMicros: bigint;
    try {
      actualMicros = decimalToMicros(row.gross_amount);
    } catch {
      return false;
    }
    if (
      expectedMicros === undefined ||
      actualMicros !== expectedMicros ||
      row.currency.toUpperCase() !== currency.toUpperCase() ||
      present.has(row.occurred_on)
    ) {
      return false;
    }
    present.add(row.occurred_on);
  }

  return reported.every((day) => {
    const micros = parseGoogleMicros(day.rawCostMicros);
    return micros === BigInt(0) || present.has(day.date);
  });
}
