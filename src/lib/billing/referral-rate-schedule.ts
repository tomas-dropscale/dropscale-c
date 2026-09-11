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

  return parsed(data);
}

/** The RPC's projection of a term - and only that, so the parser's shape check holds. */
const SCHEDULE_COLUMNS =
  "effective_from, revision, referral_count, referral_discount_rate, fee_rate";

/**
 * The same schedule, read by an ADMIN for a named client.
 *
 * The RPC answers a member of the client and nobody else, so the agency
 * cannot price a client's fee through it. This reads the sealed terms under
 * the admin's own row-level grant (0030) and reproduces the RPC's projection
 * exactly - the latest sealed revision of each effective date, nothing more -
 * so the same parser and the same rate-of-the-day apply. The caller must
 * already have verified the viewer is an admin; the grant refuses anyone else.
 */
export async function fetchManualReferralRateScheduleAsAdmin(
  clientId: string,
): Promise<ManualReferralRatePoint[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("referral_discount_terms")
    .select(SCHEDULE_COLUMNS)
    .eq("client_id", clientId)
    .not("sealed_at", "is", null)
    .order("effective_from", { ascending: true })
    .order("revision", { ascending: false });

  if (error) {
    throw new Error("Could not load the manual referral rate schedule", { cause: error });
  }

  // `distinct on (effective_from)` over that ordering: the first row of each
  // date is its highest sealed revision.
  const latestByDate = new Map<string, unknown>();
  for (const row of data ?? []) {
    if (!latestByDate.has(row.effective_from)) latestByDate.set(row.effective_from, row);
  }
  return parsed([...latestByDate.values()]);
}

function parsed(data: unknown): ManualReferralRatePoint[] {
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
  return feeEstimateOrNull(() => fetchManualReferralRateSchedule(clientId));
}

/** The admin's read with the same fail-closed fee semantics. */
export async function fetchManualReferralRateScheduleAsAdminOrNull(
  clientId: string,
): Promise<ManualReferralRatePoint[] | null> {
  return feeEstimateOrNull(() => fetchManualReferralRateScheduleAsAdmin(clientId));
}

async function feeEstimateOrNull(
  read: () => Promise<ManualReferralRatePoint[]>,
): Promise<ManualReferralRatePoint[] | null> {
  try {
    return await read();
  } catch (error) {
    console.error(
      "Manual referral rate schedule unavailable; fee estimate suppressed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
