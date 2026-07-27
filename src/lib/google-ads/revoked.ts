import type { SupabaseClient } from "@supabase/supabase-js";

import { GoogleAuthRevokedError } from "@/lib/google-ads/client";
import type { Database } from "@/lib/supabase/types";

/**
 * Record a Google authorisation that can no longer be used.
 *
 * Four separate readers call Google (admin campaigns, the commission ledger,
 * the metrics recompute and the client's own portal), each with its own catch.
 * They all need the same reaction to `invalid_grant`, and getting it wrong is
 * invisible: the store keeps reporting "connected", every sync keeps failing,
 * and only the server log says why. So the reaction lives here, once.
 *
 * Flipping `google_ads_connected` to false is what makes the portal show the
 * "Connect Google Ads" button again — the client is the only one who can fix
 * this, so the fix has to be put back in front of them.
 *
 * Returns whether it handled the error, so callers can tell a permanent
 * authorisation failure from a transient one worth retrying.
 */
export async function markIfAuthRevoked(
  supabase: SupabaseClient<Database>,
  accountId: string,
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof GoogleAuthRevokedError)) return false;

  console.error(`Google authorisation revoked for ${accountId}; marking disconnected.`);
  await supabase
    .from("ad_accounts")
    .update({ google_ads_connected: false })
    .eq("id", accountId);

  return true;
}
