import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  decrypt: vi.fn(async () => "s".repeat(32)),
  exchange: vi.fn(async () => "a".repeat(32)),
  verify: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ from: mocks.from }),
}));
vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decrypt }));
vi.mock("./shopify", async () => {
  const actual = await vi.importActual<typeof import("./shopify")>("./shopify");
  return {
    ...actual,
    exchangeAuditClientCredentials: mocks.exchange,
    verifyAuditShop: mocks.verify,
  };
});

import {
  LARA_PRICING_LIVE_GRAPHQL_MANIFEST,
  LaraPricingLiveRuntimeError,
  createLaraPricingLiveRuntime,
} from "./lara-pricing-live-runtime";
import {
  LARA_PRICING_API_VERSION,
  LARA_PRICING_CATALOG_BULK_QUERY,
} from "./lara-pricing-sale-plan";
import { LaraPricingMutationAmbiguousError } from "./lara-pricing-sale-executor";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";

function connection(scopes = ["read_products", "write_products"]) {
  return {
    id: LARA_AUDIT_CONNECTION.connectionId,
    status: "connected",
    shopify_shop_id: LARA_AUDIT_CONNECTION.shopId,
    shopify_domain: LARA_AUDIT_CONNECTION.shopDomain,
    shopify_client_id: "client-id-123",
    granted_scopes: scopes,
    audit_shopify_credentials: { client_secret_ciphertext: "sealed" },
  };
}

function installConnection(row = connection()) {
  const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  mocks.from.mockReturnValue({ select });
}

function graphqlResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "x-shopify-api-version": LARA_PRICING_API_VERSION,
    },
  });
}

function bulk(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/BulkOperation/9001",
    type: "QUERY",
    status: "COMPLETED",
    errorCode: null,
    createdAt: "2026-08-12T20:00:00.000Z",
    completedAt: "2026-08-12T20:01:00.000Z",
    rootObjectCount: "1",
    objectCount: "2",
    fileSize: "1",
    query: LARA_PRICING_CATALOG_BULK_QUERY,
    url: "https://storage.googleapis.com/shopify/opaque-result-file?X-Goog-Signature=private",
    partialDataUrl: null,
    ...overrides,
  };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  installConnection();
  mocks.verify.mockResolvedValue({
    shopId: LARA_AUDIT_CONNECTION.shopId,
    myshopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
    scopes: {
      granted: ["read_products", "write_products"],
      required: [],
      missing: [],
      extras: [],
      exact: true,
    },
  });
});

describe("Lara pricing live Shopify boundary", () => {
  it("exposes only fixed operations and starts the exact server-owned catalogue query", async () => {
    const fetchMock = vi.fn(async () =>
      graphqlResponse({
        data: {
          bulkOperationRunQuery: {
            bulkOperation: bulk({ status: "CREATED", completedAt: null, fileSize: null, url: null }),
            userErrors: [],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraPricingLiveRuntime();

    await expect(runtime.startCatalogueBulk()).resolves.toEqual(
      expect.objectContaining({ id: "gid://shopify/BulkOperation/9001", status: "CREATED" }),
    );
    expect(Object.keys(runtime).sort()).toEqual([
      "apiVersion",
      "clearCompareAtPricesAtomic",
      "connectionId",
      "downloadCompletedCatalogue",
      "grantedScopes",
      "pollCatalogueBulk",
      "readFullProduct",
      "recoverExactCatalogueStarts",
      "shopDomain",
      "shopId",
      "startCatalogueBulk",
    ]);
    const startCalls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    const init = startCalls[0]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      query: LARA_PRICING_LIVE_GRAPHQL_MANIFEST.startCatalogue,
      variables: {},
    });
    expect(init.redirect).toBe("manual");
  });

  it("recovers an ambiguous start only from a complete bounded exact-query listing", async () => {
    const requestedAfter = "2026-08-12T19:59:00.000Z";
    const fetchMock = vi.fn(async () =>
      graphqlResponse({
        data: {
          bulkOperations: {
            nodes: [bulk()],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraPricingLiveRuntime();
    await expect(runtime.recoverExactCatalogueStarts(requestedAfter)).resolves.toEqual([
      expect.objectContaining({ id: "gid://shopify/BulkOperation/9001" }),
    ]);
    const recoveryCalls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    const body = JSON.parse(String(recoveryCalls[0]?.[1]?.body));
    expect(body.query).toContain("first: 50");
    expect(body.variables).toEqual({
      query:
        "operation_type:query created_at:>=2026-08-12T19:54:00.000Z",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        graphqlResponse({
          data: {
            bulkOperations: {
              nodes: [bulk()],
              pageInfo: { hasNextPage: true },
            },
          },
        }),
      ),
    );
    await expect(runtime.recoverExactCatalogueStarts(requestedAfter)).rejects.toMatchObject({
      code: "graphql_error",
    });
  });

  it("distinguishes retryable capacity rejection from an ambiguous start acknowledgement", async () => {
    const runtime = await createLaraPricingLiveRuntime();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        graphqlResponse({
          data: {
            bulkOperationRunQuery: {
              bulkOperation: null,
              userErrors: [
                {
                  code: "LIMIT_REACHED",
                  field: null,
                  message: "try later",
                },
              ],
            },
          },
        }),
      ),
    );
    await expect(runtime.startCatalogueBulk()).rejects.toMatchObject({
      code: "bulk_start_rejected",
      retryable: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        graphqlResponse({
          data: {
            bulkOperationRunQuery: {
              bulkOperation: { id: "truncated" },
              userErrors: [],
            },
          },
        }),
      ),
    );
    await expect(runtime.startCatalogueBulk()).rejects.toMatchObject({
      code: "bulk_start_ambiguous",
      retryable: true,
    });
  });

  it("preserves a lowercase Unicode Shopify handle during the product CAS read", async () => {
    const fetchMock = vi.fn(async () =>
      graphqlResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            handle: "čarape-1",
            title: "Safe product",
            vendor: "Lara Rovinj",
            status: "ACTIVE",
            publishedAt: "2026-08-10T10:00:00.000Z",
            updatedAt: "2026-08-11T10:00:00.000Z",
            variants: {
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/11",
                  title: "Default Title",
                  price: "49.95",
                  compareAtPrice: "99.90",
                  updatedAt: "2026-08-11T10:00:00.000Z",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraPricingLiveRuntime();

    await expect(
      runtime.readFullProduct("gid://shopify/Product/1"),
    ).resolves.toMatchObject({ handle: "čarape-1" });
  });

  it("sends only id plus compareAtPrice null and distinguishes definite rejection from ambiguity", async () => {
    const accepted = vi.fn(async () =>
      graphqlResponse({
        data: {
          productVariantsBulkUpdate: {
            product: { id: "gid://shopify/Product/1", updatedAt: "2026-08-12T20:02:00Z" },
            productVariants: [
              {
                id: "gid://shopify/ProductVariant/11",
                price: "49.95",
                compareAtPrice: null,
                updatedAt: "2026-08-12T20:02:00Z",
              },
            ],
            userErrors: [],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", accepted);
    const runtime = await createLaraPricingLiveRuntime();
    await runtime.clearCompareAtPricesAtomic({
      productId: "gid://shopify/Product/1",
      variantIds: ["gid://shopify/ProductVariant/11"],
      allowPartialUpdates: false,
    });
    const mutationCalls = accepted.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    const body = JSON.parse(String(mutationCalls[0]?.[1].body));
    expect(body.variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [{ id: "gid://shopify/ProductVariant/11", compareAtPrice: null }],
    });
    expect(JSON.stringify(body.variables)).not.toMatch(/vendor|"price":/i);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        graphqlResponse({
          data: {
            productVariantsBulkUpdate: {
              product: null,
              productVariants: [],
              userErrors: [{ code: "INVALID", field: ["variants"], message: "no" }],
            },
          },
        }),
      ),
    );
    await expect(
      runtime.clearCompareAtPricesAtomic({
        productId: "gid://shopify/Product/1",
        variantIds: ["gid://shopify/ProductVariant/11"],
        allowPartialUpdates: false,
      }),
    ).rejects.toMatchObject({ code: "mutation_rejected", retryable: false });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("lost"))));
    await expect(
      runtime.clearCompareAtPricesAtomic({
        productId: "gid://shopify/Product/1",
        variantIds: ["gid://shopify/ProductVariant/11"],
        allowPartialUpdates: false,
      }),
    ).rejects.toBeInstanceOf(LaraPricingMutationAmbiguousError);
  });

  it.each([
    {
      label: "another host",
      resultUrl: "https://evil.example/shopify/opaque-result-file",
    },
    {
      label: "a near-match tier bucket",
      resultUrl:
        "https://storage.googleapis.com/shopify-tiers-assets-prod-us-east10/opaque-result-file?X-Goog-Signature=private",
    },
    {
      label: "another Google Storage bucket",
      resultUrl:
        "https://storage.googleapis.com/shopify-tiers-assets-prod-us-west1/opaque-result-file?X-Goog-Signature=private",
    },
    {
      label: "literal path traversal into an allowed bucket",
      resultUrl:
        "https://storage.googleapis.com/shopify-tiers-assets-prod-us-east1/../shopify/opaque-result-file?X-Goog-Signature=private",
    },
    {
      label: "encoded path traversal into an allowed bucket",
      resultUrl:
        "https://storage.googleapis.com/shopify-tiers-assets-prod-us-east1/%2e%2e/shopify/opaque-result-file?X-Goog-Signature=private",
    },
  ])("rejects $label without fetching it", async ({ resultUrl }) => {
    const fetchMock = vi.fn(async () =>
      graphqlResponse({ data: { bulkOperation: bulk({ url: resultUrl }) } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraPricingLiveRuntime();
    await expect(
      runtime.downloadCompletedCatalogue({
        operationId: "gid://shopify/BulkOperation/9001",
        capturedAt: "2026-08-12T20:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "bulk_download_invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      bucket: "shopify",
      resultUrl:
        "https://storage.googleapis.com/shopify/opaque-result-file?X-Goog-Signature=private",
    },
    {
      bucket: "shopify-tiers-assets-prod-us-east1",
      resultUrl:
        "https://storage.googleapis.com/shopify-tiers-assets-prod-us-east1/opaque-result-file?X-Goog-Signature=private",
    },
  ])(
    "streams, hashes and count-checks a direct credential-free JSONL result from $bucket",
    async ({ bucket, resultUrl }) => {
      const product = {
        id: "gid://shopify/Product/1",
        handle: "safe-product",
        title: "Safe product",
        vendor: "Lara Rovinj",
        status: "ACTIVE",
        publishedAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z",
      };
      const variant = {
        id: "gid://shopify/ProductVariant/11",
        title: "Default Title",
        price: "49.95",
        compareAtPrice: "99.90",
        updatedAt: "2026-08-11T10:00:00.000Z",
        __parentId: product.id,
      };
      const jsonl = `${JSON.stringify(product)}\n${JSON.stringify(variant)}\n`;
      const bytes = new TextEncoder().encode(jsonl).byteLength;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          graphqlResponse({
            data: { bulkOperation: bulk({ fileSize: String(bytes), url: resultUrl }) },
          }),
        )
        .mockResolvedValueOnce(
          new Response(jsonl, {
            status: 200,
            headers: {
              "content-length": String(bytes),
              "content-type": "application/octet-stream",
            },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const runtime = await createLaraPricingLiveRuntime();
      const downloaded = await runtime.downloadCompletedCatalogue({
        operationId: "gid://shopify/BulkOperation/9001",
        capturedAt: "2026-08-12T20:01:00.000Z",
      });

      expect(downloaded.byteLength).toBe(bytes);
      expect(downloaded.jsonlSha256).toBe(await sha256(jsonl));
      expect(downloaded.catalogue.counts).toEqual({
        products: 1,
        variants: 1,
        productsWithCompareAt: 1,
        variantsWithCompareAt: 1,
      });
      const downloadCall = fetchMock.mock.calls[1];
      const downloadUrl = downloadCall?.[0] as URL;
      const init = downloadCall?.[1] as RequestInit;
      expect(downloadUrl.hostname).toBe("storage.googleapis.com");
      expect(downloadUrl.pathname.split("/")[1]).toBe(bucket);
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).has("x-shopify-access-token")).toBe(false);
    },
  );

  it("fails closed when stored or freshly verified product scopes are missing", async () => {
    installConnection(connection(["read_products"]));
    await expect(createLaraPricingLiveRuntime()).rejects.toMatchObject({
      code: "missing_write_products",
    });
    expect(mocks.exchange).not.toHaveBeenCalled();

    installConnection(connection());
    mocks.verify.mockResolvedValueOnce({
      shopId: LARA_AUDIT_CONNECTION.shopId,
      myshopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
      scopes: { granted: ["read_products"], required: [], missing: [], extras: [], exact: false },
    });
    await expect(createLaraPricingLiveRuntime()).rejects.toBeInstanceOf(
      LaraPricingLiveRuntimeError,
    );
  });
});
