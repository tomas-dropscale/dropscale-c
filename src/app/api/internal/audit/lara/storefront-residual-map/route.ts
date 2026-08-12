import { NextResponse, type NextRequest } from "next/server";

import { getAuditMachineSponsor } from "@/lib/audit/connections";
import {
  LARA_STOREFRONT_RESIDUAL_RUN_ID,
  runLaraStorefrontResidualCollector,
} from "@/lib/audit/lara-storefront-residual-collector";
import { LARA_AUDIT_CONNECTION } from "@/lib/audit/shopify-lara";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256;
const RESPONSE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return response({ error: "Machine access is unavailable." }, 503);
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return response({ error: "Unauthorised." }, 401);
  }
  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return response({ error: "Request body is too large." }, 413);
  }
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return response({ error: "Invalid JSON body." }, 400);
  }
  if (!bodyText || new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return response(
      { error: bodyText ? "Request body is too large." : "Invalid JSON body." },
      bodyText ? 413 : 400,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return response({ error: "Invalid JSON body." }, 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    (body as Record<string, unknown>).action !== "collect"
  ) {
    return response({ error: "Invalid residual-map request." }, 400);
  }

  try {
    // Connection, shop, theme, menus, filenames, markers and the durable run
    // ID are all server-owned. The caller can only trigger this one fixed read.
    const requestedBy = await getAuditMachineSponsor({
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      shopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
      shopifyShopId: LARA_AUDIT_CONNECTION.shopId,
    });
    const result = await runLaraStorefrontResidualCollector({ requestedBy });
    if (result.state === "in_progress") return response({ ok: true, ...result }, 202);
    if (result.state === "failed") return response({ ok: false, ...result }, 502);
    return response({ ok: true, ...result });
  } catch {
    console.error("The fixed Lara storefront residual map request failed.");
    return response(
      {
        error: "The storefront residual map could not be completed.",
        runId: LARA_STOREFRONT_RESIDUAL_RUN_ID,
      },
      500,
    );
  }
}
