import type { NextRequest } from "next/server";

import { configureCampaignActionPolicyRequest } from "@/lib/admin/campaign-actions";
import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
} from "@/lib/client-onboarding/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const result = await configureCampaignActionPolicyRequest(request);
    return clientOnboardingResponse({ ok: true, ...result });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The campaign action policy could not be configured.",
    );
  }
}
