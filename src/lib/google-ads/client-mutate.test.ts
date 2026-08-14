import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agencyServiceAccount: vi.fn(),
  googleAdsApiBasics: vi.fn(),
  serviceAccountAccessToken: vi.fn(),
}));

vi.mock("@/lib/google-ads/env", () => ({
  agencyServiceAccount: mocks.agencyServiceAccount,
  googleAdsApiBasics: mocks.googleAdsApiBasics,
  googleAdsEnv: vi.fn(),
}));
vi.mock("@/lib/google-ads/service-account", () => ({
  serviceAccountAccessToken: mocks.serviceAccountAccessToken,
}));

import {
  GoogleAdsMutationError,
  mutateGoogleAdsAsAgency,
} from "./client";

describe("Google Ads agency mutation transport", () => {
  beforeEach(() => {
    mocks.agencyServiceAccount.mockReturnValue({
      key: { client_email: "agency@example.test" },
      loginCustomerId: "1111111111",
    });
    mocks.googleAdsApiBasics.mockReturnValue({
      developerToken: "developer-token",
      apiVersion: "v25",
    });
    mocks.serviceAccountAccessToken.mockResolvedValue({ ok: true, token: "access-token" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends one exact validate-only operation and returns a redacted receipt", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ campaign: { resourceName: "campaign" } }] }), {
        status: 200,
        headers: { "request-id": "request-1" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await mutateGoogleAdsAsAgency(
      "123-456-7890",
      "campaigns",
      [{ update: { resourceName: "campaign" }, updateMask: "status" }],
      { validateOnly: true },
    );

    expect(result).toEqual({
      requestId: "request-1",
      results: [{ campaign: { resourceName: "campaign" } }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://googleads.googleapis.com/v25/customers/1234567890/campaigns:mutate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "developer-token": "developer-token",
          "login-customer-id": "1111111111",
        }),
      }),
    );
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      validateOnly: true,
      partialFailure: false,
      responseContentType: "MUTABLE_RESOURCE",
    });
  });

  it("redacts a definitive validation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              status: "PERMISSION_DENIED",
              message: "secret upstream wording and identifiers",
            },
          }),
          { status: 403, headers: { "request-id": "request-denied" } },
        ),
      ),
    );

    const error = await mutateGoogleAdsAsAgency(
      "1234567890",
      "campaigns",
      [{ update: { resourceName: "campaign" }, updateMask: "status" }],
      { validateOnly: true },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(GoogleAdsMutationError);
    expect(error).toMatchObject({
      status: 403,
      providerCode: "PERMISSION_DENIED",
      requestId: "request-denied",
      indeterminate: false,
    });
    expect(String(error)).not.toContain("secret upstream wording");
  });

  it("marks a lost actual-mutation response indeterminate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket closed")));

    await expect(
      mutateGoogleAdsAsAgency(
        "1234567890",
        "campaignBudgets",
        [{ update: { resourceName: "budget" }, updateMask: "amount_micros" }],
        { validateOnly: false },
      ),
    ).rejects.toMatchObject({
      providerCode: "NETWORK_OR_TIMEOUT",
      indeterminate: true,
    });
  });

  it("rejects customer strings containing non-canonical noise", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      mutateGoogleAdsAsAgency(
        "account=1234567890",
        "campaigns",
        [{ update: { resourceName: "campaign" }, updateMask: "status" }],
        { validateOnly: true },
      ),
    ).rejects.toThrow("Invalid Google Ads mutate request");
    expect(fetch).not.toHaveBeenCalled();
  });
});
