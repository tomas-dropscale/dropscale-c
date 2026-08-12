import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import {
  ClientOnboardingError,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
import { createServiceClient } from "@/lib/supabase/service";
import { checkGoogleAdsAccountHealth, WindsorError } from "@/lib/windsor/client";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Not found." }, 404);
    }
    const body = await readSmallJson(request, 1_024);
    if (!isExactRecord(body, ["action"]) || body.action !== "test") {
      return clientOnboardingResponse({ error: "Send exactly action: test." }, 400);
    }
    const service = createServiceClient();
    if (!service) {
      throw new ClientOnboardingError(
        "server_not_configured",
        "Client onboarding is not configured on the server.",
        503,
      );
    }
    const { data: connection, error } = await service
      .from("client_google_ads_connections")
      .select("id, windsor_account_id")
      .eq("id", id)
      .eq("status", "connected")
      .maybeSingle();
    if (error) {
      throw new ClientOnboardingError(
        "database_error",
        "The Google Ads connection could not be loaded.",
        500,
      );
    }
    if (!connection) {
      throw new ClientOnboardingError("not_found", "Google Ads connection not found.", 404);
    }
    const testedAt = new Date().toISOString();
    try {
      const health = await checkGoogleAdsAccountHealth(connection.windsor_account_id);
      const { error: recordError } = await service.rpc("record_client_google_ads_health", {
        p_connection_id: id,
        p_admin_id: admin.id,
        p_ok: health.ok,
        p_tested_at: health.checkedAt,
        p_error_code: health.ok ? null : health.code,
      });
      if (recordError) {
        throw new ClientOnboardingError(
          "database_error",
          "The Google Ads health result could not be recorded.",
          500,
        );
      }
      return clientOnboardingResponse({ ok: health.ok, health });
    } catch (healthError) {
      const code =
        healthError instanceof WindsorError ? healthError.code : "health_check_failed";
      await service.rpc("record_client_google_ads_health", {
        p_connection_id: id,
        p_admin_id: admin.id,
        p_ok: false,
        p_tested_at: testedAt,
        p_error_code: code,
      });
      throw healthError;
    }
  } catch (error) {
    if (error instanceof WindsorError) {
      return clientOnboardingResponse(
        { error: error.message, code: error.code },
        error.status === 499 ? 408 : error.status,
      );
    }
    return clientOnboardingErrorResponse(error, "The Google Ads connection test failed.");
  }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Not found." }, 404);
    }
    const service = createServiceClient();
    if (!service) {
      throw new ClientOnboardingError(
        "server_not_configured",
        "Client onboarding is not configured on the server.",
        503,
      );
    }
    const { data, error } = await service.rpc("revoke_client_google_ads_connection", {
      p_connection_id: id,
      p_admin_id: admin.id,
    });
    if (error || data !== id) {
      throw new ClientOnboardingError(
        error?.code === "P0002" ? "not_found" : "database_error",
        error?.code === "P0002"
          ? "Connected Google Ads asset not found."
          : "The Google Ads connection could not be disconnected.",
        error?.code === "P0002" ? 404 : 500,
      );
    }
    return clientOnboardingResponse({
      ok: true,
      scope: "dropscale_only",
      message: "Disconnected from Dropscale. The Windsor authorization was not removed.",
    });
  } catch (error) {
    return clientOnboardingErrorResponse(error, "The Google Ads connection could not be disconnected.");
  }
}
