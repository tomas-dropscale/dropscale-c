import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  decryptToken: vi.fn(),
  exchangeReportingClientCredentials: vi.fn(),
  verifyReportingShop: vi.fn(),
  reportingShopifyGraphql: vi.fn(),
  resolveAdminToken: vi.fn(),
  fxDailyRates: vi.fn(),
  rateOn: vi.fn(),
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
vi.mock("../shopify/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shopify/client")>();
  return { ...actual, resolveAdminToken: mocks.resolveAdminToken };
});
vi.mock("../shopify/fx", () => ({
  fxDailyRates: mocks.fxDailyRates,
  rateOn: mocks.rateOn,
}));

import type { CanonicalReportingSource } from "./sources";
import {
  createLegacyShopifyReportingAdapter,
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
    shop: { currencyCode, ianaTimezone: "Europe/Lisbon" },
    orders: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: "gid://shopify/Order/1",
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
            pageInfo: { hasNextPage: false },
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

function dailyOrderNode(id: number, createdAt: string) {
  return {
    ...orderResponse().orders.nodes[0],
    id: `gid://shopify/Order/${id}`,
    createdAt,
  };
}

describe("V2 Shopify reporting adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decryptToken.mockResolvedValue(CLIENT_SECRET);
    mocks.exchangeReportingClientCredentials.mockResolvedValue(ACCESS_TOKEN);
    mocks.resolveAdminToken.mockResolvedValue(ACCESS_TOKEN);
    mocks.fxDailyRates.mockResolvedValue([["2026-08-13", 1]]);
    mocks.rateOn.mockImplementation((pairs: [string, number][]) => pairs[0][1]);
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

  it("uses the shop IANA reporting day and DST-aware exclusive order bounds", async () => {
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query }: { query: string; variables?: Record<string, unknown> }) => {
        if (query.includes("DropscaleDailySalesShop")) {
          return { shop: { currencyCode: "EUR", ianaTimezone: "Europe/Lisbon" } };
        }
        if (query.includes("DropscaleDailySalesOrders")) {
          return {
            orders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [dailyOrderNode(2, "2026-03-29T23:30:00.000Z")],
            },
          };
        }
        throw new Error("Unexpected reporting query");
      },
    );
    const adapter = await createShopifyReportingAdapter(source());

    await expect(
      adapter.fetchDailySales("2026-03-29", "2026-03-30"),
    ).resolves.toMatchObject({ days: [{ date: "2026-03-30", orders: 1 }] });

    const orderCall = mocks.reportingShopifyGraphql.mock.calls.find(([input]) =>
      String(input.query).includes("DropscaleDailySalesOrders"));
    expect(orderCall?.[0].variables).toMatchObject({
      q: "created_at:>='2026-03-29T00:00:00.000Z' AND created_at:<'2026-03-30T23:00:00.000Z'",
    });
  });

  it("splits a saturated multi-day order window without overlapping reporting days", async () => {
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
        if (query.includes("DropscaleDailySalesShop")) {
          return { shop: { currencyCode: "EUR", ianaTimezone: "Europe/Lisbon" } };
        }
        if (!query.includes("DropscaleDailySalesOrders")) {
          throw new Error("Unexpected reporting query");
        }
        const q = String(variables?.q ?? "");
        const cursor = typeof variables?.cursor === "string" ? variables.cursor : null;
        const fullRange = q.includes("2026-08-07T23:00:00.000Z") &&
          q.includes("2026-08-14T23:00:00.000Z");
        if (fullRange) {
          const page = cursor ? Number(cursor.split("-")[1]) : 0;
          return {
            orders: {
              pageInfo: { hasNextPage: true, endCursor: `full-${page + 1}` },
              nodes: [dailyOrderNode(100 + page, "2026-08-10T10:00:00.000Z")],
            },
          };
        }
        const left = q.startsWith("created_at:>='2026-08-07T23:00:00.000Z'");
        return {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              left
                ? dailyOrderNode(200, "2026-08-09T10:00:00.000Z")
                : dailyOrderNode(201, "2026-08-13T10:00:00.000Z"),
            ],
          },
        };
      },
    );
    const adapter = await createShopifyReportingAdapter(source());

    await expect(
      adapter.fetchDailySales("2026-08-08", "2026-08-14"),
    ).resolves.toMatchObject({
      days: [
        { date: "2026-08-09", orders: 1 },
        { date: "2026-08-13", orders: 1 },
      ],
      orders: [{ date: "2026-08-09" }, { date: "2026-08-13" }],
    });
    const orderQueries = mocks.reportingShopifyGraphql.mock.calls
      .filter(([input]) => String(input.query).includes("DropscaleDailySalesOrders"));
    expect(orderQueries).toHaveLength(12);
    expect(orderQueries.map(([input]) => String(input.variables?.q ?? ""))).toEqual(
      expect.arrayContaining([
        "created_at:>='2026-08-07T23:00:00.000Z' AND created_at:<'2026-08-11T23:00:00.000Z'",
        "created_at:>='2026-08-11T23:00:00.000Z' AND created_at:<'2026-08-14T23:00:00.000Z'",
      ]),
    );
  });

  it("fails closed when one Shopify reporting day exceeds the order page cap", async () => {
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
        if (query.includes("DropscaleDailySalesShop")) {
          return { shop: { currencyCode: "EUR", ianaTimezone: "Europe/Lisbon" } };
        }
        const cursor = typeof variables?.cursor === "string" ? variables.cursor : null;
        const page = cursor ? Number(cursor.split("-")[1]) : 0;
        return {
          orders: {
            pageInfo: { hasNextPage: true, endCursor: `day-${page + 1}` },
            nodes: [dailyOrderNode(300 + page, "2026-08-13T10:00:00.000Z")],
          },
        };
      },
    );
    const adapter = await createShopifyReportingAdapter(source());

    await expect(
      adapter.fetchDailySales("2026-08-13", "2026-08-13"),
    ).rejects.toThrow(/single Shopify reporting day has too many orders/);
    expect(mocks.reportingShopifyGraphql).toHaveBeenCalledTimes(11);
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

  it("loads exact-range funnel, campaign attribution and official collection membership", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_orders", "read_products", "read_reports"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
        const shopifyQl = String(variables?.query ?? "");
        if (shopifyQl.includes("FROM sessions")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "sessions_that_completed_checkout" },
                  { name: "day" },
                  { name: "sessions_with_cart_additions" },
                  { name: "sessions" },
                  { name: "sessions_that_reached_checkout" },
                ],
                rows: [["8", "2026-08-13", "44", "200", "19"]],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM campaign_sales")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "utm_campaign" },
                  { name: "referring_platform" },
                  { name: "day" },
                  { name: "campaign_last_non_direct_click_total_sales" },
                  { name: "campaign_last_non_direct_click_order_count" },
                ],
                rows: [
                  {
                    utm_campaign: "123456789",
                    referring_platform: "Google",
                    day: "2026-08-13",
                    campaign_last_non_direct_click_total_sales: "625.50",
                    campaign_last_non_direct_click_order_count: "8",
                  },
                  {
                    utm_campaign: "123456789",
                    referring_platform: "Meta",
                    day: "2026-08-13",
                    campaign_last_non_direct_click_total_sales: "999",
                    campaign_last_non_direct_click_order_count: "99",
                  },
                  {
                    utm_campaign: 123456789,
                    referring_platform: "Google",
                    day: "2026-08-13",
                    campaign_last_non_direct_click_total_sales: "999",
                    campaign_last_non_direct_click_order_count: "99",
                  },
                ],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM campaign_sessions")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "utm_campaign" },
                  { name: "referring_platform" },
                  { name: "day" },
                  { name: "sessions" },
                ],
                rows: [
                  {
                    utm_campaign: "123456789",
                    referring_platform: "Google",
                    day: "2026-08-13",
                    sessions: "190",
                  },
                ],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM campaign_products")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "utm_campaign" },
                  { name: "referring_platform" },
                  { name: "product_id" },
                  { name: "product_title" },
                  { name: "day" },
                  { name: "campaign_last_non_direct_click_net_items_sold" },
                ],
                rows: [
                  {
                    utm_campaign: "123456789",
                    referring_platform: "Google",
                    product_id: "gid://shopify/Product/10",
                    product_title: "Summer Dress",
                    day: "2026-08-13",
                    campaign_last_non_direct_click_net_items_sold: "2",
                  },
                  {
                    utm_campaign: "123456789",
                    referring_platform: "Meta",
                    product_id: "gid://shopify/Product/10",
                    product_title: "Summer Dress",
                    day: "2026-08-13",
                    campaign_last_non_direct_click_net_items_sold: "99",
                  },
                  {
                    utm_campaign: 123456789,
                    referring_platform: "Google",
                    product_id: "gid://shopify/Product/10",
                    product_title: "Summer Dress",
                    day: "2026-08-13",
                    campaign_last_non_direct_click_net_items_sold: "99",
                  },
                ],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM sales")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "product_id" },
                  { name: "day" },
                  { name: "net_sales" },
                  { name: "net_items_sold" },
                ],
                rows: [["10", "2026-08-13", "120.50", "2"]],
              },
              parseErrors: [],
            },
          };
        }
        if (query.includes("DropscaleCollectionProducts")) {
          return {
            nodes: [{
              __typename: "Product",
              id: "gid://shopify/Product/10",
              title: "Summer Dress",
              collections: {
                pageInfo: { hasNextPage: false },
                nodes: [{ id: "gid://shopify/Collection/20", title: "Summer" }],
              },
            }],
          };
        }
        throw new Error("Unexpected reporting query");
      },
    );

    const adapter = await createShopifyReportingAdapter(source());
    await expect(adapter.fetchFunnel("2026-08-13", "2026-08-13")).resolves.toEqual([
      {
        day: "2026-08-13",
        sessions: 200,
        addedToCart: 44,
        reachedCheckout: 19,
        completedCheckout: 8,
      },
    ]);
    await expect(
      adapter.fetchCampaignAttribution("2026-08-13", "2026-08-13"),
    ).resolves.toEqual([
      {
        campaignId: "123456789",
        attributionModel: "last_non_direct_click",
        sessions: 190,
        revenue: 625.5,
        orders: 8,
      },
    ]);
    await expect(
      adapter.fetchCampaignProducts("2026-08-13", "2026-08-13"),
    ).resolves.toEqual([
      {
        campaignId: "123456789",
        productId: "gid://shopify/Product/10",
        title: "Summer Dress",
        attributionModel: "last_non_direct_click",
        units: 2,
      },
    ]);
    await expect(
      adapter.fetchCollectionSales("2026-08-13", "2026-08-13"),
    ).resolves.toEqual([
      {
        collectionId: "gid://shopify/Collection/20",
        title: "Summer",
        revenue: 120.5,
        units: 2,
        products: [
          {
            productId: "gid://shopify/Product/10",
            title: "Summer Dress",
            revenue: 120.5,
            units: 2,
          },
        ],
      },
    ]);

    const exactQueries = mocks.reportingShopifyGraphql.mock.calls
      .map(([input]) => String(input.variables?.query ?? ""))
      .filter(Boolean);
    expect(exactQueries).toHaveLength(5);
    expect(exactQueries.every((query) => query.includes("SINCE 2026-08-13"))).toBe(true);
    expect(exactQueries.every((query) => query.includes("UNTIL 2026-08-13"))).toBe(true);
  });

  it("fills leading, middle and trailing zero days in the exact funnel range", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_reports"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    mocks.reportingShopifyGraphql.mockResolvedValue({
      shopifyqlQuery: {
        tableData: {
          columns: [
            { name: "day" },
            { name: "sessions" },
            { name: "sessions_with_cart_additions" },
            { name: "sessions_that_reached_checkout" },
            { name: "sessions_that_completed_checkout" },
          ],
          rows: [
            ["2026-03-31", "20", "4", "2", "1"],
            ["2026-03-29", "10", "2", "1", "0"],
          ],
        },
        parseErrors: [],
      },
    });
    const adapter = await createShopifyReportingAdapter(source());

    await expect(adapter.fetchFunnel("2026-03-28", "2026-04-01")).resolves.toEqual([
      {
        day: "2026-03-28",
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        completedCheckout: 0,
      },
      {
        day: "2026-03-29",
        sessions: 10,
        addedToCart: 2,
        reachedCheckout: 1,
        completedCheckout: 0,
      },
      {
        day: "2026-03-30",
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        completedCheckout: 0,
      },
      {
        day: "2026-03-31",
        sessions: 20,
        addedToCart: 4,
        reachedCheckout: 2,
        completedCheckout: 1,
      },
      {
        day: "2026-04-01",
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        completedCheckout: 0,
      },
    ]);
  });

  it("fails closed on ShopifyQL parse errors instead of returning an empty funnel", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_reports"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    mocks.reportingShopifyGraphql.mockResolvedValue({
      shopifyqlQuery: {
        tableData: null,
        parseErrors: [{ message: "unsupported field" }],
      },
    });
    const adapter = await createShopifyReportingAdapter(source());

    await expect(adapter.fetchFunnel("2026-08-13", "2026-08-13")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    {
      label: "duplicate",
      rows: [
        ["2026-08-13", "1", "0", "0", "0"],
        ["2026-08-13", "2", "0", "0", "0"],
      ],
    },
    {
      label: "out-of-range",
      rows: [["2026-08-12", "1", "0", "0", "0"]],
    },
  ])("fails closed on $label Shopify funnel days", async ({ rows }) => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_reports"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    mocks.reportingShopifyGraphql.mockResolvedValue({
      shopifyqlQuery: {
        tableData: {
          columns: [
            { name: "day" },
            { name: "sessions" },
            { name: "sessions_with_cart_additions" },
            { name: "sessions_that_reached_checkout" },
            { name: "sessions_that_completed_checkout" },
          ],
          rows,
        },
        parseErrors: [],
      },
    });
    const adapter = await createShopifyReportingAdapter(source());

    await expect(adapter.fetchFunnel("2026-08-13", "2026-08-13")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("uses Shopify reporting days for collection sales across a DST boundary", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_reports", "read_products"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
        const shopifyQl = String(variables?.query ?? "");
        if (shopifyQl.includes("FROM sales")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "day" },
                  { name: "product_id" },
                  { name: "net_sales" },
                  { name: "net_items_sold" },
                ],
                rows: [["2026-03-29", "10", "50", "1"]],
              },
              parseErrors: [],
            },
          };
        }
        if (query.includes("DropscaleCollectionProducts")) {
          return {
            nodes: [{
              __typename: "Product",
              id: "gid://shopify/Product/10",
              title: "DST Lamp",
              collections: {
                pageInfo: { hasNextPage: false },
                nodes: [{ id: "gid://shopify/Collection/20", title: "Lamps" }],
              },
            }],
          };
        }
        throw new Error("Unexpected reporting query");
      },
    );
    const adapter = await createShopifyReportingAdapter(source());

    await expect(
      adapter.fetchCollectionSales("2026-03-29", "2026-03-29"),
    ).resolves.toMatchObject([{ revenue: 50, units: 1 }]);

    const salesQuery = mocks.reportingShopifyGraphql.mock.calls
      .map(([input]) => String(input.variables?.query ?? ""))
      .find((query) => query.includes("FROM sales"));
    expect(salesQuery).toContain("TIMESERIES day");
    expect(salesQuery).toContain("SINCE 2026-03-29");
    expect(salesQuery).toContain("UNTIL 2026-03-29");
    expect(salesQuery).not.toContain("processed_at");
    expect(JSON.stringify(mocks.reportingShopifyGraphql.mock.calls)).not.toContain(
      "T23:59:59Z",
    );
  });

  it("splits every bounded ShopifyQL family without overlapping a long range", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_reports", "read_products"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    const sentinelRows = Array.from({ length: 1000 }, () => ({}));
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
        const shopifyQl = String(variables?.query ?? "");
        const fullYear =
          shopifyQl.includes("SINCE 2026-01-01") &&
          shopifyQl.includes("UNTIL 2026-12-31");
        if (fullYear) {
          return {
            shopifyqlQuery: {
              tableData: { columns: [], rows: sentinelRows },
              parseErrors: [],
            },
          };
        }
        const left = shopifyQl.includes("UNTIL 2026-07-02");
        if (shopifyQl.includes("FROM sessions")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "day" },
                  { name: "sessions" },
                  { name: "sessions_with_cart_additions" },
                  { name: "sessions_that_reached_checkout" },
                  { name: "sessions_that_completed_checkout" },
                ],
                rows: [[
                  left ? "2026-03-01" : "2026-09-01",
                  left ? "10" : "20",
                  left ? "2" : "4",
                  left ? "1" : "2",
                  left ? "0" : "1",
                ]],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM campaign_sales")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "utm_campaign" },
                  { name: "referring_platform" },
                  { name: "day" },
                  { name: "campaign_last_non_direct_click_total_sales" },
                  { name: "campaign_last_non_direct_click_order_count" },
                ],
                rows: [{
                  utm_campaign: "123456789",
                  referring_platform: "Google",
                  day: left ? "2026-03-01" : "2026-09-01",
                  campaign_last_non_direct_click_total_sales: left ? "100" : "200",
                  campaign_last_non_direct_click_order_count: left ? "1" : "2",
                }],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM campaign_sessions")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "utm_campaign" },
                  { name: "referring_platform" },
                  { name: "day" },
                  { name: "sessions" },
                ],
                rows: [{
                  utm_campaign: "123456789",
                  referring_platform: "Google",
                  day: left ? "2026-03-01" : "2026-09-01",
                  sessions: left ? "5" : "7",
                }],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM campaign_products")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "utm_campaign" },
                  { name: "referring_platform" },
                  { name: "product_id" },
                  { name: "product_title" },
                  { name: "day" },
                  { name: "campaign_last_non_direct_click_net_items_sold" },
                ],
                rows: [{
                  utm_campaign: "123456789",
                  referring_platform: "Google",
                  product_id: "10",
                  product_title: "Lamp",
                  day: left ? "2026-03-01" : "2026-09-01",
                  campaign_last_non_direct_click_net_items_sold: left ? "1" : "2",
                }],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM sales")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "product_id" },
                  { name: "day" },
                  { name: "net_sales" },
                  { name: "net_items_sold" },
                ],
                rows: [[
                  "10",
                  left ? "2026-03-01" : "2026-09-01",
                  left ? "50" : "75",
                  left ? "1" : "2",
                ]],
              },
              parseErrors: [],
            },
          };
        }
        if (query.includes("DropscaleCollectionProducts")) {
          return {
            nodes: [{
              __typename: "Product",
              id: "gid://shopify/Product/10",
              title: "Lamp",
              collections: {
                pageInfo: { hasNextPage: false },
                nodes: [{ id: "gid://shopify/Collection/20", title: "Lamps" }],
              },
            }],
          };
        }
        throw new Error("Unexpected reporting query");
      },
    );
    const adapter = await createShopifyReportingAdapter(source());

    await expect(
      adapter.fetchFunnel("2026-01-01", "2026-12-31"),
    ).resolves.toHaveLength(365);
    await expect(
      adapter.fetchCampaignAttribution("2026-01-01", "2026-12-31"),
    ).resolves.toMatchObject([{ sessions: 12, orders: 3, revenue: 300 }]);
    await expect(
      adapter.fetchCampaignProducts("2026-01-01", "2026-12-31"),
    ).resolves.toMatchObject([{ units: 3 }]);
    await expect(
      adapter.fetchCollectionSales("2026-01-01", "2026-12-31"),
    ).resolves.toMatchObject([{ revenue: 125, units: 3 }]);

    for (const family of [
      "FROM sessions",
      "FROM campaign_sales",
      "FROM campaign_sessions",
      "FROM campaign_products",
      "FROM sales",
    ]) {
      const queries = mocks.reportingShopifyGraphql.mock.calls
        .map(([input]) => String(input.variables?.query ?? ""))
        .filter((query) => query.includes(family));
      expect(queries).toHaveLength(3);
      expect(queries[0]).toContain("SINCE 2026-01-01");
      expect(queries[0]).toContain("UNTIL 2026-12-31");
      expect(queries[1]).toContain("SINCE 2026-01-01");
      expect(queries[1]).toContain("UNTIL 2026-07-02");
      expect(queries[2]).toContain("SINCE 2026-07-03");
      expect(queries[2]).toContain("UNTIL 2026-12-31");
    }
  });

  it.each(["funnel", "campaign", "campaign products", "collection sales"] as const)(
    "fails closed when one day overflows %s",
    async (operation) => {
      mocks.verifyReportingShop.mockResolvedValue(
        verifiedShop({
          scopes: {
            granted: ["read_reports", "read_products"],
            missing: [],
            missingPermissionGated: [],
            writeScopes: [],
            unexpectedReadScopes: [],
            valid: true,
          },
        }),
      );
      mocks.reportingShopifyGraphql.mockResolvedValue({
        shopifyqlQuery: {
          tableData: {
            columns: [],
            rows: Array.from({ length: 1000 }, () => ({})),
          },
          parseErrors: [],
        },
      });
      const adapter = await createShopifyReportingAdapter(source());
      const request = operation === "funnel"
        ? adapter.fetchFunnel("2026-08-13", "2026-08-13")
        : operation === "campaign"
          ? adapter.fetchCampaignAttribution("2026-08-13", "2026-08-13")
          : operation === "campaign products"
            ? adapter.fetchCampaignProducts("2026-08-13", "2026-08-13")
            : adapter.fetchCollectionSales("2026-08-13", "2026-08-13");

      await expect(request).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  it("keeps a missing reports scope explicit instead of returning zero funnel data", async () => {
    const adapter = await createShopifyReportingAdapter(source());
    await expect(adapter.fetchFunnel("2026-08-13", "2026-08-13")).rejects.toMatchObject({
      code: "missing_scope",
    });
  });

  it("converts JPY campaign and collection revenue to the account currency by day", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        currencyCode: "JPY",
        scopes: {
          granted: ["read_orders", "read_products", "read_reports"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    mocks.fxDailyRates.mockResolvedValue([["2026-08-13", 0.006]]);
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
        const shopifyQl = String(variables?.query ?? "");
        if (shopifyQl.includes("FROM campaign_sales")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "utm_campaign" },
                  { name: "referring_platform" },
                  { name: "day" },
                  { name: "campaign_last_non_direct_click_total_sales" },
                  { name: "campaign_last_non_direct_click_order_count" },
                ],
                rows: [{
                  utm_campaign: "123456789",
                  referring_platform: "Google",
                  day: "2026-08-13",
                  campaign_last_non_direct_click_total_sales: "100000",
                  campaign_last_non_direct_click_order_count: "2",
                }],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM campaign_sessions")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [],
                rows: [],
              },
              parseErrors: [],
            },
          };
        }
        if (shopifyQl.includes("FROM sales")) {
          return {
            shopifyqlQuery: {
              tableData: {
                columns: [
                  { name: "product_id" },
                  { name: "day" },
                  { name: "net_sales" },
                  { name: "net_items_sold" },
                ],
                rows: [["gid://shopify/Product/10", "2026-08-13", "50000", "1"]],
              },
              parseErrors: [],
            },
          };
        }
        if (query.includes("DropscaleCollectionProducts")) {
          return {
            nodes: [{
              __typename: "Product",
              id: "gid://shopify/Product/10",
              title: "Lamp",
              collections: {
                pageInfo: { hasNextPage: false },
                nodes: [{ id: "gid://shopify/Collection/20", title: "Lamps" }],
              },
            }],
          };
        }
        throw new Error("Unexpected reporting query");
      },
    );
    const jpySource = source({
      shopify: { ...source().shopify!, currency: "JPY" },
    });
    const adapter = await createShopifyReportingAdapter(jpySource);

    await expect(
      adapter.fetchCampaignAttribution("2026-08-13", "2026-08-13", "EUR"),
    ).resolves.toMatchObject([{ campaignId: "123456789", revenue: 600, orders: 2 }]);
    await expect(
      adapter.fetchCollectionSales("2026-08-13", "2026-08-13", "EUR"),
    ).resolves.toMatchObject([{ revenue: 300, products: [{ revenue: 300 }] }]);
    expect(mocks.fxDailyRates).toHaveBeenCalledWith(
      "JPY",
      "EUR",
      "2026-08-13",
      "2026-08-13",
    );
  });

  it("supports an exact legacy ILS shop reporting in EUR without exposing credentials", async () => {
    mocks.verifyReportingShop.mockResolvedValue(
      verifiedShop({
        currencyCode: "ILS",
        scopes: {
          granted: ["read_reports"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: true,
        },
      }),
    );
    mocks.fxDailyRates.mockResolvedValue([["2026-08-13", 0.25]]);
    mocks.reportingShopifyGraphql.mockImplementation(
      async ({ variables }: { variables?: Record<string, unknown> }) => {
        const query = String(variables?.query ?? "");
        return {
          shopifyqlQuery: {
            tableData: {
              columns: query.includes("campaign_sessions")
                ? []
                : [
                    { name: "utm_campaign" },
                    { name: "referring_platform" },
                    { name: "day" },
                    { name: "campaign_last_non_direct_click_total_sales" },
                    { name: "campaign_last_non_direct_click_order_count" },
                  ],
              rows: query.includes("campaign_sessions")
                ? []
                : [{
                    utm_campaign: "123456789",
                    referring_platform: "Google",
                    day: "2026-08-13",
                    campaign_last_non_direct_click_total_sales: "100",
                    campaign_last_non_direct_click_order_count: "1",
                  }],
            },
            parseErrors: [],
          },
        };
      },
    );
    const adapter = await createLegacyShopifyReportingAdapter({
      clientId: "70000000-0000-4000-8000-000000000002",
      adAccountId: "70000000-0000-4000-8000-000000000003",
      shopDomain: "northwind-demo.myshopify.com",
      currency: "EUR",
      shopifyClientId: "legacy-client-id",
      credentialCiphertext: CIPHERTEXT,
    });

    await expect(
      adapter.fetchCampaignAttribution("2026-08-13", "2026-08-13", "EUR"),
    ).resolves.toMatchObject([{ campaignId: "123456789", revenue: 25 }]);

    expect(mocks.decryptToken).toHaveBeenCalledWith(CIPHERTEXT);
    expect(mocks.resolveAdminToken).toHaveBeenCalledWith(
      "northwind-demo.myshopify.com",
      CLIENT_SECRET,
      "legacy-client-id",
    );
    expect(mocks.verifyReportingShop).toHaveBeenCalledWith({
      shopDomain: "northwind-demo.myshopify.com",
      accessToken: ACCESS_TOKEN,
    });
    expect(JSON.stringify(adapter)).not.toContain(CIPHERTEXT);
    expect(JSON.stringify(adapter)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(adapter)).not.toContain(ACCESS_TOKEN);
    expect(mocks.fxDailyRates).toHaveBeenCalledWith(
      "ILS",
      "EUR",
      "2026-08-13",
      "2026-08-13",
    );
  });
});
