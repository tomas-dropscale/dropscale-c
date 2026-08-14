import "server-only";

/**
 * Master gate for every live invoice issue.
 *
 * Fail closed: only the exact lowercase string `true` enables issuance. This
 * deliberately rejects unset, blank, case-varied and whitespace-padded values
 * so an accidental deployment configuration cannot make Stripe writes live.
 */
export function billingIssuanceEnabled(): boolean {
  return process.env.BILLING_ISSUANCE_ENABLED === "true";
}

/**
 * Recovery-only arm for the unattended billing engine.
 *
 * Recovery is permitted only while ordinary invoice issuance is disabled.
 * The HTTP route also requires an explicit `?mode=recovery` request; normal
 * scheduled calls remain reconcile-only even after this gate is armed.
 */
export function billingRecoveryEnabled(): boolean {
  return (
    !billingIssuanceEnabled() &&
    process.env.BILLING_AUTOMATION_ENABLED === "true" &&
    process.env.BILLING_AUTOMATION_RECOVERY_ARMED === "true"
  );
}
