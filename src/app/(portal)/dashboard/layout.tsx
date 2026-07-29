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
 * No middleware/proxy on purpose: OpenNext for Cloudflare rejects Node
 * middleware outright. This layout plus RLS gives the same guarantee: the
 * layout decides what renders, RLS decides what data can ever leave the
 * database.
 *
 * Who lands where:
 *   at least one open workspace   → the portal (regardless of any staff role)
 *   client row but no workspace   → awaiting-approval screen
 *   no client row + role 'admin'  → /admin
 *   no client row + role 'member' → staff awaiting approval screen
 *   no client row + no profile    → generic "no client account"
 *
 * "A workspace" is their own approved account OR one they were invited into as
 * a sócio (migration 0015) — which is why the check is no longer "is my own row
 * approved": a sócio's own row is usually untouched and pending forever, and
 * that must not keep them out of the workspace that invited them.
 *
 * The approval check here is a courtesy screen, not the boundary — migrations
 * 0002/0015 scope the data itself to approved workspaces, so someone who
 * skipped this layout would still read nothing.
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

  if (workspaces.length === 0) {
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
