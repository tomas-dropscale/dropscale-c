import { redirect } from "next/navigation";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { getSessionProfile } from "@/lib/supabase/server";
import { acceptPendingInvites, getWorkspaceContext } from "@/lib/portal/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { NotAClient } from "@/components/portal/not-a-client";
import { PendingApproval } from "@/components/auth/pending-approval";

/**
 * The portal's security gate. Every /dashboard/* route renders through here.
 *
 * The gate is the layout, not the middleware: this layout decides what renders,
 * RLS decides what data can ever leave the database. src/middleware.ts only
 * refreshes the session cookie before this runs — it grants nothing.
 *
 * Who lands where:
 *   blocked client row           → account-blocked screen (migration 0083)
 *   at least one open workspace   → the portal (regardless of any staff role)
 *   archived client row          → blocked screen
 *   no client row + role 'admin'  → /admin
 *   no client row + role 'member' → staff awaiting approval screen
 *   no client row + no profile    → generic "no client account"
 *
 * The block is checked before the workspace list because it is a decision
 * about the person, not about what they own: a blocked client with a perfectly
 * healthy workspace must still be turned away, and told why.
 *
 * "A workspace" is their own non-archived account OR one they were invited into
 * as a sócio (migration 0015). Pending remains available for audit, but it no
 * longer creates a manual approval hop.
 *
 * Rejected is the durable archive boundary in both this layout and RLS.
 */
export const dynamic = "force-dynamic";

export default async function PortalGate({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv()) return <SetupNotice />;

  // Before deciding anything: a person who was invited as a sócio while signed
  // out becomes a member here, on their first load back. Runs ahead of the
  // context so the workspace list already includes what it just granted.
  await acceptPendingInvites();

  const { user, viewer: client, workspaces } = await getWorkspaceContext();

  if (!user) redirect("/login");

  if (!client) {
    const { profile } = await getSessionProfile();
    if (profile?.role === "admin") redirect("/admin");
    if (profile) return <PendingApproval email={user.email ?? ""} audience="staff" />;
    return <NotAClient email={user.email ?? ""} />;
  }

  // A blocked client keeps their approval, their data and their billing. The
  // only thing they lose is the way in, and they get told so plainly rather
  // than being shown an empty dashboard they cannot explain.
  if (client.access_blocked) {
    return <PendingApproval email={user.email ?? ""} audience="client" blocked />;
  }

  if (workspaces.length === 0) {
    // Staff who are also clients keep their own way in when their client row
    // was archived.
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
