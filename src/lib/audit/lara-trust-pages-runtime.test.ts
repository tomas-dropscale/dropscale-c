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
  LARA_CONTACT_PAGE_BODY_HTML,
  LARA_TRUST_PAGE_TARGETS,
} from "./lara-trust-pages";
import {
  createLaraTrustPagesRuntime,
  LARA_TRUST_PAGE_BODY_MUTATION,
  LARA_TRUST_PAGES_QUERY,
} from "./lara-trust-pages-runtime";
import {
  buildShopifyRemediationCas,
  LARA_ROVINJ_REMEDIATION_SHOP,
  remediationSha256,
  type PageBeforeSnapshot,
  type PageRemediationCas,
} from "./shopify-remediation-plan";

const CONTACT = {
  id: LARA_TRUST_PAGE_TARGETS[0].resourceId,
  title: LARA_TRUST_PAGE_TARGETS[0].title,
  handle: LARA_TRUST_PAGE_TARGETS[0].handle,
  body: "",
  templateSuffix: "contact",
  isPublished: true,
  publishedAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-11T10:00:00.000Z",
};

function connection(scopes = ["read_content", "write_content"]) {
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

async function expectationFor(page = CONTACT) {
  const state = {
    id: page.id,
    title: page.title,
    handle: page.handle,
    bodyHtml: page.body,
    templateSuffix: page.templateSuffix,
    isPublished: page.isPublished,
    publishedAt: page.publishedAt,
    updatedAt: page.updatedAt,
  };
  const snapshot: PageBeforeSnapshot = {
    kind: "page",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt: state.updatedAt,
    target: { resourceId: state.id, handle: state.handle },
    state: {
      title: state.title,
      bodyHtml: state.bodyHtml,
      templateSuffix: state.templateSuffix,
      isPublished: state.isPublished,
      publishedAt: state.publishedAt,
      updatedAt: state.updatedAt,
    },
  };
  const cas = (await buildShopifyRemediationCas(snapshot)) as PageRemediationCas;
  return {
    updatedAt: state.updatedAt,
    bodySha256: await remediationSha256(state.bodyHtml),
    protectedFieldsSha256: await remediationSha256(cas.protectedFields),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  serviceReturning(connection());
  mocks.decryptToken.mockResolvedValue("decrypted-secret-long-enough");
  mocks.exchange.mockResolvedValue("temporary-access-token-long-enough");
  mocks.verify.mockResolvedValue({
    shopId: "gid://shopify/Shop/95462097276",
    myshopifyDomain: "jwmtjg-fm.myshopify.com",
    scopes: { granted: ["read_content", "write_content"] },
  });
});

describe("the dedicated Lara trust-pages runtime", () => {
  it("exposes no GraphQL proxy and sends only the body in the fixed pageUpdate", async () => {
    const changed = {
      ...CONTACT,
      body: LARA_CONTACT_PAGE_BODY_HTML,
      updatedAt: "2026-08-12T19:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(shopifyResponse({ data: { nodes: [CONTACT] } }))
      .mockResolvedValueOnce(shopifyResponse({ data: { nodes: [CONTACT] } }))
      .mockResolvedValueOnce(
        shopifyResponse({
          data: { pageUpdate: { page: changed, userErrors: [] } },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await createLaraTrustPagesRuntime();
    expect(Object.keys(runtime).sort()).toEqual([
      "connectionId",
      "readPages",
      "replaceBodyIfUnchanged",
      "shopDomain",
      "shopId",
    ]);
    await expect(
      runtime.readPages({
        shop: LARA_ROVINJ_REMEDIATION_SHOP,
        resourceIds: [CONTACT.id],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: CONTACT.id, bodyHtml: CONTACT.body }),
    ]);
    await expect(
      runtime.replaceBodyIfUnchanged({
        shop: LARA_ROVINJ_REMEDIATION_SHOP,
        target: { resourceId: CONTACT.id, handle: CONTACT.handle },
        expected: await expectationFor(),
        bodyHtml: LARA_CONTACT_PAGE_BODY_HTML,
      }),
    ).resolves.toMatchObject({
      status: "written",
      before: { id: CONTACT.id, bodyHtml: "" },
      after: { id: CONTACT.id, bodyHtml: LARA_CONTACT_PAGE_BODY_HTML },
    });

    const readBody = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const mutationBody = JSON.parse(String(fetchMock.mock.calls[2]![1]!.body));
    expect(readBody).toEqual({ query: LARA_TRUST_PAGES_QUERY, variables: { ids: [CONTACT.id] } });
    expect(mutationBody).toEqual({
      query: LARA_TRUST_PAGE_BODY_MUTATION,
      variables: { id: CONTACT.id, page: { body: LARA_CONTACT_PAGE_BODY_HTML } },
    });
    expect(Object.keys(mutationBody.variables.page)).toEqual(["body"]);
  });

  it("re-reads and rejects a CAS mismatch before mutation", async () => {
    const concurrent = {
      ...CONTACT,
      body: "<p>Concurrent merchant edit</p>",
      updatedAt: "2026-08-12T18:59:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(shopifyResponse({ data: { nodes: [concurrent] } }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraTrustPagesRuntime();

    await expect(
      runtime.replaceBodyIfUnchanged({
        shop: LARA_ROVINJ_REMEDIATION_SHOP,
        target: { resourceId: CONTACT.id, handle: CONTACT.handle },
        expected: await expectationFor(),
        bodyHtml: LARA_CONTACT_PAGE_BODY_HTML,
      }),
    ).resolves.toMatchObject({
      status: "cas_mismatch",
      current: {
        id: concurrent.id,
        bodyHtml: concurrent.body,
        updatedAt: concurrent.updatedAt,
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects any page outside the two fixed ids before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraTrustPagesRuntime();

    await expect(
      runtime.readPages({
        shop: LARA_ROVINJ_REMEDIATION_SHOP,
        resourceIds: ["gid://shopify/Page/999999"],
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [["write_content"], "missing_read_content"],
    [["read_content"], "missing_write_content"],
  ] as const)("fails closed for missing required scopes", async (scopes, code) => {
    serviceReturning(connection([...scopes]));
    mocks.verify.mockResolvedValue({
      shopId: "gid://shopify/Shop/95462097276",
      myshopifyDomain: "jwmtjg-fm.myshopify.com",
      scopes: { granted: [...scopes] },
    });

    await expect(createLaraTrustPagesRuntime()).rejects.toMatchObject({ code });
    expect(mocks.decryptToken).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("treats an unconfirmed mutation response as ambiguous for reconciliation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(shopifyResponse({ data: { nodes: [CONTACT] } }))
      .mockResolvedValueOnce(
        new Response("upstream failure", {
          status: 503,
          headers: { "x-shopify-api-version": "2026-07" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraTrustPagesRuntime();

    await expect(
      runtime.replaceBodyIfUnchanged({
        shop: LARA_ROVINJ_REMEDIATION_SHOP,
        target: { resourceId: CONTACT.id, handle: CONTACT.handle },
        expected: await expectationFor(),
        bodyHtml: LARA_CONTACT_PAGE_BODY_HTML,
      }),
    ).rejects.toMatchObject({ code: "mutation_ambiguous" });
  });

  it("treats a successful response with an invalid returned page as mutation-ambiguous", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(shopifyResponse({ data: { nodes: [CONTACT] } }))
      .mockResolvedValueOnce(
        shopifyResponse({
          data: {
            pageUpdate: {
              page: { ...CONTACT, id: "gid://shopify/Page/999999" },
              userErrors: [],
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraTrustPagesRuntime();

    await expect(
      runtime.replaceBodyIfUnchanged({
        shop: LARA_ROVINJ_REMEDIATION_SHOP,
        target: { resourceId: CONTACT.id, handle: CONTACT.handle },
        expected: await expectationFor(),
        bodyHtml: LARA_CONTACT_PAGE_BODY_HTML,
      }),
    ).rejects.toMatchObject({ code: "mutation_ambiguous" });
  });

  it("treats a mutation response with an unexpected API-version header as ambiguous", async () => {
    const wrongVersion = new Response(
      JSON.stringify({
        data: {
          pageUpdate: {
            page: {
              ...CONTACT,
              body: LARA_CONTACT_PAGE_BODY_HTML,
              updatedAt: "2026-08-12T19:00:00.000Z",
            },
            userErrors: [],
          },
        },
      }),
      { status: 200, headers: { "x-shopify-api-version": "2026-04" } },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(shopifyResponse({ data: { nodes: [CONTACT] } }))
      .mockResolvedValueOnce(wrongVersion);
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraTrustPagesRuntime();

    await expect(
      runtime.replaceBodyIfUnchanged({
        shop: LARA_ROVINJ_REMEDIATION_SHOP,
        target: { resourceId: CONTACT.id, handle: CONTACT.handle },
        expected: await expectationFor(),
        bodyHtml: LARA_CONTACT_PAGE_BODY_HTML,
      }),
    ).rejects.toMatchObject({ code: "mutation_ambiguous" });
  });
});
