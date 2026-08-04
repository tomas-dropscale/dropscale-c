import { BILLING_CURRENCY } from "./weekly";

type PositionCertificationCandidate = {
  currency: string;
  amount: number;
  billableSpend: number;
  storeCount: number;
  existingInvoiceRecoverable: boolean;
  blockers: { code: string; severity: "error" | "warning" }[];
};

const OPERATIONAL_ONLY_BLOCKERS = new Set([
  "stripe_not_configured",
  "issue_in_progress",
]);

/**
 * Financial/evidence certification is deliberately narrower than a positive
 * preview. Stripe readiness and a short issue lease may delay collection, but
 * every Google, boundary, referral, recipient and cutover error invalidates
 * the amount shown as exact.
 */
export function automaticPositionCandidateIsCertified(
  candidate: PositionCertificationCandidate,
): boolean {
  return (
    candidate.currency.toUpperCase() === BILLING_CURRENCY &&
    Number.isFinite(candidate.amount) &&
    candidate.amount >= 0.01 &&
    Number.isFinite(candidate.billableSpend) &&
    candidate.billableSpend > 0 &&
    candidate.storeCount > 0 &&
    candidate.existingInvoiceRecoverable &&
    candidate.blockers
      .filter((blocker) => blocker.severity === "error")
      .every((blocker) => OPERATIONAL_ONLY_BLOCKERS.has(blocker.code))
  );
}
