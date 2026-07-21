import type { Metadata } from "next";
import { PageContainer } from "@/components/ui/page-container";
import { ClientsManager } from "@/components/admin/clients-manager";
import { createClient, getSessionProfile } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Clients" };

/**
 * Portal-client management: who can sign in, what is waiting for approval.
 * All reads ride the admin RLS policies (is_admin()) — nothing here would
 * return rows for a non-admin even if the layout gate were bypassed.
 */
export default async function ClientsPage() {
  const supabase = await createClient();

  const [clientsRes, profilesRes, accountsRes, requestsRes, { profile }] = await Promise.all([
    supabase.from("portal_clients").select("*").order("created_at", { ascending: true }),
    supabase.from("profiles").select("*").order("created_at", { ascending: true }),
    supabase
      .from("ad_accounts")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("account_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    getSessionProfile(),
  ]);

  const allClients = clientsRes.data ?? [];
  const profiles = profilesRes.data ?? [];
  const pendingAccounts = accountsRes.data ?? [];
  const pendingRequests = requestsRes.data ?? [];

  // Self-registrations get their own section at the top; everyone else —
  // approved or rejected — stays in the main list.
  const pendingClients = allClients.filter((client) => client.approval_status === "pending");
  const clients = allClients.filter((client) => client.approval_status !== "pending");

  const clientIds = new Set(allClients.map((client) => client.id));
  const nameById = new Map(allClients.map((client) => [client.id, client.full_name]));

  // Count stores per client for the list badges.
  const { data: allAccounts } = await supabase.from("ad_accounts").select("client_id");
  const accountCount = new Map<string, number>();
  for (const row of allAccounts ?? []) {
    accountCount.set(row.client_id, (accountCount.get(row.client_id) ?? 0) + 1);
  }

  return (
    <PageContainer
      title="Clients"
      description="Portal access, pending stores and account requests."
    >
      <ClientsManager
        clients={clients.map((client) => ({
          ...client,
          accounts: accountCount.get(client.id) ?? 0,
        }))}
        pendingClients={pendingClients}
        candidates={profiles.filter((profile) => !clientIds.has(profile.id))}
        pendingAccounts={pendingAccounts.map((account) => ({
          ...account,
          owner: nameById.get(account.client_id) ?? "Unknown client",
        }))}
        pendingRequests={pendingRequests.map((request) => ({
          ...request,
          owner: nameById.get(request.client_id) ?? "Unknown client",
        }))}
        adminId={profile?.id ?? ""}
      />
    </PageContainer>
  );
}
