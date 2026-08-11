import { describe, expect, it } from "vitest";

import {
  REQUIRED_AUDIT_SHOPIFY_SCOPES,
  checkAuditShopifyScopes,
} from "./shopify-scopes";

describe("audit Shopify scope contract", () => {
  it("publishes a unique broad-clearance profile for store audit and remediation", () => {
    const result = checkAuditShopifyScopes(REQUIRED_AUDIT_SHOPIFY_SCOPES);
    expect(REQUIRED_AUDIT_SHOPIFY_SCOPES).toHaveLength(87);
    expect(new Set(REQUIRED_AUDIT_SHOPIFY_SCOPES).size).toBe(87);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.writeScopes.length).toBeGreaterThan(0);
    expect(result.writeScopes).toContain("write_products");
    expect(result.unexpectedScopes).toEqual([]);

    expect(REQUIRED_AUDIT_SHOPIFY_SCOPES).toEqual(
      expect.arrayContaining([
        "read_orders",
        "read_products",
        "write_products",
        "read_files",
        "write_files",
        "read_themes",
        "write_themes",
        "read_markets",
        "write_markets",
        "read_product_feeds",
        "write_product_feeds",
        "read_product_listings",
        "write_product_listings",
        "read_channels",
        "write_channels",
      ]),
    );
    expect(REQUIRED_AUDIT_SHOPIFY_SCOPES).not.toEqual(
      expect.arrayContaining([
        "read_all_orders",
        "read_customers",
        "write_customers",
        "write_orders",
        "read_customer_payment_methods",
        "read_shopify_payments_bank_accounts",
        "read_gift_cards",
        "write_store_credit_account_transactions",
        "write_fulfillments",
      ]),
    );
  });

  it("reports missing requested scopes without blocking the connection", () => {
    const result = checkAuditShopifyScopes(
      REQUIRED_AUDIT_SHOPIFY_SCOPES.filter((scope) => scope !== "read_products"),
    );
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual(["read_products"]);
  });

  it("also tolerates a requested write scope Shopify did not grant", () => {
    const result = checkAuditShopifyScopes(
      REQUIRED_AUDIT_SHOPIFY_SCOPES.filter((scope) => scope !== "write_products"),
    );
    expect(result.valid).toBe(true);
    expect(result.missing).toContain("write_products");
  });

  it("records permissions outside the profile without blocking the connection", () => {
    const result = checkAuditShopifyScopes([
      ...REQUIRED_AUDIT_SHOPIFY_SCOPES,
      "root_store_access",
    ]);
    expect(result.valid).toBe(true);
    expect(result.unexpectedScopes).toEqual(["root_store_access"]);
  });

  it("normalises duplicates and empty handles before comparison", () => {
    const result = checkAuditShopifyScopes([
      ...REQUIRED_AUDIT_SHOPIFY_SCOPES,
      "read_products",
      " ",
    ]);
    expect(result.valid).toBe(true);
    expect(result.granted).toHaveLength(REQUIRED_AUDIT_SHOPIFY_SCOPES.length);
  });
});
