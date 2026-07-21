import { redirect } from "next/navigation";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { getSessionClient, getSessionProfile } from "@/lib/supabase/server";
import { SetupNotice } from "@/components/setup-notice";
import { NotAClient } from "@/components/portal/not-a-client";
import { PendingApproval } from "@/components/auth/pending-approval";

/**
 * The portal's security gate. Every /dashboard/* route renders through here.
 *
 * No middleware/proxy on purpose: OpenNext for Cloudflare rejects Node
 * middleware outright. This layout plus RLS gives the same guarantee: the
 * layout decides what renders, RLS decides what data can ever leave the
 * database.
 *
 * Who lands where:
 *   approved client row           → the portal (regardless of any staff role)
 *   pending/rejected client row   → awaiting-approval screen
 *   no client row + role 'admin'  → /admin
 *   no client row + role 'member' → staff awaiting approval screen
 *   no client row + no profile    → generic "no client account"
 *
 * The approval check here is a courtesy screen, not the boundary — migration
 * 0002 scopes the data itself to approved clients, so someone who skipped
 * this layout would still read nothing.
 */
export const dynamic = "force-dynamic";

export default async function PortalGate({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv()) return <SetupNotice />;

  const { user, client } = await getSessionClient();

  if (!user) redirect("/login");

  if (!client) {
    const { profile } = await getSessionProfile();
    if (profile?.role === "admin") redirect("/admin");
    if (profile) return <PendingApproval email={user.email ?? ""} audience="staff" />;
    return <NotAClient email={user.email ?? ""} />;
  }

  if (client.approval_status !== "approved") {
    // Staff who are also clients keep their own way in, so a pending client
    // row can never lock an admin out of the product entirely.
    const { profile } = await getSessionProfile();
    if (profile?.role === "admin") redirect("/admin");

    return (
      <PendingApproval
        email={user.email ?? ""}
        audience="client"
        rejected={client.approval_status === "rejected"}
      />
    );
  }

  return <>{children}</>;
}
