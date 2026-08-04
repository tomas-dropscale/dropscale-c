import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  billingIssuanceEnabled: vi.fn(),
  checkStripeReadiness: vi.fn(),
  getSessionProfile: vi.fn(),
}));

vi.mock("@/lib/billing/issuance-gate", () => ({
  billingIssuanceEnabled: mocks.billingIssuanceEnabled,
}));
vi.mock("@/lib/stripe/client", () => ({
  checkStripeReadiness: mocks.checkStripeReadiness,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));

import { GET } from "./route";

const LIMITATIONS = [
  "stripe_write_permissions_not_verified",
  "webhook_signing_secret_match_not_verified",
];

describe("admin Stripe readiness route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_configured");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_configured");
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: "00000000-0000-4000-8000-000000000001" },
      profile: {
        id: "00000000-0000-4000-8000-000000000001",
        role: "admin",
      },
    });
    mocks.billingIssuanceEnabled.mockReturnValue(false);
    mocks.checkStripeReadiness.mockResolvedValue({
      keyMode: "live",
      liveMode: true,
      permissions: {
        customersRead: true,
        invoicesRead: true,
        invoiceItemsRead: true,
      },
      limitations: LIMITATIONS,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { user: null, profile: null },
    {
      user: { id: "00000000-0000-4000-8000-000000000002" },
      profile: {
        id: "00000000-0000-4000-8000-000000000002",
        role: "client",
      },
    },
  ])("authenticates an admin before reading readiness state", async (session) => {
    mocks.getSessionProfile.mockResolvedValue(session);

    const response = await GET();

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
    expect(mocks.checkStripeReadiness).not.toHaveBeenCalled();
    expect(mocks.billingIssuanceEnabled).not.toHaveBeenCalled();
  });

  it("returns normalized, no-store readiness without enabling issuance", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      ready: true,
      keyMode: "live",
      liveMode: true,
      webhookSecretConfigured: true,
      serviceRoleConfigured: true,
      issuanceEnabled: false,
      permissions: {
        customersRead: true,
        invoicesRead: true,
        invoiceItemsRead: true,
      },
      limitations: LIMITATIONS,
    });
    expect(mocks.checkStripeReadiness).toHaveBeenCalledWith();
  });

  it("fails readiness for missing server secrets or any denied read", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    mocks.billingIssuanceEnabled.mockReturnValue(true);
    mocks.checkStripeReadiness.mockResolvedValue({
      keyMode: "live",
      liveMode: true,
      permissions: {
        customersRead: true,
        invoicesRead: false,
        invoiceItemsRead: true,
      },
      limitations: LIMITATIONS,
    });

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      ready: false,
      webhookSecretConfigured: false,
      serviceRoleConfigured: false,
      issuanceEnabled: true,
      permissions: { invoicesRead: false },
      limitations: LIMITATIONS,
    });
  });
});
