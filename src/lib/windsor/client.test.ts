import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  WindsorError,
  checkGoogleAdsAccountHealth,
  createGoogleAdsAuthorization,
  decryptWindsorAccessToken,
  encryptWindsorAccessToken,
  listLinkedGoogleAdsAccounts,
  normalizeGoogleAdsCustomerId,
  pollLinkedGoogleAdsAccounts,
  probeGoogleAdsCapabilities,
} from "./client";

const API_KEY = "server-api-key-that-must-never-leak";
const ACCESS_TOKEN = "co-user-access-token-that-must-never-leak";
const ENCRYPTION_KEY = btoa("12345678901234567890123456789012");

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function mockFetch(...responses: Array<Response | Error>) {
  const fetcher = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fetcher.mockRejectedValueOnce(response);
    else fetcher.mockResolvedValueOnce(response);
  }
  return fetcher;
}

function requestedUrl(fetcher: ReturnType<typeof vi.fn>, call = 0) {
  const input = fetcher.mock.calls[call]?.[0];
  return input instanceof URL ? input : new URL(String(input));
}

describe("Windsor Google Ads server adapter", () => {
  beforeEach(() => {
    vi.stubEnv("WINDSOR_API_KEY", API_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fails closed when the server API key is missing", async () => {
    vi.stubEnv("WINDSOR_API_KEY", "");
    const fetcher = mockFetch(jsonResponse({ url: "unused" }));

    await expect(
      createGoogleAdsAuthorization({ fetcher: fetcher as typeof fetch }),
    ).rejects.toMatchObject({
      code: "server_not_configured",
      status: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("generates a co-user link restricted to Google Ads without returning the API key", async () => {
    const authorizationUrl =
      `https://onboard.windsor.ai/token-login?access_token=${ACCESS_TOKEN}` +
      "&allowed_sources=google_ads";
    const fetcher = mockFetch(jsonResponse({ url: authorizationUrl }));

    const authorization = await createGoogleAdsAuthorization({
      fetcher: fetcher as typeof fetch,
    });

    expect(authorization).toEqual({ authorizationUrl, accessToken: ACCESS_TOKEN });
    expect(JSON.stringify(authorization)).not.toContain(API_KEY);

    const upstream = requestedUrl(fetcher);
    expect(upstream.origin).toBe("https://onboard.windsor.ai");
    expect(upstream.pathname).toBe("/api/team/generate-co-user-url/");
    expect(upstream.searchParams.get("allowed_sources")).toBe("google_ads");
    expect(upstream.searchParams.get("api_key")).toBe(API_KEY);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("rejects redirects without following or exposing the API key", async () => {
    const fetcher = mockFetch(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/capture" },
      }),
    );

    await expect(
      createGoogleAdsAuthorization({ fetcher: fetcher as typeof fetch }),
    ).rejects.toMatchObject({
      code: "upstream_unavailable",
      upstreamStatus: 302,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("allows the co-user link generator more than the read-request timeout", async () => {
    vi.useFakeTimers();
    const authorizationUrl =
      `https://onboard.windsor.ai/token-login?access_token=${ACCESS_TOKEN}` +
      "&allowed_sources=google_ads";
    const fetcher = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(jsonResponse({ url: authorizationUrl })),
            12_000,
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const pending = createGoogleAdsAuthorization({
      fetcher: fetcher as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(12_000);

    await expect(pending).resolves.toEqual({
      authorizationUrl,
      accessToken: ACCESS_TOKEN,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    `https://attacker.invalid/token-login?access_token=${ACCESS_TOKEN}&allowed_sources=google_ads`,
    `https://onboard.windsor.ai:444/token-login?access_token=${ACCESS_TOKEN}&allowed_sources=google_ads`,
    `https://onboard.windsor.ai/token-login?access_token=${ACCESS_TOKEN}&allowed_sources=shopify`,
  ])("rejects an authorization link outside the exact origin/source boundary", async (url) => {
    const fetcher = mockFetch(jsonResponse({ url }));

    await expect(
      createGoogleAdsAuthorization({ fetcher: fetcher as typeof fetch }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("normalizes and deduplicates accounts linked by one secret access token", async () => {
    const fetcher = mockFetch(
      jsonResponse([
        {
          datasource: "google_ads",
          account_id: "1234567890",
          account_name: "  Primary   Ads  ",
          access_token: ACCESS_TOKEN,
          co_user_member_name: "private@example.com",
        },
        {
          datasource: "google_ads",
          account_id: "123-456-7890",
          account_currency_code: "EUR",
          account_time_zone: "Europe/Lisbon",
        },
        {
          datasource: "facebook",
          account_id: "not-a-google-id",
        },
      ]),
    );

    const accounts = await listLinkedGoogleAdsAccounts(ACCESS_TOKEN, {
      fetcher: fetcher as typeof fetch,
    });

    expect(accounts).toEqual([
      {
        datasource: "google_ads",
        accountId: "123-456-7890",
        customerId: "1234567890",
        accountName: "Primary Ads",
        status: null,
        currency: "EUR",
        timeZone: "Europe/Lisbon",
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(accounts)).not.toContain("private@example.com");

    const upstream = requestedUrl(fetcher);
    expect(upstream.searchParams.get("ds_id")).toBe("google_ads");
    expect(upstream.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
    expect(upstream.searchParams.get("api_key")).toBe(API_KEY);
  });

  it("does not include upstream bodies, URLs, API keys or tokens in errors", async () => {
    const fetcher = mockFetch(
      new Response(
        JSON.stringify({
          error: `bad api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`,
        }),
        { status: 403 },
      ),
    );

    let error: unknown;
    try {
      await listLinkedGoogleAdsAccounts(ACCESS_TOKEN, {
        fetcher: fetcher as typeof fetch,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WindsorError);
    expect(error).toMatchObject({ code: "forbidden", upstreamStatus: 403 });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain(ACCESS_TOKEN);
    expect(String(error)).not.toContain("api_key=");
    expect(String(error)).not.toContain("access_token=");
  });

  it("redacts even a network error that contains the authenticated URL", async () => {
    const fetcher = mockFetch(
      new Error(
        `fetch https://connectors.windsor.ai/google_ads?api_key=${API_KEY} failed`,
      ),
    );

    let error: unknown;
    try {
      await probeGoogleAdsCapabilities({ fetcher: fetcher as typeof fetch });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "upstream_unavailable" });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain("connectors.windsor.ai");
  });

  it("polls immediately, backs off and stops as soon as accounts appear", async () => {
    const fetcher = mockFetch(
      jsonResponse([]),
      jsonResponse([]),
      jsonResponse([
        {
          datasource: "google_ads",
          account_id: "123-456-7890",
          account_name: "Primary Ads",
        },
      ]),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollLinkedGoogleAdsAccounts({
      accessToken: ACCESS_TOKEN,
      maxAttempts: 5,
      initialDelayMs: 250,
      maxDelayMs: 1_000,
      sleep,
      fetcher: fetcher as typeof fetch,
    });

    expect(result).toMatchObject({ status: "connected", attempts: 3 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 500, undefined);
  });

  it("honours a bounded Retry-After while polling", async () => {
    const fetcher = mockFetch(
      jsonResponse({ error: "quota" }, { status: 429, headers: { "retry-after": "2" } }),
      jsonResponse([]),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollLinkedGoogleAdsAccounts({
      accessToken: ACCESS_TOKEN,
      maxAttempts: 2,
      initialDelayMs: 250,
      maxDelayMs: 3_000,
      sleep,
      fetcher: fetcher as typeof fetch,
    });

    expect(result).toEqual({ status: "pending", accounts: [], attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
  });

  it("discovers write capabilities through GET but exposes no action executor", async () => {
    const fetcher = mockFetch(
      jsonResponse([
        { id: "pause_campaign", name: "Pause campaign", schema: { secret: true } },
        { id: "create_campaign", name: "Create campaign" },
        { id: "pause_campaign", name: "Duplicate" },
        { id: "invalid-action-id", name: "Ignored" },
      ]),
    );

    const capabilities = await probeGoogleAdsCapabilities({
      fetcher: fetcher as typeof fetch,
    });

    expect(capabilities).toEqual({
      datasource: "google_ads",
      actionIds: ["create_campaign", "pause_campaign"],
      canCreateCampaign: true,
      canPauseCampaign: true,
      canEnableCampaign: false,
    });
    expect(requestedUrl(fetcher).pathname).toBe("/google_ads/actions");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("performs an exact, read-only account health check without forced refresh", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            datasource: "google_ads",
            account_id: "123-456-7890",
            account_name: "Primary Ads",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
          },
        ],
      }),
      jsonResponse([
        {
          datasource: "google_ads",
          account_id: "123-456-7890",
          account_name: "Primary Ads",
          status: "active",
        },
      ]),
    );

    const result = await checkGoogleAdsAccountHealth("1234567890", {
      fetcher: fetcher as typeof fetch,
      now: () => new Date("2026-08-12T16:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      code: "healthy",
      account: {
        datasource: "google_ads",
        accountId: "123-456-7890",
        customerId: "1234567890",
        accountName: "Primary Ads",
        status: "active",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
      },
      recentDataAvailable: true,
      checkedAt: "2026-08-12T16:00:00.000Z",
    });

    const healthUrl = requestedUrl(fetcher, 0);
    expect(healthUrl.pathname).toBe("/google_ads");
    expect(healthUrl.searchParams.get("date_preset")).toBe("last_30dT");
    expect(healthUrl.searchParams.get("filter")).toBe(
      JSON.stringify([["account_id", "eq", "123-456-7890"]]),
    );
    expect(healthUrl.searchParams.has("refresh_since")).toBe(false);
    expect(healthUrl.searchParams.has("refresh_interval")).toBe(false);

    const inventoryUrl = requestedUrl(fetcher, 1);
    expect(inventoryUrl.pathname).toBe("/api/common/ds-accounts");
    expect(inventoryUrl.searchParams.get("datasource")).toBe("google_ads");
  });

  it("reports a missing account only after proving the reporting API is reachable", async () => {
    const fetcher = mockFetch(jsonResponse({ data: [] }), jsonResponse([]));

    const result = await checkGoogleAdsAccountHealth("123-456-7890", {
      fetcher: fetcher as typeof fetch,
      now: () => new Date("2026-08-12T16:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: false,
      code: "not_connected",
      account: null,
      recentDataAvailable: false,
      checkedAt: "2026-08-12T16:00:00.000Z",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestedUrl(fetcher, 0).origin).toBe("https://connectors.windsor.ai");
  });

  it("never mislabels a rejected Windsor key as a client reconnection", async () => {
    const fetcher = mockFetch(jsonResponse({ error: "Not authorized" }, { status: 400 }));

    await expect(
      checkGoogleAdsAccountHealth("123-456-7890", {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_request", upstreamStatus: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps an account healthy when the authenticated read has no recent rows", async () => {
    const fetcher = mockFetch(
      jsonResponse({ data: [] }),
      jsonResponse([
        {
          datasource: "google_ads",
          account_id: "123-456-7890",
          account_name: "Quiet account",
        },
      ]),
    );

    const result = await checkGoogleAdsAccountHealth("123-456-7890", {
      fetcher: fetcher as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.recentDataAvailable).toBe(false);
  });

  it("encrypts the co-user correlation token before persistence", async () => {
    vi.stubEnv("GOOGLE_ADS_TOKEN_ENC_KEY", ENCRYPTION_KEY);
    const ciphertext = await encryptWindsorAccessToken(ACCESS_TOKEN);

    expect(ciphertext).not.toBe(ACCESS_TOKEN);
    expect(ciphertext).not.toContain(ACCESS_TOKEN);
    await expect(decryptWindsorAccessToken(ciphertext)).resolves.toBe(ACCESS_TOKEN);
  });

  it("normalizes the two supported Google Ads customer id forms", () => {
    expect(normalizeGoogleAdsCustomerId("customers/1234567890")).toEqual({
      accountId: "123-456-7890",
      customerId: "1234567890",
    });
    expect(normalizeGoogleAdsCustomerId("123-456-7890")).toEqual({
      accountId: "123-456-7890",
      customerId: "1234567890",
    });
    expect(() => normalizeGoogleAdsCustomerId("123")).toThrowError(WindsorError);
    expect(() => normalizeGoogleAdsCustomerId("abc1234567890")).toThrowError(
      WindsorError,
    );
  });
});
