import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class ShopifyError extends Error {
    constructor(
      message: string,
      public status?: number,
    ) {
      super(message);
    }
  }
  return {
    ShopifyError,
    decryptToken: vi.fn(),
    resolveAdminToken: vi.fn(),
    shopifyGraphql: vi.fn(),
    validateShopifyCredentials: vi.fn(),
  };
});

vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decryptToken }));
vi.mock("@/lib/shopify/client", () => ({
  ShopifyError: mocks.ShopifyError,
  normalizeShopDomain: (input: string) => {
    const domain = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
  },
  resolveAdminToken: mocks.resolveAdminToken,
  shopifyGraphql: mocks.shopifyGraphql,
  validateShopifyCredentials: mocks.validateShopifyCredentials,
}));

import { ShopifyError } from "@/lib/shopify/client";
import {
  disconnectLegacyShopifyConnection,
  LegacyShopifyDisconnectError,
  LegacyShopifyHealthError,
  testLegacyShopifyConnection,
} from "./legacy-shopify";

const ID = "40000000-0000-4000-8000-000000000002";
const CIPHERTEXT = "encrypted-shopify-credential";
const DIRECT_TOKEN = "shpat_direct-token-that-must-stay-server-side";
const CLIENT_SECRET = "shpss_client-secret-that-must-stay-server-side";
const ACCESS_TOKEN = "shpat_exchanged-token-that-must-stay-server-side";
const DOMAIN = "example-store.myshopify.com";
const ALL_SCOPES = [
  "read_orders",
  "read_all_orders",
  "read_analytics",
  "read_reports",
  "read_products",
  "read_inventory",
  "read_locations",
  "read_returns",
  "read_shopify_payments_accounts",
  "read_shopify_payments_payouts",
];

function serviceWith(
  data: Record<string, unknown> | null,
  error: unknown = null,
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const renameQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { id: ID }, error: null }),
  };
  renameQuery.select.mockReturnValue(renameQuery);
  renameQuery.eq.mockReturnValue(renameQuery);
  const update = vi.fn().mockReturnValue(renameQuery);
  const from = vi.fn().mockReturnValueOnce(query).mockReturnValueOnce({ update });
  return {
    service: { from } as never,
    from,
    query,
    renameQuery,
    update,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    shopify_url: DOMAIN,
    shopify_client_id: null,
    shopify_admin_token: CIPHERTEXT,
    ...overrides,
  };
}

function shop(accessScopes: string[] = ALL_SCOPES) {
  return {
    name: "Private merchant name",
    currencyCode: "EUR",
    myshopifyDomain: DOMAIN,
    accessScopes,
  };
}

describe("legacy Shopify health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAdminToken.mockResolvedValue(ACCESS_TOKEN);
    mocks.shopifyGraphql.mockResolvedValue({ orders: { nodes: [] } });
    mocks.validateShopifyCredentials.mockResolvedValue(shop());
  });

  it("loads only an active connected account and verifies a direct token server-side", async () => {
    const { service, query, renameQuery, update } = serviceWith(row());
    mocks.decryptToken.mockResolvedValue(DIRECT_TOKEN);

    const health = await testLegacyShopifyConnection({
      accountId: ID,
      service,
      now: new Date("2026-08-13T09:30:00.000Z"),
    });

    expect(query.eq.mock.calls).toEqual([
      ["id", ID],
      ["status", "active"],
      ["shopify_connected", true],
    ]);
    expect(mocks.decryptToken).toHaveBeenCalledWith(CIPHERTEXT);
    expect(mocks.resolveAdminToken).toHaveBeenCalledWith(DOMAIN, DIRECT_TOKEN, null);
    expect(mocks.validateShopifyCredentials).toHaveBeenCalledWith(DOMAIN, ACCESS_TOKEN);
    expect(mocks.shopifyGraphql).toHaveBeenCalledWith(
      DOMAIN,
      ACCESS_TOKEN,
      "{ orders(first: 1) { nodes { id } } }",
    );
    expect(mocks.shopifyGraphql).toHaveBeenCalledBefore(update);
    expect(update).toHaveBeenCalledWith({ store_name: "Private merchant name" });
    expect(renameQuery.eq.mock.calls).toEqual([
      ["id", ID],
      ["status", "active"],
      ["shopify_connected", true],
      ["shopify_url", DOMAIN],
    ]);
    expect(health).toMatchObject({
      ok: true,
      limited: false,
      testedAt: "2026-08-13T09:30:00.000Z",
      scopesMissing: [],
    });
    const serialised = JSON.stringify(health);
    expect(serialised).not.toContain(CIPHERTEXT);
    expect(serialised).not.toContain(DIRECT_TOKEN);
    expect(serialised).not.toContain(ACCESS_TOKEN);
    expect(serialised).not.toContain("Private merchant name");
    expect(serialised).not.toContain(DOMAIN);
  });

  it("resolves a stored client secret with its client ID before verification", async () => {
    const { service } = serviceWith(row({ shopify_client_id: "legacy-client-id" }));
    mocks.decryptToken.mockResolvedValue(CLIENT_SECRET);

    await testLegacyShopifyConnection({ accountId: ID, service });

    expect(mocks.resolveAdminToken).toHaveBeenCalledWith(
      DOMAIN,
      CLIENT_SECRET,
      "legacy-client-id",
    );
    expect(mocks.validateShopifyCredentials).toHaveBeenCalledWith(DOMAIN, ACCESS_TOKEN);
  });

  it("keeps a valid legacy grant usable when optional reporting scopes differ", async () => {
    const { service } = serviceWith(row());
    mocks.decryptToken.mockResolvedValue(DIRECT_TOKEN);
    mocks.validateShopifyCredentials.mockResolvedValue(
      shop(["read_orders"]),
    );

    const health = await testLegacyShopifyConnection({ accountId: ID, service });

    expect(health.ok).toBe(true);
    expect(health.limited).toBe(true);
    expect(health.capabilities.orders).toBe(true);
    expect(health.scopesMissing).toContain("read_reports");
    expect(health).not.toHaveProperty("reconnectRecommended");
  });

  it("accepts an older app when the live order report works despite incomplete scope metadata", async () => {
    const { service } = serviceWith(row());
    mocks.decryptToken.mockResolvedValue(DIRECT_TOKEN);
    mocks.validateShopifyCredentials.mockResolvedValue(
      shop(["read_analytics", "read_reports"]),
    );

    const health = await testLegacyShopifyConnection({ accountId: ID, service });

    expect(mocks.shopifyGraphql).toHaveBeenCalledWith(
      DOMAIN,
      ACCESS_TOKEN,
      "{ orders(first: 1) { nodes { id } } }",
    );
    expect(health).toMatchObject({
      ok: true,
      limited: true,
      capabilities: { orders: true },
    });
  });

  it("fails safely when the live order probe is rejected", async () => {
    const { service, update } = serviceWith(row());
    mocks.decryptToken.mockResolvedValue(DIRECT_TOKEN);
    mocks.shopifyGraphql.mockRejectedValue(
      new ShopifyError("Access denied for orders", 403),
    );

    await expect(testLegacyShopifyConnection({ accountId: ID, service })).rejects.toMatchObject({
      code: "reporting_unavailable",
      status: 422,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("never renames when Shopify returns a different store domain", async () => {
    const { service, update } = serviceWith(row());
    mocks.decryptToken.mockResolvedValue(DIRECT_TOKEN);
    mocks.validateShopifyCredentials.mockResolvedValue(
      { ...shop(), myshopifyDomain: "another-store.myshopify.com" },
    );

    await expect(testLegacyShopifyConnection({ accountId: ID, service })).rejects.toMatchObject({
      code: "domain_mismatch",
      status: 409,
    });
    expect(mocks.shopifyGraphql).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("classifies invalid stored domains before decrypting", async () => {
    const { service } = serviceWith(row({ shopify_url: "https://attacker.test" }));

    await expect(testLegacyShopifyConnection({ accountId: ID, service })).rejects.toMatchObject({
      code: "invalid_domain",
      status: 422,
    });
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });

  it("never leaks credential details through classified failures", async () => {
    const { service } = serviceWith(row());
    mocks.decryptToken.mockResolvedValue(DIRECT_TOKEN);
    mocks.validateShopifyCredentials.mockRejectedValue(
      new ShopifyError(`Shopify rejected ${DIRECT_TOKEN} from ${CIPHERTEXT}`, 401),
    );

    let caught: unknown;
    try {
      await testLegacyShopifyConnection({ accountId: ID, service });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LegacyShopifyHealthError);
    expect(caught).toMatchObject({ code: "invalid_credential", status: 422 });
    expect((caught as Error).message).not.toContain(DIRECT_TOKEN);
    expect((caught as Error).message).not.toContain(CIPHERTEXT);
  });
});

describe("legacy Shopify disconnect", () => {
  it("delegates the exact account and verified admin to the atomic RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ID, error: null });

    await disconnectLegacyShopifyConnection({
      accountId: ID,
      adminId: "40000000-0000-4000-8000-000000000003",
      service: { rpc } as never,
    });

    expect(rpc).toHaveBeenCalledWith("disconnect_legacy_shopify_connection", {
      p_account_id: ID,
      p_admin_id: "40000000-0000-4000-8000-000000000003",
    });
  });

  it("classifies a non-active legacy connection without exposing database details", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "secret database detail" },
    });

    let caught: unknown;
    try {
      await disconnectLegacyShopifyConnection({
        accountId: ID,
        adminId: "40000000-0000-4000-8000-000000000003",
        service: { rpc } as never,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LegacyShopifyDisconnectError);
    expect(caught).toMatchObject({ code: "not_found", status: 404 });
    expect((caught as Error).message).not.toContain("secret database detail");
  });

  it("keeps a store connected while its reconnect link is open", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23514", message: "internal reconnect target detail" },
    });

    await expect(
      disconnectLegacyShopifyConnection({
        accountId: ID,
        adminId: "40000000-0000-4000-8000-000000000003",
        service: { rpc } as never,
      }),
    ).rejects.toMatchObject({
      code: "reconnect_in_progress",
      status: 409,
    });
  });

  it("fails closed when the RPC does not return the exact account", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: "40000000-0000-4000-8000-000000000099",
      error: null,
    });

    await expect(
      disconnectLegacyShopifyConnection({
        accountId: ID,
        adminId: "40000000-0000-4000-8000-000000000003",
        service: { rpc } as never,
      }),
    ).rejects.toMatchObject({ code: "database_error", status: 500 });
  });
});
