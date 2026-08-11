import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class AuditConnectionError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  class ShopifyAuditError extends Error {
    constructor(
      public code: string,
      message: string,
      public retryable = false,
    ) {
      super(message);
    }
  }
  return {
    AuditConnectionError,
    ShopifyAuditError,
    validateAuditInvitation: vi.fn(),
    verifyAuditClientCredentials: vi.fn(),
    completeAuditConnection: vi.fn(),
    recordAuditConnectionFailure: vi.fn(),
    normalizeAuditShopDomain: vi.fn((value: string) => value.trim()),
    isAuditConnectionId: vi.fn(() => true),
  };
});

vi.mock("@/lib/audit/connections", () => ({
  AuditConnectionError: mocks.AuditConnectionError,
  validateAuditInvitation: mocks.validateAuditInvitation,
  verifyAuditClientCredentials: mocks.verifyAuditClientCredentials,
  completeAuditConnection: mocks.completeAuditConnection,
  recordAuditConnectionFailure: mocks.recordAuditConnectionFailure,
}));
vi.mock("@/lib/audit/invitations", () => ({
  isAuditConnectionId: mocks.isAuditConnectionId,
}));
vi.mock("@/lib/audit/shopify", () => ({
  ShopifyAuditError: mocks.ShopifyAuditError,
  normalizeAuditShopDomain: mocks.normalizeAuditShopDomain,
  verifyAuditClientCredentials: mocks.verifyAuditClientCredentials,
}));

import { GET, POST } from "./route";

const ID = "40000000-0000-4000-8000-000000000003";
const BODY = {
  inviteToken: "A".repeat(43),
  shopDomain: "willow-wren.myshopify.com",
  clientId: "client-id-123456",
  clientSecret: "client-secret-123456",
};

function request(body: unknown = BODY) {
  return new NextRequest(`http://localhost/api/audit/shopify/${ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ id: ID }) };
}

function preflight(token = BODY.inviteToken) {
  return new NextRequest(`http://localhost/api/audit/shopify/${ID}`, {
    headers: { "x-dropscale-audit-invite": token },
  });
}

function verifiedShop(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "gid://shopify/Shop/123",
    name: "Willow & Wren",
    myshopifyDomain: "willow-wren.myshopify.com",
    primaryDomain: "willowren-melbourne.com",
    currencyCode: "AUD",
    scopes: {
      granted: ["read_products"],
      missing: [],
      writeScopes: [],
      unexpectedScopes: [],
      valid: true,
    },
    ...overrides,
  };
}

describe("public audit Shopify connection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuditConnectionId.mockReturnValue(true);
    mocks.validateAuditInvitation.mockResolvedValue({ id: ID, tokenHash: "a".repeat(64) });
    mocks.verifyAuditClientCredentials.mockResolvedValue(verifiedShop());
    mocks.completeAuditConnection.mockResolvedValue(undefined);
    mocks.recordAuditConnectionFailure.mockResolvedValue(undefined);
  });

  it("preflights the bearer before the merchant starts Shopify setup", async () => {
    const result = await GET(preflight(), context());
    expect(result.status).toBe(200);
    expect(mocks.validateAuditInvitation).toHaveBeenCalledWith(ID, BODY.inviteToken);
    expect(mocks.verifyAuditClientCredentials).not.toHaveBeenCalled();
  });

  it("rejects a streamed oversized body even when Content-Length lies", async () => {
    const result = await POST(
      new NextRequest(`http://localhost/api/audit/shopify/${ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1" },
        body: JSON.stringify({ ...BODY, padding: "x".repeat(9_000) }),
      }),
      context(),
    );
    expect(result.status).toBe(413);
    expect(mocks.validateAuditInvitation).not.toHaveBeenCalled();
  });

  it("validates the one-time invitation before sending credentials to Shopify", async () => {
    mocks.validateAuditInvitation.mockRejectedValue(
      new mocks.AuditConnectionError("invalid_invitation", "Invalid link.", 404),
    );
    const result = await POST(request(), context());
    expect(result.status).toBe(404);
    expect(mocks.verifyAuditClientCredentials).not.toHaveBeenCalled();
    expect(mocks.completeAuditConnection).not.toHaveBeenCalled();
  });

  it("accepts write scopes when they belong to the required audit profile", async () => {
    mocks.verifyAuditClientCredentials.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_products", "write_products"],
          missing: [],
          writeScopes: ["write_products"],
          unexpectedScopes: [],
          valid: true,
        },
      }),
    );
    const result = await POST(request(), context());
    expect(result.status).toBe(200);
    expect(mocks.completeAuditConnection).toHaveBeenCalledOnce();
  });

  it("returns the missing scope list without consuming the invitation", async () => {
    mocks.verifyAuditClientCredentials.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: [],
          missing: ["read_products"],
          writeScopes: [],
          unexpectedScopes: [],
          valid: false,
        },
      }),
    );
    const result = await POST(request(), context());
    expect(result.status).toBe(422);
    await expect(result.json()).resolves.toMatchObject({
      code: "missing_scopes",
      missingScopes: ["read_products"],
    });
    expect(mocks.completeAuditConnection).not.toHaveBeenCalled();
  });

  it("rejects scopes outside the published audit profile", async () => {
    mocks.verifyAuditClientCredentials.mockResolvedValue(
      verifiedShop({
        scopes: {
          granted: ["read_products", "root_store_access"],
          missing: [],
          writeScopes: [],
          unexpectedScopes: ["root_store_access"],
          valid: false,
        },
      }),
    );
    const result = await POST(request(), context());
    expect(result.status).toBe(422);
    await expect(result.json()).resolves.toMatchObject({
      code: "extra_scopes_not_allowed",
      extraScopes: ["root_store_access"],
    });
  });

  it("saves only after identity/scopes verify and returns a secret-free DTO", async () => {
    const result = await POST(request(), context());
    expect(result.status).toBe(200);
    expect(mocks.completeAuditConnection).toHaveBeenCalledWith({
      invitation: { id: ID, tokenHash: "a".repeat(64) },
      shop: verifiedShop(),
      clientId: BODY.clientId,
      clientSecret: BODY.clientSecret,
    });
    const payload = await result.json();
    expect(payload).toEqual({
      ok: true,
      store: {
        name: "Willow & Wren",
        domain: "willow-wren.myshopify.com",
      },
    });
    expect(JSON.stringify(payload)).not.toContain(BODY.clientSecret);
    expect(result.headers.get("cache-control")).toContain("no-store");
  });

  it("does not echo Shopify response details or credentials", async () => {
    mocks.verifyAuditClientCredentials.mockRejectedValue(
      new mocks.ShopifyAuditError(
        "invalid_credentials",
        "Shopify rejected the Client ID or Client Secret.",
      ),
    );
    const result = await POST(request(), context());
    expect(result.status).toBe(422);
    const payload = await result.json();
    expect(payload).toEqual({
      error: "Shopify rejected the Client ID or Client Secret.",
      code: "invalid_credentials",
    });
    expect(JSON.stringify(payload)).not.toContain(BODY.clientSecret);
  });
});
