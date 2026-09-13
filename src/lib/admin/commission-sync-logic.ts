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

export type AccountCommissionRateTerm = {
  id: string;
  effectiveFrom: string;
  revision: number;
  listRate: number;
};

export type ResolvedAccountCommissionTerms = {
  commissionTermId: string | null;
  pricingMode: "manual" | "referral";
  listRate: number;
  referralCount: number;
  referralDiscountRate: number;
  feeRate: number;
};

function manualReferralTermsForDate(
  date: string,
  terms: ManualReferralRateTerm[],
): ManualReferralRateTerm {
  const applicable = terms
    .filter((term) => term.effectiveFrom <= date)
    .sort((left, right) =>
      left.effectiveFrom === right.effectiveFrom
        ? right.revision - left.revision
        : right.effectiveFrom.localeCompare(left.effectiveFrom),
    )[0];
  if (!applicable) {
    return {
      effectiveFrom: date,
      revision: 0,
      referralCount: 0,
      listRate: 10,
      stepRate: 0.5,
      discountRate: 0,
      feeRate: 10,
    };
  }

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
  return applicable;
}

/** Resolve the append-only manual term in force on an exact Google day. */
export function manualReferralRateForDate(
  date: string,
  terms: ManualReferralRateTerm[],
): number {
  return manualReferralTermsForDate(date, terms).feeRate;
}

function exactHundredth(value: number): boolean {
  const scaled = value * 100;
  return (
    Number.isFinite(value) &&
    Math.abs(Math.round(scaled) - scaled) <=
      Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4
  );
}

/** Resolve one store's immutable Monday term; manual and referral never stack. */
export function accountCommissionTermsForDate(
  date: string,
  accountTerms: AccountCommissionRateTerm[],
  referralTerms: ManualReferralRateTerm[],
): ResolvedAccountCommissionTerms {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError("Invalid account commission date.");
  }
  const applicable = accountTerms
    .filter((term) => term.effectiveFrom <= date)
    .sort((left, right) =>
      left.effectiveFrom === right.effectiveFrom
        ? right.revision - left.revision
        : right.effectiveFrom.localeCompare(left.effectiveFrom),
    )[0];
  const listRate = applicable?.listRate ?? 10;
  if (
    !exactHundredth(listRate) ||
    listRate < 0 ||
    listRate > 100 ||
    (applicable &&
      (!applicable.id ||
        !Number.isSafeInteger(applicable.revision) ||
        applicable.revision < 1 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(applicable.effectiveFrom)))
  ) {
    throw new RangeError("Invalid sealed account commission term.");
  }

  if (listRate !== 10) {
    return {
      commissionTermId: applicable?.id ?? null,
      pricingMode: "manual",
      listRate,
      referralCount: 0,
      referralDiscountRate: 0,
      feeRate: listRate,
    };
  }

  const referral = manualReferralTermsForDate(date, referralTerms);
  return {
    commissionTermId: applicable?.id ?? null,
    pricingMode: "referral",
    listRate,
    referralCount: referral.referralCount,
    referralDiscountRate: referral.discountRate,
    feeRate: referral.feeRate,
  };
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
  const raw =
    typeof rawMicros === "bigint" ? rawMicros : parseGoogleMicros(rawMicros);
  const capped =
    end && date === end.googleLocalDate
      ? raw < parseGoogleMicros(end.endCostMicros)
        ? raw
        : parseGoogleMicros(end.endCostMicros)
      : raw;
  return date === startDate
    ? billableMicrosSinceBaseline(capped, baselineMicros)
    : capped;
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
  const effectiveStartDayMicros =
    sameBoundaryDay && endingApplied ? cappedEndDayMicros : startDayMicros;
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
    result.push({
      date,
      costMicros: (byDate.get(date) ?? BigInt(0)).toString(),
    });
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
export function billableGoogleSpendWindow(
  from: string,
  to: string,
  reported: RawGoogleSpendDay[],
  start: { googleLocalDate: string; baselineCostMicros: string },
  end?: { googleLocalDate: string; endCostMicros: string },
): BillableGoogleSpendDay[] {
  const effectiveTo =
    end && end.googleLocalDate < to ? end.googleLocalDate : to;
  if (start.googleLocalDate > effectiveTo) return [];
  const effectiveFrom =
    start.googleLocalDate > from ? start.googleLocalDate : from;
  return completeGoogleMicrosWindow(effectiveFrom, effectiveTo, reported).map(
    (day) => {
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
    },
  );
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
  return (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber) &&
    leftNumber === rightNumber
  );
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
  ledger: {
    occurred_on: string;
    gross_amount: string | number;
    currency: string;
  }[],
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

export type ReportingBindingDomainRow = {
  id: string;
  ad_account_id: string;
  shopify_connection_id: string | null;
  shopify_anchor_binding_id: string | null;
  status: string;
  bound_at: string | null;
  revoked_at: string | null;
};

/**
 * Newest binding first, compared as INSTANTS rather than as text. Timestamps
 * arrive as whatever the database serialises: fractional digits vary and an
 * offset may be written "+00:00" or as a real zone, so string order is not time
 * order. A missing timestamp sorts oldest instead of throwing the order away,
 * and the id is the last resort so two bindings stamped alike rank the same way
 * twice.
 */
function bindingInstant(value: string | null): number {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newestBindingFirst(
  left: ReportingBindingDomainRow,
  right: ReportingBindingDomainRow,
): number {
  const bound = bindingInstant(right.bound_at) - bindingInstant(left.bound_at);
  if (bound !== 0 && Number.isFinite(bound)) return bound;
  const revoked = bindingInstant(right.revoked_at) - bindingInstant(left.revoked_at);
  if (revoked !== 0 && Number.isFinite(revoked)) return revoked;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/**
 * Which binding says whose spend a Google account carries, and which accounts
 * have lost the store they had.
 *
 * The ledger filters a shared Google account's campaigns down to the store
 * under contract, and it reads that store from the account's binding. A RETIRED
 * source has no live binding left, and its account stays readable on purpose so
 * its own history can still be certified - so the revoked binding it left
 * behind has to answer for the store, or an account shared with a store outside
 * this contract gets billed whole to the one that remains.
 *
 * Three rules keep that fallback honest:
 *  - A LIVE binding always decides, even one that names no store. An account
 *    deliberately bound to no store reads whole; letting a dead store-naming
 *    binding outvote it would filter live spend to a store it left. A STAGED
 *    binding counts as live: a source in flight, not a discarded one.
 *  - A revoked binding only answers when a lifecycle RPC NAMED it in the
 *    append-only anchor events. Row shape is not enough, and this is the rule
 *    that matters most: an ordinary pre-cutover unbind leaves an identical
 *    revoked row on an account still under contract and still billing, and
 *    attributing it to the store it just left would rewrite live commissions
 *    down to campaigns that store no longer runs.
 *  - Among several evidenced revoked bindings - an account can be rebound from
 *    one store to another before it is retired - the most recent one wins. Row
 *    arrival order is not an answer: it decides which store gets billed and it
 *    can differ between two runs of the same query.
 *
 * retiredBoundAccountIds is the other half: an account whose evidenced revoked
 * binding named a store and which has no live binding left. For those, and only
 * those, an empty domain list means "nothing left to attribute this to" rather
 * than "this account was never tied to a store", so the caller must refuse to
 * read instead of billing the whole account. A legacy account with no reporting
 * binding at all, an unallocated source and a plainly unbound account are all
 * outside this set and read exactly as they always did.
 */
export function storeBindingsForLedger(
  rows: readonly ReportingBindingDomainRow[],
  retiredBindingIds: ReadonlySet<string>,
): {
  bindings: ReportingBindingDomainRow[];
  retiredBoundAccountIds: Set<string>;
} {
  const namesStore = (row: ReportingBindingDomainRow) =>
    row.shopify_connection_id !== null || row.shopify_anchor_binding_id !== null;
  const rowsByAccount = new Map<string, ReportingBindingDomainRow[]>();
  for (const row of rows) {
    rowsByAccount.set(row.ad_account_id, [...(rowsByAccount.get(row.ad_account_id) ?? []), row]);
  }

  const bindings: ReportingBindingDomainRow[] = [];
  const retiredBoundAccountIds = new Set<string>();
  for (const [accountId, accountRows] of rowsByAccount) {
    const live = accountRows.filter((row) => row.status === "active" || row.status === "staged");
    const retired = accountRows.filter(
      (row) => row.status === "revoked" && retiredBindingIds.has(row.id),
    );
    const deciding = live.length > 0 ? live : retired;
    const named = deciding.filter(namesStore).sort(newestBindingFirst);
    if (named[0]) bindings.push(named[0]);
    if (live.length === 0 && retired.some(namesStore)) retiredBoundAccountIds.add(accountId);
  }
  return { bindings, retiredBoundAccountIds };
}

/**
 * Whether the source answered with NOTHING for a window the ledger already
 * books money on.
 *
 * Windsor omits the days an account did not spend, so a single absent day is
 * a real zero and may correct a row. A whole window with no rows at all, over
 * days that hold booked spend, is something else: a source that no longer
 * reports the account - closed in Google, forgotten by Windsor, a lapsed
 * grant. Read as "seven days of nothing" it rewrote confirmed money to zero
 * (Viktoria Bratislava, TRÅD & GLÖD, Miguel Casal's 163-954-1537, 2026-09-13).
 * Such a window must fail and leave the rows as they are.
 */
export function sourceWentSilent(
  reportedDays: readonly { date: string }[],
  existingRows: readonly { gross_amount: number | string }[],
): boolean {
  return (
    reportedDays.length === 0 &&
    existingRows.some((row) => Number(row.gross_amount) > 0)
  );
}
