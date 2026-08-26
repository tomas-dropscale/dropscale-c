import type { NextRequest } from "next/server";

import { mapGoogleAdsAccountToStore } from "@/lib/client-onboarding/client-admin";
import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
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

/**
 * Attach a Google Ads account to one of the client's stores.
 *
 * The database is the one that decides whether the pair is legitimate — same
 * workspace, both connected, no staged binding reserving the account for a
 * different store. This route only carries the admin's intent to it.
 */
export async function POST(request: NextRequest) {
  try {
    const admin = await requireClientOnboardingAdmin();
    if (!sameOrigin(request)) {
      return clientOnboardingResponse({ error: "Forbidden." }, 403);
    }
    const body = await readSmallJson(request, 1_024);
    if (!isExactRecord(body, ["googleAdsConnectionId", "shopifyConnectionId"])) {
      return clientOnboardingResponse(
        { error: "Send exactly googleAdsConnectionId and shopifyConnectionId." },
        400,
      );
    }
    const googleAdsConnectionId =
      typeof body.googleAdsConnectionId === "string" ? body.googleAdsConnectionId : "";
    const shopifyConnectionId =
      typeof body.shopifyConnectionId === "string" ? body.shopifyConnectionId : "";
    if (
      !isClientOnboardingId(googleAdsConnectionId) ||
      !isClientOnboardingId(shopifyConnectionId)
    ) {
      return clientOnboardingResponse({ error: "Send two valid asset ids." }, 400);
    }

    await mapGoogleAdsAccountToStore({
      googleAdsConnectionId,
      shopifyConnectionId,
      adminId: admin.id,
    });
    return clientOnboardingResponse({ ok: true });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The store mapping could not be saved.",
    );
  }
}
