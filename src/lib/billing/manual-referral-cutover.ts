import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Database,
  ManualReferralBillingConfig,
} from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

export type ManualReferralCutoverGate =
  | {
      allowed: true;
      reason: "allowed";
      v3CutoverMonday: string;
    }
  | {
      allowed: false;
      reason: "unavailable" | "missing" | "invalid" | "pre_cutover";
      v3CutoverMonday: string | null;
    };

export type ManualReferralCutoverPreviewBlocker = {
  code: "pre_v3_cutover" | "referral_cutover_unavailable";
  message: string;
  severity: "error";
};

function isIsoMonday(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    date.getUTCDay() === 1
  );
}

/**
 * Resolve the immutable v3 rollout boundary without ever defaulting to 10%.
 * Lexical comparison is exact for the canonical ISO dates enforced here.
 */
export function evaluateManualReferralCutover(
  periodStart: string,
  config: ManualReferralBillingConfig | null,
): ManualReferralCutoverGate {
  if (!config) {
    return {
      allowed: false,
      reason: "missing",
      v3CutoverMonday: null,
    };
  }
  if (config.singleton !== true || !isIsoMonday(config.v3_cutover_monday)) {
    return {
      allowed: false,
      reason: "invalid",
      v3CutoverMonday: null,
    };
  }
  if (!isIsoMonday(periodStart)) {
    return {
      allowed: false,
      reason: "invalid",
      v3CutoverMonday: config.v3_cutover_monday,
    };
  }
  if (periodStart < config.v3_cutover_monday) {
    return {
      allowed: false,
      reason: "pre_cutover",
      v3CutoverMonday: config.v3_cutover_monday,
    };
  }
  return {
    allowed: true,
    reason: "allowed",
    v3CutoverMonday: config.v3_cutover_monday,
  };
}

/** Convert a closed gate into the exact error rendered by the admin preview. */
export function manualReferralCutoverPreviewBlocker(
  gate: ManualReferralCutoverGate,
): ManualReferralCutoverPreviewBlocker | null {
  if (gate.allowed) return null;
  if (gate.reason === "pre_cutover" && gate.v3CutoverMonday) {
    return {
      code: "pre_v3_cutover",
      message: `This week predates the v3 manual-referral billing cutover (${gate.v3CutoverMonday}). Settle it through the reviewed legacy rollover; v3 will not assume the 10% list rate.`,
      severity: "error",
    };
  }
  return {
    code: "referral_cutover_unavailable",
    message:
      "The immutable v3 manual-referral billing cutover could not be verified. Do not issue until the billing configuration is restored and reviewed.",
    severity: "error",
  };
}

/** Load and evaluate the singleton through the same admin Supabase session. */
export async function loadManualReferralCutoverGate(
  supabase: Supabase,
  periodStart: string,
): Promise<ManualReferralCutoverGate> {
  const { data, error } = await supabase
    .from("manual_referral_billing_config")
    .select("singleton, v3_cutover_monday, created_at")
    .eq("singleton", true)
    .maybeSingle();

  if (error) {
    return {
      allowed: false,
      reason: "unavailable",
      v3CutoverMonday: null,
    };
  }
  return evaluateManualReferralCutover(
    periodStart,
    (data as ManualReferralBillingConfig | null) ?? null,
  );
}
