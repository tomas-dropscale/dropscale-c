import { getSessionClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchAccounts } from "@/lib/portal/data";
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

  // Someone who is BOTH a client and staff-admin gets a link into /admin.
  // Cosmetic only — the /admin gate re-checks the role server-side.
  const { profile } = await getSessionProfile();

  return (
    <PortalShell client={client} accounts={accounts} isAdmin={profile?.role === "admin"}>
      {children}
    </PortalShell>
  );
}
