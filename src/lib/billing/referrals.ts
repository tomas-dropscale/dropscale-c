/**
 * The affiliate deal's public numbers, sealed financially by migration 0027.
 *
 * A claimed code is attribution only. It never changes a bill. An admin must
 * validate the referred client and schedule an immutable Monday-effective
 * referral term; weekly invoices then pin that exact term and its item rows.
 * These constants let the UI explain the offer. SQL remains the authority for
 * deciding which term applies and what can be issued.
 *
 * Change one and you must change the other. They are kept apart rather than
 * read from the database on every page because a copy that drifts shows the
 * wrong explanation, whereas a rate read from the wrong place bills the wrong
 * amount — and only the second is unrecoverable.
 */

/** Percentage points off the fee per manually approved referral. */
export const REFERRAL_STEP_PCT = 0.5;

/**
 * The fee's floor. Zero: bring in enough approved clients and the management
 * fee disappears entirely — that is the offer, not a rounding edge.
 *
 * A floor limits how far the DISCOUNT goes. It must never be read as a minimum
 * price: 0022 shipped it that way and pushed every store priced below it UP,
 * which is the one direction a pricing bug must never take.
 */
export const REFERRAL_FLOOR_RATE = 0;

/** The standard fee a client starts on, before any referral. */
export const DEFAULT_FEE_RATE = 10;

/** How many referrals it takes to wipe the fee out from the standard rate. */
export const REFERRALS_TO_ZERO = DEFAULT_FEE_RATE / REFERRAL_STEP_PCT;

/**
 * The deliberately small DTO returned by `manual_referral_rate_schedule`.
 * IDs, referred clients, evidence and reviewer data never cross into portal
 * rendering; this is all a historical fee calculation needs.
 */
export type ManualReferralRatePoint = {
  effectiveFrom: string;
  revision: number;
  referralCount: number;
  referralDiscountRate: number;
  feeRate: number;
};

const RATE_SCHEDULE_FIELDS = [
  "effective_from",
  "fee_rate",
  "referral_count",
  "referral_discount_rate",
  "revision",
] as const;

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function numberFromDatabase(value: unknown, field: string): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new Error(`Invalid manual referral rate schedule field: ${field}`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid manual referral rate schedule field: ${field}`);
  }
  return parsed;
}

function isExactHundredth(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}

/**
 * Turns the unknown PostgREST payload into the only DTO portal pages may use.
 * This is intentionally strict: a changed RPC shape or broken commercial
 * invariant must stop the fee display instead of silently repricing history.
 */
export function parseManualReferralRateSchedule(input: unknown): ManualReferralRatePoint[] {
  if (!Array.isArray(input)) {
    throw new Error("Invalid manual referral rate schedule response");
  }

  const seen = new Set<string>();
  const parsed = input.map((value): ManualReferralRatePoint => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid manual referral rate schedule row");
    }

    const row = value as Record<string, unknown>;
    const fields = Object.keys(row).sort();
    if (
      fields.length !== RATE_SCHEDULE_FIELDS.length ||
      fields.some((field, index) => field !== RATE_SCHEDULE_FIELDS[index])
    ) {
      throw new Error("Invalid manual referral rate schedule row shape");
    }

    if (!isIsoDate(row.effective_from)) {
      throw new Error("Invalid manual referral rate schedule effective date");
    }
    const effectiveDate = new Date(`${row.effective_from}T00:00:00.000Z`);
    if (effectiveDate.getUTCDay() !== 1) {
      throw new Error("Manual referral rate schedule dates must be Mondays");
    }

    const revision = numberFromDatabase(row.revision, "revision");
    const referralCount = numberFromDatabase(row.referral_count, "referral_count");
    const referralDiscountRate = numberFromDatabase(
      row.referral_discount_rate,
      "referral_discount_rate",
    );
    const feeRate = numberFromDatabase(row.fee_rate, "fee_rate");

    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Invalid manual referral rate schedule revision");
    }
    if (!Number.isSafeInteger(referralCount) || referralCount < 0) {
      throw new Error("Invalid manual referral rate schedule referral count");
    }
    if (!isExactHundredth(referralDiscountRate) || !isExactHundredth(feeRate)) {
      throw new Error("Invalid manual referral rate schedule precision");
    }

    const expectedDiscount = Math.min(
      DEFAULT_FEE_RATE,
      referralCount * REFERRAL_STEP_PCT,
    );
    const expectedFee = Math.max(REFERRAL_FLOOR_RATE, DEFAULT_FEE_RATE - expectedDiscount);
    if (referralDiscountRate !== expectedDiscount || feeRate !== expectedFee) {
      throw new Error("Invalid manual referral rate schedule formula");
    }

    const key = `${row.effective_from}:${revision}`;
    if (seen.has(key)) {
      throw new Error("Duplicate manual referral rate schedule revision");
    }
    seen.add(key);

    return {
      effectiveFrom: row.effective_from,
      revision,
      referralCount,
      referralDiscountRate,
      feeRate,
    };
  });

  return parsed.sort(
    (left, right) =>
      left.effectiveFrom.localeCompare(right.effectiveFrom) || left.revision - right.revision,
  );
}

/**
 * Historical rate in force on one Google reporting day. Before the first
 * sealed term, the contractual list fee is 10%. If several sealed revisions
 * are supplied for one future Monday, only the highest revision can win.
 */
export function manualReferralRateOnDay(
  day: string,
  schedule: readonly ManualReferralRatePoint[],
): number {
  if (!isIsoDate(day)) {
    throw new Error("Invalid Google reporting day for manual referral rate");
  }

  let effective: ManualReferralRatePoint | null = null;
  for (const point of schedule) {
    if (point.effectiveFrom > day) continue;
    if (
      effective === null ||
      point.effectiveFrom > effective.effectiveFrom ||
      (point.effectiveFrom === effective.effectiveFrom && point.revision > effective.revision)
    ) {
      effective = point;
    }
  }

  return effective?.feeRate ?? DEFAULT_FEE_RATE;
}
