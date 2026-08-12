import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import {
  requireClientOnboardingAdmin,
  reviewClientOnboardingSession,
  revokeClientOnboardingSession,
  rotateClientOnboardingInvitation,
} from "@/lib/client-onboarding/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    const body = await readSmallJson(request, 2_048);
    if (!isExactRecord(body, ["action"]) || typeof body.action !== "string") {
      return clientOnboardingResponse({ error: "Send exactly one action." }, 400);
    }
    if (body.action === "rotate") {
      const invitation = await rotateClientOnboardingInvitation(id, admin.id);
      return clientOnboardingResponse({ ok: true, invitation });
    }
    if (body.action === "review" || body.action === "activate") {
      await reviewClientOnboardingSession(id, admin.id, body.action === "activate");
      return clientOnboardingResponse({ ok: true });
    }
    if (body.action === "revoke") {
      await revokeClientOnboardingSession(id, admin.id);
      return clientOnboardingResponse({ ok: true });
    }
    return clientOnboardingResponse({ error: "Unsupported onboarding action." }, 400);
  } catch (error) {
    return clientOnboardingErrorResponse(error);
  }
}
