import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
} from "@/lib/client-onboarding/http";
import { commitClientReportingBindingRequest } from "@/lib/client-onboarding/reporting-bindings";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const result = await commitClientReportingBindingRequest(request);
    return clientOnboardingResponse({ ok: true, ...result });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The reporting binding could not be committed.",
    );
  }
}
