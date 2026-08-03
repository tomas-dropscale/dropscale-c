import { describe, expect, it } from "vitest";

import {
  manualReferralRateOnDay,
  parseManualReferralRateSchedule,
} from "./referrals";

function point(
  effectiveFrom: string,
  revision: number,
  referralCount: number,
): Record<string, unknown> {
  const discount = Math.min(10, referralCount * 0.5);
  return {
    effective_from: effectiveFrom,
    revision,
    referral_count: referralCount,
    referral_discount_rate: discount.toFixed(2),
    fee_rate: (10 - discount).toFixed(2),
  };
}

describe("manual referral rate schedule", () => {
  it("uses the 10% list rate before the first sealed term", () => {
    const schedule = parseManualReferralRateSchedule([point("2026-08-10", 1, 1)]);

    expect(manualReferralRateOnDay("2026-08-09", schedule)).toBe(10);
    expect(manualReferralRateOnDay("2026-08-10", schedule)).toBe(9.5);
    expect(manualReferralRateOnDay("2026-08-16", schedule)).toBe(9.5);
    expect(manualReferralRateOnDay("2026-01-01", [])).toBe(10);
  });

  it("changes only on the effective Monday and keeps later history stable", () => {
    const schedule = parseManualReferralRateSchedule([
      point("2026-08-03", 1, 1),
      point("2026-08-17", 1, 3),
    ]);

    expect(manualReferralRateOnDay("2026-08-02", schedule)).toBe(10);
    expect(manualReferralRateOnDay("2026-08-03", schedule)).toBe(9.5);
    expect(manualReferralRateOnDay("2026-08-16", schedule)).toBe(9.5);
    expect(manualReferralRateOnDay("2026-08-17", schedule)).toBe(8.5);
  });

  it("selects the highest sealed revision for the same Monday", () => {
    const schedule = parseManualReferralRateSchedule([
      point("2026-08-10", 3, 4),
      point("2026-08-03", 1, 1),
      point("2026-08-10", 1, 2),
      point("2026-08-10", 2, 3),
    ]);

    expect(manualReferralRateOnDay("2026-08-09", schedule)).toBe(9.5);
    expect(manualReferralRateOnDay("2026-08-10", schedule)).toBe(8);
  });

  it("accepts Postgres numeric strings and returns a minimal camel-case DTO", () => {
    expect(parseManualReferralRateSchedule([point("2026-08-03", 2, 20)])).toEqual([
      {
        effectiveFrom: "2026-08-03",
        revision: 2,
        referralCount: 20,
        referralDiscountRate: 10,
        feeRate: 0,
      },
    ]);
  });

  it.each([
    ["a non-array response", null],
    ["an extra private field", [{ ...point("2026-08-03", 1, 1), term_id: "secret" }]],
    ["a non-Monday effective date", [point("2026-08-04", 1, 1)]],
    ["an invalid calendar date", [point("2026-02-30", 1, 1)]],
    ["a fractional revision", [point("2026-08-03", 1.5, 1)]],
    [
      "a formula mismatch",
      [{ ...point("2026-08-03", 1, 1), referral_discount_rate: "9.00" }],
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseManualReferralRateSchedule(value)).toThrow();
  });

  it("rejects malformed metric days instead of guessing a rate", () => {
    expect(() => manualReferralRateOnDay("03/08/2026", [])).toThrow(
      "Invalid Google reporting day",
    );
  });
});
