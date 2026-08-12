import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  encryptToken: vi.fn(),
  decryptToken: vi.fn(),
  verifyReportingClientCredentials: vi.fn(),
  testReportingShopConnection: vi.fn(),
}));

vi.mock("@/lib/google-ads/crypto", () => ({
  encryptToken: mocks.encryptToken,
  decryptToken: mocks.decryptToken,
}));
vi.mock("./shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shopify")>();
  return {
    ...actual,
    verifyReportingClientCredentials: mocks.verifyReportingClientCredentials,
    testReportingShopConnection: mocks.testReportingShopConnection,
  };
});

import {
  ClientShopifyConnectionError,
  connectReportingShopifyStore,
  revokeReportingShopifyStore,
  testStoredReportingShopifyStore,
  type ReportingShopifyConnectionRepository,
} from "./shopify-connections";
import type { ReportingShopHealth, VerifiedReportingShop } from "./shopify";

const SESSION_ID = "40000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "40000000-0000-4000-8000-000000000002";
const ADMIN_ID = "40000000-0000-4000-8000-000000000003";

function shop(overrides: Partial<VerifiedReportingShop> = {}): VerifiedReportingShop {
  return {
    shopId: "gid://shopify/Shop/123",
    name: "Northwind Demo Store",
    myshopifyDomain: "northwind-demo.myshopify.com",
    primaryDomain: "northwind.example",
    currencyCode: "AUD",
    scopes: {
      granted: ["read_orders"],
      missing: [],
      missingPermissionGated: [],
      writeScopes: [],
      unexpectedReadScopes: [],
      valid: true,
    },
    ...overrides,
  };
}

function health(overrides: Partial<ReportingShopHealth> = {}): ReportingShopHealth {
  return {
    ok: true,
    limited: false,
    testedAt: "2026-08-12T19:00:00.000Z",
    capabilities: [],
    ...overrides,
  };
}

function repository(): ReportingShopifyConnectionRepository {
  return {
    complete: vi.fn().mockResolvedValue(CONNECTION_ID),
    loadCredential: vi.fn().mockResolvedValue({
      connectionId: CONNECTION_ID,
      shopifyShopId: "gid://shopify/Shop/123",
      shopifyDomain: "northwind-demo.myshopify.com",
      shopifyClientId: "client-id-123456",
      clientSecretCiphertext: "ciphertext-only",
    }),
    recordHealth: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
}

describe("client reporting Shopify connection service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(CONNECTION_ID);
    mocks.encryptToken.mockResolvedValue("ciphertext-only");
    mocks.decryptToken.mockResolvedValue("client-secret-value-123456");
    mocks.verifyReportingClientCredentials.mockResolvedValue({
      accessToken: "ephemeral-access-token",
      shop: shop(),
    });
    mocks.testReportingShopConnection.mockResolvedValue(health());
  });

  it("persists only after scope and read-only health verification", async () => {
    const repo = repository();
    const result = await connectReportingShopifyStore({
      authorization: {
        sessionId: SESSION_ID,
        tokenHash: "a".repeat(64),
      },
      shopDomain: "northwind-demo.myshopify.com",
      shopifyClientId: " client-id-123456 ",
      clientSecret: " client-secret-value-123456 ",
      repository: repo,
    });

    expect(mocks.verifyReportingClientCredentials).toHaveBeenCalledBefore(
      mocks.testReportingShopConnection,
    );
    expect(mocks.encryptToken).toHaveBeenCalledWith(
      "client-secret-value-123456",
    );
    expect(repo.complete).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      sessionId: SESSION_ID,
      tokenHash: "a".repeat(64),
      shop: shop(),
      shopifyClientId: "client-id-123456",
      credentialHint: "3456",
      clientSecretCiphertext: "ciphertext-only",
    });
    expect(result).toEqual({
      id: CONNECTION_ID,
      store: {
        name: "Northwind Demo Store",
        domain: "northwind-demo.myshopify.com",
        primaryDomain: "northwind.example",
        currencyCode: "AUD",
      },
      health: health(),
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("access-token");
  });

  it("never encrypts or writes a credential with missing scopes", async () => {
    const repo = repository();
    mocks.verifyReportingClientCredentials.mockResolvedValue({
      accessToken: "ephemeral-access-token",
      shop: shop({
        scopes: {
          granted: [],
          missing: ["read_orders"],
          missingPermissionGated: [],
          writeScopes: [],
          unexpectedReadScopes: [],
          valid: false,
        },
      }),
    });

    await expect(
      connectReportingShopifyStore({
        authorization: {
          sessionId: SESSION_ID,
          tokenHash: "a".repeat(64),
        },
        shopDomain: "northwind-demo.myshopify.com",
        shopifyClientId: "client-id-123456",
        clientSecret: "client-secret-value-123456",
        repository: repo,
      }),
    ).rejects.toBeInstanceOf(ClientShopifyConnectionError);
    expect(mocks.testReportingShopConnection).not.toHaveBeenCalled();
    expect(mocks.encryptToken).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it("rejects any unexpected write permission", async () => {
    const repo = repository();
    mocks.verifyReportingClientCredentials.mockResolvedValue({
      accessToken: "ephemeral-access-token",
      shop: shop({
        scopes: {
          granted: ["read_orders", "write_orders"],
          missing: [],
          missingPermissionGated: [],
          writeScopes: ["write_orders"],
          unexpectedReadScopes: [],
          valid: false,
        },
      }),
    });

    await expect(
      connectReportingShopifyStore({
        authorization: {
          sessionId: SESSION_ID,
          tokenHash: "a".repeat(64),
        },
        shopDomain: "northwind-demo.myshopify.com",
        shopifyClientId: "client-id-123456",
        clientSecret: "client-secret-value-123456",
        repository: repo,
      }),
    ).rejects.toMatchObject({
      code: "invalid_scope_profile",
      status: 422,
    });
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it("does not persist when the actual reporting reads fail", async () => {
    const repo = repository();
    mocks.testReportingShopConnection.mockResolvedValue(
      health({ ok: false, limited: true }),
    );

    await expect(
      connectReportingShopifyStore({
        authorization: {
          sessionId: SESSION_ID,
          tokenHash: "a".repeat(64),
        },
        shopDomain: "northwind-demo.myshopify.com",
        shopifyClientId: "client-id-123456",
        clientSecret: "client-secret-value-123456",
        repository: repo,
      }),
    ).rejects.toMatchObject({ code: "health_check_failed" });
    expect(mocks.encryptToken).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it("decrypts server-side, rechecks stable identity and records health", async () => {
    const repo = repository();
    const result = await testStoredReportingShopifyStore({
      connectionId: CONNECTION_ID,
      adminId: ADMIN_ID,
      repository: repo,
    });

    expect(mocks.decryptToken).toHaveBeenCalledWith("ciphertext-only");
    expect(mocks.verifyReportingClientCredentials).toHaveBeenCalledWith({
      shopDomain: "northwind-demo.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-value-123456",
    });
    expect(repo.recordHealth).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      adminId: ADMIN_ID,
      ok: true,
      testedAt: "2026-08-12T19:00:00.000Z",
      errorCode: null,
    });
    expect(result).toEqual(health());
  });

  it("fails closed and records a redacted code if the credential changes shop", async () => {
    const repo = repository();
    mocks.verifyReportingClientCredentials.mockResolvedValue({
      accessToken: "ephemeral-access-token",
      shop: shop({ shopId: "gid://shopify/Shop/999" }),
    });

    await expect(
      testStoredReportingShopifyStore({
        connectionId: CONNECTION_ID,
        adminId: ADMIN_ID,
        repository: repo,
      }),
    ).rejects.toMatchObject({ code: "stored_identity_mismatch" });
    expect(repo.recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        adminId: ADMIN_ID,
        ok: false,
        errorCode: "stored_identity_mismatch",
      }),
    );
  });

  it("delegates revoke to the atomic credential-destruction boundary", async () => {
    const repo = repository();
    await revokeReportingShopifyStore({
      connectionId: CONNECTION_ID,
      adminId: ADMIN_ID,
      repository: repo,
    });
    expect(repo.revoke).toHaveBeenCalledWith(
      CONNECTION_ID,
      ADMIN_ID,
    );
  });
});
