import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import {
  claimExistingClientOnboardingIdentity,
  createClientOnboardingIdentity,
  recoverClientOnboardingIdentity,
} from "@/lib/client-onboarding/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const body = await readSmallJson(request, 8_192);
    const invitationToken = request.headers.get("x-dropscale-client-onboarding");
    if (isExactRecord(body, ["kind"]) && body.kind === "existing") {
      await claimExistingClientOnboardingIdentity({
        sessionId: id,
        invitationToken,
      });
      return clientOnboardingResponse({ ok: true });
    }
    if (
      isExactRecord(body, ["kind", "firstName", "lastName", "email", "discordHandle"]) &&
      body.kind === "recover" &&
      typeof body.firstName === "string" &&
      typeof body.lastName === "string" &&
      typeof body.email === "string" &&
      typeof body.discordHandle === "string" &&
      invitationToken
    ) {
      const result = await recoverClientOnboardingIdentity({
        sessionId: id,
        invitationToken,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        discordHandle: body.discordHandle,
      });
      return clientOnboardingResponse({ ok: true, ...result });
    }
    if (
      !isExactRecord(body, ["kind", "firstName", "lastName", "email", "discordHandle", "userId"]) ||
      body.kind !== "new" ||
      typeof body.firstName !== "string" ||
      typeof body.lastName !== "string" ||
      typeof body.email !== "string" ||
      typeof body.discordHandle !== "string" ||
      typeof body.userId !== "string" ||
      !invitationToken
    ) {
      return clientOnboardingResponse({ error: "Enter the complete account details." }, 400);
    }
    const result = await createClientOnboardingIdentity({
      sessionId: id,
      invitationToken,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      discordHandle: body.discordHandle,
      userId: body.userId,
    });
    return clientOnboardingResponse({ ok: true, ...result }, 201);
  } catch (error) {
    return clientOnboardingErrorResponse(error, "The client account could not be created.");
  }
}
