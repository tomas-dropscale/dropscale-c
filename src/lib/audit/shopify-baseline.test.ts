import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AUDIT_BASELINE_QUERY_MANIFEST,
  LARA_PRIORITY_PRODUCT_HANDLES,
  collectShopifyAuditBaseline,
  type AuditGraphqlExecutor,
} from "./shopify-baseline";

function priorityProduct(handle: string, index: number) {
  return {
    id: `gid://shopify/Product/${index + 1}`,
    handle,
    title: `Product ${index}`,
    status: "ACTIVE",
    vendor: "Lara Rovinj",
    productType: index === 0 ? "" : "Shoes",
    descriptionHtml:
      index === 0
        ? '<p>Description</p><p>{"client_secret":"json-secret-123"}</p>'
        : `<p>Description ${index}</p>`,
    updatedAt: "2026-08-12T10:00:00Z",
    publishedAt: "2026-08-11T10:00:00Z",
    category: null,
    seo: { title: null, description: null },
    options: [
      {
        id: `gid://shopify/ProductOption/${index + 1}`,
        name: "Title",
        position: 1,
        optionValues: [
          {
            id: `gid://shopify/ProductOptionValue/${index + 1}`,
            name: "Default Title",
            hasVariants: true,
          },
        ],
      },
    ],
    variantsCount: { count: 1, precision: "EXACT" },
    variants: {
      nodes: [
        {
          id: `gid://shopify/ProductVariant/${index + 1}`,
          title: "Default Title",
          sku: "",
          barcode: null,
          price: "39.95",
          compareAtPrice: "79.90",
          availableForSale: true,
          inventoryQuantity: 4,
          inventoryPolicy: "DENY",
          taxable: true,
          selectedOptions: [{ name: "Title", value: "Default Title" }],
          inventoryItem: {
            id: `gid://shopify/InventoryItem/${index + 1}`,
            tracked: false,
            requiresShipping: true,
            measurement: { weight: { value: 0, unit: "KILOGRAMS" } },
          },
          image:
            index === 0
              ? {
                  id: "gid://shopify/ProductImage/1",
                  altText: "Bearer abcd1234",
                  url: "https://cdn.shopify.com/image.jpg?access_token=image-secret",
                  width: 100,
                  height: 100,
                }
              : null,
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    media: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function successfulExecutor() {
  const pageCalls: Array<string | null> = [];
  const execute = vi.fn(async (document: string, variables?: Record<string, unknown>) => {
    if (document.includes("query AuditShopIdentity")) {
      return {
        shop: {
          id: "gid://shopify/Shop/95462097276",
          name: "Lara Rovinj",
          myshopifyDomain: "jwmtjg-fm.myshopify.com",
          primaryDomain: { host: "www.lararovinj.com", url: "https://www.lararovinj.com" },
          contactEmail: "info@lararovinj.com",
          currencyCode: "EUR",
          ianaTimezone: "Europe/Lisbon",
          shopOwnerName: "Marta Neto",
          shopAddress: {
            company: null,
            address1: "Rua Capitão Manuel Tavares",
            address2: null,
            city: "Cortegaça",
            province: "Aveiro",
            country: "Portugal",
            countryCodeV2: "PT",
            zip: "3885-232",
            phone: null,
          },
          countriesInShippingZones: { countryCodes: ["HR", "PT"], includeRestOfWorld: false },
        },
      };
    }
    if (document.includes("query AuditStoreCounts")) {
      return {
        productsCount: { count: 1_448, precision: "EXACT" },
        productVariantsCount: { count: 38_068, precision: "EXACT" },
        collectionsCount: { count: 39, precision: "EXACT" },
      };
    }
    if (document.includes("query AuditPriorityProduct")) {
      const handle = String(variables?.handle ?? "");
      const index = LARA_PRIORITY_PRODUCT_HANDLES.indexOf(
        handle as (typeof LARA_PRIORITY_PRODUCT_HANDLES)[number],
      );
      return { product: index >= 0 ? priorityProduct(handle, index) : null };
    }
    if (document.includes("query AuditLegalPolicies")) {
      return {
        shop: {
          shopPolicies: [
            {
              id: "gid://shopify/ShopPolicy/1",
              type: "REFUND_POLICY",
              title: "Refund policy",
              url: "https://www.lararovinj.com/policies/refund-policy",
              body: "<p>Imate 14 dana. Authorization: Bearer policy-secret-123</p>",
              updatedAt: "2026-08-11T10:00:00Z",
            },
          ],
        },
      };
    }
    if (document.includes("query AuditOnlineStorePages")) {
      pageCalls.push((variables?.after as string | null) ?? null);
      if (!variables?.after) {
        return {
          pages: {
            nodes: [
              {
                id: "gid://shopify/Page/1",
                handle: "kontakt",
                title: "Kontakt",
                body: "<p>info@lararovinj.com shpat_page-secret-123</p>",
                isPublished: true,
                publishedAt: "2026-08-11T10:00:00Z",
                templateSuffix: null,
                updatedAt: "2026-08-11T10:00:00Z",
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "page-1" },
          },
        };
      }
      return {
        pages: {
          nodes: [
            {
              id: "gid://shopify/Page/2",
              handle: "o-nama",
              title: "O nama",
              body: "<p>About</p>",
              isPublished: true,
              publishedAt: "2026-08-11T10:00:00Z",
              templateSuffix: null,
              updatedAt: "2026-08-11T10:00:00Z",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "page-2" },
        },
      };
    }
    if (document.includes("query AuditOnlineStoreMenus")) {
      return {
        menus: {
          nodes: [
            {
              id: "gid://shopify/Menu/1",
              handle: "footer",
              title: "Footer",
              items: [
                {
                  id: "gid://shopify/MenuItem/1",
                  title: "Contact",
                  type: "HTTP",
                  url: "https://www.lararovinj.com/contact?access_token=url-secret",
                  resourceId: null,
                  items: [],
                },
              ],
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "menu-1" },
        },
      };
    }
    if (document.includes("query AuditMainTheme")) {
      return {
        themes: {
          nodes: [
            {
              id: "gid://shopify/OnlineStoreTheme/186665468284",
              name: "symmetry",
              prefix: "t/2",
              role: "MAIN",
              themeStoreId: 785,
              updatedAt: "2026-08-12T10:00:00Z",
            },
          ],
        },
      };
    }
    if (document.includes("query AuditThemeFiles")) {
      return {
        theme: {
          files: {
            nodes: [
              {
                filename: "templates/index.json",
                checksumMd5: "index-md5",
                contentType: "application/json",
                size: "100",
                updatedAt: "2026-08-12T10:00:00Z",
              },
              {
                filename: "sections/main-product.liquid",
                checksumMd5: "product-md5",
                contentType: "application/x-liquid",
                size: "200",
                updatedAt: "2026-08-12T10:00:00Z",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "files-1" },
            userErrors: [],
          },
        },
      };
    }
    if (document.includes("query AuditThemeFileBodies")) {
      return {
        theme: {
          files: {
            nodes: [
              {
                filename: "templates/index.json",
                checksumMd5: "index-md5",
                contentType: "application/json",
                size: "100",
                updatedAt: "2026-08-12T10:00:00Z",
                body: {
                  __typename: "OnlineStoreThemeFileBodyText",
                  content:
                    'Lara Rovinj zatvara svoja vrata. client_secret="must-not-leak"',
                },
              },
              {
                filename: "sections/main-product.liquid",
                checksumMd5: "product-md5",
                contentType: "application/x-liquid",
                size: "200",
                updatedAt: "2026-08-12T10:00:00Z",
                body: {
                  __typename: "OnlineStoreThemeFileBodyText",
                  content: "<span class=stock-urgency__text>Posljednji komadi</span>",
                },
              },
            ],
            userErrors: [],
          },
        },
      };
    }
    throw new Error(`Unexpected query: ${document.slice(0, 80)}`);
  }) as unknown as AuditGraphqlExecutor;

  return { execute, pageCalls };
}

const ALL_SCOPES = [
  "read_products",
  "read_legal_policies",
  "read_online_store_pages",
  "read_online_store_navigation",
  "read_themes",
];

describe("Shopify audit baseline query boundary", () => {
  it("contains only named static queries and never a mutation/subscription", () => {
    for (const [name, document] of Object.entries(AUDIT_BASELINE_QUERY_MANIFEST)) {
      expect(name).toMatch(/^[a-z][a-zA-Z]+$/);
      expect(document).toMatch(/^#graphql\s+query\s+[A-Za-z]/);
      expect(document).not.toMatch(/\bmutation\b/i);
      expect(document).not.toMatch(/\bsubscription\b/i);
    }
  });

  it("collects bounded summaries, paginates pages and never persists theme source", async () => {
    const { execute, pageCalls } = successfulExecutor();
    const baseline = await collectShopifyAuditBaseline({
      execute,
      grantedScopes: ALL_SCOPES,
      now: () => new Date("2026-08-12T12:00:00Z"),
    });

    expect(baseline.generatedAt).toBe("2026-08-12T12:00:00.000Z");
    expect(baseline.queryManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline.shopIdentity).toMatchObject({
      id: "gid://shopify/Shop/95462097276",
      shopOwnerName: "Marta Neto",
    });
    expect(baseline.counts?.productVariantsCount.count).toBe(38_068);
    expect(pageCalls).toEqual([null, "page-1"]);
    expect(baseline.pages.map((page) => page.handle)).toEqual(["kontakt", "o-nama"]);
    expect(baseline.priorityProducts).toHaveLength(10);
    expect(baseline.priorityProducts.every((product) => product.found)).toBe(true);
    expect(baseline.theme?.sourceScan.matches.map((match) => match.filename)).toEqual([
      "templates/index.json",
      "sections/main-product.liquid",
    ]);

    const serialized = JSON.stringify(baseline);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("client_secret=\"");
    expect(serialized).not.toContain("json-secret-123");
    expect(serialized).not.toContain("policy-secret-123");
    expect(serialized).not.toContain("page-secret-123");
    expect(serialized).not.toContain("image-secret");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("abcd1234");
    expect(serialized).not.toContain(
      'Lara Rovinj zatvara svoja vrata. client_secret="must-not-leak"',
    );
  });

  it("accepts read_content as Shopify's alternative Page read grant", async () => {
    const { execute } = successfulExecutor();
    const scopes = ALL_SCOPES.filter(
      (scope) => scope !== "read_online_store_pages",
    ).concat("read_content");

    const baseline = await collectShopifyAuditBaseline({
      execute,
      grantedScopes: scopes,
    });

    expect(baseline.modules.pages).toMatchObject({ status: "complete" });
    expect(baseline.pages.map((page) => page.handle)).toEqual(["kontakt", "o-nama"]);
  });

  it("scans an explicitly textual JavaScript asset when it is the only marker source", async () => {
    const { execute: base } = successfulExecutor();
    const execute = vi.fn(async (document: string, variables?: Record<string, unknown>) => {
      if (document.includes("query AuditThemeFiles")) {
        return {
          theme: {
            files: {
              nodes: [
                {
                  filename: "assets/theme.js",
                  checksumMd5: "theme-js-md5",
                  contentType: "application/javascript",
                  size: "120",
                  updatedAt: "2026-08-12T10:00:00Z",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "files-1" },
              userErrors: [],
            },
          },
        };
      }
      if (document.includes("query AuditThemeFileBodies")) {
        expect(variables?.filenames).toEqual(["assets/theme.js"]);
        return {
          theme: {
            files: {
              nodes: [
                {
                  filename: "assets/theme.js",
                  checksumMd5: "theme-js-md5",
                  contentType: "application/javascript",
                  size: "120",
                  updatedAt: "2026-08-12T10:00:00Z",
                  body: {
                    __typename: "OnlineStoreThemeFileBodyText",
                    content: "function updateStockUrgency() { return true; }",
                  },
                },
              ],
              userErrors: [],
            },
          },
        };
      }
      return base(document, variables);
    }) as unknown as AuditGraphqlExecutor;

    const baseline = await collectShopifyAuditBaseline({
      execute,
      grantedScopes: ALL_SCOPES,
    });

    expect(baseline.theme?.sourceScan).toMatchObject({
      candidateCount: 1,
      scannedCount: 1,
      scanComplete: true,
      matches: [
        {
          filename: "assets/theme.js",
          markers: [{ marker: "updateStockUrgency" }],
        },
      ],
    });
    expect(baseline.auditStatus).toBe("complete");
    expect(JSON.stringify(baseline)).not.toContain(
      "function updateStockUrgency() { return true; }",
    );
  });

  it("blocks scoped modules without attempting their queries", async () => {
    const execute = vi.fn(async (document: string) => {
      if (!document.includes("query AuditShopIdentity")) {
        throw new Error("A scoped query was unexpectedly attempted.");
      }
      return {
        shop: {
          id: "gid://shopify/Shop/95462097276",
          name: "Lara Rovinj",
          myshopifyDomain: "jwmtjg-fm.myshopify.com",
          primaryDomain: { host: "www.lararovinj.com", url: "https://www.lararovinj.com" },
          contactEmail: "info@lararovinj.com",
          currencyCode: "EUR",
          ianaTimezone: "Europe/Lisbon",
          shopOwnerName: "Marta Neto",
          shopAddress: {
            company: null,
            address1: null,
            address2: null,
            city: null,
            province: null,
            country: null,
            countryCodeV2: null,
            zip: null,
            phone: null,
          },
          countriesInShippingZones: { countryCodes: [], includeRestOfWorld: false },
        },
      };
    }) as unknown as AuditGraphqlExecutor;

    const baseline = await collectShopifyAuditBaseline({ execute, grantedScopes: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(baseline.modules.shopIdentity).toMatchObject({ status: "complete" });
    expect(baseline.modules.counts).toEqual({
      status: "blocked_missing_scope",
      missingScopes: ["read_products"],
      requests: 0,
    });
    expect(baseline.modules.theme).toMatchObject({
      status: "blocked_missing_scope",
      missingScopes: ["read_themes"],
    });
  });

  it("isolates one failed optional module and continues the remaining baseline", async () => {
    const { execute: base } = successfulExecutor();
    const execute = vi.fn(async (document: string, variables?: Record<string, unknown>) => {
      if (document.includes("query AuditLegalPolicies")) {
        throw Object.assign(new Error("No policy response."), { code: "policy_unavailable" });
      }
      return base(document, variables);
    }) as unknown as AuditGraphqlExecutor;

    const baseline = await collectShopifyAuditBaseline({
      execute,
      grantedScopes: ALL_SCOPES,
    });
    expect(baseline.modules.policies).toEqual({
      status: "failed",
      requests: 1,
      errorCode: "policy_unavailable",
      retryable: false,
    });
    expect(baseline.auditStatus).toBe("partial");
    expect(baseline.modules.theme).toMatchObject({ status: "complete" });
    expect(baseline.priorityProducts).toHaveLength(10);
  });
});
