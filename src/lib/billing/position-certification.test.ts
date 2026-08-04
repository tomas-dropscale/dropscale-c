import { describe, expect, it } from "vitest";

import { automaticPositionCandidateIsCertified } from "./position-certification";

function candidate(
  over: Partial<Parameters<typeof automaticPositionCandidateIsCertified>[0]> = {},
) {
  return {
    currency: "EUR",
    amount: 10,
    billableSpend: 100,
    storeCount: 1,
    existingInvoiceRecoverable: true,
    blockers: [],
    ...over,
  };
}

describe("automatic billing position certification", () => {
  it("accepts a positive exact automatic candidate", () => {
    expect(automaticPositionCandidateIsCertified(candidate())).toBe(true);
  });

  it.each(["stripe_not_configured", "issue_in_progress"])(
    "keeps an exact amount stable through the operational %s blocker",
    (code) => {
      expect(
        automaticPositionCandidateIsCertified(
          candidate({ blockers: [{ code, severity: "error" }] }),
        ),
      ).toBe(true);
    },
  );

  it.each([
    "ledger_missing",
    "ledger_stale",
    "evidence_settling",
    "billing_not_started",
    "billing_start_mismatch",
    "billing_end_mismatch",
    "recipient_invalid",
    "referral_term_mismatch",
    "pre_v3_cutover",
  ])("rejects a positive but uncertified %s preview", (code) => {
    expect(
      automaticPositionCandidateIsCertified(
        candidate({ blockers: [{ code, severity: "error" }] }),
      ),
    ).toBe(false);
  });

  it("ignores non-blocking warnings but rejects zero or non-EUR money", () => {
    expect(
      automaticPositionCandidateIsCertified(
        candidate({ blockers: [{ code: "no_spend", severity: "warning" }] }),
      ),
    ).toBe(true);
    expect(automaticPositionCandidateIsCertified(candidate({ amount: 0 }))).toBe(
      false,
    );
    expect(
      automaticPositionCandidateIsCertified(candidate({ currency: "USD" })),
    ).toBe(false);
  });

  it("rejects an already settled invoice snapshot", () => {
    expect(
      automaticPositionCandidateIsCertified(
        candidate({ existingInvoiceRecoverable: false }),
      ),
    ).toBe(false);
  });
});
