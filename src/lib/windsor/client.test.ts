import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  WindsorError,
  checkGoogleAdsAccountHealth,
  createGoogleAdsAuthorization,
  decryptWindsorAccessToken,
  encryptWindsorAccessToken,
  fetchGoogleAdsCampaignBreakdown,
  fetchGoogleAdsCampaignFinalUrls,
  fetchGoogleAdsCampaignTimeline,
  fetchGoogleAdsDailyBreakdown,
  fetchGoogleAdsDailyBreakdownForStore,
  fetchGoogleAdsDemandGenAdBreakdown,
  fetchGoogleAdsPmaxProductBreakdown,
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
          link: {
            access_token: ACCESS_TOKEN,
            co_user_member_name: "private@example.com",
          },
          accounts: [
            {
              datasource: "google_ads",
              account_id: "1234567890",
              account_name: "  Primary   Ads  ",
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
          ],
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

  it("ignores deactivated linked accounts and treats an empty link as pending", async () => {
    const fetcher = mockFetch(
      jsonResponse([
        {
          link: { access_token: ACCESS_TOKEN },
          accounts: [
            {
              datasource: "google_ads",
              account_id: "123-456-7890",
              account_name: "Inactive Ads",
              is_deactivated: true,
            },
          ],
        },
      ]),
      jsonResponse([{ link: { access_token: ACCESS_TOKEN }, accounts: [] }]),
    );

    await expect(
      listLinkedGoogleAdsAccounts(ACCESS_TOKEN, {
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toEqual([]);
    await expect(
      listLinkedGoogleAdsAccounts(ACCESS_TOKEN, {
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a nested active Google Ads account without a valid identifier", async () => {
    const invalidId = "private-invalid-account-id";
    const privateName = "Private Account Name";
    const fetcher = mockFetch(
      jsonResponse([
        {
          link: { access_token: ACCESS_TOKEN },
          accounts: [
            {
              datasource: "google_ads",
              account_id: invalidId,
              account_name: privateName,
              is_deactivated: false,
            },
          ],
        },
      ]),
    );

    let error: unknown;
    try {
      await listLinkedGoogleAdsAccounts(ACCESS_TOKEN, {
        fetcher: fetcher as typeof fetch,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).not.toContain(invalidId);
    expect(String(error)).not.toContain(privateName);
    expect(String(error)).not.toContain(ACCESS_TOKEN);
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

  it("reads, validates and sorts daily metrics for one exact Google Ads account", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            date: "2026-08-12",
            account_id: "1234567890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            spend: "12.34",
            impressions: "1000",
            clicks: 25,
            conversions: "2.5",
            conversion_value: "49.99",
          },
          {
            date: "2026-08-10",
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            spend: 0,
            impressions: 0,
            clicks: 0,
            conversions: 0,
            conversion_value: 0,
          },
        ],
      }),
    );

    const rows = await fetchGoogleAdsDailyBreakdown(
      "customers/1234567890",
      "2026-08-10",
      "2026-08-12",
      { fetcher: fetcher as typeof fetch },
    );

    expect(rows).toEqual([
      {
        date: "2026-08-10",
        accountId: "123-456-7890",
        customerId: "1234567890",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValue: 0,
      },
      {
        date: "2026-08-12",
        accountId: "123-456-7890",
        customerId: "1234567890",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        spend: 12.34,
        impressions: 1000,
        clicks: 25,
        conversions: 2.5,
        conversionValue: 49.99,
      },
    ]);

    const upstream = requestedUrl(fetcher);
    expect(upstream.origin).toBe("https://connectors.windsor.ai");
    expect(upstream.pathname).toBe("/google_ads");
    expect(upstream.searchParams.get("fields")).toBe(
      "date,account_id,account_currency_code,account_time_zone,spend," +
        "impressions,clicks,conversions,conversion_value",
    );
    expect(upstream.searchParams.get("date_from")).toBe("2026-08-10");
    expect(upstream.searchParams.get("date_to")).toBe("2026-08-12");
    expect(upstream.searchParams.get("filter")).toBe(
      JSON.stringify([["account_id", "eq", "123-456-7890"]]),
    );
    expect(upstream.searchParams.get("_max_rows")).toBe("4");
    expect(upstream.searchParams.get("_renderer")).toBe("json");
    expect(upstream.searchParams.has("date_preset")).toBe(false);
  });

  it("builds today's daily metric from current campaign-hour rows", async () => {
    const fetcher = mockFetch(jsonResponse({ data: [
      {
        date: "2026-08-17",
        hour_of_day: 10,
        account_id: "123-456-7890",
        account_currency_code: "EUR",
        account_time_zone: "Europe/Lisbon",
        campaign_id: "1",
        spend: 12,
        impressions: 100,
        clicks: 10,
        conversions: 1,
        conversion_value: 20,
      },
      {
        date: "2026-08-17",
        hour_of_day: 11,
        account_id: "123-456-7890",
        account_currency_code: "EUR",
        account_time_zone: "Europe/Lisbon",
        campaign_id: "2",
        spend: 21,
        impressions: 200,
        clicks: 20,
        conversions: 2,
        conversion_value: 40,
      },
    ] }));

    await expect(fetchGoogleAdsDailyBreakdown(
      "123-456-7890",
      "2026-08-17",
      "2026-08-17",
      { fetcher: fetcher as typeof fetch },
    )).resolves.toEqual([
      expect.objectContaining({
        date: "2026-08-17",
        spend: 33,
        impressions: 300,
        clicks: 30,
        conversions: 3,
        conversionValue: 60,
      }),
    ]);
    expect(requestedUrl(fetcher).searchParams.get("fields")?.split(","))
      .toContain("hour_of_day");
  });

  it("segments campaign timelines by local hour only for a one-day range", async () => {
    const hourlyFetcher = mockFetch(jsonResponse({ data: [{
      date: "2026-08-16",
      hour_of_day: 6,
      account_id: "123-456-7890",
      account_currency_code: "EUR",
      account_time_zone: "Europe/Lisbon",
      campaign_id: "42",
      spend: 24.68,
      impressions: 1_000,
      clicks: 50,
      conversions: 2,
      conversion_value: 80,
    }] }));
    const dailyFetcher = mockFetch(jsonResponse({ data: [{
      date: "2026-08-15",
      account_id: "123-456-7890",
      account_currency_code: "EUR",
      account_time_zone: "Europe/Lisbon",
      campaign_id: "42",
      spend: 20,
      impressions: 900,
      clicks: 40,
      conversions: 1,
      conversion_value: 50,
    }] }));

    await expect(fetchGoogleAdsCampaignTimeline(
      "123-456-7890",
      "2026-08-16",
      "2026-08-16",
      { fetcher: hourlyFetcher as typeof fetch },
    )).resolves.toEqual([
      expect.objectContaining({
        date: "2026-08-16",
        bucket: "2026-08-16T06:00:00",
        granularity: "hour",
        campaignId: "42",
        spend: 24.68,
      }),
    ]);
    expect(requestedUrl(hourlyFetcher).searchParams.get("fields")?.split(","))
      .toContain("hour_of_day");

    await expect(fetchGoogleAdsCampaignTimeline(
      "123-456-7890",
      "2026-08-15",
      "2026-08-16",
      { fetcher: dailyFetcher as typeof fetch },
    )).resolves.toEqual([
      expect.objectContaining({
        date: "2026-08-15",
        bucket: "2026-08-15",
        granularity: "day",
      }),
    ]);
    expect(requestedUrl(dailyFetcher).searchParams.get("fields")?.split(","))
      .not.toContain("hour_of_day");
  });

  it.each([
    ["invalid from", "2026-02-30", "2026-03-01"],
    ["invalid to", "2026-03-01", "2026-03-1"],
    ["reversed", "2026-03-02", "2026-03-01"],
    ["more than 366 days", "2025-01-01", "2026-01-02"],
  ])("rejects an %s reporting range before contacting Windsor", async (_label, from, to) => {
    const fetcher = mockFetch(jsonResponse({ data: [] }));

    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", from, to, {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects daily metrics returned for another Google Ads account", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            date: "2026-08-12",
            account_id: "987-654-3210",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            spend: 1,
            impressions: 1,
            clicks: 1,
            conversions: 1,
            conversion_value: 1,
          },
        ],
      }),
    );

    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", "2026-08-12", "2026-08-12", {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it.each([
    ["invalid day", { date: "2026-02-30" }],
    ["out-of-range day", { date: "2026-08-13" }],
    ["negative spend", { spend: -0.01 }],
    ["infinite impressions", { impressions: "Infinity" }],
    ["NaN clicks", { clicks: Number.NaN }],
    ["empty conversions", { conversions: "" }],
    ["missing conversion value", { conversion_value: null }],
    ["invalid currency", { account_currency_code: "EURO" }],
    ["missing time zone", { account_time_zone: "" }],
  ])("rejects a daily row with %s", async (_label, override) => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            date: "2026-08-12",
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            spend: 1,
            impressions: 1,
            clicks: 1,
            conversions: 1,
            conversion_value: 1,
            ...override,
          },
        ],
      }),
    );

    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", "2026-08-12", "2026-08-12", {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it.each([
    ["currency", { account_currency_code: "USD" }],
    ["time zone", { account_time_zone: "America/New_York" }],
  ])("rejects inconsistent daily-row %s", async (_label, override) => {
    const base = {
      account_id: "123-456-7890",
      account_currency_code: "EUR",
      account_time_zone: "Europe/Lisbon",
      spend: 1,
      impressions: 1,
      clicks: 1,
      conversions: 1,
      conversion_value: 1,
    };
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          { ...base, date: "2026-08-11" },
          { ...base, date: "2026-08-12", ...override },
        ],
      }),
    );

    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", "2026-08-11", "2026-08-12", {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("rejects the daily sentinel before deduplicating and rejects divergent duplicates", async () => {
    const row = {
      date: "2026-08-12",
      account_id: "123-456-7890",
      account_currency_code: "EUR",
      account_time_zone: "Europe/Lisbon",
      spend: 1,
      impressions: 2,
      clicks: 3,
      conversions: 4,
      conversion_value: 5,
    };
    const fetcher = mockFetch(
      jsonResponse({ data: [row, { ...row }] }),
      jsonResponse({ data: [row, { ...row }] }),
      jsonResponse({ data: [row, { ...row, spend: 2 }] }),
    );

    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", "2026-08-12", "2026-08-12", {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", "2026-08-11", "2026-08-12", {
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", "2026-08-11", "2026-08-12", {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("rejects oversized daily reporting responses before parsing them", async () => {
    const fetcher = mockFetch(
      new Response("[]", {
        headers: {
          "content-type": "application/json",
          "content-length": "1000001",
        },
      }),
    );

    await expect(
      fetchGoogleAdsDailyBreakdown("123-456-7890", "2026-08-12", "2026-08-12", {
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("reads one validated aggregate row per campaign for an exact account", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            campaign_id: "42",
            campaign: "Demand Gen — Summer",
            campaign_status: "ENABLED",
            advertising_channel_type: "DEMAND_GEN",
            campaign_shopping_setting_merchant_id: "123456789",
            campaign_budget: "35",
            bidding_strategy_type: "MAXIMIZE_CONVERSIONS",
            start_date: "2026-07-01",
            spend: "125.5",
            impressions: "10000",
            clicks: "250",
            conversions: "12",
            conversion_value: "490",
          },
        ],
      }),
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            campaign_id: "42",
            final_url: "https://shop.example/collections/summer?ref=demand-gen",
          },
        ],
      }),
    );

    await expect(
      fetchGoogleAdsCampaignBreakdown(
        "1234567890",
        "2026-08-01",
        "2026-08-12",
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual([
      {
        accountId: "123-456-7890",
        customerId: "1234567890",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        campaignId: "42",
        name: "Demand Gen — Summer",
        status: "ENABLED",
        advertisingChannelType: "DEMAND_GEN",
        shoppingFeed: true,
        biddingStrategyType: "MAXIMIZE_CONVERSIONS",
        startDate: "2026-07-01",
        dailyBudget: 35,
        spend: 125.5,
        impressions: 10000,
        clicks: 250,
        conversions: 12,
        conversionValue: 490,
        finalUrls: ["https://shop.example/collections/summer?ref=demand-gen"],
      },
    ]);

    const upstream = requestedUrl(fetcher);
    expect(upstream.searchParams.get("date_from")).toBe("2026-08-01");
    expect(upstream.searchParams.get("date_to")).toBe("2026-08-12");
    expect(upstream.searchParams.get("_max_rows")).toBe("1001");
    const fields = upstream.searchParams.get("fields")?.split(",") ?? [];
    expect(fields).toContain("campaign_shopping_setting_merchant_id");
    expect(fields).not.toContain("date");
    const finalUrls = requestedUrl(fetcher, 1);
    expect(finalUrls.searchParams.get("fields")).toBe(
      "account_id,campaign_id,final_url",
    );
    expect(finalUrls.searchParams.get("date_from")).toBe("2026-08-01");
    expect(finalUrls.searchParams.get("date_to")).toBe("2026-08-12");
  });

  it.each([
    ["another account", { account_id: "987-654-3210" }],
    ["unknown status", { campaign_status: "UNKNOWN" }],
    ["invalid channel", { advertising_channel_type: "" }],
    ["invalid Merchant Center id", { campaign_shopping_setting_merchant_id: "merchant" }],
    ["negative spend", { spend: -1 }],
    ["invalid currency", { account_currency_code: "EURO" }],
    ["missing time zone", { account_time_zone: null }],
  ])("rejects a campaign row with %s", async (_label, override) => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            campaign_id: "42",
            campaign: "Campaign",
            campaign_status: "PAUSED",
            advertising_channel_type: "PERFORMANCE_MAX",
            campaign_shopping_setting_merchant_id: null,
            campaign_budget: 20,
            bidding_strategy_type: null,
            start_date: null,
            spend: 1,
            impressions: 1,
            clicks: 1,
            conversions: 1,
            conversion_value: 1,
            ...override,
          },
        ],
      }),
      // The final-URL companion read succeeds; the campaign row itself must
      // still fail the account closed.
      jsonResponse({ data: [] }),
    );

    await expect(
      fetchGoogleAdsCampaignBreakdown(
        "123-456-7890",
        "2026-08-12",
        "2026-08-12",
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("ignores an ad's invalid final URL without failing the whole account", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            campaign_id: "42",
            campaign: "Campaign",
            campaign_status: "ENABLED",
            advertising_channel_type: "PERFORMANCE_MAX",
            campaign_shopping_setting_merchant_id: null,
            campaign_budget: 20,
            bidding_strategy_type: null,
            start_date: null,
            spend: 10,
            impressions: 100,
            clicks: 10,
            conversions: 1,
            conversion_value: 30,
          },
        ],
      }),
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            campaign_id: "42",
            final_url: "https://shop.example/collections/summer",
          },
          {
            account_id: "123-456-7890",
            campaign_id: "42",
            final_url: "http://insecure.example/landing",
          },
          {
            account_id: "123-456-7890",
            campaign_id: "42",
            final_url: "not a url at all",
          },
        ],
      }),
    );

    const campaigns = await fetchGoogleAdsCampaignBreakdown(
      "123-456-7890",
      "2026-08-12",
      "2026-08-12",
      { fetcher: fetcher as typeof fetch },
    );

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({
      campaignId: "42",
      spend: 10,
      finalUrls: ["https://shop.example/collections/summer"],
    });
  });

  it("still fails closed when a final-URL row reports another account", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            campaign_id: "42",
            campaign: "Campaign",
            campaign_status: "ENABLED",
            advertising_channel_type: "PERFORMANCE_MAX",
            campaign_shopping_setting_merchant_id: null,
            campaign_budget: 20,
            bidding_strategy_type: null,
            start_date: null,
            spend: 10,
            impressions: 100,
            clicks: 10,
            conversions: 1,
            conversion_value: 30,
          },
        ],
      }),
      jsonResponse({
        data: [
          {
            account_id: "987-654-3210",
            campaign_id: "42",
            final_url: "https://shop.example/collections/summer",
          },
        ],
      }),
    );

    await expect(
      fetchGoogleAdsCampaignBreakdown(
        "123-456-7890",
        "2026-08-12",
        "2026-08-12",
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
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

  it("reads bounded Demand Gen ad rows for the exact account and range", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            campaign_id: "42",
            advertising_channel_type: "DEMAND_GEN",
            asset_id: "9001",
            ad_group_ad_asset_view_field_type: "SQUARE_MARKETING_IMAGE",
            spend: "125.5",
            impressions: "10000",
            clicks: "250",
            conversions: "12",
            conversion_value: "490",
          },
        ],
      }),
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            asset_id: "9001",
            asset_name: "Summer creative",
            asset_type: "IMAGE",
            asset_image_asset_full_size_url: "https://img.example/full.png",
          },
        ],
      }),
    );

    await expect(
      fetchGoogleAdsDemandGenAdBreakdown(
        "1234567890",
        "2026-08-08",
        "2026-08-14",
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual([
      {
        accountId: "123-456-7890",
        customerId: "1234567890",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        campaignId: "42",
        adId: "9001",
        name: "Summer creative",
        type: "SQUARE_MARKETING_IMAGE",
        thumbnailUrl: "https://img.example/full.png",
        assetKind: "image",
        spend: 125.5,
        impressions: 10000,
        clicks: 250,
        conversions: 12,
        conversionValue: 490,
      },
    ]);

    const upstream = requestedUrl(fetcher);
    expect(upstream.searchParams.get("date_from")).toBe("2026-08-08");
    expect(upstream.searchParams.get("date_to")).toBe("2026-08-14");
    expect(upstream.searchParams.get("_max_rows")).toBe("10001");
    expect(upstream.searchParams.get("filter")).toBe(JSON.stringify([
      ["account_id", "eq", "123-456-7890"],
      "and",
      ["advertising_channel_type", "eq", "DEMAND_GEN"],
    ]));
    const fields = upstream.searchParams.get("fields")?.split(",") ?? [];
    expect(fields).toEqual(expect.arrayContaining([
      "campaign_id",
      "asset_id",
      "ad_group_ad_asset_view_field_type",
      "spend",
    ]));
    expect(fields).not.toContain("date");

    const metadata = requestedUrl(fetcher, 1);
    expect(metadata.searchParams.get("date_from")).toBe("2026-08-08");
    expect(metadata.searchParams.get("date_to")).toBe("2026-08-14");
    expect(metadata.searchParams.get("_max_rows")).toBe("10001");
    expect(metadata.searchParams.get("filter")).toBe(
      JSON.stringify([["account_id", "eq", "123-456-7890"]]),
    );
    expect(metadata.searchParams.get("fields")?.split(",")).toEqual(
      expect.arrayContaining([
        "asset_id",
        "asset_name",
        "asset_type",
        "asset_image_asset_full_size_url",
        "asset_youtube_video_asset_youtube_video_title",
      ]),
    );
  });

  it("reads exact PMax products and keeps the full Merchant identity", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            campaign_id: "84",
            advertising_channel_type: "PERFORMANCE_MAX",
            product_merchant_id: 123456789,
            product_feed_label: "PT",
            product_language: "languageConstants/1014",
            product_country: "geoTargetConstants/2620",
            product_channel: "ONLINE",
            product_item_id: "shopify_PT_123_456",
            product_title: "Linen dress",
            product_brand: "Northwind",
            spend: "25.25",
            impressions: "2000",
            clicks: "80",
            conversions: "3.5",
            conversion_value: "120",
          },
        ],
      }),
    );

    await expect(
      fetchGoogleAdsPmaxProductBreakdown(
        "123-456-7890",
        "2026-08-08",
        "2026-08-14",
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        accountId: "123-456-7890",
        customerId: "1234567890",
        campaignId: "84",
        merchantId: "123456789",
        feedLabel: "PT",
        language: "languageConstants/1014",
        country: "geoTargetConstants/2620",
        channel: "ONLINE",
        itemId: "shopify_PT_123_456",
        title: "Linen dress",
        brand: "Northwind",
        spend: 25.25,
        conversions: 3.5,
        conversionValue: 120,
      }),
    ]);

    const upstream = requestedUrl(fetcher);
    expect(upstream.searchParams.get("_max_rows")).toBe("10001");
    expect(upstream.searchParams.get("filter")).toBe(JSON.stringify([
      ["account_id", "eq", "123-456-7890"],
      "and",
      ["advertising_channel_type", "eq", "PERFORMANCE_MAX"],
      "and",
      ["spend", "gt", 0],
    ]));
    const fields = upstream.searchParams.get("fields")?.split(",") ?? [];
    expect(fields).toEqual(expect.arrayContaining([
      "product_merchant_id",
      "product_feed_label",
      "product_language",
      "product_country",
      "product_channel",
      "product_item_id",
      "product_title",
      "product_brand",
      "spend",
    ]));
    expect(fields).not.toContain("date");
  });

  it("fails campaign detail closed on identity escape and sentinel truncation", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "987-654-3210",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            campaign_id: "42",
            advertising_channel_type: "DEMAND_GEN",
            ad_id: "1",
            ad_group_ad_ad_name: null,
            ad_type: "DEMAND_GEN_CAROUSEL_AD",
            ad_group_ad_status: "PAUSED",
            spend: 0,
            impressions: 0,
            clicks: 0,
            conversions: 0,
            conversion_value: 0,
          },
        ],
      }),
      jsonResponse({ data: Array.from({ length: 10_001 }, () => ({})) }),
    );

    await expect(
      fetchGoogleAdsDemandGenAdBreakdown(
        "123-456-7890",
        "2026-08-14",
        "2026-08-14",
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
    await expect(
      fetchGoogleAdsPmaxProductBreakdown(
        "123-456-7890",
        "2026-08-14",
        "2026-08-14",
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("rejects zero-spend and non-unique stable Windsor product identities", async () => {
    const product = (title: string, brand: string, spend: number) => ({
      account_id: "123-456-7890",
      account_currency_code: "EUR",
      account_time_zone: "Europe/Lisbon",
      campaign_id: "84",
      advertising_channel_type: "PERFORMANCE_MAX",
      product_merchant_id: 123456789,
      product_feed_label: "PT",
      product_language: "languageConstants/1014",
      product_country: "geoTargetConstants/2620",
      product_channel: "ONLINE",
      product_item_id: "shopify_PT_123_456",
      product_title: title,
      product_brand: brand,
      spend,
      impressions: 10,
      clicks: 2,
      conversions: 1,
      conversion_value: 5,
    });
    const fetcher = mockFetch(
      jsonResponse({ data: [product("Old title", "Old brand", 1), product("New title", "New brand", 2)] }),
      jsonResponse({ data: [product("Current title", "Current brand", 0)] }),
    );

    await expect(
      fetchGoogleAdsPmaxProductBreakdown(
        "123-456-7890",
        "2026-08-08",
        "2026-08-14",
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
    await expect(
      fetchGoogleAdsPmaxProductBreakdown(
        "123-456-7890",
        "2026-08-08",
        "2026-08-14",
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
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

describe("Windsor store-scoped daily breakdown", () => {
  beforeEach(() => {
    vi.stubEnv("WINDSOR_API_KEY", API_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const timelineRow = (
    campaignId: string,
    date: string,
    spend: number,
  ) => ({
    date,
    account_id: "123-456-7890",
    account_currency_code: "EUR",
    account_time_zone: "Europe/Lisbon",
    campaign_id: campaignId,
    spend,
    impressions: 100,
    clicks: 10,
    conversions: "0.5",
    conversion_value: spend * 2,
  });

  it("reads campaign→final-URL pairs as a deduplicated sorted map", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            campaign_id: "1",
            final_url: "https://akinikko.com/b",
          },
          {
            account_id: "123-456-7890",
            campaign_id: "1",
            final_url: "https://akinikko.com/a",
          },
          {
            account_id: "123-456-7890",
            campaign_id: "1",
            final_url: "https://akinikko.com/a",
          },
          { account_id: "123-456-7890", campaign_id: "2", final_url: null },
        ],
      }),
    );
    const urls = await fetchGoogleAdsCampaignFinalUrls(
      "123-456-7890",
      "2026-08-10",
      "2026-08-16",
      { fetcher: fetcher as typeof fetch },
    );
    expect(urls.get("1")).toEqual([
      "https://akinikko.com/a",
      "https://akinikko.com/b",
    ]);
    expect(urls.has("2")).toBe(false);
  });

  it("sums only the campaigns that belong to the store's domains", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          timelineRow("1", "2026-08-10", 10.111111),
          timelineRow("2", "2026-08-10", 99),
          timelineRow("1", "2026-08-11", 5.25),
          timelineRow("3", "2026-08-11", 7),
        ],
      }),
      jsonResponse({
        data: [
          {
            account_id: "123-456-7890",
            campaign_id: "1",
            final_url: "https://akinikko.com/collections/bags",
          },
          {
            account_id: "123-456-7890",
            campaign_id: "2",
            final_url: "https://casa-luna-artesanias.com/en/collections/lamparas",
          },
        ],
      }),
    );

    const rows = await fetchGoogleAdsDailyBreakdownForStore(
      "123-456-7890",
      "2026-08-10",
      "2026-08-11",
      ["akinikko.com"],
      { fetcher: fetcher as typeof fetch },
    );

    // Campaign 2 is excluded by positive foreign-URL evidence; campaign 3 has
    // no URL evidence and stays attributed.
    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-08-10",
        accountId: "123-456-7890",
        customerId: "1234567890",
        spend: 10.111111,
      }),
      expect.objectContaining({
        date: "2026-08-11",
        spend: 12.25,
        conversions: 1,
        conversionValue: 24.5,
      }),
    ]);
  });

  it("stays an exact account-level read when the store has no domains", async () => {
    const fetcher = mockFetch(
      jsonResponse({
        data: [
          {
            date: "2026-08-10",
            account_id: "123-456-7890",
            account_currency_code: "EUR",
            account_time_zone: "Europe/Lisbon",
            spend: "12.34",
            impressions: 100,
            clicks: 10,
            conversions: 1,
            conversion_value: 20,
          },
        ],
      }),
    );
    const rows = await fetchGoogleAdsDailyBreakdownForStore(
      "123-456-7890",
      "2026-08-01",
      "2026-08-10",
      [],
      { fetcher: fetcher as typeof fetch },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ date: "2026-08-10", spend: 12.34 });
  });
});

describe("Single-day hourly aggregation money contract", () => {
  beforeEach(() => {
    vi.stubEnv("WINDSOR_API_KEY", API_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rounds hourly float sums to at most six decimals", async () => {
    // 4.121 + 9.212 in IEEE 754 is 13.332999999999998 — exactly the artifact
    // that poisoned daily_metrics and crashed the billing dashboard.
    const hour = (hour_of_day: number, spend: number) => ({
      date: "2026-08-18",
      hour_of_day,
      account_id: "123-456-7890",
      account_currency_code: "EUR",
      account_time_zone: "Europe/Lisbon",
      campaign_id: "1",
      spend,
      impressions: 10,
      clicks: 1,
      conversions: 0.1,
      conversion_value: spend,
    });
    const fetcher = mockFetch(
      jsonResponse({ data: [hour(1, 4.121), hour(2, 9.212)] }),
    );
    const rows = await fetchGoogleAdsDailyBreakdown(
      "123-456-7890",
      "2026-08-18",
      "2026-08-18",
      { fetcher: fetcher as typeof fetch },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].spend).toBe(13.333);
    expect(rows[0].conversionValue).toBe(13.333);
    expect(rows[0].conversions).toBe(0.2);
  });
});
