import { NextResponse, type NextRequest } from "next/server";

import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
import {
  ClientOnboardingError,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import {
  ClientShopifyConnectionError,
  revokeReportingShopifyStore,
  testStoredReportingShopifyStore,
} from "@/lib/client-onboarding/shopify-connections";
import { createReportingShopifyRepository } from "@/lib/client-onboarding/shopify-repository";
import { ShopifyReportingError } from "@/lib/client-onboarding/shopify";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function errorResponse(error: unknown) {
  if (
    error instanceof ClientOnboardingError ||
    error instanceof ClientShopifyConnectionError
  ) {
    return response({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof ShopifyReportingError) {
    const status =
      error.code === "shopify_rate_limited"
        ? 429
        : error.retryable
          ? 503
          : 422;
    return response({ error: error.message, code: error.code }, status);
  }
  console.error("Admin Shopify reporting action failed without a classified error.");
  return response(
    {
      error: "The Shopify reporting connection could not be updated.",
      code: "connection_failed",
    },
    500,
  );
}

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    // Re-authorise the admin inside the public Route Handler entry point.
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) return response({ error: "Not found." }, 404);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return response({ error: "Invalid JSON body." }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      (body as Record<string, unknown>).action !== "test"
    ) {
      return response({ error: "Send exactly action: test." }, 400);
    }

    const health = await testStoredReportingShopifyStore({
      connectionId: id,
      adminId: admin.id,
      repository: createReportingShopifyRepository(),
    });
    return response({ ok: health.ok, health });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const admin = await requireClientOnboardingAdmin();
    const { id } = await params;
    if (!isClientOnboardingId(id)) return response({ error: "Not found." }, 404);
    await revokeReportingShopifyStore({
      connectionId: id,
      adminId: admin.id,
      repository: createReportingShopifyRepository(),
    });
    return response({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
