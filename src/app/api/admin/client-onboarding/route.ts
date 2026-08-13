import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { listExistingClientRoster } from "@/lib/client-onboarding/legacy-roster";
import {
  createClientOnboardingSession,
  listClientOnboardingSessions,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import type { ClientOnboardingMode } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [sessions, roster] = await Promise.all([
      listClientOnboardingSessions(),
      listExistingClientRoster(),
    ]);
    return clientOnboardingResponse({ sessions, roster });
  } catch (error) {
    return clientOnboardingErrorResponse(error, "The client list could not be loaded.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const body = await readSmallJson(request, 4_096);
    if (!isExactRecord(body, ["mode", "requestedAssets"], ["targetClientId"])) {
      return clientOnboardingResponse(
        { error: "Send mode, requestedAssets and an optional targetClientId." },
        400,
      );
    }
    if (
      typeof body.mode !== "string" ||
      !Array.isArray(body.requestedAssets) ||
      !body.requestedAssets.every((asset) => typeof asset === "string") ||
      (body.targetClientId !== undefined &&
        body.targetClientId !== null &&
        typeof body.targetClientId !== "string")
    ) {
      return clientOnboardingResponse({ error: "Invalid onboarding invitation request." }, 400);
    }
    const invitation = await createClientOnboardingSession({
      mode: body.mode as ClientOnboardingMode,
      requestedAssets: body.requestedAssets,
      targetClientId: body.targetClientId as string | null | undefined,
      adminId: admin.id,
    });
    return clientOnboardingResponse({ ok: true, invitation }, 201);
  } catch (error) {
    return clientOnboardingErrorResponse(error, "The onboarding invitation could not be created.");
  }
}
