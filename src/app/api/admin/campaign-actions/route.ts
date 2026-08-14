import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
} from "@/lib/client-onboarding/http";
import { executeCampaignActionRequest } from "@/lib/admin/campaign-actions";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const result = await executeCampaignActionRequest(request);
    return clientOnboardingResponse({ ok: true, ...result });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The campaign action could not be completed.",
    );
  }
}
