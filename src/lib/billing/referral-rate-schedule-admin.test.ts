import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/referrals", () => import("./referrals"));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import {
  fetchManualReferralRateScheduleAsAdmin,
  fetchManualReferralRateScheduleAsAdminOrNull,
} from "./referral-rate-schedule";

const CLIENT = "70000000-0000-4000-8000-000000000001";

/** A sealed term as PostgREST returns it: dates as strings, numerics as strings. */
function term(effectiveFrom: string, revision: number, referralCount: number) {
  const discount = Math.min(10, referralCount * 0.5);
  return {
    effective_from: effectiveFrom,
    revision,
    referral_count: referralCount,
    referral_discount_rate: discount.toFixed(2),
    fee_rate: (10 - discount).toFixed(2),
  };
}

/** A query builder that records every filter and resolves to `result` when awaited. */
function session(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[][]> = {};
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "order"]) {
    chain[method] = vi.fn((...args: unknown[]) => {
      (calls[method] ??= []).push(args);
      return chain;
    });
  }
  chain.then = (
    resolve: (value: typeof result) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  const from = vi.fn(() => chain);
  return { client: { from }, from, calls };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("the manual referral rate schedule read by an admin", () => {
  it("reads the client's sealed terms under the admin's own grant, keeping the latest revision of each Monday", async () => {
    // In the order the database returns them: by date, latest revision first.
    const db = session({
      data: [
        term("2026-08-03", 1, 1),
        term("2026-08-10", 3, 4),
        term("2026-08-10", 2, 3),
        term("2026-08-10", 1, 2),
      ],
      error: null,
    });
    mocks.createClient.mockResolvedValue(db.client);

    const schedule = await fetchManualReferralRateScheduleAsAdmin(CLIENT);

    expect(db.from).toHaveBeenCalledWith("referral_discount_terms");
    expect(db.calls.select).toEqual([
      ["effective_from, revision, referral_count, referral_discount_rate, fee_rate"],
    ]);
    expect(db.calls.eq).toEqual([["client_id", CLIENT]]);
    expect(db.calls.not).toEqual([["sealed_at", "is", null]]);
    expect(db.calls.order).toEqual([
      ["effective_from", { ascending: true }],
      ["revision", { ascending: false }],
    ]);
    // The RPC's `distinct on (effective_from)`: revision 3 wins the 10th.
    expect(schedule).toEqual([
      { effectiveFrom: "2026-08-03", revision: 1, referralCount: 1, referralDiscountRate: 0.5, feeRate: 9.5 },
      { effectiveFrom: "2026-08-10", revision: 3, referralCount: 4, referralDiscountRate: 2, feeRate: 8 },
    ]);
  });

  it("is an empty schedule, not a failure, for a client with no sealed term", async () => {
    mocks.createClient.mockResolvedValue(session({ data: [], error: null }).client);

    await expect(fetchManualReferralRateScheduleAsAdmin(CLIENT)).resolves.toEqual([]);
  });

  it("propagates a failed read, and the fee-estimate variant suppresses it to null", async () => {
    mocks.createClient.mockResolvedValue(
      session({ data: null, error: { message: "permission denied" } }).client,
    );

    await expect(fetchManualReferralRateScheduleAsAdmin(CLIENT)).rejects.toThrow(
      "Could not load the manual referral rate schedule",
    );
    await expect(fetchManualReferralRateScheduleAsAdminOrNull(CLIENT)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "Manual referral rate schedule unavailable; fee estimate suppressed:",
      "Could not load the manual referral rate schedule",
    );
  });

  it("rejects a term that breaks the commercial formula instead of repricing history", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        data: [{ ...term("2026-08-03", 1, 1), fee_rate: "9.00" }],
        error: null,
      }).client,
    );

    await expect(fetchManualReferralRateScheduleAsAdmin(CLIENT)).rejects.toThrow(
      "The manual referral rate schedule was invalid",
    );
  });
});
