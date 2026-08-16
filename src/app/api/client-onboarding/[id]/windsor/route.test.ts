import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class ClientOnboardingError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }

  class WindsorError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }

  const secretQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    upsert: vi.fn(),
  };
  secretQuery.select.mockReturnValue(secretQuery);
  secretQuery.eq.mockReturnValue(secretQuery);

  const service = {
    from: vi.fn(() => secretQuery),
    rpc: vi.fn(),
  };

  return {
    ClientOnboardingError,
    WindsorError,
    authorizeClientOnboardingRequest: vi.fn(),
    getPublicClientOnboardingSession: vi.fn(),
    submitClientOnboardingSessionIfReady: vi.fn(),
    createServiceClient: vi.fn(() => service),
    createGoogleAdsAuthorization: vi.fn(),
    decryptWindsorAccessToken: vi.fn(),
    encryptWindsorAccessToken: vi.fn(),
    pollLinkedGoogleAdsAccounts: vi.fn(),
    secretQuery,
    service,
  };
});

vi.mock("@/lib/client-onboarding/http", () => ({
  clientOnboardingResponse: (body: unknown, status = 200) =>
    Response.json(body, { status }),
  clientOnboardingErrorResponse: (error: unknown, fallback: string) => {
    const value = error as { message?: string; status?: number; code?: string };
    return Response.json(
      { error: value.message ?? fallback, code: value.code },
      { status: value.status ?? 500 },
    );
  },
}));

vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
  authorizeClientOnboardingRequest: mocks.authorizeClientOnboardingRequest,
  getPublicClientOnboardingSession: mocks.getPublicClientOnboardingSession,
  submitClientOnboardingSessionIfReady:
    mocks.submitClientOnboardingSessionIfReady,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

vi.mock("@/lib/windsor/client", () => ({
  WindsorError: mocks.WindsorError,
  createGoogleAdsAuthorization: mocks.createGoogleAdsAuthorization,
  decryptWindsorAccessToken: mocks.decryptWindsorAccessToken,
  encryptWindsorAccessToken: mocks.encryptWindsorAccessToken,
  pollLinkedGoogleAdsAccounts: mocks.pollLinkedGoogleAdsAccounts,
}));

import { GET, POST } from "./route";

const SESSION_ID = "40000000-0000-4000-8000-000000000001";
const CLAIMED_USER_ID = "40000000-0000-4000-8000-000000000002";
const INVITATION_TOKEN = "A".repeat(43);
const TOKEN_HASH = "b".repeat(64);

const PUBLIC_ACCOUNTS = [
  {
    id: "40000000-0000-4000-8000-000000000010",
    accountId: "123-456-7890",
    accountName: "Northwind Demo Ads",
    currency: "USD",
    timeZone: "Europe/Lisbon",
    status: "connected",
  },
  {
    id: "40000000-0000-4000-8000-000000000011",
    accountId: "987-654-3210",
    accountName: "987-654-3210",
    currency: null,
    timeZone: null,
    status: "connected",
  },
];

function authorization() {
  return {
    session: {
      id: SESSION_ID,
      status: "collecting",
      claimed_user_id: CLAIMED_USER_ID,
      requested_assets: ["google_ads"],
    },
    tokenHash: TOKEN_HASH,
    actorUserId: null,
    usingInvitation: true,
  };
}

function context() {
  return { params: Promise.resolve({ id: SESSION_ID }) };
}

function request(method: "GET" | "POST") {
  return new NextRequest(
    `http://localhost/api/client-onboarding/${SESSION_ID}/windsor`,
    {
      method,
      headers: { "x-dropscale-client-onboarding": INVITATION_TOKEN },
    },
  );
}

describe("client onboarding Windsor route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.secretQuery.select.mockReturnValue(mocks.secretQuery);
    mocks.secretQuery.eq.mockReturnValue(mocks.secretQuery);
    mocks.service.from.mockReturnValue(mocks.secretQuery);
    mocks.createServiceClient.mockReturnValue(mocks.service);
    mocks.authorizeClientOnboardingRequest.mockResolvedValue(authorization());
    mocks.submitClientOnboardingSessionIfReady.mockResolvedValue(true);
    mocks.secretQuery.maybeSingle.mockResolvedValue({
      data: { windsor_access_token_ciphertext: "encrypted-correlation-token" },
      error: null,
    });
    mocks.decryptWindsorAccessToken.mockResolvedValue("windsor-correlation-token");
    mocks.pollLinkedGoogleAdsAccounts.mockResolvedValue({
      status: "connected",
      attempts: 1,
      accounts: [
        {
          datasource: "google_ads",
          accountId: "123-456-7890",
          customerId: "1234567890",
          accountName: "Northwind Demo Ads",
          status: "active",
          currency: "usd",
          timeZone: "Europe/Lisbon",
        },
        {
          datasource: "google_ads",
          accountId: "987-654-3210",
          customerId: "9876543210",
          accountName: null,
          status: null,
          currency: null,
          timeZone: null,
        },
      ],
    });
    mocks.service.rpc.mockResolvedValue({ data: [], error: null });
    mocks.getPublicClientOnboardingSession.mockResolvedValue({
      id: SESSION_ID,
      googleAds: PUBLIC_ACCOUNTS,
    });
  });

  it("persists every connected account atomically with exactly one batch RPC", async () => {
    const response = await GET(request("GET"), context());

    expect(response.status).toBe(200);
    expect(mocks.service.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.service.rpc).toHaveBeenCalledWith(
      "upsert_client_google_ads_connections",
      {
        p_session_id: SESSION_ID,
        p_token_hash: TOKEN_HASH,
        p_accounts: [
          {
            windsorAccountId: "123-456-7890",
            accountName: "Northwind Demo Ads",
            currency: "USD",
            timeZone: "Europe/Lisbon",
            dataSourceId: null,
          },
          {
            windsorAccountId: "987-654-3210",
            accountName: "987-654-3210",
            currency: null,
            timeZone: null,
            dataSourceId: null,
          },
        ],
      },
    );
    expect(
      mocks.service.rpc.mock.calls.some(
        ([name]) => name === "upsert_client_google_ads_connection",
      ),
    ).toBe(false);
    expect(await response.json()).toEqual({
      status: "connected",
      accounts: PUBLIC_ACCOUNTS,
      completed: true,
    });
    expect(mocks.getPublicClientOnboardingSession).toHaveBeenCalledWith(
      SESSION_ID,
      INVITATION_TOKEN,
    );
  });

  it("maps a batch uniqueness conflict to 409 and does not return a partial session", async () => {
    mocks.service.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "unique violation" },
    });

    const response = await GET(request("GET"), context());

    expect(response.status).toBe(409);
    expect(mocks.service.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.service.rpc).toHaveBeenCalledWith(
      "upsert_client_google_ads_connections",
      expect.objectContaining({
        p_accounts: expect.arrayContaining([
          expect.objectContaining({ windsorAccountId: "123-456-7890" }),
          expect.objectContaining({ windsorAccountId: "987-654-3210" }),
        ]),
      }),
    );
    expect(mocks.getPublicClientOnboardingSession).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: "One of these Google Ads accounts is already active in another onboarding.",
      code: "invalid_state",
    });
  });

  it("stores only an encrypted Windsor correlation token and returns only the co-user URL", async () => {
    const rawAccessToken = "windsor-raw-correlation-token";
    mocks.createGoogleAdsAuthorization.mockResolvedValue({
      authorizationUrl: "https://onboard.windsor.ai/co-user/example",
      accessToken: rawAccessToken,
    });
    mocks.encryptWindsorAccessToken.mockResolvedValue("encrypted-token");
    mocks.service.rpc.mockResolvedValue({ data: SESSION_ID, error: null });

    const postRequest = request("POST");
    const response = await POST(postRequest, context());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.createGoogleAdsAuthorization).toHaveBeenCalledTimes(1);
    expect(mocks.createGoogleAdsAuthorization).toHaveBeenCalledWith({
      signal: postRequest.signal,
    });
    expect(mocks.encryptWindsorAccessToken).toHaveBeenCalledWith(rawAccessToken);
    expect(mocks.service.rpc).toHaveBeenCalledWith("store_client_windsor_authorization", {
      p_session_id: SESSION_ID,
      p_token_hash: TOKEN_HASH,
      p_ciphertext: "encrypted-token",
    });
    expect(payload).toEqual({
      ok: true,
      authorizationUrl: "https://onboard.windsor.ai/co-user/example",
    });
    expect(JSON.stringify(payload)).not.toContain(rawAccessToken);
    expect(JSON.stringify(mocks.service.rpc.mock.calls)).not.toContain(
      rawAccessToken,
    );
  });

  it("does not return a generated Windsor URL when the session was cancelled in flight", async () => {
    mocks.createGoogleAdsAuthorization.mockResolvedValue({
      authorizationUrl: "https://onboard.windsor.ai/co-user/now-cancelled",
      accessToken: "windsor-raw-correlation-token",
    });
    mocks.encryptWindsorAccessToken.mockResolvedValue("encrypted-token");
    mocks.service.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "session closed" },
    });

    const response = await POST(request("POST"), context());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({
      error: "This Google Ads onboarding is no longer available. Ask Dropscale for a new link.",
      code: "invalid_state",
    });
    expect(JSON.stringify(payload)).not.toContain("now-cancelled");
  });
});
