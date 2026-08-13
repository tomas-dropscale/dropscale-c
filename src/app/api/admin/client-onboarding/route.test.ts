import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

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
  return {
    ClientOnboardingError,
    requireClientOnboardingAdmin: vi.fn(),
    createClientOnboardingSession: vi.fn(),
    listClientOnboardingSessions: vi.fn(),
    listExistingClientRoster: vi.fn(),
  };
});

vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
  requireClientOnboardingAdmin: mocks.requireClientOnboardingAdmin,
  createClientOnboardingSession: mocks.createClientOnboardingSession,
  listClientOnboardingSessions: mocks.listClientOnboardingSessions,
}));
vi.mock("@/lib/client-onboarding/legacy-roster", () => ({
  listExistingClientRoster: mocks.listExistingClientRoster,
}));
vi.mock("@/lib/client-onboarding/http", () => ({
  clientOnboardingResponse: (body: unknown, status = 200) =>
    NextResponse.json(body, { status }),
  clientOnboardingErrorResponse: (error: unknown, fallback: string) =>
    error instanceof mocks.ClientOnboardingError
      ? NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.status },
        )
      : NextResponse.json(
          { error: fallback, code: "request_failed" },
          { status: 500 },
        ),
  readSmallJson: (request: Request) => request.json(),
  isExactRecord: (
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
  ) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
      required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key))
    );
  },
}));

import { POST } from "./route";

const ADMIN = "40000000-0000-4000-8000-000000000001";
const STORE = "40000000-0000-4000-8000-000000000002";

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/client-onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin client onboarding invitation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClientOnboardingAdmin.mockResolvedValue({ id: ADMIN, role: "admin" });
    mocks.createClientOnboardingSession.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000003",
      url: "https://dropscale.app/onboarding/client/example#secret",
      mode: "reconnect",
      requestedAssets: ["shopify"],
    });
  });

  it("passes the exact Shopify asset target without accepting a client-wide reconnect", async () => {
    const result = await POST(
      post({
        mode: "reconnect",
        requestedAssets: ["shopify"],
        targetShopify: { source: "legacy", id: STORE },
      }),
    );

    expect(result.status).toBe(201);
    expect(mocks.createClientOnboardingSession).toHaveBeenCalledWith({
      mode: "reconnect",
      requestedAssets: ["shopify"],
      targetClientId: undefined,
      targetShopify: { source: "legacy", id: STORE },
      adminId: ADMIN,
    });
  });

  it.each([
    {
      mode: "reconnect",
      requestedAssets: ["shopify"],
      targetShopify: { source: "legacy", id: STORE, clientId: ADMIN },
    },
    {
      mode: "reconnect",
      requestedAssets: ["shopify"],
      targetShopify: STORE,
    },
  ])("rejects a malformed reconnect target before session creation", async (body) => {
    const result = await POST(post(body));

    expect(result.status).toBe(400);
    expect(mocks.createClientOnboardingSession).not.toHaveBeenCalled();
  });
});
