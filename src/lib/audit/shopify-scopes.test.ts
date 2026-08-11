import { describe, expect, it } from "vitest";

import {
  REQUIRED_AUDIT_SHOPIFY_SCOPES,
  checkAuditShopifyScopes,
} from "./shopify-scopes";

describe("audit Shopify scope contract", () => {
  it("accepts exactly the versioned full audit profile", () => {
    const result = checkAuditShopifyScopes(REQUIRED_AUDIT_SHOPIFY_SCOPES);
    expect(REQUIRED_AUDIT_SHOPIFY_SCOPES).toHaveLength(152);
    expect(new Set(REQUIRED_AUDIT_SHOPIFY_SCOPES).size).toBe(152);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.writeScopes.length).toBeGreaterThan(0);
    expect(result.writeScopes).toContain("write_products");
    expect(result.unexpectedScopes).toEqual([]);
  });

  it("reports every required scope that Shopify did not grant", () => {
    const result = checkAuditShopifyScopes(
      REQUIRED_AUDIT_SHOPIFY_SCOPES.filter((scope) => scope !== "read_products"),
    );
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["read_products"]);
  });

  it("reports a required write scope that Shopify did not grant", () => {
    const result = checkAuditShopifyScopes(
      REQUIRED_AUDIT_SHOPIFY_SCOPES.filter((scope) => scope !== "write_products"),
    );
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("write_products");
  });

  it("rejects permissions outside the exact audit profile", () => {
    const result = checkAuditShopifyScopes([
      ...REQUIRED_AUDIT_SHOPIFY_SCOPES,
      "root_store_access",
    ]);
    expect(result.valid).toBe(false);
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
