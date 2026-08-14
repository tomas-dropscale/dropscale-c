import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  decryptToken: vi.fn(),
  exchangeReportingClientCredentials: vi.fn(),
  verifyReportingShop: vi.fn(),
  reportingShopifyGraphql: vi.fn(),
}));

vi.mock("../google-ads/crypto", () => ({
  decryptToken: mocks.decryptToken,
}));
vi.mock("@/lib/shopify/referrer", () => ({
  isMetaReferral: () => false,
}));
vi.mock("../client-onboarding/shopify", () => ({
  normalizeReportingShopDomain(value: string) {
    const domain = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
      throw new Error("Invalid domain");
    }
    return domain;
  },
  exchangeReportingClientCredentials: mocks.exchangeReportingClientCredentials,
  verifyReportingShop: mocks.verifyReportingShop,
  reportingShopifyGraphql: mocks.reportingShopifyGraphql,
}));

import type { CanonicalReportingSource } from "./sources";
import {
  createShopifyReportingAdapter,
  ShopifyReportingAdapterError,
} from "./shopify";

const CIPHERTEXT = "encrypted-shopify-client-secret";
const CLIENT_SECRET = "client-secret-value-that-must-never-leak";
const ACCESS_TOKEN = "temporary-access-token-that-must-never-leak";

function source(
  overrides: Partial<CanonicalReportingSource> = {},
): CanonicalReportingSource {
  return {
    bindingId: "70000000-0000-4000-8000-000000000001",
    clientId: "70000000-0000-4000-8000-000000000002",
    adAccountId: "70000000-0000-4000-8000-000000000003",
    kind: "shopify",
    group: {
      id: "70000000-0000-4000-8000-000000000001",
      shopifyAnchorBindingId: "70000000-0000-4000-8000-000000000001",
      shopifyAnchorAdAccountId: "70000000-0000-4000-8000-000000000003",
    },
    shopify: {
      connectionId: "70000000-0000-4000-8000-000000000004",
      shopId: "gid://shopify/Shop/123",
      shopifyName: "Northwind Demo Store",
      domain: "northwind-demo.myshopify.com",
      primaryDomain: "northwind.example",
      currency: "EUR",
      credential: {
        shopifyClientId: "client-id-123456",
        clientSecretCiphertext: CIPHERTEXT,
      },
    },
    googleAds: null,
    ...overrides,
  };
}

function verifiedShop(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "gid://shopify/Shop/123",
    name: "Northwind Demo Store",
    myshopifyDomain: "northwind-demo.myshopify.com",
    primaryDomain: "northwind.example",
    currencyCode: "EUR",
    scopes: {
      granted: ["read_orders"],
      missing: [],
      missingPermissionGated: [],
      writeScopes: [],
      unexpectedReadScopes: [],
      valid: true,
    },
    ...overrides,
  };
}

function orderResponse(currencyCode = "EUR") {
  return {
    shop: { currencyCode },
    orders: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          createdAt: "2026-08-13T10:00:00Z",
          test: false,
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          customerJourneySummary: {
            firstVisit: {
              landingPage: "/collections/summer",
              source: "google",
              referrerUrl: "https://google.com",
              utmParameters: { source: "google" },
            },
          },
          totalPriceSet: { shopMoney: { amount: "120.50" } },
          totalRefundedSet: { shopMoney: { amount: "5.00" } },
          lineItems: {
            nodes: [
              {
                title: "Summer Dress",
                sku: "SUMMER-1",
                quantity: 2,
                originalUnitPriceSet: { shopMoney: { amount: "60.25" } },
              },
            ],
          },
        },
      ],
    },
  };
}

describe("V2 Shopify reporting adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decryptToken.mockResolvedValue(CLIENT_SECRET);
    mocks.exchangeReportingClientCredentials.mockResolvedValue(ACCESS_TOKEN);
    mocks.verifyReportingShop.mockResolvedValue(verifiedShop());
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query }: { query: string }) => {
        if (query.includes("collectionByHandle")) {
          return {
            collectionByHandle: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    title: "Summer Dress",
                    variants: { nodes: [{ sku: "SUMMER-1" }] },
                  },
                ],
              },
            },
          };
        }
        return orderResponse();
      },
    );
  });

  it("uses the V2 credential while keeping secrets inside the adapter", async () => {
    const adapter = await createShopifyReportingAdapter(source());
    const sales = await adapter.fetchDailySales("2026-08-13", "2026-08-13");
    const productKeys = await adapter.fetchCollectionProductKeys("summer");

    expect(mocks.decryptToken).toHaveBeenCalledWith(CIPHERTEXT);
    expect(mocks.exchangeReportingClientCredentials).toHaveBeenCalledWith({
      shopDomain: "northwind-demo.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: CLIENT_SECRET,
    });
    expect(mocks.verifyReportingShop).toHaveBeenCalledWith({
      shopDomain: "northwind-demo.myshopify.com",
      accessToken: ACCESS_TOKEN,
    });
    expect(sales).toEqual({
      currency: "EUR",
      days: [
        {
          date: "2026-08-13",
          revenue: 120.5,
          orders: 1,
          refunds: 5,
          units: 2,
          attributedOrders: 1,
          attributedRevenue: 120.5,
        },
      ],
      orders: [
        {
          date: "2026-08-13",
          total: 120.5,
          paid: true,
          landingPath: "/collections/summer",
          lines: [
            {
              productKey: "SUMMER-1",
              title: "Summer Dress",
              quantity: 2,
              unitPrice: 60.25,
            },
          ],
        },
      ],
    });
    expect(productKeys).toEqual(new Set(["Summer Dress", "SUMMER-1"]));

    for (const call of mocks.reportingShopifyGraphql.mock.calls) {
      expect(call[0]).toMatchObject({
        shopDomain: "northwind-demo.myshopify.com",
        accessToken: ACCESS_TOKEN,
      });
    }
    const publicResult = JSON.stringify({ adapter, sales, productKeys: [...productKeys] });
    expect(publicResult).not.toContain(CIPHERTEXT);
    expect(publicResult).not.toContain(CLIENT_SECRET);
    expect(publicResult).not.toContain(ACCESS_TOKEN);
  });

  it("rejects a Google-only child before reading any Shopify credential", async () => {
    await expect(
      createShopifyReportingAdapter(
        source({
          kind: "google_ads",
          shopify: null,
          group: {
            id: "70000000-0000-4000-8000-000000000001",
            shopifyAnchorBindingId: "70000000-0000-4000-8000-000000000099",
            shopifyAnchorAdAccountId: "70000000-0000-4000-8000-000000000098",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_source" });
    expect(mocks.decryptToken).not.toHaveBeenCalled();
    expect(mocks.exchangeReportingClientCredentials).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "non-anchor group",
      value: source({
        group: {
          id: "70000000-0000-4000-8000-000000000099",
          shopifyAnchorBindingId: "70000000-0000-4000-8000-000000000099",
          shopifyAnchorAdAccountId: "70000000-0000-4000-8000-000000000003",
        },
      }),
    },
    {
      label: "unsafe domain",
      value: source({
        shopify: {
          ...source().shopify!,
          domain: "northwind-demo.myshopify.com.evil.test",
        },
      }),
    },
    {
      label: "invalid shop id",
      value: source({
        shopify: { ...source().shopify!, shopId: "private-shop-id" },
      }),
    },
  ])("rejects an invalid $label before decrypting", async ({ value }) => {
    await expect(createShopifyReportingAdapter(value)).rejects.toBeInstanceOf(
      ShopifyReportingAdapterError,
    );
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });

  it("fails closed if the exchanged credential identifies another shop", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({ shopId: "gid://shopify/Shop/999" }),
    );

    await expect(createShopifyReportingAdapter(source())).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(mocks.reportingShopifyGraphql).not.toHaveBeenCalled();
  });

  it("rejects a changed or invalid currency instead of mixing money", async () => {
    mocks.reportingShopifyGraphql.mockResolvedValue(orderResponse("USD"));
    const adapter = await createShopifyReportingAdapter(source());

    await expect(
      adapter.fetchDailySales("2026-08-13", "2026-08-13"),
    ).rejects.toMatchObject({ code: "currency_mismatch" });
  });

  it("redacts failures while decrypting the stored credential", async () => {
    mocks.decryptToken.mockRejectedValue(
      new Error(`Cannot decrypt ${CIPHERTEXT} into ${CLIENT_SECRET}`),
    );

    let error: unknown;
    try {
      await createShopifyReportingAdapter(source());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "credential_decrypt_failed" });
    expect(String(error)).not.toContain(CIPHERTEXT);
    expect(String(error)).not.toContain(CLIENT_SECRET);
    expect(mocks.exchangeReportingClientCredentials).not.toHaveBeenCalled();
  });
});
