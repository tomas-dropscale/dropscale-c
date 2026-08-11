import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { REQUIRED_AUDIT_SHOPIFY_SCOPES } from "./shopify-scopes";
import {
  AUDIT_SHOPIFY_API_VERSION,
  ShopifyAuditError,
  exchangeAuditClientCredentials,
  normalizeAuditShopDomain,
  verifyAuditShop,
} from "./shopify";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audit Shopify domain boundary", () => {
  it("normalises only canonical myshopify hosts", () => {
    expect(normalizeAuditShopDomain(" Example-Shop.myshopify.com ")).toBe(
      "example-shop.myshopify.com",
    );
    expect(normalizeAuditShopDomain("https://example-shop.myshopify.com/admin")).toBe(
      "example-shop.myshopify.com",
    );
  });

  it.each([
    "example.com",
    "example.myshopify.com.evil.test",
    "http://example.myshopify.com",
    "https://user@example.myshopify.com",
    "https://example.myshopify.com:8443",
    "127.0.0.1",
    "localhost",
    "example.myshopify.com/path",
  ])("rejects unsafe/non-Shopify input: %s", (value) => {
    expect(() => normalizeAuditShopDomain(value)).toThrow(ShopifyAuditError);
  });
});

describe("audit Shopify client credentials exchange", () => {
  it("uses a fresh form-urlencoded exchange without following redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "temporary-access-token-123", expires_in: 86_399 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const token = await exchangeAuditClientCredentials({
      shopDomain: "example.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-value-123456",
    });
    expect(token).toBe("temporary-access-token-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.myshopify.com/admin/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
    });
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id-123456",
      client_secret: "client-secret-value-123456",
    });
  });

  it("returns a sanitised error when Shopify rejects the secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "secret client-secret-value-123456 invalid" }), {
          status: 401,
        }),
      ),
    );

    await expect(
      exchangeAuditClientCredentials({
        shopDomain: "example.myshopify.com",
        clientId: "client-id-123456",
        clientSecret: "client-secret-value-123456",
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });

    try {
      await exchangeAuditClientCredentials({
        shopDomain: "example.myshopify.com",
        clientId: "client-id-123456",
        clientSecret: "client-secret-value-123456",
      });
    } catch (error) {
      expect(String(error)).not.toContain("client-secret-value-123456");
    }
  });

  it("classifies a Shopify redirect as a credentials or installation problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://admin.shopify.com/store/example/apps" },
        }),
      ),
    );

    await expect(
      exchangeAuditClientCredentials({
        shopDomain: "example.myshopify.com",
        clientId: "client-id-123456",
        clientSecret: "client-secret-value-123456",
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials", retryable: false });
  });
});

describe("audit Shopify GraphQL verification", () => {
  it("pins 2026-07 and returns the verified identity + granted scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            shop: {
              id: "gid://shopify/Shop/123",
              name: "Example Shop",
              myshopifyDomain: "example.myshopify.com",
              currencyCode: "EUR",
              primaryDomain: { host: "example.com" },
            },
            currentAppInstallation: {
              accessScopes: REQUIRED_AUDIT_SHOPIFY_SCOPES.map((handle) => ({ handle })),
            },
          },
        }),
        {
          status: 200,
          headers: { "x-shopify-api-version": AUDIT_SHOPIFY_API_VERSION },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const shop = await verifyAuditShop({
      shopDomain: "example.myshopify.com",
      accessToken: "temporary-access-token-123",
    });
    expect(shop).toMatchObject({
      shopId: "gid://shopify/Shop/123",
      name: "Example Shop",
      myshopifyDomain: "example.myshopify.com",
      primaryDomain: "example.com",
      currencyCode: "EUR",
    });
    expect(shop.scopes.valid).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/admin/api/${AUDIT_SHOPIFY_API_VERSION}/graphql.json`);
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
  });

  it("does not follow a GraphQL redirect carrying the temporary access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://admin.shopify.com/store/example" },
        }),
      ),
    );

    await expect(
      verifyAuditShop({
        shopDomain: "example.myshopify.com",
        accessToken: "temporary-access-token-123",
      }),
    ).rejects.toMatchObject({ code: "invalid_shop_response", retryable: false });
  });

  it("rejects a credential that resolves to another shop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              shop: {
                id: "gid://shopify/Shop/456",
                name: "Other",
                myshopifyDomain: "other.myshopify.com",
                currencyCode: "EUR",
                primaryDomain: null,
              },
              currentAppInstallation: { accessScopes: [] },
            },
          }),
          {
            status: 200,
            headers: { "x-shopify-api-version": AUDIT_SHOPIFY_API_VERSION },
          },
        ),
      ),
    );

    await expect(
      verifyAuditShop({
        shopDomain: "example.myshopify.com",
        accessToken: "temporary-access-token-123",
      }),
    ).rejects.toMatchObject({ code: "domain_mismatch" });
  });

  it("fails closed if Shopify silently falls forward to another API version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: { "x-shopify-api-version": "2027-01" },
        }),
      ),
    );
    await expect(
      verifyAuditShop({
        shopDomain: "example.myshopify.com",
        accessToken: "temporary-access-token-123",
      }),
    ).rejects.toMatchObject({ code: "unsupported_api_version" });
  });
});
