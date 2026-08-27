import { createClient } from "@/lib/supabase/server";

export type PendingCounts = {
  clients: number;
  accounts: number;
  requests: number;
  /** Creatives clients handed in that nobody has reviewed (migration 0018). */
  creatives: number;
  total: number;
};

/**
 * Everything waiting on the team, counted in one place so the notification
 * bell and the sidebar badge can never disagree.
 *
 * Reads ride the admin RLS policies (is_admin()); a non-admin gets zeroes
 * rather than an error, which is what we want for a decorative badge.
 *
 * "Pending" means two different things in ad_accounts and only one of them is
 * a notification. A legacy account sits at pending because a person has not
 * approved it yet. A normalized reporting account — the shopify_anchor and
 * google_spend rows the V2 lifecycle provisions — sits at pending because its
 * billing baseline has not started, which no amount of clicking Approve will
 * change; 0055 put it plainly when it hid them from the legacy portal, "a
 * pending Shopify anchor is operational without becoming a legacy pending
 * request". Counting them told the team eight stores needed a decision and
 * sent them to a page with nothing to decide.
 */
const APPROVABLE_ROLE = "legacy_hybrid";

export async function fetchPendingCounts(): Promise<PendingCounts> {
  const supabase = await createClient();

  const [clients, accounts, requests, creatives] = await Promise.all([
    supabase
      .from("portal_clients")
      .select("id", { count: "exact", head: true })
      .eq("approval_status", "pending"),
    supabase
      .from("ad_accounts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("reporting_role", APPROVABLE_ROLE),
    supabase
      .from("account_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("creative_submissions")
      .select("id", { count: "exact", head: true })
      .eq("status", "new"),
  ]);

  const counts = {
    clients: clients.count ?? 0,
    accounts: accounts.count ?? 0,
    requests: requests.count ?? 0,
    creatives: creatives.count ?? 0,
  };

  return {
    ...counts,
    total: counts.clients + counts.accounts + counts.requests + counts.creatives,
  };
}
