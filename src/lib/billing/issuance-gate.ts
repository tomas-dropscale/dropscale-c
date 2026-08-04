import "server-only";

/**
 * Master gate for every live invoice issue, automatic or manual.
 *
 * Fail closed: only the exact lowercase string `true` enables issuance. This
 * deliberately rejects unset, blank, case-varied and whitespace-padded values
 * so an accidental deployment configuration cannot make Stripe writes live.
 */
export function billingIssuanceEnabled(): boolean {
  return process.env.BILLING_ISSUANCE_ENABLED === "true";
}

/**
 * Separate arm for the unattended all-client worker.
 *
 * Production previously used BILLING_ISSUANCE_ENABLED for an admin-confirmed
 * path. Requiring a second exact-true value prevents an existing manual gate
 * from turning a code deploy into an immediate batch issue.
 */
export function automaticBillingIssuanceEnabled(): boolean {
  return (
    billingIssuanceEnabled() &&
    process.env.BILLING_AUTOMATION_ENABLED === "true"
  );
}
