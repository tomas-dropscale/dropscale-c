import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptToken } from "@/lib/google-ads/crypto";
import {
  normalizeShopDomain,
  resolveAdminToken,
  shopifyGraphql,
  ShopifyError,
  validateShopifyCredentials,
} from "@/lib/shopify/client";
import type { Database } from "@/lib/supabase/types";
import { REQUIRED_REPORTING_SHOPIFY_SCOPES } from "./shopify-scopes";

export type LegacyShopifyCapability =
  | "orders"
  | "reports"
  | "products"
  | "inventory"
  | "locations"
  | "returns"
  | "payouts";

export type LegacyShopifyHealth = {
  ok: true;
  limited: boolean;
  testedAt: string;
  capabilities: Record<LegacyShopifyCapability, boolean>;
  scopesMissing: string[];
};

export class LegacyShopifyHealthError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "invalid_domain"
      | "invalid_credential"
      | "domain_mismatch"
      | "reporting_unavailable"
      | "shopify_unavailable"
      | "database_error",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "LegacyShopifyHealthError";
  }
}

export class LegacyShopifyDisconnectError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "reconnect_in_progress"
      | "database_error",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "LegacyShopifyDisconnectError";
  }
}

/** Atomically clears only the active legacy Shopify credential and connection state. */
export async function disconnectLegacyShopifyConnection({
  accountId,
  adminId,
  service,
}: {
  accountId: string;
  adminId: string;
  service: SupabaseClient<Database>;
}): Promise<void> {
  const { data, error } = await service.rpc(
    "disconnect_legacy_shopify_connection",
    { p_account_id: accountId, p_admin_id: adminId },
  );
  if (!error && data === accountId) return;
  if (error?.code === "P0002") {
    throw new LegacyShopifyDisconnectError(
      "not_found",
      "Active legacy Shopify connection not found.",
      404,
    );
  }
  if (error?.code === "23514") {
    throw new LegacyShopifyDisconnectError(
      "reconnect_in_progress",
      "Complete or cancel this store's open reconnect link before removing it.",
      409,
    );
  }
  throw new LegacyShopifyDisconnectError(
    "database_error",
    "The Shopify connection could not be removed.",
    500,
  );
}

function invalidCredential(): LegacyShopifyHealthError {
  return new LegacyShopifyHealthError(
    "invalid_credential",
    "The stored Shopify credential is invalid. Reconnect this store.",
    422,
  );
}

function hasScope(scopes: ReadonlySet<string>, scope: string): boolean {
  if (scopes.has(scope)) return true;
  return scope.startsWith("read_") && scopes.has(`write_${scope.slice(5)}`);
}

function capabilities(scopes: ReadonlySet<string>): Record<LegacyShopifyCapability, boolean> {
  return {
    orders: hasScope(scopes, "read_orders"),
    reports: hasScope(scopes, "read_reports") && hasScope(scopes, "read_analytics"),
    products: hasScope(scopes, "read_products"),
    inventory: hasScope(scopes, "read_inventory"),
    locations: hasScope(scopes, "read_locations"),
    returns: hasScope(scopes, "read_returns"),
    payouts:
      hasScope(scopes, "read_shopify_payments_accounts") &&
      hasScope(scopes, "read_shopify_payments_payouts"),
  };
}

/** Fresh, read-only health check for a Shopify connection stored on legacy ad_accounts. */
export async function testLegacyShopifyConnection({
  accountId,
  service,
  now = new Date(),
}: {
  accountId: string;
  service: SupabaseClient<Database>;
  now?: Date;
}): Promise<LegacyShopifyHealth> {
  const { data, error } = await service
    .from("ad_accounts")
    .select("id, shopify_url, shopify_client_id, shopify_admin_token")
    .eq("id", accountId)
    .eq("status", "active")
    .eq("shopify_connected", true)
    .maybeSingle();

  if (error) {
    throw new LegacyShopifyHealthError(
      "database_error",
      "The Shopify connection could not be loaded.",
      500,
    );
  }
  if (!data) {
    throw new LegacyShopifyHealthError(
      "not_found",
      "Active Shopify connection not found.",
      404,
    );
  }

  const storedShopifyUrl = data.shopify_url;
  const domain =
    typeof storedShopifyUrl === "string"
      ? normalizeShopDomain(storedShopifyUrl)
      : null;
  if (typeof storedShopifyUrl !== "string" || !domain) {
    throw new LegacyShopifyHealthError(
      "invalid_domain",
      "The stored Shopify domain is invalid. Reconnect this store.",
      422,
    );
  }
  if (
    typeof data.shopify_admin_token !== "string" ||
    data.shopify_admin_token.trim() === ""
  ) {
    throw invalidCredential();
  }

  let credential: string;
  try {
    credential = (await decryptToken(data.shopify_admin_token)).trim();
  } catch {
    throw invalidCredential();
  }
  if (
    credential.length < 16 ||
    credential.length > 512 ||
    /\s/.test(credential) ||
    (!credential.startsWith("shpat_") && !credential.startsWith("shpss_"))
  ) {
    throw invalidCredential();
  }

  const clientId = data.shopify_client_id?.trim() || null;
  if (credential.startsWith("shpss_") && !clientId) throw invalidCredential();

  try {
    const accessToken = await resolveAdminToken(domain, credential, clientId);
    const shop = await validateShopifyCredentials(domain, accessToken);
    const returnedDomain = normalizeShopDomain(shop.myshopifyDomain);
    if (!returnedDomain || returnedDomain !== domain) {
      throw new LegacyShopifyHealthError(
        "domain_mismatch",
        "The stored credential belongs to a different Shopify store. Reconnect this store.",
        409,
      );
    }

    const granted = new Set(shop.accessScopes.map((scope) => scope.trim()).filter(Boolean));
    const scopesMissing = REQUIRED_REPORTING_SHOPIFY_SCOPES.filter(
      (scope) => !hasScope(granted, scope),
    );
    // Older custom apps do not always report a complete scope list. The live
    // reporting read is authoritative: keep the scope list as capability
    // metadata, but do not reject a working connection from metadata alone.
    try {
      await shopifyGraphql<{ orders: { nodes: Array<{ id: string }> } }>(
        domain,
        accessToken,
        "{ orders(first: 1) { nodes { id } } }",
      );
    } catch (error) {
      if (error instanceof ShopifyError && (!error.status || error.status < 500)) {
        throw new LegacyShopifyHealthError(
          "reporting_unavailable",
          "This Shopify connection cannot read orders. Reconnect this store before using it for reporting.",
          422,
        );
      }
      throw error;
    }
    const verifiedCapabilities = capabilities(granted);
    verifiedCapabilities.orders = true;
    const authoritativeName = shop.name.trim();
    const renameResult = await service
      .from("ad_accounts")
      .update({ store_name: authoritativeName })
      .eq("id", data.id)
      .eq("status", "active")
      .eq("shopify_connected", true)
      .eq("shopify_url", storedShopifyUrl)
      .select("id")
      .maybeSingle();
    if (renameResult.error || renameResult.data?.id !== data.id) {
      throw new LegacyShopifyHealthError(
        "database_error",
        "The verified Shopify store name could not be saved.",
        500,
      );
    }
    const limited = scopesMissing.length > 0;
    return {
      ok: true,
      limited,
      testedAt: now.toISOString(),
      capabilities: verifiedCapabilities,
      scopesMissing: [...scopesMissing],
    };
  } catch (error) {
    if (error instanceof LegacyShopifyHealthError) throw error;
    if (error instanceof ShopifyError && error.status && error.status < 500) {
      throw invalidCredential();
    }
    throw new LegacyShopifyHealthError(
      "shopify_unavailable",
      "Shopify could not verify this store right now.",
      503,
    );
  }
}
