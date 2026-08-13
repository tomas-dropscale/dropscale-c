import { NextResponse, type NextRequest } from "next/server";

import { getAuditMachineSponsor } from "@/lib/audit/connections";
import {
  buildLaraThemeUrgencyDryRun,
  LaraThemeUrgencyRepairError,
  runLaraThemeUrgencyRepairOneShot,
} from "@/lib/audit/lara-theme-urgency-live-repair";
import { LaraThemeUrgencyLiveContractError } from "@/lib/audit/lara-theme-urgency-live-contract";
import {
  LARA_THEME_URGENCY_SAFE_REST_INTEGRITY_CLASSES,
  LARA_THEME_URGENCY_SAFE_REST_INTEGRITY_FILENAMES,
  LaraThemeUrgencyLiveRuntimeError,
} from "@/lib/audit/lara-theme-urgency-live-runtime";
import { LARA_AUDIT_CONNECTION } from "@/lib/audit/shopify-lara";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;
const APPLY_CONFIRMATION = "apply-lara-exact-theme-copy-with-durable-backup";
const RESPONSE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}
function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function safeRestIntegrityDiagnostic(
  error: LaraThemeUrgencyLiveRuntimeError,
): Readonly<{ filename: string; discrepancyClass: string }> | null {
  const diagnostic = error.diagnostic;
  if (
    error.code !== "invalid_rest_asset_integrity" ||
    !diagnostic ||
    !exactKeys(diagnostic as unknown as Record<string, unknown>, [
      "filename",
      "discrepancyClass",
    ]) ||
    !LARA_THEME_URGENCY_SAFE_REST_INTEGRITY_FILENAMES.includes(
      diagnostic.filename,
    ) ||
    !LARA_THEME_URGENCY_SAFE_REST_INTEGRITY_CLASSES.includes(
      diagnostic.discrepancyClass,
    )
  ) {
    return null;
  }
  return {
    filename: diagnostic.filename,
    discrepancyClass: diagnostic.discrepancyClass,
  };
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response({ error: "Invalid exact-theme request." }, 400);
  }
  const requestBody = body as Record<string, unknown>;

  try {
    if (requestBody.action === "dry-run") {
      if (!exactKeys(requestBody, ["action"])) {
        return response({ error: "Invalid dry-run request." }, 400);
      }
      const dryRun = await buildLaraThemeUrgencyDryRun();
      return response({ ok: true, ...dryRun });
    }

    if (requestBody.action !== "apply") {
      return response({ error: "Invalid exact-theme action." }, 400);
    }
    if (
      !exactKeys(requestBody, ["action", "confirmation"]) ||
      requestBody.confirmation !== APPLY_CONFIRMATION
    ) {
      return response({ error: "The exact apply confirmation is required." }, 400);
    }

    // Connection, shop, theme, filenames, bodies, plan, backup and run IDs are
    // all fixed server-side. The request can neither upload content nor select
    // an arbitrary theme. Kaching remains explicitly excluded from this route.
    const requestedBy = await getAuditMachineSponsor({
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      shopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
      shopifyShopId: LARA_AUDIT_CONNECTION.shopId,
    });
    const result = await runLaraThemeUrgencyRepairOneShot({ requestedBy });
    if (result.state === "in_progress") return response({ ok: true, ...result }, 202);
    if (result.state === "failed") return response({ ok: false, ...result }, 502);
    return response({ ok: true, ...result });
  } catch (error) {
    if (error instanceof LaraThemeUrgencyLiveRuntimeError) {
      const diagnostic = safeRestIntegrityDiagnostic(error);
      return response(
        diagnostic ? { error: error.code, diagnostic } : { error: error.code },
        409,
      );
    }
    if (
      error instanceof LaraThemeUrgencyRepairError ||
      error instanceof LaraThemeUrgencyLiveContractError
    ) {
      return response({ error: error.code }, 409);
    }
    console.error("The exact Lara theme repair request failed.");
    return response({ error: "The exact theme request could not be completed." }, 500);
  }
}
