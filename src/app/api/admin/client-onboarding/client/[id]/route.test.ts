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
    isClientOnboardingId: vi.fn(),
    updatePortalClientIdentity: vi.fn(),
    archivePortalClient: vi.fn(),
  };
});

vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
  requireClientOnboardingAdmin: mocks.requireClientOnboardingAdmin,
}));
vi.mock("@/lib/client-onboarding/invitations", () => ({
  isClientOnboardingId: mocks.isClientOnboardingId,
}));
vi.mock("@/lib/client-onboarding/client-admin", () => ({
  updatePortalClientIdentity: mocks.updatePortalClientIdentity,
  archivePortalClient: mocks.archivePortalClient,
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

import { DELETE, PATCH } from "./route";

const CLIENT_ID = "40000000-0000-4000-8000-000000000001";
const ADMIN_ID = "40000000-0000-4000-8000-000000000002";

function context(id = CLIENT_ID) {
  return { params: Promise.resolve({ id }) };
}

function patch(body: unknown) {
  return new NextRequest(
    `http://localhost/api/admin/client-onboarding/client/${CLIENT_ID}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function remove(body?: unknown) {
  return new NextRequest(
    `http://localhost/api/admin/client-onboarding/client/${CLIENT_ID}`,
    body === undefined
      ? { method: "DELETE" }
      : {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}

describe("admin portal client identity route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClientOnboardingAdmin.mockResolvedValue({
      id: ADMIN_ID,
      role: "admin",
    });
    mocks.isClientOnboardingId.mockReturnValue(true);
    mocks.updatePortalClientIdentity.mockResolvedValue(undefined);
    mocks.archivePortalClient.mockResolvedValue(undefined);
  });

  it("re-authorises the admin before any client operation", async () => {
    mocks.requireClientOnboardingAdmin.mockRejectedValue(
      new mocks.ClientOnboardingError("forbidden", "Forbidden.", 403),
    );

    const response = await PATCH(
      patch({
        fullName: "Northwind Home",
        email: "owner@northwind.example",
        discordHandle: "northwind.home",
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mocks.isClientOnboardingId).not.toHaveBeenCalled();
    expect(mocks.updatePortalClientIdentity).not.toHaveBeenCalled();
  });

  it("accepts exactly fullName, email and nullable Discord handle", async () => {
    const response = await PATCH(
      patch({
        fullName: " Northwind Home ",
        email: " OWNER@NORTHWIND.EXAMPLE ",
        discordHandle: null,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.updatePortalClientIdentity).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      fullName: " Northwind Home ",
      email: " OWNER@NORTHWIND.EXAMPLE ",
      discordHandle: null,
      adminId: ADMIN_ID,
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each([
    { fullName: "Client", email: "client@example.com" },
    {
      fullName: "Client",
      email: "client@example.com",
      discordHandle: "client",
      extra: true,
    },
    { fullName: "Client", email: 42, discordHandle: "client" },
  ])("rejects a malformed or expanded edit payload", async (body) => {
    const response = await PATCH(patch(body), context());

    expect(response.status).toBe(400);
    expect(mocks.updatePortalClientIdentity).not.toHaveBeenCalled();
  });

  it("archives with no body and preserves the service contract", async () => {
    const response = await DELETE(remove(), context());

    expect(response.status).toBe(200);
    expect(mocks.archivePortalClient).toHaveBeenCalledWith(CLIENT_ID, ADMIN_ID);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a DELETE body before archiving", async () => {
    const response = await DELETE(remove({ hardDelete: true }), context());

    expect(response.status).toBe(400);
    expect(mocks.archivePortalClient).not.toHaveBeenCalled();
  });

  it("does not expose the client helpers for an invalid identifier", async () => {
    mocks.isClientOnboardingId.mockReturnValue(false);

    const response = await DELETE(remove(), context("not-a-client"));

    expect(response.status).toBe(404);
    expect(mocks.archivePortalClient).not.toHaveBeenCalled();
  });
});
