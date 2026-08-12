import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/google-ads/crypto", () => ({
  encryptToken: vi.fn(),
  decryptToken: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import type { CompleteShopifyConnectionRecord } from "./shopify-connections";
import { createReportingShopifyRepository } from "./shopify-repository";

const CONNECTION_ID = "40000000-0000-4000-8000-000000000002";
const SESSION_ID = "40000000-0000-4000-8000-000000000001";
const ADMIN_ID = "40000000-0000-4000-8000-000000000003";

function completion(): CompleteShopifyConnectionRecord {
  return {
    connectionId: CONNECTION_ID,
    sessionId: SESSION_ID,
    tokenHash: "a".repeat(64),
    shop: {
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
    },
    shopifyClientId: "client-id-123456",
    credentialHint: "3456",
    clientSecretCiphertext: "ciphertext-only",
  };
}

function query(data: unknown, error: unknown = null) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return builder;
}

describe("Supabase reporting Shopify repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_ADS_TOKEN_ENC_KEY = "configured";
  });

  it("fails closed before constructing a secret repository when env is absent", () => {
    delete process.env.GOOGLE_ADS_TOKEN_ENC_KEY;
    mocks.createServiceClient.mockReturnValue(null);
    expect(() => createReportingShopifyRepository()).toThrow(
      expect.objectContaining({ code: "server_not_configured", status: 503 }),
    );
  });

  it("sends the complete atomic RPC contract without raw credentials", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: CONNECTION_ID, error: null });
    mocks.createServiceClient.mockReturnValue({ rpc });
    const repo = createReportingShopifyRepository();

    await expect(repo.complete(completion())).resolves.toBe(CONNECTION_ID);
    expect(rpc).toHaveBeenCalledWith("complete_client_shopify_connection", {
      p_connection_id: CONNECTION_ID,
      p_session_id: SESSION_ID,
      p_token_hash: "a".repeat(64),
      p_shopify_shop_id: "gid://shopify/Shop/123",
      p_shopify_name: "Northwind Demo Store",
      p_shopify_domain: "northwind-demo.myshopify.com",
      p_primary_domain: "northwind.example",
      p_shopify_currency: "AUD",
      p_shopify_client_id: "client-id-123456",
      p_credential_hint: "3456",
      p_granted_scopes: ["read_orders"],
      p_client_secret_ciphertext: "ciphertext-only",
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("client-secret-value");
  });

  it("maps the active-domain uniqueness boundary to a safe conflict", async () => {
    mocks.createServiceClient.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23505", message: "database details" },
      }),
    });
    const repo = createReportingShopifyRepository();
    await expect(repo.complete(completion())).rejects.toMatchObject({
      code: "duplicate_store",
      status: 409,
    });
  });

  it("loads connection metadata and ciphertext from separate service-only tables", async () => {
    const connectionQuery = query({
      id: CONNECTION_ID,
      shopify_shop_id: "gid://shopify/Shop/123",
      shopify_domain: "northwind-demo.myshopify.com",
    });
    const credentialQuery = query({
      connection_id: CONNECTION_ID,
      shopify_client_id: "client-id-123456",
      client_secret_ciphertext: "ciphertext-only",
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(connectionQuery)
      .mockReturnValueOnce(credentialQuery);
    mocks.createServiceClient.mockReturnValue({ from });
    const repo = createReportingShopifyRepository();

    await expect(repo.loadCredential(CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      shopifyShopId: "gid://shopify/Shop/123",
      shopifyDomain: "northwind-demo.myshopify.com",
      shopifyClientId: "client-id-123456",
      clientSecretCiphertext: "ciphertext-only",
    });
    expect(from).toHaveBeenNthCalledWith(1, "client_shopify_connections");
    expect(from).toHaveBeenNthCalledWith(2, "client_shopify_credentials");
  });

  it("records health and revokes through admin-bound atomic RPCs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: CONNECTION_ID, error: null });
    mocks.createServiceClient.mockReturnValue({ rpc });
    const repo = createReportingShopifyRepository();

    await repo.recordHealth({
      connectionId: CONNECTION_ID,
      adminId: ADMIN_ID,
      ok: true,
      testedAt: "2026-08-12T19:00:00.000Z",
      errorCode: null,
    });
    await repo.revoke(CONNECTION_ID, ADMIN_ID);
    expect(rpc).toHaveBeenNthCalledWith(1, "record_client_shopify_health", {
      p_connection_id: CONNECTION_ID,
      p_admin_id: ADMIN_ID,
      p_ok: true,
      p_tested_at: "2026-08-12T19:00:00.000Z",
      p_error_code: null,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "revoke_client_shopify_connection", {
      p_connection_id: CONNECTION_ID,
      p_admin_id: ADMIN_ID,
    });
  });
});
