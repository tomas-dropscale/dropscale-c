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
};

function textOrder(left: string, right: string) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minimal read-only catalogue used before an Analytics client is selected. */
export async function listAdminAnalyticsClients(): Promise<AdminAnalyticsClient[]> {
  await requireClientOnboardingAdmin();
  const service = createServiceClient();
  if (!service) throw new Error("The admin analytics catalogue is unavailable.");

  const [clientsResult, adminsResult, accountsResult, rolloutsResult] =
    await Promise.all([
      service
        .from("portal_clients")
        .select("id, full_name, email, approval_status")
        .eq("approval_status", "approved"),
      service.from("profiles").select("id, role").eq("role", "admin"),
      service.from("ad_accounts").select("id, client_id, shopify_url"),
      service
        .from("client_rollout_states")
        .select(
          "client_id, operational_surface, reporting_cutover_at, reporting_cutover_by, reporting_cutover_reason",
        ),
    ]);

  const clients = clientsResult.data;
  const admins = adminsResult.data;
  const accounts = accountsResult.data;
  const rollouts = rolloutsResult.data;
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

  const storeDomainsByClient = new Map<string, Set<string>>();
  const clientsWithAccounts = new Set<string>();
  for (const account of accounts) {
    clientsWithAccounts.add(account.client_id);
    const domain = account.shopify_url
      ?.trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!domain) continue;
    const domains = storeDomainsByClient.get(account.client_id) ?? new Set<string>();
    domains.add(domain);
    storeDomainsByClient.set(account.client_id, domains);
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
          completeReportingMarkers.has(client.id)),
    )
    .map((client) => ({
      id: client.id,
      name: client.full_name,
      email: client.email,
      storeCount: storeDomainsByClient.get(client.id)?.size ?? 0,
    }))
    .sort(
      (left, right) =>
        textOrder(left.name, right.name) ||
        textOrder(left.email, right.email) ||
        textOrder(left.id, right.id),
    );
}
