import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  decryptToken: vi.fn(),
  createServiceClient: vi.fn(),
  exchange: vi.fn(),
  normalize: vi.fn((value: string) => value),
  verify: vi.fn(),
}));

vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decryptToken }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("./shopify", async (importOriginal) => {
  const original = await importOriginal<typeof import("./shopify")>();
  return {
    ...original,
    exchangeAuditClientCredentials: mocks.exchange,
    normalizeAuditShopDomain: mocks.normalize,
    verifyAuditShop: mocks.verify,
  };
});

import {
  createLaraPriorityQuarantineRuntime,
  LARA_PRIORITY_PRODUCT_DRAFT_MUTATION,
  LARA_PRIORITY_PRODUCT_QUERY,
} from "./shopify-priority-quarantine-runtime";

const PRODUCT = {
  id: "gid://shopify/Product/1001",
  handle: "tila-marije-prirodni-caj-za-opustanje",
  title: "Protected title",
  status: "ACTIVE",
  updatedAt: "2026-08-12T17:00:00.000Z",
  vendor: "Lara Rovinj",
};

function connection(scopes = ["read_products", "write_products"]) {
  return {
    id: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    status: "connected",
    shopify_shop_id: "gid://shopify/Shop/95462097276",
    shopify_domain: "jwmtjg-fm.myshopify.com",
    shopify_client_id: "client-id-long-enough",
    granted_scopes: scopes,
    audit_shopify_credentials: { client_secret_ciphertext: "encrypted" },
  };
}

function serviceReturning(row: ReturnType<typeof connection>) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  mocks.createServiceClient.mockReturnValue({ from });
}

function shopifyResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "x-shopify-api-version": "2026-07" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceReturning(connection());
  mocks.decryptToken.mockResolvedValue("decrypted-secret-long-enough");
  mocks.exchange.mockResolvedValue("temporary-access-token-long-enough");
  mocks.verify.mockResolvedValue({
    shopId: "gid://shopify/Shop/95462097276",
    myshopifyDomain: "jwmtjg-fm.myshopify.com",
    scopes: { granted: ["read_products", "write_products"] },
  });
});

describe("the dedicated Lara priority quarantine runtime", () => {
  it("exposes no GraphQL proxy and sends only id/status in its fixed mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(shopifyResponse({ data: { product: PRODUCT } }))
      .mockResolvedValueOnce(
        shopifyResponse({
          data: {
            productUpdate: {
              product: { ...PRODUCT, status: "DRAFT", updatedAt: "2026-08-12T18:00:00.000Z" },
              userErrors: [],
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await createLaraPriorityQuarantineRuntime();
    expect(Object.keys(runtime).sort()).toEqual([
      "connectionId",
      "quarantineProductToDraft",
      "readPriorityProduct",
      "shopDomain",
      "shopId",
    ]);
    await expect(runtime.readPriorityProduct(PRODUCT.handle)).resolves.toMatchObject(PRODUCT);
    await expect(runtime.quarantineProductToDraft(PRODUCT.id)).resolves.toMatchObject({
      id: PRODUCT.id,
      status: "DRAFT",
      vendor: "Lara Rovinj",
    });

    const readBody = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const mutationBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(readBody.query).toBe(LARA_PRIORITY_PRODUCT_QUERY);
    expect(mutationBody.query).toBe(LARA_PRIORITY_PRODUCT_DRAFT_MUTATION);
    expect(mutationBody.variables).toEqual({
      product: { id: PRODUCT.id, status: "DRAFT" },
    });
    expect(JSON.stringify(mutationBody.variables)).not.toContain("vendor");
  });

  it("fails closed before credential use when write_products is absent", async () => {
    serviceReturning(connection(["read_products"]));
    mocks.verify.mockResolvedValue({
      shopId: "gid://shopify/Shop/95462097276",
      myshopifyDomain: "jwmtjg-fm.myshopify.com",
      scopes: { granted: ["read_products"] },
    });

    await expect(createLaraPriorityQuarantineRuntime()).rejects.toMatchObject({
      code: "missing_write_products",
    });
    expect(mocks.decryptToken).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("treats an unconfirmed mutation response as ambiguous for reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("upstream failure", {
          status: 503,
          headers: { "x-shopify-api-version": "2026-07" },
        }),
      ),
    );
    const runtime = await createLaraPriorityQuarantineRuntime();
    await expect(runtime.quarantineProductToDraft(PRODUCT.id)).rejects.toMatchObject({
      code: "mutation_ambiguous",
    });
  });

  it("classifies Shopify userErrors as a definitive mutation rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        shopifyResponse({
          data: {
            productUpdate: {
              product: null,
              userErrors: [{ field: ["status"], message: "Rejected" }],
            },
          },
        }),
      ),
    );
    const runtime = await createLaraPriorityQuarantineRuntime();

    await expect(runtime.quarantineProductToDraft(PRODUCT.id)).rejects.toMatchObject({
      code: "mutation_rejected",
      retryable: false,
    });
  });

  it("keeps a no-userError malformed mutation snapshot ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        shopifyResponse({
          data: {
            productUpdate: {
              product: null,
              userErrors: [],
            },
          },
        }),
      ),
    );
    const runtime = await createLaraPriorityQuarantineRuntime();

    await expect(runtime.quarantineProductToDraft(PRODUCT.id)).rejects.toMatchObject({
      code: "mutation_ambiguous",
    });
  });
});
