import { NextResponse, type NextRequest } from "next/server";

import { getAuditMachineSponsor } from "@/lib/audit/connections";
import {
  LaraPricingLiveRepairError,
  runLaraPricingLiveRepairOneShot,
} from "@/lib/audit/lara-pricing-live-repair";
import { LaraPricingLiveRuntimeError } from "@/lib/audit/lara-pricing-live-runtime";
import { LARA_AUDIT_CONNECTION } from "@/lib/audit/shopify-lara";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;
const ACTION = "advance";
const CONFIRMATION = "apply-lara-remove-unsupported-compare-at-prices";
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

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "action" && keys[1] === "confirmation";
}

export async function POST(request: NextRequest) {
  const machineSecret = process.env.CRON_SECRET;
  if (!machineSecret) return response({ error: "Machine access is unavailable." }, 503);
  if (request.headers.get("authorization") !== `Bearer ${machineSecret}`) {
    return response({ error: "Unauthorised." }, 401);
  }
  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return response({ error: "Request body is too large." }, 413);
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return response({ error: "Invalid JSON body." }, 400);
  }
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return response(
      { error: raw ? "Request body is too large." : "Invalid JSON body." },
      raw ? 413 : 400,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return response({ error: "Invalid JSON body." }, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return response({ error: "Invalid pricing repair request." }, 400);
  }
  const body = parsed as Record<string, unknown>;
  if (
    !exactKeys(body) ||
    body.action !== ACTION ||
    body.confirmation !== CONFIRMATION
  ) {
    return response({ error: "The exact pricing repair confirmation is required." }, 400);
  }

  try {
    // Every consequential value is server-owned: connection/shop/run IDs,
    // GraphQL, result-URL allowlist, product/variant IDs, digests and the sole
    // `compareAtPrice: null` mutation. The request can only advance one slice.
    const requestedBy = await getAuditMachineSponsor({
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      shopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
      shopifyShopId: LARA_AUDIT_CONNECTION.shopId,
    });
    const result = await runLaraPricingLiveRepairOneShot({ requestedBy });
    if (result.state === "in_progress") return response({ ok: true, ...result }, 202);
    if (result.state === "failed") return response({ ok: false, ...result }, 502);
    return response({ ok: true, ...result });
  } catch (error) {
    if (
      error instanceof LaraPricingLiveRepairError ||
      error instanceof LaraPricingLiveRuntimeError
    ) {
      return response({ error: error.code }, 409);
    }
    console.error("The fixed Lara pricing repair request failed.");
    return response({ error: "The pricing repair request could not be completed." }, 500);
  }
}
