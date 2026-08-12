import "server-only";

import { cache } from "react";

import { getWorkspaceContext } from "@/lib/portal/workspace";
import { createServiceClient } from "@/lib/supabase/service";

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

  const service = createServiceClient();
  if (!service) return true;

  try {
    const { data, error } = await service
      .from("client_rollout_states")
      .select("operational_surface")
      .eq("client_id", active.id)
      .maybeSingle();

    if (error) {
      console.error("client rollout lookup failed:", error.code ?? "unknown");
      return true;
    }

    return data?.operational_surface === "v2_active";
  } catch {
    console.error("client rollout lookup failed unexpectedly");
    return true;
  }
});
