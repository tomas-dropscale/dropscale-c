import "server-only";

import { decryptToken, encryptToken } from "@/lib/google-ads/crypto";
import {
  ShopifyReportingError,
  testReportingShopConnection,
  verifyReportingClientCredentials,
  type ReportingShopHealth,
  type VerifiedReportingShop,
} from "./shopify";

export type ShopifyConnectionAuthorization = {
  sessionId: string;
  /** SHA-256 digest returned by the already-validated onboarding boundary. */
  tokenHash: string;
};

export type CompleteShopifyConnectionRecord = {
  connectionId: string;
  sessionId: string;
  tokenHash: string;
  shop: VerifiedReportingShop;
  shopifyClientId: string;
  credentialHint: string;
  clientSecretCiphertext: string;
};

export type StoredShopifyConnectionCredential = {
  connectionId: string;
  shopifyShopId: string;
  shopifyDomain: string;
  shopifyClientId: string;
  clientSecretCiphertext: string;
};

export type ShopifyHealthRecord = {
  connectionId: string;
  adminId: string;
  ok: boolean;
  testedAt: string;
  errorCode: string | null;
};

/**
 * Persistence boundary implemented by the Supabase DAL. Keeping Shopify's
 * wire protocol outside the repository makes the security-critical flow easy
 * to unit-test without a database or a live merchant store.
 */
export interface ReportingShopifyConnectionRepository {
  complete(input: CompleteShopifyConnectionRecord): Promise<string>;
  loadCredential(connectionId: string): Promise<StoredShopifyConnectionCredential>;
  recordHealth(input: ShopifyHealthRecord): Promise<void>;
  revoke(connectionId: string, adminId: string): Promise<void>;
}

export type ConnectedShopifyDTO = {
  id: string;
  store: {
    name: string;
    domain: string;
    primaryDomain: string | null;
    currencyCode: string;
  };
  health: ReportingShopHealth;
};

export class ClientShopifyConnectionError extends Error {
  constructor(
    public readonly code:
      | "invalid_scope_profile"
      | "health_check_failed"
      | "stored_identity_mismatch"
      | "invalid_session"
      | "reconnect_target_mismatch"
      | "reconnect_in_progress"
      | "duplicate_store"
      | "not_found"
      | "server_not_configured"
      | "database_error",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ClientShopifyConnectionError";
  }
}

function assertPurposeBoundScopes(shop: VerifiedReportingShop): void {
  if (shop.scopes.writeScopes.length > 0) {
    throw new ClientShopifyConnectionError(
      "invalid_scope_profile",
      "Remove every Shopify write permission from the reporting app, then try again.",
      422,
    );
  }
  if (!shop.scopes.valid) {
    throw new ClientShopifyConnectionError(
      "invalid_scope_profile",
      "Grant every requested read-only Shopify reporting permission, then try again.",
      422,
    );
  }
}

/**
 * Verify the merchant grant, exercise the exact reporting reads, then persist
 * only encrypted long-lived material. No database write happens before all
 * core probes succeed.
 */
export async function connectReportingShopifyStore({
  authorization,
  shopDomain,
  shopifyClientId,
  clientSecret,
  repository,
}: {
  authorization: ShopifyConnectionAuthorization;
  shopDomain: string;
  shopifyClientId: string;
  clientSecret: string;
  repository: ReportingShopifyConnectionRepository;
}): Promise<ConnectedShopifyDTO> {
  const { accessToken, shop } = await verifyReportingClientCredentials({
    shopDomain,
    clientId: shopifyClientId,
    clientSecret,
  });
  assertPurposeBoundScopes(shop);

  const health = await testReportingShopConnection({ shop, accessToken });
  if (!health.ok) {
    throw new ClientShopifyConnectionError(
      "health_check_failed",
      "Shopify accepted the app, but the reporting reads did not all succeed.",
      422,
    );
  }

  const connectionId = crypto.randomUUID();
  const trimmedSecret = clientSecret.trim();
  const clientSecretCiphertext = await encryptToken(trimmedSecret);
  const persistedConnectionId = await repository.complete({
    connectionId,
    sessionId: authorization.sessionId,
    tokenHash: authorization.tokenHash,
    shop,
    shopifyClientId: shopifyClientId.trim(),
    credentialHint: trimmedSecret.slice(-4),
    clientSecretCiphertext,
  });

  return {
    id: persistedConnectionId,
    store: {
      name: shop.name,
      domain: shop.myshopifyDomain,
      primaryDomain: shop.primaryDomain,
      currencyCode: shop.currencyCode,
    },
    health,
  };
}

function safeHealthErrorCode(error: unknown): string {
  if (error instanceof ShopifyReportingError) return error.code;
  if (error instanceof ClientShopifyConnectionError) return error.code;
  return "health_check_failed";
}

/** Fresh exchange + metadata identity check + read-only probes. */
export async function testStoredReportingShopifyStore({
  connectionId,
  adminId,
  repository,
}: {
  connectionId: string;
  adminId: string;
  repository: ReportingShopifyConnectionRepository;
}): Promise<ReportingShopHealth> {
  let testedAt = new Date().toISOString();
  try {
    const stored = await repository.loadCredential(connectionId);
    const clientSecret = await decryptToken(stored.clientSecretCiphertext);
    const { accessToken, shop } = await verifyReportingClientCredentials({
      shopDomain: stored.shopifyDomain,
      clientId: stored.shopifyClientId,
      clientSecret,
    });
    if (
      shop.shopId !== stored.shopifyShopId ||
      shop.myshopifyDomain !== stored.shopifyDomain
    ) {
      throw new ClientShopifyConnectionError(
        "stored_identity_mismatch",
        "The Shopify credential no longer resolves to the stored shop.",
        409,
      );
    }
    assertPurposeBoundScopes(shop);
    const health = await testReportingShopConnection({ shop, accessToken });
    testedAt = health.testedAt;
    await repository.recordHealth({
      connectionId,
      adminId,
      ok: health.ok,
      testedAt,
      errorCode: health.ok ? null : "health_check_failed",
    });
    return health;
  } catch (error) {
    try {
      await repository.recordHealth({
        connectionId,
        adminId,
        ok: false,
        testedAt,
        errorCode: safeHealthErrorCode(error),
      });
    } catch {
      // Preserve the original verification failure. The admin receives the
      // real classified cause instead of an event-recording follow-up error.
    }
    throw error;
  }
}

/** Credential destruction and status/event transition belong in one DB RPC. */
export async function revokeReportingShopifyStore({
  connectionId,
  adminId,
  repository,
}: {
  connectionId: string;
  adminId: string;
  repository: ReportingShopifyConnectionRepository;
}): Promise<void> {
  await repository.revoke(connectionId, adminId);
}
