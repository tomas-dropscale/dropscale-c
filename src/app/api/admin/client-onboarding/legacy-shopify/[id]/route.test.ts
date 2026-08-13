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
  class LegacyShopifyHealthError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    ClientOnboardingError,
    LegacyShopifyHealthError,
    isClientOnboardingId: vi.fn(() => true),
    requireClientOnboardingAdmin: vi.fn(),
    createServiceClient: vi.fn(),
    testLegacyShopifyConnection: vi.fn(),
  };
});

vi.mock("@/lib/client-onboarding/invitations", () => ({
  isClientOnboardingId: mocks.isClientOnboardingId,
}));
vi.mock("@/lib/client-onboarding/http", () => ({
  clientOnboardingResponse: (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store, max-age=0" },
    }),
  clientOnboardingErrorResponse: (error: unknown, fallback: string) => {
    const classified = error as { message?: string; code?: string; status?: number };
    return Response.json(
      {
        error: classified.message ?? fallback,
        code: classified.code ?? "request_failed",
      },
      { status: classified.status ?? 500 },
    );
  },
  isExactRecord: (value: unknown, required: string[]) =>
    Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === required.length &&
        required.every((key) => key in (value as Record<string, unknown>)),
    ),
  readSmallJson: (request: Request) => request.json(),
}));
vi.mock("@/lib/client-onboarding/legacy-shopify", () => ({
  LegacyShopifyHealthError: mocks.LegacyShopifyHealthError,
  testLegacyShopifyConnection: mocks.testLegacyShopifyConnection,
}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
  requireClientOnboardingAdmin: mocks.requireClientOnboardingAdmin,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { PATCH } from "./route";

const ID = "40000000-0000-4000-8000-000000000002";
const HEALTH = {
  ok: true,
  limited: true,
  testedAt: "2026-08-13T09:30:00.000Z",
  capabilities: { orders: false },
  scopesMissing: ["read_reports"],
};

function context(id = ID) {
  return { params: Promise.resolve({ id }) };
}

function patch(body: unknown = { action: "test" }) {
  return new NextRequest(
    `http://localhost/api/admin/client-onboarding/legacy-shopify/${ID}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("admin legacy Shopify health route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isClientOnboardingId.mockReturnValue(true);
    mocks.requireClientOnboardingAdmin.mockResolvedValue({ role: "admin" });
    mocks.createServiceClient.mockReturnValue({ kind: "service" });
    mocks.testLegacyShopifyConnection.mockResolvedValue(HEALTH);
  });

  it("authenticates an admin before creating a service-role client", async () => {
    mocks.requireClientOnboardingAdmin.mockRejectedValue(
      new mocks.ClientOnboardingError("forbidden", "Forbidden.", 403),
    );

    const response = await PATCH(patch(), context());

    expect(response.status).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.testLegacyShopifyConnection).not.toHaveBeenCalled();
  });

  it("rejects an invalid UUID before service-role access", async () => {
    mocks.isClientOnboardingId.mockReturnValue(false);

    const response = await PATCH(patch(), context("not-an-id"));

    expect(response.status).toBe(404);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("accepts only the exact read-only test action", async () => {
    const response = await PATCH(patch({ action: "test", extra: true }), context());

    expect(response.status).toBe(400);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.testLegacyShopifyConnection).not.toHaveBeenCalled();
  });

  it("returns only the safe read-only health result with no caching", async () => {
    const response = await PATCH(patch(), context());

    expect(response.status).toBe(200);
    expect(mocks.testLegacyShopifyConnection).toHaveBeenCalledWith({
      accountId: ID,
      service: { kind: "service" },
    });
    expect(await response.json()).toEqual(HEALTH);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns classified errors without upstream or credential details", async () => {
    mocks.testLegacyShopifyConnection.mockRejectedValue(
      new mocks.LegacyShopifyHealthError(
        "invalid_credential",
        "The stored Shopify credential is invalid. Reconnect this store.",
        422,
      ),
    );

    const response = await PATCH(patch(), context());
    const serialised = JSON.stringify(await response.json());

    expect(response.status).toBe(422);
    expect(serialised).toContain("invalid_credential");
    expect(serialised).not.toContain("shpat_");
    expect(serialised).not.toContain("encrypted-");
  });
});
