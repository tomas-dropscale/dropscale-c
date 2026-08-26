import type { NextRequest } from "next/server";

import { setPortalClientAccessBlock } from "@/lib/client-onboarding/client-admin";
import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Same shape as the other admin mutations: a cross-site POST is not a click. */
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
 * Flip a client's portal lockout. Deliberately separate from the identity
 * PATCH on the parent route: blocking is a decision about access, not a field
 * on a form, and it must never ride along with an unrelated profile edit.
 */
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    if (!sameOrigin(request)) {
      return clientOnboardingResponse({ error: "Forbidden." }, 403);
    }
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Client not found." }, 404);
    }

    const body = await readSmallJson(request, 1_024);
    if (!isExactRecord(body, ["blocked"]) || typeof body.blocked !== "boolean") {
      return clientOnboardingResponse(
        { error: "Send exactly blocked: true or blocked: false." },
        400,
      );
    }

    await setPortalClientAccessBlock(id, admin.id, body.blocked);
    return clientOnboardingResponse({ ok: true, blocked: body.blocked });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The client's portal access could not be changed.",
    );
  }
}
