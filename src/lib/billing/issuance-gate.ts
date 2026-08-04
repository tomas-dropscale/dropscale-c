import "server-only";

/**
 * Master gate for every live manual invoice issue.
 *
 * Fail closed: only the exact lowercase string `true` enables issuance. This
 * deliberately rejects unset, blank, case-varied and whitespace-padded values
 * so an accidental deployment configuration cannot make Stripe writes live.
 */
export function billingIssuanceEnabled(): boolean {
  return process.env.BILLING_ISSUANCE_ENABLED === "true";
}
