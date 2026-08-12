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
  class ClientShopifyConnectionError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  class ShopifyReportingError extends Error {
    constructor(
      public code: string,
      message: string,
      public retryable = false,
    ) {
      super(message);
    }
  }
  return {
    ClientOnboardingError,
    ClientShopifyConnectionError,
    ShopifyReportingError,
    isClientOnboardingId: vi.fn(() => true),
    authorizeClientOnboardingRequest: vi.fn(),
    connectReportingShopifyStore: vi.fn(),
    createReportingShopifyRepository: vi.fn(),
  };
});

vi.mock("@/lib/client-onboarding/invitations", () => ({
  isClientOnboardingId: mocks.isClientOnboardingId,
}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
  authorizeClientOnboardingRequest: mocks.authorizeClientOnboardingRequest,
}));
vi.mock("@/lib/client-onboarding/shopify-connections", () => ({
  ClientShopifyConnectionError: mocks.ClientShopifyConnectionError,
  connectReportingShopifyStore: mocks.connectReportingShopifyStore,
}));
vi.mock("@/lib/client-onboarding/shopify-repository", () => ({
  createReportingShopifyRepository: mocks.createReportingShopifyRepository,
}));
vi.mock("@/lib/client-onboarding/shopify-scopes", () => ({
  REQUIRED_REPORTING_SHOPIFY_SCOPES: ["read_orders", "read_reports"],
}));
vi.mock("@/lib/client-onboarding/shopify", () => ({
  ShopifyReportingError: mocks.ShopifyReportingError,
}));

import { GET, POST } from "./route";

const ID = "40000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const BODY = {
  shopDomain: "northwind-demo.myshopify.com",
  shopifyClientId: "client-id-123456",
  clientSecret: "client-secret-value-123456",
};

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      id: ID,
      status: "collecting",
      claimed_user_id: "40000000-0000-4000-8000-000000000009",
      requested_assets: ["shopify", "google_ads"],
      ...overrides,
    },
    tokenHash: "a".repeat(64),
    actorUserId: null,
    usingInvitation: true,
  };
}

function context() {
  return { params: Promise.resolve({ id: ID }) };
}

function post(body: unknown = BODY, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/onboarding/client/${ID}/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dropscale-client-onboarding": TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("public client reporting Shopify route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isClientOnboardingId.mockReturnValue(true);
    mocks.authorizeClientOnboardingRequest.mockResolvedValue(authorization());
    mocks.createReportingShopifyRepository.mockReturnValue({ kind: "repository" });
    mocks.connectReportingShopifyStore.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000002",
      store: {
        name: "Northwind Demo Store",
        domain: "northwind-demo.myshopify.com",
        primaryDomain: "northwind.example",
        currencyCode: "AUD",
      },
      health: {
        ok: true,
        limited: false,
        testedAt: "2026-08-12T19:00:00.000Z",
        capabilities: [],
      },
    });
  });

  it("preflights the fragment bearer before showing Shopify setup", async () => {
    const request = new NextRequest(
      `http://localhost/api/onboarding/client/${ID}/shopify`,
      { headers: { "x-dropscale-client-onboarding": TOKEN } },
    );
    const result = await GET(request, context());
    expect(result.status).toBe(200);
    expect(mocks.authorizeClientOnboardingRequest).toHaveBeenCalledWith(
      ID,
      TOKEN,
    );
    expect(await result.json()).toEqual({
      ok: true,
      scopes: ["read_orders", "read_reports"],
    });
    expect(result.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects a streamed oversized body before authorisation", async () => {
    const result = await POST(
      post(
        { ...BODY, clientSecret: "x".repeat(9_000) },
        { "content-length": "1" },
      ),
      context(),
    );
    expect(result.status).toBe(413);
    expect(mocks.authorizeClientOnboardingRequest).not.toHaveBeenCalled();
    expect(mocks.createReportingShopifyRepository).not.toHaveBeenCalled();
  });

  it("authorises the link before constructing service-role persistence", async () => {
    mocks.authorizeClientOnboardingRequest.mockRejectedValue(
      new mocks.ClientOnboardingError("invalid_invitation", "Invalid link.", 404),
    );
    const result = await POST(post(), context());
    expect(result.status).toBe(404);
    expect(mocks.createReportingShopifyRepository).not.toHaveBeenCalled();
    expect(mocks.connectReportingShopifyStore).not.toHaveBeenCalled();
  });

  it("requires the account step and Shopify request before accepting credentials", async () => {
    mocks.authorizeClientOnboardingRequest.mockResolvedValue(
      authorization({ claimed_user_id: null }),
    );
    const result = await POST(post(), context());
    expect(result.status).toBe(409);
    expect(mocks.createReportingShopifyRepository).not.toHaveBeenCalled();
    expect(mocks.connectReportingShopifyStore).not.toHaveBeenCalled();
  });

  it("connects through the purpose-bound service and returns a secret-free DTO", async () => {
    const result = await POST(post(), context());
    expect(result.status).toBe(201);
    expect(mocks.connectReportingShopifyStore).toHaveBeenCalledWith({
      authorization: { sessionId: ID, tokenHash: "a".repeat(64) },
      shopDomain: BODY.shopDomain,
      shopifyClientId: BODY.shopifyClientId,
      clientSecret: BODY.clientSecret,
      repository: { kind: "repository" },
    });
    const payload = await result.json();
    expect(payload.ok).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(BODY.clientSecret);
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });

  it("maps classified Shopify failures without leaking merchant credentials", async () => {
    mocks.connectReportingShopifyStore.mockRejectedValue(
      new mocks.ShopifyReportingError(
        "invalid_credentials",
        "Shopify rejected the reporting app.",
      ),
    );
    const result = await POST(post(), context());
    expect(result.status).toBe(422);
    const payload = await result.json();
    expect(payload).toEqual({
      error: "Shopify rejected the reporting app.",
      code: "invalid_credentials",
    });
    expect(JSON.stringify(payload)).not.toContain(BODY.clientSecret);
  });
});
