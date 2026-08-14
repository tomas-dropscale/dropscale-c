import { NextResponse, type NextRequest } from "next/server";

import { isExactRecord, readSmallJson } from "@/lib/client-onboarding/http";
import {
  executePurposeBoundReportingCutoverRollback,
  executePurposeBoundReportingCutoverStep,
  validatePurposeBoundReportingCutoverContext,
  type PurposeBoundReportingCutoverContext,
} from "@/lib/client-onboarding/reporting-cutover";
import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";
import {
  ClientShopifyConnectionError,
  testStoredReportingShopifyStore,
} from "@/lib/client-onboarding/shopify-connections";
import { createReportingShopifyRepository } from "@/lib/client-onboarding/shopify-repository";
import { ShopifyReportingError } from "@/lib/client-onboarding/shopify";
import { createServiceClient } from "@/lib/supabase/service";
import { checkGoogleAdsAccountHealth, WindsorError } from "@/lib/windsor/client";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const STEPS = {
  c12_provision: "provision",
  c12_sync: "sync",
  c12_activate: "activate",
  c16_upgrade: "upgrade",
  c16_sync: "sync",
  c16_activate: "activate",
  c12_rollback: "rollback",
  c16_rollback: "rollback",
} as const;
type Step = keyof typeof STEPS;

type CutoverConfig = {
  token: string;
  adminId: string;
  c12ClientId: string;
  c12ShopifyConnectionId: string;
  c16ClientId: string;
  c16ShopifyConnectionId: string;
  c16GoogleConnectionId: string;
};

const RESPONSE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function loadConfig(): CutoverConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.REPORTING_CUTOVER_CONTEXT ?? "");
  } catch {
    return null;
  }
  const keys = [
    "token",
    "adminId",
    "c12ClientId",
    "c12ShopifyConnectionId",
    "c16ClientId",
    "c16ShopifyConnectionId",
    "c16GoogleConnectionId",
  ] as const;
  if (
    !isExactRecord(parsed, keys) ||
    typeof parsed.token !== "string" ||
    !TOKEN.test(parsed.token) ||
    keys.slice(1).some(
      (key) => typeof parsed[key] !== "string" || !UUID.test(parsed[key] as string),
    ) ||
    parsed.c12ClientId === parsed.c16ClientId ||
    parsed.c12ShopifyConnectionId === parsed.c16ShopifyConnectionId
  ) {
    return null;
  }
  return parsed as CutoverConfig;
}

function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function reportingContext(config: CutoverConfig, step: Step): PurposeBoundReportingCutoverContext {
  if (step.startsWith("c12_")) {
    return {
      adminId: config.adminId,
      clientId: config.c12ClientId,
      shopifyConnectionIds: [config.c12ShopifyConnectionId],
      googleAdsConnectionIds: [],
    };
  }
  return {
    adminId: config.adminId,
    clientId: config.c16ClientId,
    shopifyConnectionIds: [config.c16ShopifyConnectionId],
    googleAdsConnectionIds: [config.c16GoogleConnectionId],
    prerequisiteClientId: config.c12ClientId,
  };
}

function invalidState(): ClientOnboardingError {
  return new ClientOnboardingError(
    "invalid_state",
    "The exact reporting cutover step is not eligible.",
    409,
  );
}

async function testExactShopifyConnection(
  connectionId: string,
  adminId: string,
): Promise<void> {
  const health = await testStoredReportingShopifyStore({
    connectionId,
    adminId,
    repository: createReportingShopifyRepository(),
  });
  if (!health.ok) throw invalidState();
}

async function testExactGoogleConnection(
  connectionId: string,
  clientId: string,
  adminId: string,
): Promise<void> {
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Server-side reporting cutover is not configured.",
      503,
    );
  }
  const { data: connection, error } = await service
    .from("client_google_ads_connections")
    .select("id, client_id, windsor_account_id")
    .eq("id", connectionId)
    .eq("client_id", clientId)
    .eq("status", "connected")
    .maybeSingle();
  if (error || !connection || connection.id !== connectionId) throw invalidState();

  const fallbackTestedAt = new Date().toISOString();
  try {
    const health = await checkGoogleAdsAccountHealth(connection.windsor_account_id);
    if (health.ok && health.account.currency && health.account.timeZone) {
      const identity = await service.rpc("record_client_google_ads_reporting_identity", {
        p_connection_id: connectionId,
        p_currency: health.account.currency,
        p_time_zone: health.account.timeZone,
        p_admin_id: adminId,
        p_verified_at: health.checkedAt,
      });
      if (identity.error || identity.data !== connectionId) {
        throw new ClientOnboardingError(
          "database_error",
          "The exact Google Ads reporting identity could not be recorded.",
          500,
        );
      }
    }
    const recorded = await service.rpc("record_client_google_ads_health", {
      p_connection_id: connectionId,
      p_admin_id: adminId,
      p_ok: health.ok,
      p_tested_at: health.checkedAt,
      p_error_code: health.ok ? null : health.code,
    });
    if (recorded.error || recorded.data !== connectionId) {
      throw new ClientOnboardingError(
        "database_error",
        "The exact Google Ads health result could not be recorded.",
        500,
      );
    }
    if (!health.ok || !health.account.currency || !health.account.timeZone) {
      throw invalidState();
    }
  } catch (healthError) {
    if (healthError instanceof ClientOnboardingError) throw healthError;
    const code = healthError instanceof WindsorError ? healthError.code : "health_check_failed";
    await service.rpc("record_client_google_ads_health", {
      p_connection_id: connectionId,
      p_admin_id: adminId,
      p_ok: false,
      p_tested_at: fallbackTestedAt,
      p_error_code: code,
    });
    throw healthError;
  }
}

function errorResponse(error: unknown) {
  if (
    error instanceof ClientOnboardingError ||
    error instanceof ClientShopifyConnectionError
  ) {
    return response({ error: "Cutover step rejected.", code: error.code }, error.status);
  }
  if (error instanceof WindsorError) {
    return response(
      { error: "Cutover source check failed.", code: error.code },
      error.status === 499 ? 408 : error.status,
    );
  }
  if (error instanceof ShopifyReportingError) {
    const status = error.code === "shopify_rate_limited" ? 429 : error.retryable ? 503 : 422;
    return response({ error: "Cutover source check failed.", code: error.code }, status);
  }
  console.error("Purpose-bound reporting cutover failed without a classified error.");
  return response({ error: "Cutover step failed.", code: "cutover_failed" }, 500);
}

export async function POST(request: NextRequest) {
  const config = loadConfig();
  if (!config) return response({ error: "Machine access is unavailable." }, 503);

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !secretMatches(provided, config.token)) {
    return response({ error: "Unauthorised." }, 401);
  }
  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);

  try {
    const body = await readSmallJson(request, 128);
    if (
      !isExactRecord(body, ["step"]) ||
      typeof body.step !== "string" ||
      !Object.hasOwn(STEPS, body.step)
    ) {
      throw new ClientOnboardingError(
        "invalid_request",
        "Send exactly one supported cutover step.",
        400,
      );
    }
    const step = body.step as Step;
    const context = reportingContext(config, step);
    const kind = STEPS[step];
    if (kind === "rollback") {
      await executePurposeBoundReportingCutoverRollback(context);
      return response({ ok: true, step });
    }

    await validatePurposeBoundReportingCutoverContext(context);

    if (step === "c12_provision") {
      await testExactShopifyConnection(config.c12ShopifyConnectionId, config.adminId);
    } else if (step === "c16_upgrade") {
      await testExactShopifyConnection(config.c16ShopifyConnectionId, config.adminId);
      await testExactGoogleConnection(
        config.c16GoogleConnectionId,
        config.c16ClientId,
        config.adminId,
      );
    }

    await executePurposeBoundReportingCutoverStep(context, kind);
    return response({ ok: true, step });
  } catch (error) {
    return errorResponse(error);
  }
}
