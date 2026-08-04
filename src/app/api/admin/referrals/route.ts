import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const BODY_KEYS = [
  "clientId",
  "referredClientId",
  "action",
  "expectedTermId",
  "decisionId",
  "reason",
] as const;

type ReferralDecision = {
  clientId: string;
  referredClientId: string;
  action: "grant" | "revoke";
  expectedTermId: string | null;
  decisionId: string;
  reason: string;
};

function decisionFromBody(body: unknown): ReferralDecision | null {
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
    typeof record.clientId !== "string" ||
    !UUID.test(record.clientId) ||
    typeof record.referredClientId !== "string" ||
    !UUID.test(record.referredClientId) ||
    record.clientId === record.referredClientId ||
    (record.action !== "grant" && record.action !== "revoke") ||
    !(
      record.expectedTermId === null ||
      (typeof record.expectedTermId === "string" &&
        UUID.test(record.expectedTermId))
    ) ||
    typeof record.decisionId !== "string" ||
    !UUID.test(record.decisionId) ||
    typeof record.reason !== "string"
  ) {
    return null;
  }

  const reason = record.reason.trim();
  if (!reason || reason.length > 1000) return null;

  return {
    clientId: record.clientId,
    referredClientId: record.referredClientId,
    action: record.action,
    expectedTermId: record.expectedTermId,
    decisionId: record.decisionId,
    reason,
  };
}

function lisbonDay(at: Date): string {
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid decision time.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  if (!ISO_DAY.test(day))
    throw new Error("Could not resolve the Lisbon decision day.");
  return day;
}

function addDays(day: string, amount: number): string {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

/** Monday allowed by the same Europe/Lisbon calendar enforced in SQL. */
function referralEffectiveMonday(at = new Date()): string {
  const today = lisbonDay(at);
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  return addDays(today, (8 - isoWeekday) % 7);
}

function serialiseTerm(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const term = value as Record<string, unknown>;
  const referralCount = Number(term.referral_count);
  const listRate = Number(term.list_rate);
  const referralStepRate = Number(term.referral_step_rate);
  const referralDiscountRate = Number(term.referral_discount_rate);
  const feeRate = Number(term.fee_rate);
  const revision = Number(term.revision);
  if (
    typeof term.id !== "string" ||
    !UUID.test(term.id) ||
    typeof term.client_id !== "string" ||
    typeof term.effective_from !== "string" ||
    !ISO_DAY.test(term.effective_from) ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    (term.decision_action !== "grant" && term.decision_action !== "revoke") ||
    typeof term.decision_id !== "string" ||
    !UUID.test(term.decision_id) ||
    typeof term.decision_referred_client_id !== "string" ||
    !UUID.test(term.decision_referred_client_id) ||
    !(
      term.expected_term_id === null ||
      (typeof term.expected_term_id === "string" &&
        UUID.test(term.expected_term_id))
    ) ||
    !Number.isInteger(referralCount) ||
    referralCount < 0 ||
    listRate !== 10 ||
    referralStepRate !== 0.5 ||
    !Number.isFinite(referralDiscountRate) ||
    !Number.isFinite(feeRate) ||
    referralDiscountRate !==
      Math.min(listRate, referralStepRate * referralCount) ||
    feeRate !== listRate - referralDiscountRate ||
    typeof term.reason !== "string" ||
    typeof term.reviewed_by !== "string" ||
    typeof term.created_at !== "string" ||
    typeof term.sealed_at !== "string"
  ) {
    return null;
  }

  return {
    id: term.id,
    clientId: term.client_id,
    effectiveFrom: term.effective_from,
    revision,
    decisionId: term.decision_id,
    action: term.decision_action,
    referredClientId: term.decision_referred_client_id,
    expectedTermId: term.expected_term_id ?? null,
    listRate,
    referralStepRate,
    referralCount,
    referralDiscountRate,
    feeRate,
    reason: term.reason,
    reviewedBy: term.reviewed_by,
    createdAt: term.created_at,
    sealedAt: term.sealed_at,
  };
}

/** Schedule one reviewed grant/revoke; rates and evidence are calculated only in SQL. */
export async function POST(request: NextRequest) {
  let decision: ReferralDecision | null;
  try {
    decision = decisionFromBody(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!decision) {
    return NextResponse.json(
      {
        error:
          "Send exactly clientId, referredClientId, action, expectedTermId, decisionId and a non-empty reason.",
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

  // Do not construct the RLS-bypassing client before database-backed admin
  // verification. The browser can never call this RPC or supply commercial
  // rates, counts, evidence rows or the effective date.
  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "Server-side referral scheduling is not configured." },
      { status: 503 },
    );
  }

  const effectiveFrom = referralEffectiveMonday();
  // Database types may lag a not-yet-generated migration during deployment;
  // this local untyped view is restricted to the exact service-only RPC.
  const referralService = service as unknown as SupabaseClient;
  const { data, error } = await referralService.rpc(
    "schedule_manual_referral_discount",
    {
      p_client_id: decision.clientId,
      p_referred_client_id: decision.referredClientId,
      p_action: decision.action,
      p_effective_from: effectiveFrom,
      p_expected_term_id: decision.expectedTermId,
      p_decision_id: decision.decisionId,
      p_reason: decision.reason,
      p_reviewed_by: profile.id,
    },
  );

  if (error) {
    console.error("Manual referral decision failed:", {
      clientId: decision.clientId,
      referredClientId: decision.referredClientId,
      decisionId: decision.decisionId,
      code: error.code,
      message: error.message,
    });

    if (error.code === "40001") {
      return NextResponse.json(
        {
          error:
            "The referral term changed while it was being reviewed. Refresh and review the latest term.",
          code: "stale_term",
        },
        { status: 409 },
      );
    }
    if (
      error.code === "22023" ||
      error.code === "23505" ||
      error.code === "P0001"
    ) {
      return NextResponse.json(
        {
          error:
            error.message ||
            "This referral decision conflicts with current evidence.",
        },
        { status: 409 },
      );
    }
    if (error.code === "42501") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { error: "The referral decision could not be scheduled." },
      { status: 500 },
    );
  }

  const term = serialiseTerm(Array.isArray(data) ? data[0] : null);
  if (!term) {
    console.error("Manual referral RPC returned an incomplete sealed term:", {
      clientId: decision.clientId,
      decisionId: decision.decisionId,
    });
    return NextResponse.json(
      {
        error:
          "The decision was processed, but its sealed receipt was incomplete. Refresh.",
      },
      { status: 500 },
    );
  }

  if (
    term.clientId !== decision.clientId ||
    term.effectiveFrom !== effectiveFrom ||
    term.decisionId !== decision.decisionId ||
    term.action !== decision.action ||
    term.referredClientId !== decision.referredClientId ||
    term.expectedTermId !== decision.expectedTermId ||
    term.reason !== decision.reason ||
    term.reviewedBy !== profile.id
  ) {
    console.error("Manual referral RPC returned mismatched evidence:", {
      clientId: decision.clientId,
      decisionId: decision.decisionId,
      termId: term.id,
    });
    return NextResponse.json(
      {
        error:
          "The decision was processed, but its sealed evidence did not match the review.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, effectiveFrom, term });
}
