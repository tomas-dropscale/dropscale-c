import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
} from "@/lib/client-onboarding/http";
import { executeClientReportingCutoverRequest } from "@/lib/client-onboarding/reporting-cutover";

export const dynamic = "force-dynamic";

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
