/**
 * Read-only Shopify access used by Client Onboarding V2 reporting.
 *
 * This contract is intentionally unrelated to the broad Audit Connections
 * clearance. It contains no mutation scope and does not grant Windsor access
 * to Shopify. The requested fields support sales reporting, order
 * source/destination analysis, catalogue and stock reporting, and a future
 * Shopify Payments payout calendar.
 *
 * `read_all_orders` is permission-gated by Shopify and the Payments scopes can
 * also depend on the merchant's payment provider and staff permissions. The
 * setup UI must explain those prerequisites, but a verified reporting asset
 * still requires the complete contract: silently accepting a partial grant
 * would produce incomplete historical and cash-flow reports.
 */
export const REPORTING_SHOPIFY_SCOPE_PROFILE =
  "client-reporting-read-v1" as const;

export const REQUIRED_REPORTING_SHOPIFY_SCOPES = [
  "read_orders",
  "read_all_orders",
  "read_analytics",
  "read_reports",
  "read_products",
  "read_inventory",
  "read_locations",
  "read_returns",
  "read_shopify_payments_accounts",
  "read_shopify_payments_payouts",
] as const;

export const PERMISSION_GATED_REPORTING_SHOPIFY_SCOPES = [
  "read_all_orders",
  "read_shopify_payments_accounts",
  "read_shopify_payments_payouts",
] as const;

export const REPORTING_SHOPIFY_SCOPES_TEXT =
  REQUIRED_REPORTING_SHOPIFY_SCOPES.join(",");

export type ReportingShopifyScope =
  (typeof REQUIRED_REPORTING_SHOPIFY_SCOPES)[number];

export type ReportingScopeCheck = {
  /** Exact, normalised handles Shopify says this installation granted. */
  granted: string[];
  /** Any missing handle prevents a reliable, complete reporting connection. */
  missing: ReportingShopifyScope[];
  /** Missing handles whose Shopify/store prerequisites need clearer guidance. */
  missingPermissionGated: ReportingShopifyScope[];
  /** A reporting credential must never retain mutation powers. */
  writeScopes: string[];
  /** Additional non-write handles also violate the fixed least-privilege profile. */
  unexpectedReadScopes: string[];
  /** True only when the grant exactly matches the complete read-only contract. */
  valid: boolean;
};

export function checkReportingShopifyScopes(
  scopes: readonly string[],
): ReportingScopeCheck {
  const granted = [
    ...new Set(scopes.map((scope) => scope.trim()).filter(Boolean)),
  ].sort();
  const requested = new Set<string>(REQUIRED_REPORTING_SHOPIFY_SCOPES);
  const permissionGated = new Set<string>(
    PERMISSION_GATED_REPORTING_SHOPIFY_SCOPES,
  );
  const missing = REQUIRED_REPORTING_SHOPIFY_SCOPES.filter(
    (scope) => !granted.includes(scope),
  );
  const missingPermissionGated = missing.filter((scope) =>
    permissionGated.has(scope),
  );
  const writeScopes = granted.filter((scope) => scope.startsWith("write_"));
  const unexpectedReadScopes = granted.filter(
    (scope) => !requested.has(scope) && !scope.startsWith("write_"),
  );
  const valid =
    missing.length === 0 &&
    writeScopes.length === 0 &&
    unexpectedReadScopes.length === 0;

  return {
    granted,
    missing,
    missingPermissionGated,
    writeScopes,
    unexpectedReadScopes,
    valid,
  };
}
