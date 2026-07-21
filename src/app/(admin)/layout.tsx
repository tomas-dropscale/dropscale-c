import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/admin/dashboard-shell";
import { PendingApproval } from "@/components/auth/pending-approval";
import { SetupNotice } from "@/components/setup-notice";
import { getSessionProfile, createClient } from "@/lib/supabase/server";
import { fetchPendingCounts } from "@/lib/admin/approvals";
import { hasSupabaseEnv } from "@/lib/supabase/env";

/**
 * Gate for everything under /admin. Layered with RLS: even if this layout
 * were bypassed entirely, the database refuses to hand non-admins a single
 * finance or board row (admin migration 0004).
 *
 * force-dynamic: authenticated per-user content must never be prerendered.
 */
export const dynamic = "force-dynamic";

export default async function AdminGate({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv()) return <SetupNotice />;

  const { user, profile } = await getSessionProfile();

  if (!user) redirect("/login");

  if (profile?.role !== "admin") {
    // Not staff-admin. If they are a portal client, their home is the portal;
    // otherwise they are staff awaiting approval.
    const supabase = await createClient();
    const { data: client } = await supabase
      .from("portal_clients")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (client) redirect("/dashboard");
    return <PendingApproval email={user.email ?? ""} />;
  }

  const pending = await fetchPendingCounts();

  return (
    <DashboardShell profile={profile} pending={pending}>
      {children}
    </DashboardShell>
  );
}
