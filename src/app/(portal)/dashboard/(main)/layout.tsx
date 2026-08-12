import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { fetchAccounts } from "@/lib/portal/data";
import { fetchPendingCounts } from "@/lib/admin/approvals";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { legacyAssetActionsBlocked } from "@/lib/portal/client-rollout";
import { PortalShell } from "@/components/portal/portal-shell";

/**
 * Main app shell (sidebar + topbar). Settings lives OUTSIDE this group and
 * brings its own internal sidebar, as in the reference product.
 */
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  // The gate above already guaranteed both of these exist.
  const { viewer, active, workspaces } = await getWorkspaceContext();
  const [accounts, blockLegacyAssetActions] = await Promise.all([
    fetchAccounts(),
    legacyAssetActionsBlocked(),
  ]);

  if (!viewer || !active) return null; // unreachable; satisfies the type-checker

  // Someone who is BOTH a client and staff-admin gets a link into /admin and
  // keeps the approval bell. Cosmetic only — the /admin gate re-checks the
  // role server-side, and the portal DATA stays scoped to their own account.
  const { profile } = await getSessionProfile();
  const isAdmin = profile?.role === "admin";
  const pending = isAdmin ? await fetchPendingCounts() : null;

  // Onboarding state for the notification bell: the store's setup steps stay in
  // the bell until every one is done.
  //
  // Costs count ONLY when this client has actually saved one. It used to also
  // count a "visited the Costs page" cookie, which lives in the browser and
  // knows nothing about which account is signed in — so opening Costs on one
  // Dropscale account marked the step done on every other account in that
  // browser. The answer is the account's, not the browser's.
  //
  // Pinned to THIS workspace's stores rather than left to RLS: since migration
  // 0015 RLS spans every workspace a sócio belongs to, so an unfiltered query
  // would let one client's saved costs tick the step off in another's bell —
  // the same class of bug as the cookie, one level up.
  const supabase = await createClient();
  const accountIds = accounts.map((account) => account.id);
  const { data: costRows } = accountIds.length
    ? await supabase
        .from("product_costs")
        .select("id, store_products!inner(ad_account_id)")
        .in("store_products.ad_account_id", accountIds)
        .limit(1)
    : { data: null };
  const setup = {
    needsGoogle: hasGoogleAdsEnv(),
    costsDone: (costRows?.length ?? 0) > 0,
  };

  return (
    <PortalShell
      viewer={viewer}
      workspace={active}
      workspaces={workspaces}
      accounts={accounts}
      isAdmin={isAdmin}
      pending={pending}
      setup={setup}
      blockLegacyAssetActions={blockLegacyAssetActions}
    >
      {children}
    </PortalShell>
  );
}
