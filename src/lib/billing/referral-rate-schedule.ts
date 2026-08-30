import "server-only";

import {
  parseManualReferralRateSchedule,
  type ManualReferralRatePoint,
} from "@/lib/billing/referrals";
import { createClient } from "@/lib/supabase/server";

/**
 * Authenticated, RLS-protected read of the portal-safe commercial timeline.
 * The RPC itself verifies membership; this DAL additionally validates and
 * minimizes its response before any page can calculate a displayed fee.
 *
 * Errors are deliberately propagated. Showing the list rate after a failed
 * read could overstate what a referred client owes, while using the mutable
 * `ad_accounts.commission_rate` cache would rewrite history.
 */
export async function fetchManualReferralRateSchedule(
  clientId: string,
): Promise<ManualReferralRatePoint[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("manual_referral_rate_schedule", {
    p_client_id: clientId,
  });

  if (error) {
    throw new Error("Could not load the manual referral rate schedule", { cause: error });
  }

  try {
    return parseManualReferralRateSchedule(data);
  } catch (error) {
    throw new Error("The manual referral rate schedule was invalid", { cause: error });
  }
}

/**
 * The same read for pages whose subject is the client's own revenue and
 * profit, where the referral schedule prices only an auxiliary fee ESTIMATE.
 *
 * Null means "cannot be priced" — never an empty schedule, which would fall
 * back to the list rate and overstate a referred client's fee. Callers must
 * suppress the fee line on null. Fail-closed for the fee, not for the page:
 * a failed fee estimate must never take a client's numbers off the screen.
 */
export async function fetchManualReferralRateScheduleOrNull(
  clientId: string,
): Promise<ManualReferralRatePoint[] | null> {
  try {
    return await fetchManualReferralRateSchedule(clientId);
  } catch (error) {
    console.error(
      "Manual referral rate schedule unavailable; fee estimate suppressed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
