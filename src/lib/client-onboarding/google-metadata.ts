import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { checkGoogleAdsAccountHealth } from "@/lib/windsor/client";

/**
 * Owner policy (2026-08-18): besides Sync and Issue Invoices there are no
 * clicks. Google reporting metadata (currency + time zone from Windsor) used
 * to be recorded only by the admin "Test" button — a connection that missed
 * it kept the whole cutover queue blocked ("EUR-only") with nothing ever
 * retrying. The sync chain now enriches connected sources that still lack
 * their metadata, attributed to the admin who created the client's session.
 */

type Service = SupabaseClient<Database>;

const METADATA_REASON =
  "Automatic Google Ads reporting metadata from the connected Windsor source.";

export type GoogleMetadataOutcome = {
  attempted: number;
  enriched: number;
  failed: number;
};

export async function ensureGoogleConnectionMetadata(
  service: Service,
): Promise<GoogleMetadataOutcome> {
  const outcome: GoogleMetadataOutcome = { attempted: 0, enriched: 0, failed: 0 };

  const [connections, sessions, admins] = await Promise.all([
    service
      .from("client_google_ads_connections")
      .select("id, session_id, windsor_account_id, currency, time_zone")
      .eq("status", "connected"),
    service
      .from("client_onboarding_sessions")
      .select("id, created_by"),
    service.from("profiles").select("id").eq("role", "admin"),
  ]);
  const firstError = connections.error ?? sessions.error ?? admins.error;
  if (firstError) throw firstError;

  const adminIds = new Set(
    ((admins.data ?? []) as { id: string }[]).map((row) => row.id),
  );
  const creatorBySession = new Map(
    ((sessions.data ?? []) as { id: string; created_by: string | null }[]).map(
      (row) => [row.id, row.created_by],
    ),
  );

  for (const connection of (connections.data ?? []) as {
    id: string;
    session_id: string | null;
    windsor_account_id: string;
    currency: string | null;
    time_zone: string | null;
  }[]) {
    if (connection.currency !== null && connection.time_zone?.trim()) continue;
    const creator = connection.session_id
      ? creatorBySession.get(connection.session_id) ?? null
      : null;
    if (!creator || !adminIds.has(creator)) continue;

    outcome.attempted += 1;
    try {
      const health = await checkGoogleAdsAccountHealth(
        connection.windsor_account_id,
      );
      if (!health.ok || !health.account.currency || !health.account.timeZone) {
        outcome.failed += 1;
        continue;
      }
      if (
        (connection.currency !== null &&
          connection.currency !== health.account.currency) ||
        (connection.time_zone?.trim() &&
          connection.time_zone.trim() !== health.account.timeZone)
      ) {
        // A conflicting identity is an admin decision, never an overwrite.
        outcome.failed += 1;
        continue;
      }
      const { data, error } = await service.rpc(
        "enrich_client_google_ads_reporting_metadata",
        {
          p_connection_id: connection.id,
          p_currency: health.account.currency,
          p_time_zone: health.account.timeZone,
          p_admin_id: creator,
          p_verified_at: health.checkedAt,
          p_reason: METADATA_REASON,
          p_idempotency_key: `google-meta:${connection.id}:${health.checkedAt}`,
        },
      );
      if (error || data !== connection.id) throw error ?? new Error("not recorded");
      outcome.enriched += 1;
    } catch (error) {
      outcome.failed += 1;
      console.error(
        `Automatic Google metadata enrichment failed for connection ${connection.id}:`,
        error,
      );
    }
  }

  return outcome;
}
