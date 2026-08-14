import "server-only";

import { cache } from "react";

import { getWorkspaceContext } from "@/lib/portal/workspace";
import { createServiceClient } from "@/lib/supabase/service";
import type { ClientRolloutState } from "@/lib/supabase/types";

export type PortalOperationalSurface =
  | ClientRolloutState["operational_surface"]
  | "unavailable";

export type PortalReportingAuthority = "legacy" | "v2" | "unavailable";

type RolloutSnapshot = {
  operationalSurface: PortalOperationalSurface;
  reportingCutoverAt: string | null;
};

const OPERATIONAL_SURFACES = new Set<ClientRolloutState["operational_surface"]>([
  "legacy_only",
  "v2_onboarding",
  "v2_ready_for_cutover",
  "v2_active",
  "rollback_legacy",
]);

/** Service-only rollout lookup for an already-authorised workspace id. */
const clientRolloutSnapshot = cache(async function clientRolloutSnapshot(
  clientId: string,
): Promise<RolloutSnapshot> {
  const service = createServiceClient();
  if (!service) {
    return { operationalSurface: "unavailable", reportingCutoverAt: null };
  }

  try {
    const { data, error } = await service
      .from("client_rollout_states")
      .select("operational_surface, reporting_cutover_at")
      .eq("client_id", clientId)
      .maybeSingle();

    if (error) {
      console.error("client rollout lookup failed:", error.code ?? "unknown");
      return { operationalSurface: "unavailable", reportingCutoverAt: null };
    }

    if (!data) {
      return { operationalSurface: "legacy_only", reportingCutoverAt: null };
    }
    if (!OPERATIONAL_SURFACES.has(data.operational_surface)) {
      return { operationalSurface: "unavailable", reportingCutoverAt: null };
    }
    const reportingCutoverAt = data.reporting_cutover_at;
    if (
      reportingCutoverAt !== null &&
      (typeof reportingCutoverAt !== "string" || Number.isNaN(Date.parse(reportingCutoverAt)))
    ) {
      return { operationalSurface: "unavailable", reportingCutoverAt: null };
    }
    return {
      operationalSurface: data.operational_surface,
      reportingCutoverAt,
    };
  } catch {
    console.error("client rollout lookup failed unexpectedly");
    return { operationalSurface: "unavailable", reportingCutoverAt: null };
  }
});

export const clientOperationalSurface = cache(async function clientOperationalSurface(
  clientId: string,
): Promise<PortalOperationalSurface> {
  return (await clientRolloutSnapshot(clientId)).operationalSurface;
});

/**
 * Which reporting source is authoritative for this workspace right now.
 *
 * `v2_active` predates the normalized reporting cutover, so it is never enough
 * on its own. Only the purpose-bound cutover RPC can set the durable marker.
 * A rollback keeps the marker as audit history but deliberately returns to the
 * legacy source.
 */
export const clientReportingAuthority = cache(async function clientReportingAuthority(
  clientId: string,
): Promise<PortalReportingAuthority> {
  const rollout = await clientRolloutSnapshot(clientId);
  if (rollout.operationalSurface === "unavailable") return "unavailable";
  return rollout.operationalSurface === "v2_active" && rollout.reportingCutoverAt !== null
    ? "v2"
    : "legacy";
});

/**
 * Whether this workspace must no longer expose the legacy asset write paths.
 *
 * `client_rollout_states` is deliberately service-role-only. We first resolve
 * the active workspace through the signed-in viewer's RLS-backed context, then
 * use the service client solely to read that exact workspace's rollout flag.
 * A missing row means the long-standing legacy behaviour remains unchanged.
 *
 * Configuration/query failures fail closed: temporarily hiding an asset CTA is
 * safer than letting a V2-active client create rows in the parallel legacy
 * `ad_accounts` or `account_requests` surfaces.
 */
export const legacyAssetActionsBlocked = cache(async function legacyAssetActionsBlocked() {
  const { active } = await getWorkspaceContext();
  if (!active) return true;

  const authority = await clientReportingAuthority(active.id);
  return authority === "v2" || authority === "unavailable";
});
