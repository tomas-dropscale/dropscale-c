import { redirect } from "next/navigation";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { getSessionClient } from "@/lib/supabase/server";
import { SetupNotice } from "@/components/setup-notice";
import { NotAClient } from "@/components/portal/not-a-client";

/**
 * The portal's security gate. Every /dashboard/* route renders through here.
 *
 * No middleware/proxy on purpose: OpenNext for Cloudflare rejects Node
 * middleware outright (same reason the admin dropped its proxy). This layout
 * plus RLS gives the same guarantee: the layout decides what renders, RLS
 * decides what data can ever leave the database.
 *
 * force-dynamic: without env vars the early return would otherwise let Next
 * statically prerender these pages at build time and freeze them that way.
 */
export const dynamic = "force-dynamic";

export default async function PortalGate({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv()) return <SetupNotice />;

  const { user, client } = await getSessionClient();

  if (!user) redirect("/login");

  // Signed in but not a client (staff account, not yet onboarded, …).
  if (!client) return <NotAClient email={user.email ?? ""} />;

  return <>{children}</>;
}
