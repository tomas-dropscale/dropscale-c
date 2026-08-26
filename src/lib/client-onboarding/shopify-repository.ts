import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "@/lib/supabase/service";
import {
  ClientShopifyConnectionError,
  type CompleteShopifyConnectionRecord,
  type ReportingShopifyConnectionRepository,
  type ShopifyHealthRecord,
  type StoredShopifyConnectionCredential,
} from "./shopify-connections";

type ReportingShopifyDatabase = {
  public: {
    Tables: {
      client_shopify_connections: {
        Row: {
          id: string;
          shopify_shop_id: string;
          shopify_name: string;
          shopify_domain: string;
          status: "connected" | "revoked";
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      client_shopify_credentials: {
        Row: {
          connection_id: string;
          shopify_client_id: string;
          client_secret_ciphertext: string;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      complete_client_shopify_connection: {
        Args: {
          p_connection_id: string;
          p_session_id: string;
          p_token_hash: string;
          p_shopify_shop_id: string;
          p_shopify_name: string;
          p_shopify_domain: string;
          p_primary_domain: string | null;
          p_shopify_currency: string;
          p_shopify_client_id: string;
          p_credential_hint: string;
          p_granted_scopes: string[];
          p_client_secret_ciphertext: string;
        };
        Returns: string;
      };
      record_client_shopify_health: {
        Args: {
          p_connection_id: string;
          p_admin_id: string;
          p_ok: boolean;
          p_tested_at: string;
          p_error_code: string | null;
        };
        Returns: string;
      };
      revoke_client_shopify_connection: {
        Args: {
          p_connection_id: string;
          p_admin_id: string;
        };
        Returns: string;
      };
    };
  };
};

type DatabaseError = { code?: string } | null;

function databaseFailure(message: string): ClientShopifyConnectionError {
  return new ClientShopifyConnectionError(
    "database_error",
    message,
    500,
  );
}

function serviceOrThrow(): SupabaseClient<ReportingShopifyDatabase> {
  const service = createServiceClient();
  if (!service || !process.env.GOOGLE_ADS_TOKEN_ENC_KEY?.trim()) {
    throw new ClientShopifyConnectionError(
      "server_not_configured",
      "Server-side Shopify reporting connections are not configured.",
      503,
    );
  }
  // The canonical generated Database type is updated only after migrations are
  // applied. This narrow local view prevents a new secret table from being
  // exposed elsewhere while retaining typed queries and RPC arguments here.
  return service as unknown as SupabaseClient<ReportingShopifyDatabase>;
}

function throwCompleteError(error: DatabaseError): never {
  if (error?.code === "P4409") {
    throw new ClientShopifyConnectionError(
      "reconnect_target_mismatch",
      "The verified Shopify store does not match the store selected for this reconnect link.",
      409,
    );
  }
  if (error?.code === "23505") {
    throw new ClientShopifyConnectionError(
      "duplicate_store",
      "This Shopify store already has an active reporting connection.",
      409,
    );
  }
  if (error?.code === "P0002") {
    throw new ClientShopifyConnectionError(
      "invalid_session",
      "Shopify onboarding is not available for this link.",
      409,
    );
  }
  if (error?.code === "22023") {
    throw new ClientShopifyConnectionError(
      "invalid_scope_profile",
      "The verified Shopify reporting grant is incomplete.",
      422,
    );
  }
  throw databaseFailure("The verified Shopify connection could not be saved.");
}

async function complete(
  service: SupabaseClient<ReportingShopifyDatabase>,
  input: CompleteShopifyConnectionRecord,
): Promise<string> {
  const { data, error } = await service.rpc(
    "complete_client_shopify_connection",
    {
      p_connection_id: input.connectionId,
      p_session_id: input.sessionId,
      p_token_hash: input.tokenHash,
      p_shopify_shop_id: input.shop.shopId,
      p_shopify_name: input.shop.name,
      p_shopify_domain: input.shop.myshopifyDomain,
      p_primary_domain: input.shop.primaryDomain,
      p_shopify_currency: input.shop.currencyCode,
      p_shopify_client_id: input.shopifyClientId,
      p_credential_hint: input.credentialHint,
      p_granted_scopes: input.shop.scopes.granted,
      p_client_secret_ciphertext: input.clientSecretCiphertext,
    },
  );
  if (error || typeof data !== "string") throwCompleteError(error);
  return data;
}

async function loadCredential(
  service: SupabaseClient<ReportingShopifyDatabase>,
  connectionId: string,
): Promise<StoredShopifyConnectionCredential> {
  const [connectionResult, credentialResult] = await Promise.all([
    service
      .from("client_shopify_connections")
      .select("id, shopify_shop_id, shopify_domain")
      .eq("id", connectionId)
      .eq("status", "connected")
      .maybeSingle(),
    service
      .from("client_shopify_credentials")
      .select(
        "connection_id, shopify_client_id, client_secret_ciphertext",
      )
      .eq("connection_id", connectionId)
      .maybeSingle(),
  ]);

  if (connectionResult.error || credentialResult.error) {
    throw databaseFailure("The Shopify reporting credential could not be loaded.");
  }
  if (!connectionResult.data || !credentialResult.data) {
    throw new ClientShopifyConnectionError(
      "not_found",
      "Active Shopify reporting connection not found.",
      404,
    );
  }

  return {
    connectionId: connectionResult.data.id,
    shopifyShopId: connectionResult.data.shopify_shop_id,
    shopifyDomain: connectionResult.data.shopify_domain,
    shopifyClientId: credentialResult.data.shopify_client_id,
    clientSecretCiphertext:
      credentialResult.data.client_secret_ciphertext,
  };
}

async function recordHealth(
  service: SupabaseClient<ReportingShopifyDatabase>,
  input: ShopifyHealthRecord,
): Promise<void> {
  const { data, error } = await service.rpc("record_client_shopify_health", {
    p_connection_id: input.connectionId,
    p_admin_id: input.adminId,
    p_ok: input.ok,
    p_tested_at: input.testedAt,
    p_error_code: input.errorCode,
  });
  if (error || data !== input.connectionId) {
    if (error?.code === "P0002") {
      throw new ClientShopifyConnectionError(
        "not_found",
        "Active Shopify reporting connection not found.",
        404,
      );
    }
    throw databaseFailure("The Shopify health result could not be recorded.");
  }

  if (!input.ok) return;
  const shop = input.verifiedShop;
  if (!shop?.name.trim()) {
    throw databaseFailure("The verified Shopify store name could not be saved.");
  }
  const renameResult = await service
    .from("client_shopify_connections")
    .update({ shopify_name: shop.name.trim() })
    .eq("id", input.connectionId)
    .eq("status", "connected")
    .eq("shopify_shop_id", shop.shopId)
    .eq("shopify_domain", shop.myshopifyDomain)
    .select("id")
    .maybeSingle();
  if (
    renameResult.error ||
    !renameResult.data ||
    renameResult.data.id !== input.connectionId
  ) {
    throw databaseFailure("The verified Shopify store name could not be saved.");
  }
}

async function revoke(
  service: SupabaseClient<ReportingShopifyDatabase>,
  connectionId: string,
  adminId: string,
): Promise<void> {
  const { data, error } = await service.rpc(
    "revoke_client_shopify_connection",
    {
      p_connection_id: connectionId,
      p_admin_id: adminId,
    },
  );
  if (error || data !== connectionId) {
    if (error?.code === "P0002") {
      throw new ClientShopifyConnectionError(
        "not_found",
        "Active Shopify reporting connection not found.",
        404,
      );
    }
    // Two different guards raise 23514 here, and telling the admin the wrong
    // one sends them looking for a reconnect link that does not exist.
    // guard_bound_shopify_connection_identity (0054) blocks the revoke while an
    // active reporting binding still points at the store.
    if (error?.code === "23514" && /reporting binding/i.test(error.message ?? "")) {
      throw new ClientShopifyConnectionError(
        "reconnect_in_progress",
        "This store still feeds the client's reporting. Revoke its reporting binding before removing it.",
        409,
      );
    }
    if (error?.code === "23514") {
      throw new ClientShopifyConnectionError(
        "reconnect_in_progress",
        "Complete or cancel this store's open reconnect link before removing it.",
        409,
      );
    }
    throw databaseFailure("The Shopify reporting connection could not be revoked.");
  }
}

export function createReportingShopifyRepository(): ReportingShopifyConnectionRepository {
  const service = serviceOrThrow();
  return {
    complete: (input) => complete(service, input),
    loadCredential: (connectionId) => loadCredential(service, connectionId),
    recordHealth: (input) => recordHealth(service, input),
    revoke: (connectionId, adminId) => revoke(service, connectionId, adminId),
  };
}
