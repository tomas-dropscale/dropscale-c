import "server-only";

import { fetchAccounts } from "@/lib/portal/data";
import { getSessionProfile } from "@/lib/supabase/server";

/**
 * May the person on this request act on this store's supplier settings?
 *
 * Two ways in, and both are legitimate. The store's own people — owner or sócio
 * — because the supplier account is theirs and the costs are their business.
 * The agency's admins, because they set these up alongside the client and are
 * the ones who get asked when it goes wrong.
 *
 * Ownership is decided by fetchAccounts rather than by reading ad_accounts:
 * 0055 hides a shopify_anchor row from its own owner, so a direct read reports
 * a client's own store as belonging to nobody. fetchAccounts is what the portal
 * itself uses to answer "which stores may this viewer see", and it is the only
 * thing that gets a V2 store right.
 */
export async function mayManageStoreSupplier(adAccountId: string): Promise<boolean> {
  const { profile } = await getSessionProfile();
  if (profile?.role === "admin") return true;

  const accounts = await fetchAccounts();
  return accounts.some((account) => account.id === adAccountId);
}
