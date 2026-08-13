import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
import {
  disconnectLegacyShopifyConnection,
  LegacyShopifyDisconnectError,
  LegacyShopifyHealthError,
  testLegacyShopifyConnection,
} from "@/lib/client-onboarding/legacy-shopify";
import {
  ClientOnboardingError,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function errorResponse(error: unknown, fallback: string) {
  if (
    error instanceof LegacyShopifyHealthError ||
    error instanceof LegacyShopifyDisconnectError
  ) {
    return clientOnboardingResponse(
      { error: error.message, code: error.code },
      error.status,
    );
  }
  return clientOnboardingErrorResponse(error, fallback);
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Not found." }, 404);
    }
    const body = await readSmallJson(request, 1_024);
    if (!isExactRecord(body, ["action"]) || body.action !== "test") {
      return clientOnboardingResponse({ error: "Send exactly action: test." }, 400);
    }
    const service = createServiceClient();
    if (!service) {
      throw new ClientOnboardingError(
        "server_not_configured",
        "Client onboarding is not configured on the server.",
        503,
      );
    }
    const health = await testLegacyShopifyConnection({ accountId: id, service });
    return clientOnboardingResponse(health);
  } catch (error) {
    return errorResponse(error, "The Shopify connection test failed.");
  }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) {
      return clientOnboardingResponse({ error: "Not found." }, 404);
    }
    const service = createServiceClient();
    if (!service) {
      throw new ClientOnboardingError(
        "server_not_configured",
        "Client onboarding is not configured on the server.",
        503,
      );
    }
    await disconnectLegacyShopifyConnection({
      accountId: id,
      adminId: admin.id,
      service,
    });
    return clientOnboardingResponse({ ok: true });
  } catch (error) {
    return errorResponse(error, "The Shopify connection could not be removed.");
  }
}
