import "server-only";

import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { createServiceClient } from "@/lib/supabase/service";

const ROLLOUT_SURFACES = new Set([
  "legacy_only",
  "v2_onboarding",
  "v2_ready_for_cutover",
  "v2_active",
  "rollback_legacy",
]);

export type AdminAnalyticsClient = {
  id: string;
  name: string;
  email: string;
  storeCount: number;
  stores: AdminAnalyticsStore[];
};

export type AdminAnalyticsStore = {
  /** Null means a healthy Shopify connection that has no reporting projection yet. */
  id: string | null;
  name: string;
  domain: string;
};

type ShopifyConnectionRow = {
  client_id: string;
  status: string;
  shopify_domain: string;
  primary_domain: string | null;
  last_verified_at: string | null;
  last_error_code: string | null;
};

function textOrder(left: string, right: string) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalShopifyDomain(value: string | null | undefined): string | null {
  const domain = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
}

function publicStoreDomain(value: string | null): string | null {
  const domain = value?.trim().toLowerCase();
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }
  return domain;
}

function storeIdentity(clientId: string, shopifyDomain: string) {
  return `${clientId}\n${shopifyDomain}`;
}

/** Minimal read-only catalogue used before an Analytics client is selected. */
export async function listAdminAnalyticsClients(): Promise<AdminAnalyticsClient[]> {
  await requireClientOnboardingAdmin();
  const service = createServiceClient();
  if (!service) throw new Error("The admin analytics catalogue is unavailable.");

  const [
    clientsResult,
    adminsResult,
    accountsResult,
    rolloutsResult,
    shopifyConnectionsResult,
  ] =
    await Promise.all([
      service
        .from("portal_clients")
        .select("id, full_name, email, approval_status")
        .eq("approval_status", "approved"),
      service.from("profiles").select("id, role").eq("role", "admin"),
      service.from("ad_accounts").select("id, client_id, store_name, shopify_url"),
      service
        .from("client_rollout_states")
        .select(
          "client_id, operational_surface, reporting_cutover_at, reporting_cutover_by, reporting_cutover_reason",
        ),
      service
        .from("client_shopify_connections")
        .select(
          "client_id, status, shopify_domain, primary_domain, last_verified_at, last_error_code",
        )
        .eq("status", "connected"),
    ]);

  const clients = clientsResult.data;
  const admins = adminsResult.data;
  const accounts = accountsResult.data;
  const rollouts = rolloutsResult.data;
  const shopifyConnections =
    !shopifyConnectionsResult.error && Array.isArray(shopifyConnectionsResult.data)
      ? shopifyConnectionsResult.data
      : [];
  if (
    clientsResult.error ||
    adminsResult.error ||
    accountsResult.error ||
    rolloutsResult.error ||
    !Array.isArray(clients) ||
    !Array.isArray(admins) ||
    !Array.isArray(accounts) ||
    !Array.isArray(rollouts)
  ) {
    throw new Error("The admin analytics catalogue is unavailable.");
  }

  const publicDomainByStore = new Map<string, string>();
  const healthyShopifyByStore = new Map<string, ShopifyConnectionRow>();
  for (const row of shopifyConnections as ShopifyConnectionRow[]) {
    const shopifyDomain = canonicalShopifyDomain(row.shopify_domain);
    const primaryDomain = publicStoreDomain(row.primary_domain);
    if (
      row.status !== "connected" ||
      !row.last_verified_at ||
      row.last_error_code !== null ||
      shopifyDomain !== row.shopify_domain
    ) {
      continue;
    }
    const identity = storeIdentity(row.client_id, shopifyDomain);
    healthyShopifyByStore.set(identity, row);
    if (primaryDomain) publicDomainByStore.set(identity, primaryDomain);
  }

  const completeReportingMarkers = new Set<string>();
  for (const rollout of rollouts) {
    const marker = [
      rollout.reporting_cutover_at,
      rollout.reporting_cutover_by,
      rollout.reporting_cutover_reason,
    ];
    const present = marker.map(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    const hasAny = present.some(Boolean);
    const complete = present.every(Boolean);
    const validTimestamp =
      !rollout.reporting_cutover_at ||
      Number.isFinite(Date.parse(rollout.reporting_cutover_at));

    if (
      !ROLLOUT_SURFACES.has(rollout.operational_surface) ||
      (hasAny && !complete) ||
      !validTimestamp ||
      (complete &&
        rollout.operational_surface !== "v2_active" &&
        rollout.operational_surface !== "rollback_legacy")
    ) {
      throw new Error("The admin analytics catalogue is inconsistent.");
    }
    if (complete && rollout.operational_surface === "v2_active") {
      completeReportingMarkers.add(rollout.client_id);
    }
  }

  const storesByClient = new Map<string, Map<string, AdminAnalyticsStore>>();
  const clientsWithAccounts = new Set<string>();
  for (const account of accounts) {
    clientsWithAccounts.add(account.client_id);
    const shopifyDomain = canonicalShopifyDomain(account.shopify_url);
    if (!shopifyDomain) continue;
    const stores = storesByClient.get(account.client_id) ?? new Map<string, AdminAnalyticsStore>();
    const candidate = {
      id: account.id,
      name: account.store_name,
      domain:
        publicDomainByStore.get(storeIdentity(account.client_id, shopifyDomain)) ??
        shopifyDomain,
    };
    const current = stores.get(shopifyDomain);
    if (!current || current.id === null || textOrder(candidate.id, current.id) < 0) {
      stores.set(shopifyDomain, candidate);
    }
    storesByClient.set(account.client_id, stores);
  }

  // A verified Shopify connection is onboarding evidence, but without an
  // exact ad_account projection it is not a reporting scope. Keep it visible
  // as not activated and never mint a fake selectable account id.
  for (const [identity, connection] of healthyShopifyByStore) {
    const shopifyDomain = canonicalShopifyDomain(connection.shopify_domain)!;
    const stores = storesByClient.get(connection.client_id) ?? new Map<string, AdminAnalyticsStore>();
    if (!stores.has(shopifyDomain)) {
      const domain = publicDomainByStore.get(identity) ?? shopifyDomain;
      stores.set(shopifyDomain, { id: null, name: domain, domain });
      storesByClient.set(connection.client_id, stores);
    }
  }

  const adminIds = new Set(
    admins.filter((profile) => profile.role === "admin").map((profile) => profile.id),
  );
  return clients
    .filter(
      (client) =>
        client.approval_status === "approved" &&
        !adminIds.has(client.id) &&
        (clientsWithAccounts.has(client.id) ||
          completeReportingMarkers.has(client.id) ||
          [...healthyShopifyByStore.values()].some(
            (connection) => connection.client_id === client.id,
          )),
    )
    .map((client) => {
      const stores = [...(storesByClient.get(client.id)?.values() ?? [])].sort(
        (left, right) =>
          textOrder(left.domain, right.domain) || textOrder(left.id ?? "", right.id ?? ""),
      );
      return {
        id: client.id,
        name: client.full_name,
        email: client.email,
        storeCount: stores.length,
        stores,
      };
    })
    .sort(
      (left, right) =>
        textOrder(left.name, right.name) ||
        textOrder(left.email, right.email) ||
        textOrder(left.id, right.id),
    );
}
