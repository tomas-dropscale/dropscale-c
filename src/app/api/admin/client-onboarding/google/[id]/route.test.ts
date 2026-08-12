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
  const rpc = vi.fn();
  return {
    ClientOnboardingError,
    WindsorError,
    isClientOnboardingId: vi.fn(() => true),
    requireClientOnboardingAdmin: vi.fn(),
    createServiceClient: vi.fn(() => ({ rpc })),
    rpc,
    checkGoogleAdsAccountHealth: vi.fn(),
  };
});

vi.mock("@/lib/client-onboarding/invitations", () => ({
  isClientOnboardingId: mocks.isClientOnboardingId,
}));
vi.mock("@/lib/client-onboarding/http", () => ({
  clientOnboardingResponse: (body: unknown, status = 200) => Response.json(body, { status }),
  clientOnboardingErrorResponse: (error: unknown) => {
    const classified = error as { message?: string; code?: string; status?: number };
    return Response.json(
      { error: classified.message ?? "Request failed.", code: classified.code },
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
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
  requireClientOnboardingAdmin: mocks.requireClientOnboardingAdmin,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/windsor/client", () => ({
  WindsorError: mocks.WindsorError,
  checkGoogleAdsAccountHealth: mocks.checkGoogleAdsAccountHealth,
}));

import { DELETE } from "./route";

const ID = "40000000-0000-4000-8000-000000000002";
const ADMIN = "40000000-0000-4000-8000-000000000003";

describe("admin client Google Ads disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isClientOnboardingId.mockReturnValue(true);
    mocks.requireClientOnboardingAdmin.mockResolvedValue({ id: ADMIN, role: "admin" });
    mocks.rpc.mockResolvedValue({ data: ID, error: null });
  });

  it("requires admin auth before service-role access", async () => {
    mocks.requireClientOnboardingAdmin.mockRejectedValue(
      new mocks.ClientOnboardingError("forbidden", "Forbidden.", 403),
    );
    const response = await DELETE(
      new NextRequest(`http://localhost/api/admin/client-onboarding/google/${ID}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("disconnects only the Dropscale asset and states the Windsor boundary", async () => {
    const response = await DELETE(
      new NextRequest(`http://localhost/api/admin/client-onboarding/google/${ID}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("revoke_client_google_ads_connection", {
      p_connection_id: ID,
      p_admin_id: ADMIN,
    });
    expect(await response.json()).toEqual({
      ok: true,
      scope: "dropscale_only",
      message: "Disconnected from Dropscale. The Windsor authorization was not removed.",
    });
  });
});
