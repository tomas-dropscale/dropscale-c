import { cookies } from "next/headers";

import { createClient, getSessionClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchAccounts } from "@/lib/portal/data";
import { fetchPendingCounts } from "@/lib/admin/approvals";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { PortalShell } from "@/components/portal/portal-shell";

/**
 * Main app shell (sidebar + topbar). Settings lives OUTSIDE this group and
 * brings its own internal sidebar, as in the reference product.
 */
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  // The gate above already guaranteed both of these exist.
  const { client } = await getSessionClient();
  const accounts = await fetchAccounts();

  if (!client) return null; // unreachable; satisfies the type-checker

  // Someone who is BOTH a client and staff-admin gets a link into /admin and
  // keeps the approval bell. Cosmetic only — the /admin gate re-checks the
  // role server-side, and the portal DATA stays scoped to their own account.
  const { profile } = await getSessionProfile();
  const isAdmin = profile?.role === "admin";
  const pending = isAdmin ? await fetchPendingCounts() : null;

  // Onboarding state for the notification bell: the store's setup steps stay in
  // the bell until every one is done. Costs count once a cost exists OR the
  // Costs page has been opened (VisitMarker's cookie).
  const supabase = await createClient();
  const { data: costRows } = await supabase.from("product_costs").select("id").limit(1);
  const cogsVisited = (await cookies()).get("cogs_visited")?.value === "1";
  const setup = {
    needsGoogle: hasGoogleAdsEnv(),
    costsDone: (costRows?.length ?? 0) > 0 || cogsVisited,
  };

  return (
    <PortalShell client={client} accounts={accounts} isAdmin={isAdmin} pending={pending} setup={setup}>
      {children}
    </PortalShell>
  );
}
