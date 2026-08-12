import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { REQUIRED_REPORTING_SHOPIFY_SCOPES } from "./shopify-scopes";
import {
  REPORTING_SHOPIFY_API_VERSION,
  ShopifyReportingError,
  exchangeReportingClientCredentials,
  normalizeReportingShopDomain,
  testReportingShopConnection,
  verifyReportingShop,
  type VerifiedReportingShop,
} from "./shopify";

afterEach(() => {
  vi.unstubAllGlobals();
});

function graphqlResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "x-shopify-api-version": REPORTING_SHOPIFY_API_VERSION },
  });
}

function verifiedShop(
  scopes: readonly string[] = REQUIRED_REPORTING_SHOPIFY_SCOPES,
): VerifiedReportingShop {
  return {
    shopId: "gid://shopify/Shop/123",
    name: "Northwind Demo Store",
    myshopifyDomain: "northwind-demo.myshopify.com",
    primaryDomain: "northwind.example",
    currencyCode: "AUD",
    scopes: {
      granted: [...scopes],
      missing: REQUIRED_REPORTING_SHOPIFY_SCOPES.filter(
        (scope) => !scopes.includes(scope),
      ),
      missingPermissionGated: [],
      writeScopes: [],
      unexpectedReadScopes: [],
      valid: REQUIRED_REPORTING_SHOPIFY_SCOPES.every((scope) =>
        scopes.includes(scope),
      ),
    },
  };
}

describe("reporting Shopify domain boundary", () => {
  it("normalises canonical myshopify hosts", () => {
    expect(
      normalizeReportingShopDomain(" Example-Shop.myshopify.com "),
    ).toBe("example-shop.myshopify.com");
    expect(
      normalizeReportingShopDomain(
        "https://example-shop.myshopify.com/admin/apps",
      ),
    ).toBe("example-shop.myshopify.com");
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
    expect(() => normalizeReportingShopDomain(value)).toThrow(
      ShopifyReportingError,
    );
  });
});

describe("reporting Shopify credential exchange", () => {
  it("sends the merchant secret only in a fresh, no-redirect form body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "temporary-access-token-123" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const token = await exchangeReportingClientCredentials({
      shopDomain: "northwind-demo.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-value-123456",
    });
    expect(token).toBe("temporary-access-token-123");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://northwind-demo.myshopify.com/admin/oauth/access_token",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(
      Object.fromEntries(new URLSearchParams(String(init.body))),
    ).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id-123456",
      client_secret: "client-secret-value-123456",
    });
  });

  it("never echoes Shopify's response or the rejected secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "client-secret-value-123456 was rejected",
          }),
          { status: 401 },
        ),
      ),
    );

    try {
      await exchangeReportingClientCredentials({
        shopDomain: "northwind-demo.myshopify.com",
        clientId: "client-id-123456",
        clientSecret: "client-secret-value-123456",
      });
      throw new Error("Expected Shopify to reject the credential.");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_credentials" });
      expect(String(error)).not.toContain("client-secret-value-123456");
    }
  });
});

describe("reporting Shopify identity and scope verification", () => {
  it("pins the stable API version and returns only verified metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        shop: {
          id: "gid://shopify/Shop/123",
          name: "Northwind Demo Store",
          myshopifyDomain: "northwind-demo.myshopify.com",
          currencyCode: "AUD",
          primaryDomain: { host: "northwind.example" },
        },
        currentAppInstallation: {
          accessScopes: REQUIRED_REPORTING_SHOPIFY_SCOPES.map((handle) => ({
            handle,
          })),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const shop = await verifyReportingShop({
      shopDomain: "northwind-demo.myshopify.com",
      accessToken: "temporary-access-token-123",
    });
    expect(shop).toMatchObject({
      shopId: "gid://shopify/Shop/123",
      name: "Northwind Demo Store",
      myshopifyDomain: "northwind-demo.myshopify.com",
      primaryDomain: "northwind.example",
      currencyCode: "AUD",
      scopes: { valid: true },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      `/admin/api/${REPORTING_SHOPIFY_API_VERSION}/graphql.json`,
    );
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
  });

  it("records a write permission as an invalid purpose-bound grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        graphqlResponse({
          shop: {
            id: "gid://shopify/Shop/123",
            name: "Northwind Demo Store",
            myshopifyDomain: "northwind-demo.myshopify.com",
            currencyCode: "AUD",
            primaryDomain: null,
          },
          currentAppInstallation: {
            accessScopes: [
              ...REQUIRED_REPORTING_SHOPIFY_SCOPES,
              "write_products",
            ].map((handle) => ({ handle })),
          },
        }),
      ),
    );

    const shop = await verifyReportingShop({
      shopDomain: "northwind-demo.myshopify.com",
      accessToken: "temporary-access-token-123",
    });
    expect(shop.scopes.valid).toBe(false);
    expect(shop.scopes.writeScopes).toEqual(["write_products"]);
  });
});

describe("read-only Shopify health check", () => {
  it("probes every reporting capability without returning merchant data", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body)) as { query: string };
        if (payload.query.includes("shopifyPaymentsAccount")) {
          return graphqlResponse({
            shopifyPaymentsAccount: {
              activated: true,
              payouts: {
                nodes: [
                  {
                    issuedAt: "2026-08-11T00:00:00Z",
                    status: "PAID",
                    net: { amount: "12.34", currencyCode: "AUD" },
                  },
                ],
              },
            },
          });
        }
        if (payload.query.includes("shopifyqlQuery")) {
          return graphqlResponse({
            shopifyqlQuery: {
              tableData: { rows: [{ total_sales: "999.00" }] },
              parseErrors: [],
            },
          });
        }
        return graphqlResponse({ probe: { nodes: [{ id: "secret-row-id" }] } });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testReportingShopConnection({
      shop: verifiedShop(),
      accessToken: "temporary-access-token-123",
      now: new Date("2026-08-12T19:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      limited: false,
      testedAt: "2026-08-12T19:00:00.000Z",
      capabilities: [
        { capability: "orders", status: "ok", code: null },
        { capability: "reports", status: "ok", code: null },
        { capability: "products", status: "ok", code: null },
        { capability: "inventory", status: "ok", code: null },
        { capability: "locations", status: "ok", code: null },
        { capability: "payouts", status: "ok", code: null },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("999.00");
    expect(JSON.stringify(result)).not.toContain("secret-row-id");
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const orderProbe = (fetchMock.mock.calls as Array<[string, RequestInit]>)
      .map(([, init]) => JSON.parse(String(init.body)) as { query: string })
      .find(({ query }) => query.includes("TestDropscaleOrderReporting"));
    expect(orderProbe?.query).toContain("returns(first: 1)");

    for (const [, init] of fetchMock.mock.calls as Array<
      [string, RequestInit]
    >) {
      const body = JSON.parse(String(init.body)) as { query: string };
      expect(body.query).not.toMatch(/\bmutation\b/i);
      expect(init).toMatchObject({
        method: "POST",
        redirect: "manual",
        cache: "no-store",
      });
    }
  });

  it("does not call a capability whose scope is missing", async () => {
    const withoutPayouts = REQUIRED_REPORTING_SHOPIFY_SCOPES.filter(
      (scope) => !scope.includes("shopify_payments"),
    );
    const fetchMock = vi.fn().mockResolvedValue(graphqlResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testReportingShopConnection({
      shop: verifiedShop(withoutPayouts),
      accessToken: "temporary-access-token-123",
    });
    expect(result.ok).toBe(false);
    expect(result.capabilities.at(-1)).toEqual({
      capability: "payouts",
      status: "missing_scope",
      code: "missing_scope",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("treats a store without Shopify Payments as not applicable, not broken", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body)) as { query: string };
        if (query.includes("shopifyPaymentsAccount")) {
          return graphqlResponse({ shopifyPaymentsAccount: null });
        }
        if (query.includes("shopifyqlQuery")) {
          return graphqlResponse({
            shopifyqlQuery: { tableData: { rows: [] }, parseErrors: [] },
          });
        }
        return graphqlResponse({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testReportingShopConnection({
      shop: verifiedShop(),
      accessToken: "temporary-access-token-123",
    });
    expect(result.ok).toBe(true);
    expect(result.limited).toBe(true);
    expect(result.capabilities.at(-1)).toMatchObject({
      capability: "payouts",
      status: "not_applicable",
    });
  });

  it("fails the reports capability when ShopifyQL returns parse errors inside HTTP 200", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body)) as { query: string };
        if (query.includes("shopifyqlQuery")) {
          return graphqlResponse({
            shopifyqlQuery: {
              tableData: null,
              parseErrors: ["Column not available"],
            },
          });
        }
        if (query.includes("shopifyPaymentsAccount")) {
          return graphqlResponse({ shopifyPaymentsAccount: null });
        }
        return graphqlResponse({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testReportingShopConnection({
      shop: verifiedShop(),
      accessToken: "temporary-access-token-123",
    });
    expect(result.ok).toBe(false);
    expect(result.capabilities[1]).toEqual({
      capability: "reports",
      status: "failed",
      code: "invalid_shop_response",
    });
  });
});
