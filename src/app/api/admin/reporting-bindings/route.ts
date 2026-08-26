import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
} from "@/lib/client-onboarding/http";
import {
  executeClientReportingCutoverRequest,
  listClientReportingCutoverQueue,
} from "@/lib/client-onboarding/reporting-cutover";
import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";

export const dynamic = "force-dynamic";

/**
 * The queue the hourly sync already computes, now readable by the admin who
 * has to act on it. Action ids are opaque and re-derived on every read, so a
 * page left open cannot replay a decision the snapshot no longer supports.
 */
export async function GET() {
  try {
    await requireClientOnboardingAdmin();
    const queue = await listClientReportingCutoverQueue();
    return clientOnboardingResponse({ ok: true, queue });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The reporting queue could not be read.",
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await executeClientReportingCutoverRequest(request);
    return clientOnboardingResponse({ ok: true, ...result });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The reporting cutover action could not be completed.",
    );
  }
}
