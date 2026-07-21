import { getSessionClient } from "@/lib/supabase/server";
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

  return (
    <PortalShell client={client} accounts={accounts}>
      {children}
    </PortalShell>
  );
}
