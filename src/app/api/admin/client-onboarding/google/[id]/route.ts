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

const METADATA_REASON = "Admin Google Ads test verified reporting metadata.";

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    if (!sameOrigin(request)) {
      throw new ClientOnboardingError("forbidden", "Forbidden.", 403);
    }
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
      .select("id, windsor_account_id, currency, time_zone")
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
      if (health.ok && health.account.currency && health.account.timeZone) {
        const currentTimeZone = connection.time_zone?.trim() || null;
        if (
          (connection.currency !== null && connection.currency !== health.account.currency) ||
          (currentTimeZone !== null && currentTimeZone !== health.account.timeZone)
        ) {
          throw new ClientOnboardingError(
            "invalid_state",
            "The verified Google Ads identity differs from the reviewed source.",
            409,
          );
        }
        if (connection.currency === null || currentTimeZone === null) {
          const { data: recordedIdentity, error: identityError } = await service.rpc(
            "enrich_client_google_ads_reporting_metadata",
            {
              p_connection_id: id,
              p_currency: health.account.currency,
              p_time_zone: health.account.timeZone,
              p_admin_id: admin.id,
              p_verified_at: health.checkedAt,
              p_reason: METADATA_REASON,
              p_idempotency_key: `google-meta:${id}:${health.checkedAt}`,
            },
          );
          if (identityError || recordedIdentity !== id) {
            throw new ClientOnboardingError(
              "database_error",
              "The Google Ads reporting identity could not be recorded.",
              500,
            );
          }
        }
      }
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
      if (healthError instanceof ClientOnboardingError) throw healthError;
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
    if (!sameOrigin(_request)) {
      throw new ClientOnboardingError("forbidden", "Forbidden.", 403);
    }
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
      if (error?.code === "P0002") {
        throw new ClientOnboardingError(
          "not_found",
          "Connected Google Ads asset not found.",
          404,
        );
      }
      // guard_bound_google_ads_connection_identity (0054) refuses any status
      // change while an active reporting binding still points at this account.
      // That is the common case by far, and reporting it as a 500 leaves the
      // admin with a dead end: the database already said what has to happen
      // first, so say it.
      if (
        error?.code === "23514" &&
        /reporting binding/i.test(error.message ?? "")
      ) {
        throw new ClientOnboardingError(
          "invalid_state",
          "This Google Ads account still feeds the client's reporting. Revoke its reporting binding before removing the account.",
          409,
        );
      }
      throw new ClientOnboardingError(
        "database_error",
        "The Google Ads connection could not be disconnected.",
        500,
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
