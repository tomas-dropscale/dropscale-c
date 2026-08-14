import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

const ROLLOUT_SURFACES = new Set([
  "legacy_only",
  "v2_onboarding",
  "v2_ready_for_cutover",
  "v2_active",
  "rollback_legacy",
]);

/**
 * How many clients the agency is actually working for right now.
 *
 * Legacy clients are counted from `ad_accounts`: one distinct client with at
 * least one ACTIVE store. A normalized reporting cutover is also active even
 * while its credential-free Shopify anchor deliberately remains PENDING, so
 * the durable cutover marker is unioned into that legacy set.
 *
 * Staff-admins are excluded on the same principle as everywhere else: their
 * stores are internal, and the agency is not a client of itself.
 */
export async function countActiveClients(
  supabase: SupabaseClient<Database>,
): Promise<number> {
  const service = createServiceClient();
  if (!service) throw new Error("The reporting service is unavailable.");

  const [accountsResult, adminsResult, rolloutsResult] = await Promise.all([
    supabase.from("ad_accounts").select("client_id").eq("status", "active"),
    supabase.from("profiles").select("id").eq("role", "admin"),
    service
      .from("client_rollout_states")
      .select(
        "client_id, operational_surface, reporting_cutover_at, reporting_cutover_by, reporting_cutover_reason",
      ),
  ]);
  if (accountsResult.error || adminsResult.error || rolloutsResult.error) {
    throw new Error("The active client projection is unavailable.");
  }

  const inconsistent = (rolloutsResult.data ?? []).some(
    (row) => {
      const marker = [
        row.reporting_cutover_at,
        row.reporting_cutover_by,
        row.reporting_cutover_reason,
      ];
      const hasAnyMarker = marker.some(Boolean);
      return (
        !ROLLOUT_SURFACES.has(row.operational_surface) ||
        (hasAnyMarker && !marker.every(Boolean))
      );
    },
  );
  if (inconsistent) throw new Error("The active client projection is inconsistent.");

  const adminIds = new Set((adminsResult.data ?? []).map((row) => row.id));
  const clients = new Set(
    (accountsResult.data ?? [])
      .map((row) => row.client_id)
      .filter((id) => !adminIds.has(id)),
  );
  for (const rollout of rolloutsResult.data ?? []) {
    if (
      rollout.operational_surface === "v2_active" &&
      Boolean(
        rollout.reporting_cutover_at &&
          rollout.reporting_cutover_by &&
          rollout.reporting_cutover_reason,
      ) &&
      !adminIds.has(rollout.client_id)
    ) {
      clients.add(rollout.client_id);
    }
  }

  return clients.size;
}
