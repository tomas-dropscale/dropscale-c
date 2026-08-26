import "server-only";

import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Revoking the reporting binding that stands between an asset and the Remove
 * button.
 *
 * revoke_client_reporting_binding has existed and been tested since migration
 * 0054, but nothing ever called it: the guards refuse to revoke a bound
 * connection, and there was no way to unbind one. "Remove asset" was therefore
 * a dead end for every bound asset — 11 of 15 Shopify stores and 15 of 18
 * Google accounts.
 *
 * The reason this is a separate, explicit action rather than a step chained
 * inside Remove: a binding can carry BOTH a Shopify store and a Google Ads
 * account at once, and 8 of the 19 live bindings do. Unbinding to remove one
 * of them stops reporting for the other too. Remove's dialog promises the
 * client's other connections are unchanged, so that promise has to be kept —
 * the admin is told what the binding covers and decides, instead of finding
 * out afterwards.
 */

export type ReportingAssetKind = "shopify" | "google_ads";

export type ReportingBindingCoverage = {
  bindingId: string;
  clientId: string;
  adAccountId: string;
  /** Every asset that stops feeding reporting if this binding is revoked. */
  covers: Array<{ kind: ReportingAssetKind; id: string; name: string }>;
  /** Child bindings that must be revoked before this anchor can be. */
  blockingChildren: Array<{ bindingId: string; name: string }>;
};

const REVOKE_REASON =
  "Admin unbound this reporting source to remove the asset from Dropscale.";

function serviceOrThrow() {
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Client onboarding is not configured on the server.",
      503,
    );
  }
  return service;
}

type Service = ReturnType<typeof serviceOrThrow>;

type BindingRow = {
  id: string;
  client_id: string;
  ad_account_id: string;
  shopify_connection_id: string | null;
  google_ads_connection_id: string | null;
  shopify_anchor_binding_id: string | null;
  status: string;
};

async function nameFor(
  service: Service,
  kind: ReportingAssetKind,
  connectionId: string,
): Promise<string> {
  if (kind === "shopify") {
    const { data } = await service
      .from("client_shopify_connections")
      .select("shopify_name, shopify_domain")
      .eq("id", connectionId)
      .maybeSingle();
    const row = data as { shopify_name?: string; shopify_domain?: string } | null;
    return row?.shopify_name?.trim() || row?.shopify_domain?.trim() || "Shopify store";
  }
  const { data } = await service
    .from("client_google_ads_connections")
    .select("account_name, windsor_account_id")
    .eq("id", connectionId)
    .maybeSingle();
  const row = data as { account_name?: string; windsor_account_id?: string } | null;
  return (
    row?.account_name?.trim() || row?.windsor_account_id?.trim() || "Google Ads account"
  );
}

async function describe(
  service: Service,
  binding: BindingRow,
): Promise<ReportingBindingCoverage> {
  const covers: ReportingBindingCoverage["covers"] = [];
  if (binding.shopify_connection_id) {
    covers.push({
      kind: "shopify",
      id: binding.shopify_connection_id,
      name: await nameFor(service, "shopify", binding.shopify_connection_id),
    });
  }
  if (binding.google_ads_connection_id) {
    covers.push({
      kind: "google_ads",
      id: binding.google_ads_connection_id,
      name: await nameFor(service, "google_ads", binding.google_ads_connection_id),
    });
  }

  const { data: children } = await service
    .from("client_reporting_bindings")
    .select("id, google_ads_connection_id, shopify_connection_id")
    .eq("shopify_anchor_binding_id", binding.id)
    .eq("status", "active");

  const blockingChildren: ReportingBindingCoverage["blockingChildren"] = [];
  for (const child of (children ?? []) as BindingRow[]) {
    const connectionId = child.google_ads_connection_id ?? child.shopify_connection_id;
    blockingChildren.push({
      bindingId: child.id,
      name: connectionId
        ? await nameFor(
            service,
            child.google_ads_connection_id ? "google_ads" : "shopify",
            connectionId,
          )
        : "Linked reporting source",
    });
  }

  return {
    bindingId: binding.id,
    clientId: binding.client_id,
    adAccountId: binding.ad_account_id,
    covers,
    blockingChildren,
  };
}

async function activeBindingFor(
  service: Service,
  kind: ReportingAssetKind,
  connectionId: string,
): Promise<BindingRow | null> {
  const column =
    kind === "shopify" ? "shopify_connection_id" : "google_ads_connection_id";
  const { data, error } = await service
    .from("client_reporting_bindings")
    .select(
      "id, client_id, ad_account_id, shopify_connection_id, google_ads_connection_id, shopify_anchor_binding_id, status",
    )
    .eq(column, connectionId)
    .eq("status", "active")
    .maybeSingle();
  if (error) {
    throw new ClientOnboardingError(
      "database_error",
      "The reporting binding could not be read.",
      500,
    );
  }
  return (data as BindingRow | null) ?? null;
}

/** What the admin is about to unbind. Null when nothing is bound. */
export async function describeReportingBindingForAsset(
  kind: ReportingAssetKind,
  connectionId: string,
): Promise<ReportingBindingCoverage | null> {
  const service = serviceOrThrow();
  const binding = await activeBindingFor(service, kind, connectionId);
  return binding ? describe(service, binding) : null;
}

export async function revokeReportingBindingForAsset(input: {
  kind: ReportingAssetKind;
  connectionId: string;
  adminId: string;
}): Promise<ReportingBindingCoverage> {
  const service = serviceOrThrow();
  const binding = await activeBindingFor(service, input.kind, input.connectionId);
  if (!binding) {
    throw new ClientOnboardingError(
      "not_found",
      "This asset has no active reporting binding.",
      404,
    );
  }
  const coverage = await describe(service, binding);
  if (coverage.blockingChildren.length > 0) {
    throw new ClientOnboardingError(
      "invalid_state",
      `Revoke the linked reporting sources first: ${coverage.blockingChildren
        .map((child) => child.name)
        .join(", ")}.`,
      409,
    );
  }

  // Deterministic key: an exact retry of this revocation returns the original
  // result instead of colliding, which is what the RPC's idempotency contract
  // rewards. The reason is fixed for the same purpose.
  const { data, error } = await service.rpc("revoke_client_reporting_binding", {
    p_binding_id: binding.id,
    p_admin_id: input.adminId,
    p_idempotency_key: `binding-revoke:${binding.id}`,
    p_reason: REVOKE_REASON,
  });
  if (error || data !== binding.id) {
    throw new ClientOnboardingError(
      error?.code === "P0002"
        ? "not_found"
        : error?.code === "23514" || error?.code === "23503"
          ? "invalid_state"
          : "database_error",
      error?.code === "P0002"
        ? "Active client reporting binding not found."
        : error?.code === "23514"
          ? "This reporting binding is no longer active."
          : error?.code === "23503"
            ? "Revoke the linked reporting sources first."
            : "The reporting binding could not be revoked.",
      error?.code === "P0002" ? 404 : error?.code?.startsWith("23") ? 409 : 500,
    );
  }
  return coverage;
}
