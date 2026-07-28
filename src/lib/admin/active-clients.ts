import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * How many clients the agency is actually working for right now.
 *
 * Counted from `ad_accounts`: a distinct client with at least one ACTIVE store.
 * The overview used to count the CRM `clients` table by `status = 'active'`,
 * which this product never writes — the rows come from the sibling admin app —
 * so the card sat at 0 while four clients were live and spending.
 *
 * Staff-admins are excluded on the same principle as everywhere else: their
 * stores are internal, and the agency is not a client of itself.
 */
export async function countActiveClients(
  supabase: SupabaseClient<Database>,
): Promise<number> {
  const [{ data: accounts }, { data: admins }] = await Promise.all([
    supabase.from("ad_accounts").select("client_id").eq("status", "active"),
    supabase.from("profiles").select("id").eq("role", "admin"),
  ]);

  const adminIds = new Set((admins ?? []).map((row) => row.id));
  const clients = new Set(
    (accounts ?? []).map((row) => row.client_id).filter((id) => !adminIds.has(id)),
  );

  return clients.size;
}
