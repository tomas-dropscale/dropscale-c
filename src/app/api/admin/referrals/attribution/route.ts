import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_KEYS = [
  "referredClientId",
  "referrerClientId",
  "decisionId",
  "reason",
  "confirmed",
] as const;

type AttributionDecision = {
  referredClientId: string;
  referrerClientId: string;
  decisionId: string;
  reason: string;
};

type AttributionReceipt = {
  id: string;
  decisionId: string;
  referredClientId: string;
  referrerClientId: string;
  reason: string;
  reviewedBy: string;
  createdAt: string;
  sealedAt: string;
};

function decisionFromBody(body: unknown): AttributionDecision | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== BODY_KEYS.length ||
    !BODY_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    return null;
  }

  if (
    typeof record.referredClientId !== "string" ||
    !UUID.test(record.referredClientId) ||
    typeof record.referrerClientId !== "string" ||
    !UUID.test(record.referrerClientId) ||
    record.referredClientId === record.referrerClientId ||
    typeof record.decisionId !== "string" ||
    !UUID.test(record.decisionId) ||
    typeof record.reason !== "string" ||
    record.confirmed !== true
  ) {
    return null;
  }

  const reason = record.reason.trim();
  if (!reason || reason.length > 1000) return null;

  return {
    referredClientId: record.referredClientId,
    referrerClientId: record.referrerClientId,
    decisionId: record.decisionId,
    reason,
  };
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function serialiseReceipt(value: unknown): AttributionReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !UUID.test(row.id) ||
    typeof row.decision_id !== "string" ||
    !UUID.test(row.decision_id) ||
    typeof row.referred_client_id !== "string" ||
    !UUID.test(row.referred_client_id) ||
    typeof row.referrer_client_id !== "string" ||
    !UUID.test(row.referrer_client_id) ||
    typeof row.reason !== "string" ||
    !row.reason.trim() ||
    row.reason.length > 1000 ||
    typeof row.reviewed_by !== "string" ||
    !UUID.test(row.reviewed_by) ||
    !isTimestamp(row.created_at) ||
    !isTimestamp(row.sealed_at)
  ) {
    return null;
  }

  return {
    id: row.id,
    decisionId: row.decision_id,
    referredClientId: row.referred_client_id,
    referrerClientId: row.referrer_client_id,
    reason: row.reason,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    sealedAt: row.sealed_at,
  };
}

/**
 * Permanently attribute one previously-unassigned client to an approved
 * referrer. This does not create or change a commercial discount term.
 */
export async function POST(request: NextRequest) {
  let decision: AttributionDecision | null;
  try {
    decision = decisionFromBody(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!decision) {
    return NextResponse.json(
      {
        error:
          "Send exactly referredClientId, referrerClientId, decisionId, a non-empty reason and confirmed=true.",
      },
      { status: 400 },
    );
  }

  const session = await createClient();
  const {
    data: { user },
    error: authError,
  } = await session.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  const { data: profile, error: profileError } = await session
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    return NextResponse.json(
      { error: "Could not verify the admin session." },
      { status: 500 },
    );
  }
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  // Only construct the RLS-bypassing client after a database-backed role
  // check. The browser cannot invoke this service-only RPC directly.
  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "Server-side referral attribution is not configured." },
      { status: 503 },
    );
  }

  // Generated database types may trail the migration during a staged deploy;
  // this untyped view is limited to the exact service-only RPC contract.
  const attributionService = service as unknown as SupabaseClient;
  const { data, error } = await attributionService.rpc(
    "assign_manual_referral_attribution",
    {
      p_referred_client_id: decision.referredClientId,
      p_referrer_client_id: decision.referrerClientId,
      p_decision_id: decision.decisionId,
      p_reason: decision.reason,
      p_reviewed_by: profile.id,
    },
  );

  if (error) {
    console.error("Manual referral attribution failed:", {
      referredClientId: decision.referredClientId,
      referrerClientId: decision.referrerClientId,
      decisionId: decision.decisionId,
      code: error.code,
      message: error.message,
    });

    if (
      error.code === "22023" ||
      error.code === "23503" ||
      error.code === "23505" ||
      error.code === "40001" ||
      error.code === "P0001"
    ) {
      return NextResponse.json(
        {
          error:
            error.message ||
            "This attribution conflicts with the current client state.",
          code: "attribution_conflict",
        },
        { status: 409 },
      );
    }
    if (error.code === "42501") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { error: "The referral attribution could not be assigned." },
      { status: 500 },
    );
  }

  const receipt = serialiseReceipt(Array.isArray(data) ? data[0] : null);
  if (!receipt) {
    console.error(
      "Manual referral attribution RPC returned an incomplete receipt:",
      {
        referredClientId: decision.referredClientId,
        referrerClientId: decision.referrerClientId,
        decisionId: decision.decisionId,
      },
    );
    return NextResponse.json(
      {
        error:
          "The attribution was processed, but its sealed receipt was incomplete. Refresh.",
      },
      { status: 500 },
    );
  }

  if (
    receipt.decisionId !== decision.decisionId ||
    receipt.referredClientId !== decision.referredClientId ||
    receipt.referrerClientId !== decision.referrerClientId ||
    receipt.reason !== decision.reason ||
    receipt.reviewedBy !== profile.id
  ) {
    console.error("Manual referral attribution receipt did not match request:", {
      requestedDecisionId: decision.decisionId,
      returnedDecisionId: receipt.decisionId,
    });
    return NextResponse.json(
      {
        error:
          "The attribution receipt did not match the reviewed decision. Refresh before taking another action.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, attribution: receipt });
}
