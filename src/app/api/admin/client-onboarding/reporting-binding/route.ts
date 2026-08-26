import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
import {
  describeReportingBindingForAsset,
  revokeReportingBindingForAsset,
  type ReportingAssetKind,
} from "@/lib/client-onboarding/reporting-binding-admin";
import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";

export const dynamic = "force-dynamic";

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function assetKind(value: unknown): ReportingAssetKind | null {
  return value === "shopify" || value === "google_ads" ? value : null;
}

/**
 * What a given asset's reporting binding covers, so the admin can see what
 * they are about to unbind before they do it. A paired binding carries both a
 * Shopify store and a Google Ads account, and revoking it stops reporting for
 * both — that has to be on screen, not discovered afterwards.
 */
export async function GET(request: NextRequest) {
  try {
    await requireClientOnboardingAdmin();
    const kind = assetKind(request.nextUrl.searchParams.get("kind"));
    const connectionId = request.nextUrl.searchParams.get("id") ?? "";
    if (!kind || !isClientOnboardingId(connectionId)) {
      return clientOnboardingResponse(
        { error: "Send kind (shopify or google_ads) and a valid asset id." },
        400,
      );
    }
    const binding = await describeReportingBindingForAsset(kind, connectionId);
    return clientOnboardingResponse({ ok: true, binding });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The reporting binding could not be read.",
    );
  }
}

/** Unbind the asset. The asset itself is removed by its own endpoint after. */
export async function POST(request: NextRequest) {
  try {
    const admin = await requireClientOnboardingAdmin();
    if (!sameOrigin(request)) {
      return clientOnboardingResponse({ error: "Forbidden." }, 403);
    }
    const body = await readSmallJson(request, 1_024);
    if (!isExactRecord(body, ["kind", "connectionId"])) {
      return clientOnboardingResponse(
        { error: "Send exactly kind and connectionId." },
        400,
      );
    }
    const kind = assetKind(body.kind);
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
    if (!kind || !isClientOnboardingId(connectionId)) {
      return clientOnboardingResponse(
        { error: "Send kind (shopify or google_ads) and a valid asset id." },
        400,
      );
    }
    const coverage = await revokeReportingBindingForAsset({
      kind,
      connectionId,
      adminId: admin.id,
    });
    return clientOnboardingResponse({ ok: true, binding: coverage });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The reporting binding could not be revoked.",
    );
  }
}
