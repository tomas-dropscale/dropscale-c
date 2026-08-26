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
 * Which surface serves this workspace's stores in the portal.
 *
 * The cutover marker decides which numbers are authoritative, and that boundary
 * exists to protect a client who already has legacy history from being switched
 * mid-flight. A client onboarded entirely through V2 has no such history.
 *
 * 0055 hid the normalized accounts from the legacy portal on the stated
 * understanding that "the V2 portal projects only active audited bindings" —
 * but the V2 portal starts at cutover, and cutover waits on a Google billing
 * baseline that can be weeks away for an account that has not spent yet.
 * Between the two, nothing served these clients at all: their dashboard said
 * "No stores linked yet" while the store was bound, syncing, and invisible to
 * its own owner, and the creatives page 404'd because the account would not
 * resolve.
 *
 * So a client with no legacy account to protect is served by the projection as
 * soon as there is something audited to project. The projection is unchanged
 * and still shows only active audited bindings; a client who does hold legacy
 * accounts keeps the legacy surface until cutover exactly as before.
 */
export const portalStoreSurface = cache(async function portalStoreSurface(
  clientId: string,
): Promise<PortalReportingAuthority> {
  const authority = await clientReportingAuthority(clientId);
  if (authority !== "legacy") return authority;

  const service = createServiceClient();
  if (!service) return authority;
  try {
    // The client's own RLS cannot see a normalized account, so this asks the
    // service client one narrow question: is there a legacy account to serve?
    const [legacy, bound] = await Promise.all([
      service
        .from("ad_accounts")
        .select("id")
        .eq("client_id", clientId)
        .eq("reporting_role", "legacy_hybrid")
        .limit(1),
      service
        .from("client_reporting_bindings")
        .select("id")
        .eq("client_id", clientId)
        .eq("status", "active")
        .not("shopify_connection_id", "is", null)
        .limit(1),
    ]);
    if (legacy.error || bound.error) return authority;
    const hasLegacy = (legacy.data ?? []).length > 0;
    const hasAuditedStore = (bound.data ?? []).length > 0;
    return !hasLegacy && hasAuditedStore ? "v2" : authority;
  } catch {
    // Failing closed here only restores today's behaviour, never widens it.
    console.error("portal store surface lookup failed unexpectedly");
    return authority;
  }
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
