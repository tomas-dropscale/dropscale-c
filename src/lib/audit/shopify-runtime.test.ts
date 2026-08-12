import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  decryptToken: vi.fn(),
  eq: vi.fn(),
  from: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/google-ads/crypto", () => ({
  decryptToken: mocks.decryptToken,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { AUDIT_SHOPIFY_API_VERSION } from "./shopify";
import { REQUIRED_AUDIT_SHOPIFY_SCOPES } from "./shopify-scopes";
import {
  AuditShopifyRuntimeError,
  createAuditShopifyRuntime,
  defineAuditShopifyQuery,
} from "./shopify-runtime";

const CONNECTION_ID = "40000000-0000-4000-8000-000000000002";
const SHOP_ID = "gid://shopify/Shop/95462097276";
const SHOP_DOMAIN = "jwmtjg-fm.myshopify.com";
const CLIENT_ID = "audit-client-id-123456";
const CIPHERTEXT = "ciphertext-that-must-never-escape";
const CLIENT_SECRET = "client-secret-that-must-never-escape";
const ACCESS_TOKEN = "temporary-access-token-that-must-never-escape";

const SHOP_QUERY = defineAuditShopifyQuery(`query AuditShopIdentity {
  shop { id myshopifyDomain }
}`);

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    status: "connected",
    shopify_shop_id: SHOP_ID,
    shopify_domain: SHOP_DOMAIN,
    shopify_client_id: CLIENT_ID,
    granted_scopes: [...REQUIRED_AUDIT_SHOPIFY_SCOPES],
    audit_shopify_credentials: {
      client_secret_ciphertext: CIPHERTEXT,
    },
    ...overrides,
  };
}

function tokenResponse() {
  return new Response(
    JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 86_399 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function verifyResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      data: {
        shop: {
          id: SHOP_ID,
          name: "Lara Rovinj",
          myshopifyDomain: SHOP_DOMAIN,
          currencyCode: "EUR",
          primaryDomain: { host: "www.lararovinj.com" },
          ...overrides,
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
  );
}

function queryResponse(
  body: unknown = { data: { shop: { id: SHOP_ID, myshopifyDomain: SHOP_DOMAIN } } },
  init: ResponseInit = {},
) {
  const headers = new Headers(init.headers);
  if (!headers.has("x-shopify-api-version")) {
    headers.set("x-shopify-api-version", AUDIT_SHOPIFY_API_VERSION);
  }
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

function input(overrides: Partial<Parameters<typeof createAuditShopifyRuntime>[0]> = {}) {
  return {
    connectionId: CONNECTION_ID,
    expectedShopDomain: SHOP_DOMAIN,
    expectedShopId: SHOP_ID,
    allowedQueryDocuments: [SHOP_QUERY],
    ...overrides,
  };
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createServiceClient.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
  mocks.maybeSingle.mockResolvedValue({ data: connectionRow(), error: null });
  mocks.decryptToken.mockResolvedValue(CLIENT_SECRET);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connected audit Shopify runtime boundary", () => {
  it("loads one exact UUID, exchanges a fresh token, verifies, and hard-binds Lara", async () => {
    const fetchMock = stubFetch(tokenResponse(), verifyResponse());

    const runtime = await createAuditShopifyRuntime(input());

    expect(mocks.from).toHaveBeenCalledWith("audit_shopify_connections");
    expect(mocks.select).toHaveBeenCalledWith(
      "id, status, shopify_shop_id, shopify_domain, shopify_client_id, granted_scopes, audit_shopify_credentials(client_secret_ciphertext)",
    );
    expect(mocks.eq).toHaveBeenCalledWith("id", CONNECTION_ID);
    expect(mocks.maybeSingle).toHaveBeenCalledOnce();
    expect(mocks.decryptToken).toHaveBeenCalledWith(CIPHERTEXT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runtime).toMatchObject({
      connectionId: CONNECTION_ID,
      shopId: SHOP_ID,
      shopDomain: SHOP_DOMAIN,
      grantedScopes: [...REQUIRED_AUDIT_SHOPIFY_SCOPES].sort(),
    });

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(`https://${SHOP_DOMAIN}/admin/oauth/access_token`);
    const tokenForm = new URLSearchParams(String(tokenInit.body));
    expect(tokenForm.get("grant_type")).toBe("client_credentials");
    expect(tokenForm.get("client_id")).toBe(CLIENT_ID);
    expect(tokenForm.get("client_secret")).toBe(CLIENT_SECRET);

    const [, verifyInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(verifyInit.headers).toMatchObject({
      "x-shopify-access-token": ACCESS_TOKEN,
    });
  });

  it.each(["pending", "revoked"])(
    "rejects a %s connection before decrypting or contacting Shopify",
    async (status) => {
      mocks.maybeSingle.mockResolvedValue({
        data: connectionRow({ status, audit_shopify_credentials: null }),
        error: null,
      });
      const fetchMock = stubFetch();

      await expect(createAuditShopifyRuntime(input())).rejects.toMatchObject({
        code: "connection_not_connected",
      });
      expect(mocks.decryptToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("turns a thrown service-role lookup into a typed, retryable error", async () => {
    mocks.maybeSingle.mockRejectedValue(new Error(`database leaked ${CIPHERTEXT}`));

    let caught: unknown;
    try {
      await createAuditShopifyRuntime(input());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "database_error", retryable: true });
    expect(String(caught)).not.toContain(CIPHERTEXT);
  });

  it.each([
    {
      label: "domain",
      row: { shopify_domain: "another-store.myshopify.com" },
      code: "expected_domain_mismatch",
    },
    {
      label: "shop GID",
      row: { shopify_shop_id: "gid://shopify/Shop/111" },
      code: "expected_shop_id_mismatch",
    },
  ])("rejects a stored $label mismatch before decrypting", async ({ row, code }) => {
    mocks.maybeSingle.mockResolvedValue({ data: connectionRow(row), error: null });
    const fetchMock = stubFetch();

    await expect(createAuditShopifyRuntime(input())).rejects.toMatchObject({ code });
    expect(mocks.decryptToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a verified shop ID mismatch after the fresh verification", async () => {
    stubFetch(
      tokenResponse(),
      verifyResponse({ id: "gid://shopify/Shop/111" }),
    );

    await expect(createAuditShopifyRuntime(input())).rejects.toMatchObject({
      code: "verified_shop_id_mismatch",
    });
  });

  it("rejects a verified domain mismatch after the fresh verification", async () => {
    stubFetch(
      tokenResponse(),
      verifyResponse({ myshopifyDomain: "another-store.myshopify.com" }),
    );

    await expect(createAuditShopifyRuntime(input())).rejects.toMatchObject({
      code: "verified_domain_mismatch",
    });
  });

  it("rejects a changed Shopify grant instead of trusting stale stored scopes", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: connectionRow({ granted_scopes: ["read_products"] }),
      error: null,
    });
    stubFetch(tokenResponse(), verifyResponse());

    await expect(createAuditShopifyRuntime(input())).rejects.toMatchObject({
      code: "connection_record_invalid",
    });
  });

  it("fails closed with a sanitised error when decryption fails", async () => {
    mocks.decryptToken.mockRejectedValue(
      new Error(`could not decrypt ${CIPHERTEXT} into ${CLIENT_SECRET}`),
    );
    const fetchMock = stubFetch();

    let caught: unknown;
    try {
      await createAuditShopifyRuntime(input());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "credential_decrypt_failed" });
    expect(String(caught)).not.toContain(CIPHERTEXT);
    expect(String(caught)).not.toContain(CLIENT_SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps token rejection without returning Shopify's response or any secret", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: `invalid ${CLIENT_SECRET} ${CIPHERTEXT} ${ACCESS_TOKEN}`,
        }),
        { status: 401 },
      ),
    );

    let caught: unknown;
    try {
      await createAuditShopifyRuntime(input());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "token_exchange_failed" });
    const rendered = String(caught);
    expect(rendered).not.toContain(CIPHERTEXT);
    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).not.toContain(ACCESS_TOKEN);
  });
});

describe("fixed read-only audit GraphQL client", () => {
  it("uses API 2026-07 without redirects or cache and returns data only", async () => {
    const fetchMock = stubFetch(tokenResponse(), verifyResponse(), queryResponse());
    const runtime = await createAuditShopifyRuntime(input());

    const data = await runtime.query<{
      shop: { id: string; myshopifyDomain: string };
    }>(SHOP_QUERY);

    expect(data.shop).toEqual({ id: SHOP_ID, myshopifyDomain: SHOP_DOMAIN });
    const [url, request] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe(
      `https://${SHOP_DOMAIN}/admin/api/${AUDIT_SHOPIFY_API_VERSION}/graphql.json`,
    );
    expect(request).toMatchObject({
      method: "POST",
      redirect: "manual",
      cache: "no-store",
    });
    expect(request.headers).toMatchObject({
      "x-shopify-access-token": ACCESS_TOKEN,
    });

    const serialisedRuntime = JSON.stringify(runtime);
    expect(serialisedRuntime).not.toContain(CIPHERTEXT);
    expect(serialisedRuntime).not.toContain(CLIENT_SECRET);
    expect(serialisedRuntime).not.toContain(ACCESS_TOKEN);
    expect(Object.keys(runtime).sort()).toEqual([
      "connectionId",
      "grantedScopes",
      "query",
      "shopDomain",
      "shopId",
    ]);
  });

  it.each(["mutation", "subscription"])(
    "rejects a %s document before any network request",
    async (operation) => {
      expect(() =>
        defineAuditShopifyQuery(`${operation} UnsafeOperation { shop { id } }`),
      ).toThrow(AuditShopifyRuntimeError);

      const fetchMock = stubFetch(tokenResponse(), verifyResponse());
      const runtime = await createAuditShopifyRuntime(input());
      await expect(
        runtime.query(`${operation} UnsafeOperation { shop { id } }`),
      ).rejects.toMatchObject({ code: "invalid_query" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects anonymous operations because the document must begin with query", () => {
    let caught: unknown;
    try {
      defineAuditShopifyQuery("{ shop { id } }");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "invalid_query" });
  });

  it.each([undefined, "2027-01"])(
    "fails closed when Shopify serves API version %s",
    async (servedVersion) => {
      const headers = new Headers();
      if (servedVersion) headers.set("x-shopify-api-version", servedVersion);
      const query = new Response(JSON.stringify({ data: { shop: { id: SHOP_ID } } }), {
        status: 200,
        headers,
      });
      stubFetch(tokenResponse(), verifyResponse(), query);
      const runtime = await createAuditShopifyRuntime(input());

      await expect(runtime.query(SHOP_QUERY)).rejects.toMatchObject({
        code: "unsupported_api_version",
      });
    },
  );

  it("does not follow a redirect carrying the temporary access token", async () => {
    const fetchMock = stubFetch(
      tokenResponse(),
      verifyResponse(),
      new Response(null, {
        status: 302,
        headers: { location: "https://admin.shopify.com/store/another" },
      }),
    );
    const runtime = await createAuditShopifyRuntime(input());

    await expect(runtime.query(SHOP_QUERY)).rejects.toMatchObject({
      code: "query_redirect",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a read query that is not in the immutable caller manifest", async () => {
    const fetchMock = stubFetch(tokenResponse(), verifyResponse());
    const runtime = await createAuditShopifyRuntime(input());

    await expect(
      runtime.query("query DifferentRead { shop { name } }"),
    ).rejects.toMatchObject({ code: "invalid_query" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an idempotent query after HTTP 429 and then returns data", async () => {
    const fetchMock = stubFetch(
      tokenResponse(),
      verifyResponse(),
      new Response(JSON.stringify({ error: "throttled" }), {
        status: 429,
        headers: { "retry-after": "0" },
      }),
      queryResponse(),
    );
    const runtime = await createAuditShopifyRuntime(input());

    await expect(runtime.query(SHOP_QUERY)).resolves.toMatchObject({
      shop: { id: SHOP_ID },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries an idempotent query after HTTP 5xx", async () => {
    const fetchMock = stubFetch(
      tokenResponse(),
      verifyResponse(),
      new Response("upstream unavailable", {
        status: 503,
        headers: { "retry-after": "0" },
      }),
      queryResponse(),
    );
    const runtime = await createAuditShopifyRuntime(input());

    await expect(runtime.query(SHOP_QUERY)).resolves.toMatchObject({
      shop: { id: SHOP_ID },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails on top-level GraphQL errors without exposing their contents", async () => {
    stubFetch(
      tokenResponse(),
      verifyResponse(),
      queryResponse({
        data: { shop: null },
        errors: [{ message: `failure ${ACCESS_TOKEN} ${CLIENT_SECRET}` }],
      }),
    );
    const runtime = await createAuditShopifyRuntime(input());

    let caught: unknown;
    try {
      await runtime.query(SHOP_QUERY);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "graphql_errors", retryable: false });
    expect(String(caught)).not.toContain(ACCESS_TOKEN);
    expect(String(caught)).not.toContain(CLIENT_SECRET);
  });

  it("classifies only Shopify throttling/server GraphQL codes as retryable", async () => {
    stubFetch(
      tokenResponse(),
      verifyResponse(),
      queryResponse({
        errors: [
          {
            message: "Throttled without echoing this body.",
            extensions: { code: "THROTTLED" },
          },
        ],
      }),
      queryResponse({
        errors: [
          {
            message: "Still throttled.",
            extensions: { code: "THROTTLED" },
          },
        ],
      }),
      queryResponse({
        errors: [
          {
            message: "Still throttled.",
            extensions: { code: "THROTTLED" },
          },
        ],
      }),
    );
    const runtime = await createAuditShopifyRuntime(input());

    await expect(runtime.query(SHOP_QUERY)).rejects.toMatchObject({
      code: "graphql_errors",
      retryable: true,
    });
  });
});
