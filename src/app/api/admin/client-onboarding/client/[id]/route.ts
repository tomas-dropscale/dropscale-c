import type { NextRequest } from "next/server";

import {
  deletePortalClientCompletely,
  sendPortalClientPasswordReset,
  updatePortalClientIdentity,
} from "@/lib/client-onboarding/client-admin";
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

async function hasNonEmptyBody(request: NextRequest): Promise<boolean> {
  return (await request.text()).trim().length > 0;
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Client not found." }, 404);
    }

    const body = await readSmallJson(request, 4_096);
    if (
      !isExactRecord(body, ["fullName", "email", "discordHandle"]) ||
      typeof body.fullName !== "string" ||
      typeof body.email !== "string" ||
      (body.discordHandle !== null && typeof body.discordHandle !== "string")
    ) {
      return clientOnboardingResponse(
        { error: "Send exactly fullName, email and discordHandle." },
        400,
      );
    }

    await updatePortalClientIdentity({
      clientId: id,
      fullName: body.fullName,
      email: body.email,
      discordHandle: body.discordHandle,
      adminId: admin.id,
    });
    return clientOnboardingResponse({ ok: true });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The client identity could not be updated.",
    );
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  try {
    await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Client not found." }, 404);
    }
    if (await hasNonEmptyBody(request)) {
      return clientOnboardingResponse(
        { error: "This request does not accept a body." },
        400,
      );
    }

    await sendPortalClientPasswordReset(id);
    return clientOnboardingResponse({ ok: true });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The password reset email could not be sent.",
    );
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Client not found." }, 404);
    }
    if (await hasNonEmptyBody(request)) {
      return clientOnboardingResponse(
        { error: "This request does not accept a body." },
        400,
      );
    }

    await deletePortalClientCompletely(id, admin.id);
    return clientOnboardingResponse({ ok: true });
  } catch (error) {
    return clientOnboardingErrorResponse(
      error,
      "The client could not be removed.",
    );
  }
}
