import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
import { rebindClientReportingSources } from "@/lib/client-onboarding/rebind-sources";
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

/** Bring a store and the Google account mapped to it into one binding. */
export async function POST(request: NextRequest) {
  try {
    const admin = await requireClientOnboardingAdmin();
    if (!sameOrigin(request)) {
      return clientOnboardingResponse({ error: "Forbidden." }, 403);
    }
    const body = await readSmallJson(request, 1_024);
    if (!isExactRecord(body, ["clientId"]) || typeof body.clientId !== "string") {
      return clientOnboardingResponse({ error: "Send exactly clientId." }, 400);
    }
    if (!isClientOnboardingId(body.clientId)) {
      return clientOnboardingResponse({ error: "Send a valid client id." }, 400);
    }

    const outcome = await rebindClientReportingSources({
      clientId: body.clientId,
      adminId: admin.id,
    });
    return clientOnboardingResponse({ ok: true, ...outcome });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The client's reporting sources could not be rebound.",
    );
  }
}
