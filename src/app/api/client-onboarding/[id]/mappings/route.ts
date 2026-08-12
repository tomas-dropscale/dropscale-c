import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { replaceClientAssetMappings } from "@/lib/client-onboarding/sessions";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const body = await readSmallJson(request, 16_384);
    if (!isExactRecord(body, ["mappings"]) || !Array.isArray(body.mappings)) {
      return clientOnboardingResponse({ error: "Send an array of asset mappings." }, 400);
    }
    const mappings: Array<{
      shopifyConnectionId: string;
      googleAdsConnectionId: string;
    }> = [];
    for (const value of body.mappings) {
      if (
        !isExactRecord(value, ["shopifyConnectionId", "googleAdsConnectionId"]) ||
        typeof value.shopifyConnectionId !== "string" ||
        typeof value.googleAdsConnectionId !== "string"
      ) {
        return clientOnboardingResponse({ error: "Invalid asset mapping." }, 400);
      }
      mappings.push({
        shopifyConnectionId: value.shopifyConnectionId,
        googleAdsConnectionId: value.googleAdsConnectionId,
      });
    }
    await replaceClientAssetMappings(
      id,
      request.headers.get("x-dropscale-client-onboarding"),
      mappings,
    );
    return clientOnboardingResponse({ ok: true });
  } catch (error) {
    return clientOnboardingErrorResponse(error, "The asset mappings could not be saved.");
  }
}
