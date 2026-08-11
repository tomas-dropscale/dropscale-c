/**
 * Broad clearance requested for merchant-created audit apps.
 *
 * The profile covers catalogue, storefront, theme, Markets, channel/feed and
 * reporting work. It deliberately leaves out direct customer-account
 * management, raw customer-event streams, payment/banking data, gift cards,
 * store credit, order mutations and operational fulfilment records. Pixel
 * configuration is included, so tracking code can be reviewed and corrected.
 * `read_orders` (which can expose order/customer details) is included because it
 * was explicitly requested for audit evidence; `read_all_orders` is not, because
 * Shopify gates historical order access behind a separate approval.
 *
 * Shopify remains authoritative about what an installation actually grants.
 * Scope differences are recorded for admins but never prevent a verified store
 * from connecting.
 */
export const AUDIT_SCOPE_PROFILE = "store-audit-clearance-v2" as const;

export const REQUIRED_AUDIT_SHOPIFY_SCOPES = [
  "read_analytics",
  "read_apps",
  "read_audit_events",
  "read_cart_transforms",
  "write_cart_transforms",
  "read_all_cart_transforms",
  "read_validations",
  "write_validations",
  "read_channels",
  "write_channels",
  "read_checkout_and_accounts_configurations",
  "write_checkout_and_accounts_configurations",
  "read_checkout_branding_settings",
  "write_checkout_branding_settings",
  "read_custom_pixels",
  "write_custom_pixels",
  "read_delivery_customizations",
  "write_delivery_customizations",
  "read_price_rules",
  "write_price_rules",
  "read_discounts",
  "write_discounts",
  "read_discounts_allocator_functions",
  "write_discounts_allocator_functions",
  "read_discovery",
  "write_discovery",
  "read_files",
  "write_files",
  "read_fulfillment_constraint_rules",
  "write_fulfillment_constraint_rules",
  "read_inventory",
  "write_inventory",
  "read_legal_policies",
  "write_legal_policies",
  "read_delivery_option_generators",
  "write_delivery_option_generators",
  "read_locales",
  "write_locales",
  "read_locations",
  "write_locations",
  "read_marketing_integrated_campaigns",
  "write_marketing_integrated_campaigns",
  "read_marketing_events",
  "write_marketing_events",
  "read_markets",
  "write_markets",
  "read_markets_home",
  "write_markets_home",
  "read_metaobject_definitions",
  "write_metaobject_definitions",
  "read_metaobjects",
  "write_metaobjects",
  "read_online_store_navigation",
  "write_online_store_navigation",
  "read_online_store_pages",
  "write_online_store_pages",
  "read_orders",
  "read_payment_customizations",
  "write_payment_customizations",
  "read_privacy_settings",
  "write_privacy_settings",
  "read_product_feeds",
  "write_product_feeds",
  "read_product_listings",
  "write_product_listings",
  "read_products",
  "write_products",
  "read_publications",
  "write_publications",
  "read_purchase_options",
  "write_purchase_options",
  "read_reports",
  "write_reports",
  "read_resource_feedbacks",
  "write_resource_feedbacks",
  "read_script_tags",
  "write_script_tags",
  "read_shipping",
  "write_shipping",
  "read_content",
  "write_content",
  "read_themes",
  "write_themes",
  "read_translations",
  "write_translations",
  "read_pixels",
  "write_pixels",
] as const;

export const AUDIT_SHOPIFY_SCOPES_TEXT = REQUIRED_AUDIT_SHOPIFY_SCOPES.join(",");

export type AuditShopifyScope = (typeof REQUIRED_AUDIT_SHOPIFY_SCOPES)[number];

export type AuditScopeCheck = {
  /** Exact, normalised handles Shopify says this installation granted. */
  granted: string[];
  /** Requested handles Shopify did not grant; informational only. */
  missing: AuditShopifyScope[];
  writeScopes: string[];
  /** Granted handles outside this versioned request; informational only. */
  unexpectedScopes: string[];
  /** A verified Shopify grant is connectable even when it differs from the request. */
  valid: boolean;
};

/**
 * Compare Shopify's authoritative grant with the profile for admin diagnostics.
 * Missing and additional handles do not invalidate a verified connection: app
 * type, plan and Shopify approvals can legitimately change the returned set.
 */
export function checkAuditShopifyScopes(scopes: readonly string[]): AuditScopeCheck {
  const granted = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  const allowed = new Set<string>(REQUIRED_AUDIT_SHOPIFY_SCOPES);
  const missing = REQUIRED_AUDIT_SHOPIFY_SCOPES.filter(
    (scope) => !granted.includes(scope),
  );
  const writeScopes = granted.filter((scope) => scope.startsWith("write_"));
  const unexpectedScopes = granted.filter((scope) => !allowed.has(scope));

  return {
    granted,
    missing,
    writeScopes,
    unexpectedScopes,
    valid: true,
  };
}
