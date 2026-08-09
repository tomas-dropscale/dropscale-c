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
export type CoveredWindow = { from: string; to: string };

/** Merge overlapping or touching proven windows into ordered, disjoint spans. */
function mergeCovered(windows: CoveredWindow[]): CoveredWindow[] {
  const sorted = [...windows]
    .filter((window) => window.from <= window.to)
    .sort((left, right) => left.from.localeCompare(right.from));
  const merged: CoveredWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    // Touching counts as continuous: [1..7] and [8..14] leave no unread day.
    if (last && window.from <= addIsoDays(last.to, 1)) {
      if (window.to > last.to) last.to = window.to;
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

/** Whole days between two ISO dates, left inclusive. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The window a routine sync should actually read.
 *
 * The rolling window alone only ever asked for the last few days, so a day
 * already older than it when the first successful sync ran was never requested
 * again — an account onboarded a week before its first sync silently lost that
 * week. Coverage is therefore computed from the PROVEN windows, merged: the
 * earliest completed window's start says nothing about a hole in the middle of
 * the covered range, and treating it as proof let such a hole survive forever.
 *
 * A gap that fits the per-run budget is folded into the ordinary window, so the
 * common onboarding case heals in one run without losing today's numbers. A
 * longer gap is read as its own older chunk instead: the frontier then advances
 * by a whole budget each run, which is what actually converges — anchoring the
 * floor to "today minus the budget" moved forward with the calendar and never
 * reached the missing days at all.
 */
export function backfilledWindow(input: {
  /** Start of the ordinary rolling window (today minus the healing days). */
  rollingFrom: string;
  /** End of the ordinary rolling window, normally the account's local today. */
  rollingTo: string;
  /** Windows already proven complete for this account. */
  covered?: CoveredWindow[];
  /** The account's immutable billing start; nothing before it is billable. */
  billingStart: string;
  maxBackfillDays: number;
}): { from: string; to: string; backfilling: boolean } {
  const { rollingFrom, rollingTo, covered = [], billingStart, maxBackfillDays } = input;
  if (!Number.isSafeInteger(maxBackfillDays) || maxBackfillDays < 1) {
    throw new RangeError("The backfill budget must be a positive whole number of days.");
  }
  const rolling = { from: rollingFrom, to: rollingTo, backfilling: false };
  // Nothing before the start is billable, and the rolling window already holds
  // everything after it.
  if (billingStart >= rollingFrom) return rolling;

  // The first billable day no proven window covers.
  let day = billingStart;
  for (const span of mergeCovered(covered)) {
    if (span.to < day) continue;
    if (span.from > day) break;
    day = addIsoDays(span.to, 1);
  }
  if (day >= rollingFrom) return rolling;

  if (daysBetween(day, rollingFrom) <= maxBackfillDays) {
    // Small hole: widen the ordinary window so today still gets refreshed.
    return { from: day, to: rollingTo, backfilling: true };
  }

  // Long hole: read one older chunk. Recent days are refreshed by the other
  // runs of the day, and each run moves the frontier a whole budget forward.
  const chunkEnd = addIsoDays(day, maxBackfillDays - 1);
  const stopBefore = addIsoDays(rollingFrom, -1);
  return {
    from: day,
    to: chunkEnd < stopBefore ? chunkEnd : stopBefore,
    backfilling: true,
  };
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
