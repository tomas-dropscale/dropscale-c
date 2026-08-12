import { describe, expect, it } from "vitest";

import {
  PERMISSION_GATED_REPORTING_SHOPIFY_SCOPES,
  REQUIRED_REPORTING_SHOPIFY_SCOPES,
  checkReportingShopifyScopes,
} from "./shopify-scopes";

describe("client reporting Shopify scope contract", () => {
  it("is a small, unique and entirely read-only profile", () => {
    expect(REQUIRED_REPORTING_SHOPIFY_SCOPES).toHaveLength(10);
    expect(new Set(REQUIRED_REPORTING_SHOPIFY_SCOPES).size).toBe(10);
    expect(
      REQUIRED_REPORTING_SHOPIFY_SCOPES.every((scope) =>
        scope.startsWith("read_"),
      ),
    ).toBe(true);
    expect(REQUIRED_REPORTING_SHOPIFY_SCOPES).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(REQUIRED_REPORTING_SHOPIFY_SCOPES).not.toEqual(
      expect.arrayContaining([
        "read_customers",
        "read_shopify_payments_bank_accounts",
        "write_orders",
        "write_products",
      ]),
    );
  });

  it("accepts a complete requested grant", () => {
    const result = checkReportingShopifyScopes(
      REQUIRED_REPORTING_SHOPIFY_SCOPES,
    );
    expect(result).toMatchObject({
      missing: [],
      missingPermissionGated: [],
      writeScopes: [],
      unexpectedReadScopes: [],
      valid: true,
    });
  });

  it("fails clearly when permission-gated historical/payment scopes are missing", () => {
    const result = checkReportingShopifyScopes(
      REQUIRED_REPORTING_SHOPIFY_SCOPES.filter(
        (scope) =>
          !PERMISSION_GATED_REPORTING_SHOPIFY_SCOPES.includes(
            scope as (typeof PERMISSION_GATED_REPORTING_SHOPIFY_SCOPES)[number],
          ),
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.missingPermissionGated).toEqual(
      PERMISSION_GATED_REPORTING_SHOPIFY_SCOPES,
    );
  });

  it("fails closed when a core reporting scope is absent", () => {
    const result = checkReportingShopifyScopes(
      REQUIRED_REPORTING_SHOPIFY_SCOPES.filter(
        (scope) => scope !== "read_orders",
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["read_orders"]);
  });

  it("fails the purpose boundary when Shopify grants any write scope", () => {
    const result = checkReportingShopifyScopes([
      ...REQUIRED_REPORTING_SHOPIFY_SCOPES,
      "write_products",
    ]);
    expect(result.valid).toBe(false);
    expect(result.writeScopes).toEqual(["write_products"]);
  });

  it("normalises duplicates while surfacing unrelated read permissions", () => {
    const result = checkReportingShopifyScopes([
      ...REQUIRED_REPORTING_SHOPIFY_SCOPES,
      "read_orders",
      " read_themes ",
      " ",
    ]);
    expect(result.granted).toHaveLength(
      REQUIRED_REPORTING_SHOPIFY_SCOPES.length + 1,
    );
    expect(result.unexpectedReadScopes).toEqual(["read_themes"]);
    expect(result.valid).toBe(false);
  });

  it("rejects every unexpected handle, even outside the read/write prefixes", () => {
    const result = checkReportingShopifyScopes([
      ...REQUIRED_REPORTING_SHOPIFY_SCOPES,
      "unauthenticated_read_product_listings",
    ]);
    expect(result.unexpectedReadScopes).toEqual([
      "unauthenticated_read_product_listings",
    ]);
    expect(result.valid).toBe(false);
  });
});
