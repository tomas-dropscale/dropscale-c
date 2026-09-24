import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { REQUIRED_REPORTING_SHOPIFY_SCOPES } from "./shopify-scopes";
import {
  REPORTING_SHOPIFY_API_VERSION,
  ShopifyReportingError,
  exchangeReportingClientCredentials,
  normalizeReportingShopDomain,
  reportingShopifyGraphql,
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
  it.each([
    ["app_not_installed", "app_not_installed", "not installed"],
    ["application_cannot_be_found", "app_not_found", "cannot find"],
  ])("classifies Shopify's HTML OAuth failure %s without exposing its body", async (providerCode, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<html><title>400 - Oauth error ${providerCode}</title><body>client-secret-value-123456</body></html>`,
      { status: 400, headers: { "content-type": "text/html" } },
    )));
    const failure = await exchangeReportingClientCredentials({
      shopDomain: "northwind-demo.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-value-123456",
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code, retryable: false });
    expect(String(failure)).toContain(message);
    expect(String(failure)).not.toContain("client-secret-value-123456");
  });

  it("also recognises an uninstalled app in a JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "app_not_installed", error_description: "private-provider-response" }),
      { status: 400 },
    )));
    const failure = await exchangeReportingClientCredentials({
      shopDomain: "northwind-demo.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-value-123456",
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "app_not_installed", retryable: false });
    expect(String(failure)).not.toContain("private-provider-response");
  });

  it("does not infer an uninstalled app from arbitrary response text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "Invalid secret: app_not_installed client-secret-value-123456", { status: 400 },
    )));
    await expect(exchangeReportingClientCredentials({
      shopDomain: "northwind-demo.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-value-123456",
    })).rejects.toMatchObject({ code: "invalid_credentials", retryable: false });
  });

  it("distinguishes a store unavailable with HTTP 402 from rejected app credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable Shop", { status: 402 })));
    await expect(exchangeReportingClientCredentials({
      shopDomain: "northwind-demo.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-value-123456",
    })).rejects.toMatchObject({ code: "shop_inactive", retryable: false });
  });

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
  it("reports an unavailable store even when its token exchange succeeded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ errors: "Unavailable Shop" }), { status: 402 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyReportingShop({
      shopDomain: "northwind-demo.myshopify.com",
      accessToken: "temporary-access-token-123",
    })).rejects.toMatchObject({ code: "shop_inactive", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

describe("reporting Shopify GraphQL throttle handling", () => {
  function graphqlErrorsResponse(errors: unknown[]) {
    return new Response(JSON.stringify({ errors }), {
      status: 200,
      headers: { "x-shopify-api-version": REPORTING_SHOPIFY_API_VERSION },
    });
  }

  function throttledHttpResponse(retryAfter?: string) {
    return new Response("", {
      status: 429,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
  }

  function throttledEnvelope(message = "Throttled") {
    return graphqlErrorsResponse([
      {
        message,
        extensions: {
          code: "THROTTLED",
          documentation: "https://shopify.dev/api/usage/rate-limits",
        },
      },
    ]);
  }

  const request = {
    shopDomain: "northwind-demo.myshopify.com",
    accessToken: "temporary-access-token-123",
    query: "query DropscaleSheet($q: String!) { shopifyqlQuery(query: $q) { tableData { rows } } }",
    variables: { q: "FROM sales SHOW total_sales SINCE -1d" },
  };

  function instantSleep() {
    return vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  }

  it("retries an HTTP 429 twice on the fixed ladder and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(throttledHttpResponse())
      .mockResolvedValueOnce(throttledHttpResponse())
      .mockResolvedValueOnce(graphqlResponse({ sheet: { rows: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql<{ sheet: { rows: number } }>(request, { sleep }),
    ).resolves.toEqual({ sheet: { rows: 3 } });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2500]]);
    for (const [url, init] of fetchMock.mock.calls as Array<
      [string, RequestInit]
    >) {
      expect(url).toBe(
        `https://northwind-demo.myshopify.com/admin/api/${REPORTING_SHOPIFY_API_VERSION}/graphql.json`,
      );
      expect(JSON.parse(String(init.body))).toEqual({
        query: request.query,
        variables: request.variables,
      });
    }
  });

  it("honours a numeric Retry-After header, capped at five seconds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(throttledHttpResponse("2.5"))
      .mockResolvedValueOnce(throttledHttpResponse("30"))
      .mockResolvedValueOnce(graphqlResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql<{ ok: boolean }>(request, { sleep }),
    ).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[2500], [5000]]);
  });

  it("falls back to the ladder when Retry-After is not a number", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        throttledHttpResponse("Wed, 21 Oct 2026 07:28:00 GMT"),
      )
      .mockResolvedValueOnce(graphqlResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql<{ ok: boolean }>(request, { sleep }),
    ).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  it("treats a THROTTLED envelope inside HTTP 200 as a throttle and retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(throttledEnvelope())
      .mockResolvedValueOnce(graphqlResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql<{ ok: boolean }>(request, { sleep }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  it.each([
    ["MAX_COST_EXCEEDED code", { message: "Query cost is too high", extensions: { code: "MAX_COST_EXCEEDED" } }],
    ["a throttled message without a code", { message: "Throttled" }],
    ["a mixed-case throttle message", { message: "Request was throttled by Shopify", extensions: { code: "SOMETHING_ELSE" } }],
  ])("recognises %s as a throttle", async (_label, error) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(graphqlErrorsResponse([error]))
      .mockResolvedValueOnce(graphqlResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql<{ ok: boolean }>(request, { sleep }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up after two retries and surfaces the throttle as retryable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(throttledHttpResponse())
      .mockResolvedValueOnce(throttledEnvelope())
      .mockResolvedValueOnce(throttledHttpResponse("1"));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql(request, { sleep }),
    ).rejects.toMatchObject({
      name: "ShopifyReportingError",
      code: "shopify_rate_limited",
      retryable: true,
      message: "Shopify is rate limiting this store. Wait a moment and try again.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2500]]);
  });

  it("appends the first Shopify message to a non-throttle GraphQL error without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlErrorsResponse([
        {
          message: "  Access denied for orders field. Required access: `read_orders` access scope.  ",
          extensions: { code: "ACCESS_DENIED" },
        },
        { message: "Second error that must not be used" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql(request, { sleep }),
    ).rejects.toMatchObject({
      code: "insufficient_scopes",
      retryable: false,
      message:
        "Shopify did not allow this read-only reporting check. Shopify said: Access denied for orders field. Required access: `read_orders` access scope.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("caps the appended Shopify message at 200 characters", async () => {
    const longMessage = "x".repeat(450);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        graphqlErrorsResponse([{ message: longMessage }]),
      ),
    );

    await expect(
      reportingShopifyGraphql(request, { sleep: instantSleep() }),
    ).rejects.toMatchObject({
      code: "insufficient_scopes",
      message: `Shopify did not allow this read-only reporting check. Shopify said: ${"x".repeat(200)}`,
    });
  });

  it("keeps the plain message when the errors carry no usable text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        graphqlErrorsResponse([{ extensions: { code: "INTERNAL" } }, { message: "   " }]),
      ),
    );

    await expect(
      reportingShopifyGraphql(request, { sleep: instantSleep() }),
    ).rejects.toMatchObject({
      code: "insufficient_scopes",
      message: "Shopify did not allow this read-only reporting check.",
    });
  });

  it("keeps today's behaviour for a missing data block with no errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "x-shopify-api-version": REPORTING_SHOPIFY_API_VERSION },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql(request, { sleep }),
    ).rejects.toMatchObject({
      code: "insufficient_scopes",
      message: "Shopify did not allow this read-only reporting check.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a 401, which waiting cannot fix", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql(request, { sleep }),
    ).rejects.toMatchObject({ code: "invalid_credentials", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a retryable outage either; only throttles wait", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = instantSleep();

    await expect(
      reportingShopifyGraphql(request, { sleep }),
    ).rejects.toMatchObject({ code: "shopify_unavailable", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits on a real timer between attempts when no sleep is injected", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(throttledHttpResponse())
        .mockResolvedValueOnce(graphqlResponse({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = reportingShopifyGraphql<{ ok: boolean }>(request);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a throttled probe as rate limited in the health check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchMock = vi.fn().mockImplementation(
        async (_url: string, init: RequestInit) => {
          const { query } = JSON.parse(String(init.body)) as { query: string };
          if (query.includes("shopifyqlQuery")) return throttledEnvelope();
          if (query.includes("shopifyPaymentsAccount")) {
            return graphqlResponse({ shopifyPaymentsAccount: null });
          }
          return graphqlResponse({ ok: true });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const pending = testReportingShopConnection({
        shop: verifiedShop(),
        accessToken: "temporary-access-token-123",
      });
      await vi.advanceTimersByTimeAsync(1000 + 2500);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.capabilities[1]).toEqual({
        capability: "reports",
        status: "failed",
        code: "shopify_rate_limited",
      });
      const reportProbes = (fetchMock.mock.calls as Array<[string, RequestInit]>)
        .filter(([, init]) => String(init.body).includes("shopifyqlQuery"));
      expect(reportProbes).toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });
});
