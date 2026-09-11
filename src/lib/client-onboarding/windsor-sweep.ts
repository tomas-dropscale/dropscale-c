import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { submitClientOnboardingSessionIfReady } from "@/lib/client-onboarding/sessions";
import type { ClientOnboardingSession, Database } from "@/lib/supabase/types";
import {
  decryptWindsorAccessToken,
  pollLinkedGoogleAdsAccounts,
} from "@/lib/windsor/client";

/**
 * Finish the Google step for clients who finished it everywhere but here.
 *
 * The Google step ends in another tab: the client clicks Finish in Windsor
 * and is supposed to come back and press "Check accounts", which is what asks
 * Windsor which accounts were linked and saves them. Many never come back. The
 * link then sits open with a completed authorization nobody has read, and
 * the admin sees a client who "did not connect Google" when he did.
 *
 * This is the same read the button performs, run for every open link that has
 * a Windsor authorization and no Google connection yet, on the hourly sync.
 * It saves what Windsor reports and closes the link when everything it asked
 * for is there - the one deterministic mapping case included, exactly as the
 * button would. It never guesses a mapping and never touches a link the
 * client did not start.
 */

type Service = SupabaseClient<Database>;

export type WindsorSweepOutcome = {
  /** Open links with a Windsor authorization and no Google connection yet. */
  attempted: number;
  /** Links whose accounts were saved, whether or not the link then closed. */
  connected: number;
  /** Links that closed in this pass. */
  completed: number;
  failed: number;
};

type OpenSessionRow = Pick<
  ClientOnboardingSession,
  | "id"
  | "mode"
  | "requested_assets"
  | "status"
  | "invite_token_hash"
  | "invite_expires_at"
  | "claimed_user_id"
  | "reconnect_completed_at"
>;

export async function finishAbandonedWindsorAuthorizations(
  service: Service,
): Promise<WindsorSweepOutcome> {
  const outcome: WindsorSweepOutcome = { attempted: 0, connected: 0, completed: 0, failed: 0 };

  // Only a link the client can still use: collecting, claimed, unexpired. The
  // same gates the save RPC applies, so nothing is read for a link it would
  // refuse anyway.
  const { data: sessions, error: sessionsError } = await service
    .from("client_onboarding_sessions")
    .select(
      "id, mode, requested_assets, status, invite_token_hash, invite_expires_at, claimed_user_id, reconnect_completed_at",
    )
    .eq("status", "collecting")
    .not("claimed_user_id", "is", null)
    .not("invite_token_hash", "is", null)
    .gt("invite_expires_at", new Date().toISOString())
    .contains("requested_assets", ["google_ads"]);
  if (sessionsError) throw sessionsError;
  const open = (sessions ?? []) as OpenSessionRow[];
  if (open.length === 0) return outcome;

  const sessionIds = open.map((row) => row.id);
  const [secrets, connections] = await Promise.all([
    service
      .from("client_onboarding_secrets")
      .select("session_id, windsor_access_token_ciphertext")
      .in("session_id", sessionIds)
      .not("windsor_access_token_ciphertext", "is", null),
    service
      .from("client_google_ads_connections")
      .select("session_id")
      .in("session_id", sessionIds)
      .eq("status", "connected"),
  ]);
  if (secrets.error) throw secrets.error;
  if (connections.error) throw connections.error;

  const ciphertextBySession = new Map(
    ((secrets.data ?? []) as { session_id: string; windsor_access_token_ciphertext: string }[]).map(
      (row) => [row.session_id, row.windsor_access_token_ciphertext],
    ),
  );
  const alreadyConnected = new Set(
    ((connections.data ?? []) as { session_id: string | null }[]).flatMap((row) =>
      row.session_id ? [row.session_id] : [],
    ),
  );

  for (const session of open) {
    const ciphertext = ciphertextBySession.get(session.id);
    // No authorization started, or the accounts are already saved and the
    // link is open for another reason (a store still missing, a mapping the
    // client must choose): neither is this sweep's to touch.
    if (!ciphertext || alreadyConnected.has(session.id) || !session.invite_token_hash) continue;

    outcome.attempted += 1;
    try {
      const accessToken = await decryptWindsorAccessToken(ciphertext);
      const result = await pollLinkedGoogleAdsAccounts({
        accessToken,
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
      });
      if (result.status !== "connected") continue;

      const { error } = await service.rpc("upsert_client_google_ads_connections", {
        p_session_id: session.id,
        p_token_hash: session.invite_token_hash,
        p_accounts: result.accounts.map((account) => ({
          windsorAccountId: account.accountId,
          accountName: account.accountName ?? account.accountId,
          currency: account.currency?.toUpperCase() ?? null,
          timeZone: account.timeZone,
          dataSourceId: null,
        })),
      });
      if (error) throw error;
      outcome.connected += 1;

      // The button's own closing step, with the link's stored token in place
      // of the one the browser would carry: the RPCs compare the hash, and
      // this IS the hash.
      const completed = await submitClientOnboardingSessionIfReady({
        session: session as ClientOnboardingSession,
        tokenHash: session.invite_token_hash,
        actorUserId: null,
        usingInvitation: true,
      });
      if (completed) outcome.completed += 1;
    } catch (error) {
      outcome.failed += 1;
      console.error(
        `Windsor sweep could not finish onboarding session ${session.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return outcome;
}
