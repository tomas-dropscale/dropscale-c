import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import {
  getPublicClientOnboardingSession,
  submitClientOnboardingSession,
} from "@/lib/client-onboarding/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function token(request: NextRequest) {
  return request.headers.get("x-dropscale-client-onboarding");
}

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const session = await getPublicClientOnboardingSession(id, token(request));
    return clientOnboardingResponse({ session });
  } catch (error) {
    return clientOnboardingErrorResponse(error, "The onboarding link could not be checked.");
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const body = await readSmallJson(request, 1_024);
    if (!isExactRecord(body, ["action"]) || body.action !== "submit") {
      return clientOnboardingResponse({ error: "Send the submit action." }, 400);
    }
    await submitClientOnboardingSession(id, token(request));
    return clientOnboardingResponse({ ok: true });
  } catch (error) {
    return clientOnboardingErrorResponse(error, "The onboarding could not be submitted.");
  }
}
