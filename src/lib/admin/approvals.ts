import { createClient } from "@/lib/supabase/server";

export type PendingCounts = {
  clients: number;
  accounts: number;
  requests: number;
  total: number;
};

/**
 * Everything waiting on the team, counted in one place so the notification
 * bell and the sidebar badge can never disagree.
 *
 * Reads ride the admin RLS policies (is_admin()); a non-admin gets zeroes
 * rather than an error, which is what we want for a decorative badge.
 */
export async function fetchPendingCounts(): Promise<PendingCounts> {
  const supabase = await createClient();

  const [clients, accounts, requests] = await Promise.all([
    supabase
      .from("portal_clients")
      .select("id", { count: "exact", head: true })
      .eq("approval_status", "pending"),
    supabase
      .from("ad_accounts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("account_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);

  const counts = {
    clients: clients.count ?? 0,
    accounts: accounts.count ?? 0,
    requests: requests.count ?? 0,
  };

  return { ...counts, total: counts.clients + counts.accounts + counts.requests };
}
