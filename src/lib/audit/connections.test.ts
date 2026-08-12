import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  eq: vi.fn(),
  from: vi.fn(),
  getSessionProfile: vi.fn(),
  maybeSingle: vi.fn(),
  neq: vi.fn(),
  order: vi.fn(),
  select: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/google-ads/crypto", () => ({
  encryptToken: vi.fn(),
}));
vi.mock("@/lib/audit/invitations", () => ({
  auditInvitationUrl: vi.fn(),
  createAuditInvitationMaterial: vi.fn(),
  hashAuditInviteToken: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { getAuditMachineSponsor, listAuditConnections } from "./connections";

const ADMIN_ID = "40000000-0000-4000-8000-000000000001";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "40000000-0000-4000-8000-000000000002",
    store_label: "Example store",
    status: "connected",
    invite_expires_at: null,
    failed_attempts: 0,
    shopify_name: "Example store",
    shopify_domain: "example.myshopify.com",
    primary_domain: "example.com",
    shopify_currency: "EUR",
    credential_hint: "client…hint",
    granted_scopes: ["read_orders"],
    scope_profile: "orders",
    created_at: "2026-08-12T10:00:00.000Z",
    updated_at: "2026-08-12T10:05:00.000Z",
    connected_at: "2026-08-12T10:02:00.000Z",
    last_verified_at: "2026-08-12T10:03:00.000Z",
    reviewed_at: null,
    revoked_at: null,
    last_error_code: null,
    ...overrides,
  };
}

describe("audit connection DAL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_ADS_TOKEN_ENC_KEY", "configured-for-test");
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: ADMIN_ID },
      profile: { id: ADMIN_ID, role: "admin" },
    });
    mocks.createServiceClient.mockReturnValue({ from: mocks.from });
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ neq: mocks.neq });
    mocks.neq.mockReturnValue({ order: mocks.order });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("queries out revoked rows and defensively removes any returned by the DAL", async () => {
    mocks.order.mockResolvedValue({
      data: [
        row(),
        row({
          id: "40000000-0000-4000-8000-000000000003",
          store_label: "Pending store",
          status: "pending",
          invite_expires_at: "2999-08-19T10:00:00.000Z",
          failed_attempts: 2,
          shopify_name: null,
          shopify_domain: null,
          primary_domain: null,
          shopify_currency: null,
          credential_hint: null,
          granted_scopes: [],
          connected_at: null,
          last_verified_at: null,
          last_error_code: "invalid_credentials",
        }),
        row({
          id: "40000000-0000-4000-8000-000000000004",
          store_label: "Revoked store",
          status: "revoked",
          reviewed_at: "2026-08-12T10:04:00.000Z",
          revoked_at: "2026-08-12T10:06:00.000Z",
        }),
      ],
      error: null,
    });

    const connections = await listAuditConnections();

    expect(mocks.from).toHaveBeenCalledWith("audit_shopify_connections");
    expect(mocks.neq).toHaveBeenCalledOnce();
    expect(mocks.neq).toHaveBeenCalledWith("status", "revoked");
    expect(connections).toEqual([
      {
        id: "40000000-0000-4000-8000-000000000002",
        storeLabel: "Example store",
        status: "connected",
        inviteExpiresAt: null,
        failedAttempts: 0,
        shopifyName: "Example store",
        shopifyDomain: "example.myshopify.com",
        primaryDomain: "example.com",
        currency: "EUR",
        credentialHint: "client…hint",
        grantedScopes: ["read_orders"],
        scopeProfile: "orders",
        createdAt: "2026-08-12T10:00:00.000Z",
        updatedAt: "2026-08-12T10:05:00.000Z",
        connectedAt: "2026-08-12T10:02:00.000Z",
        lastVerifiedAt: "2026-08-12T10:03:00.000Z",
        reviewedAt: null,
        revokedAt: null,
        lastErrorCode: null,
        needsReview: true,
      },
      {
        id: "40000000-0000-4000-8000-000000000003",
        storeLabel: "Pending store",
        status: "waiting",
        inviteExpiresAt: "2999-08-19T10:00:00.000Z",
        failedAttempts: 2,
        shopifyName: null,
        shopifyDomain: null,
        primaryDomain: null,
        currency: null,
        credentialHint: null,
        grantedScopes: [],
        scopeProfile: "orders",
        createdAt: "2026-08-12T10:00:00.000Z",
        updatedAt: "2026-08-12T10:05:00.000Z",
        connectedAt: null,
        lastVerifiedAt: null,
        reviewedAt: null,
        revokedAt: null,
        lastErrorCode: "invalid_credentials",
        needsReview: false,
      },
    ]);
  });

  it("resolves a machine sponsor only from the exact connected shop binding", async () => {
    mocks.select.mockReturnValueOnce({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.maybeSingle.mockResolvedValue({
      data: {
        created_by: ADMIN_ID,
        status: "connected",
        shopify_domain: "jwmtjg-fm.myshopify.com",
        shopify_shop_id: "gid://shopify/Shop/95462097276",
      },
      error: null,
    });

    await expect(
      getAuditMachineSponsor({
        connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
        shopifyDomain: "jwmtjg-fm.myshopify.com",
        shopifyShopId: "gid://shopify/Shop/95462097276",
      }),
    ).resolves.toBe(ADMIN_ID);
    expect(mocks.eq).toHaveBeenCalledWith(
      "id",
      "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    );
  });

  it("fails closed when the machine binding does not match", async () => {
    mocks.select.mockReturnValueOnce({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.maybeSingle.mockResolvedValue({
      data: {
        created_by: ADMIN_ID,
        status: "connected",
        shopify_domain: "different.myshopify.com",
        shopify_shop_id: "gid://shopify/Shop/95462097276",
      },
      error: null,
    });

    await expect(
      getAuditMachineSponsor({
        connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
        shopifyDomain: "jwmtjg-fm.myshopify.com",
        shopifyShopId: "gid://shopify/Shop/95462097276",
      }),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
  });
});
