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
    requireClientOnboardingAdmin: vi.fn(),
    createReportingShopifyRepository: vi.fn(),
    testStoredReportingShopifyStore: vi.fn(),
    revokeReportingShopifyStore: vi.fn(),
  };
});

vi.mock("@/lib/client-onboarding/invitations", () => ({
  isClientOnboardingId: mocks.isClientOnboardingId,
}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
  requireClientOnboardingAdmin: mocks.requireClientOnboardingAdmin,
}));
vi.mock("@/lib/client-onboarding/shopify-connections", () => ({
  ClientShopifyConnectionError: mocks.ClientShopifyConnectionError,
  testStoredReportingShopifyStore: mocks.testStoredReportingShopifyStore,
  revokeReportingShopifyStore: mocks.revokeReportingShopifyStore,
}));
vi.mock("@/lib/client-onboarding/shopify-repository", () => ({
  createReportingShopifyRepository: mocks.createReportingShopifyRepository,
}));
vi.mock("@/lib/client-onboarding/shopify", () => ({
  ShopifyReportingError: mocks.ShopifyReportingError,
}));

import { DELETE, PATCH } from "./route";

const ID = "40000000-0000-4000-8000-000000000002";
const ADMIN_ID = "40000000-0000-4000-8000-000000000003";

function context() {
  return { params: Promise.resolve({ id: ID }) };
}

function patch(body: unknown = { action: "test" }) {
  return new NextRequest(
    `http://localhost/api/admin/client-onboarding/shopify/${ID}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function remove() {
  return new NextRequest(
    `http://localhost/api/admin/client-onboarding/shopify/${ID}`,
    { method: "DELETE" },
  );
}

describe("admin client reporting Shopify route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isClientOnboardingId.mockReturnValue(true);
    mocks.requireClientOnboardingAdmin.mockResolvedValue({
      id: ADMIN_ID,
      role: "admin",
    });
    mocks.createReportingShopifyRepository.mockReturnValue({ kind: "repository" });
    mocks.testStoredReportingShopifyStore.mockResolvedValue({
      ok: true,
      limited: false,
      testedAt: "2026-08-12T19:00:00.000Z",
      capabilities: [],
    });
    mocks.revokeReportingShopifyStore.mockResolvedValue(undefined);
  });

  it("re-authorises admin before constructing service-role persistence", async () => {
    mocks.requireClientOnboardingAdmin.mockRejectedValue(
      new mocks.ClientOnboardingError("forbidden", "Forbidden.", 403),
    );
    const result = await PATCH(patch(), context());
    expect(result.status).toBe(403);
    expect(mocks.createReportingShopifyRepository).not.toHaveBeenCalled();
    expect(mocks.testStoredReportingShopifyStore).not.toHaveBeenCalled();
  });

  it("accepts only the exact read-only test action", async () => {
    const result = await PATCH(patch({ action: "test", extra: true }), context());
    expect(result.status).toBe(400);
    expect(mocks.createReportingShopifyRepository).not.toHaveBeenCalled();
    expect(mocks.testStoredReportingShopifyStore).not.toHaveBeenCalled();
  });

  it("runs the fresh test and returns only safe health metadata", async () => {
    const result = await PATCH(patch(), context());
    expect(result.status).toBe(200);
    expect(mocks.testStoredReportingShopifyStore).toHaveBeenCalledWith({
      connectionId: ID,
      adminId: ADMIN_ID,
      repository: { kind: "repository" },
    });
    expect(await result.json()).toEqual({
      ok: true,
      health: {
        ok: true,
        limited: false,
        testedAt: "2026-08-12T19:00:00.000Z",
        capabilities: [],
      },
    });
    expect(result.headers.get("cache-control")).toContain("no-store");
  });

  it("revokes only after admin auth and delegates credential destruction", async () => {
    const result = await DELETE(remove(), context());
    expect(result.status).toBe(200);
    expect(mocks.revokeReportingShopifyStore).toHaveBeenCalledWith({
      connectionId: ID,
      adminId: ADMIN_ID,
      repository: { kind: "repository" },
    });
    expect(await result.json()).toEqual({ ok: true });
  });

  it("maps a missing active asset without exposing database details", async () => {
    mocks.revokeReportingShopifyStore.mockRejectedValue(
      new mocks.ClientShopifyConnectionError(
        "not_found",
        "Active Shopify reporting connection not found.",
        404,
      ),
    );
    const result = await DELETE(remove(), context());
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({
      error: "Active Shopify reporting connection not found.",
      code: "not_found",
    });
  });
});
