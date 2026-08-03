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

  const [
    clientsRes,
    profilesRes,
    accountsRes,
    billingStartsRes,
    billingEndsRes,
    requestsRes,
    { profile },
  ] = await Promise.all([
    supabase.from("portal_clients").select("*").order("created_at", { ascending: true }),
    supabase.from("profiles").select("*").order("created_at", { ascending: true }),
    supabase.from("ad_accounts").select("*").order("created_at", { ascending: true }),
    supabase.from("ad_account_billing_starts").select("*"),
    supabase.from("ad_account_billing_ends").select("*"),
    supabase
      .from("account_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    getSessionProfile(),
  ]);

  const allClients = clientsRes.data ?? [];
  const profiles = profilesRes.data ?? [];
  const allAccounts = accountsRes.data ?? [];
  const pendingAccounts = allAccounts.filter((account) => account.status === "pending");
  const pendingRequests = requestsRes.data ?? [];
  const nameById = new Map(allClients.map((client) => [client.id, client.full_name]));
  const billingStartByAccount = new Map(
    (billingStartsRes.data ?? []).map((start) => [start.ad_account_id, start]),
  );
  const billingEndByAccount = new Map(
    (billingEndsRes.data ?? []).map((end) => [end.ad_account_id, end]),
  );
  // Fail closed if the evidence table cannot be read. Treating an empty/error
  // response as "every legacy account is missing" would invite duplicate live
  // captures and turn a database fault into misleading review work.
  const billingStartAuditFailed = Boolean(accountsRes.error || billingStartsRes.error);
  const billingBoundaryAuditFailed = Boolean(
    accountsRes.error || billingStartsRes.error || billingEndsRes.error,
  );
  const untrackedAccounts = billingStartAuditFailed
    ? []
    : allAccounts.filter(
        (account) =>
          (account.status === "active" || account.status === "suspended") &&
          !billingStartByAccount.has(account.id),
      );
  const billingAccounts = billingBoundaryAuditFailed
    ? []
    : allAccounts.flatMap((account) => {
        if (account.status !== "active" && account.status !== "suspended") return [];
        const billingStart = billingStartByAccount.get(account.id);
        if (!billingStart) return [];
        return [
          {
            ...account,
            owner: nameById.get(account.client_id) ?? "Unknown client",
            billingStart,
            billingEnd: billingEndByAccount.get(account.id) ?? null,
          },
        ];
      });

  // Self-registrations get their own section at the top; everyone else —
  // approved or rejected — stays in the main list.
  const pendingClients = allClients.filter((client) => client.approval_status === "pending");
  const clients = allClients.filter((client) => client.approval_status !== "pending");

  const clientIds = new Set(allClients.map((client) => client.id));

  // Who is a sócio of whom (migration 0015). Only used to warn in the approval
  // queue: a self-registration that is really somebody's partner looks like an
  // unknown stranger otherwise, and rejecting it quietly revokes their access
  // to the workspace that invited them.
  const { data: memberships } = await supabase
    .from("client_members")
    .select("client_id, member_id");
  const partnerOf: Record<string, string[]> = {};
  for (const row of memberships ?? []) {
    const ownerName = nameById.get(row.client_id);
    if (!ownerName) continue;
    (partnerOf[row.member_id] ??= []).push(ownerName);
  }

  // Count stores per client for the list badges.
  const accountCount = new Map<string, number>();
  for (const row of allAccounts) {
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
        untrackedAccounts={untrackedAccounts.map((account) => ({
          ...account,
          owner: nameById.get(account.client_id) ?? "Unknown client",
        }))}
        billingStartAuditFailed={billingStartAuditFailed}
        billingAccounts={billingAccounts}
        billingBoundaryAuditFailed={billingBoundaryAuditFailed}
        pendingRequests={pendingRequests.map((request) => ({
          ...request,
          owner: nameById.get(request.client_id) ?? "Unknown client",
        }))}
        partnerOf={partnerOf}
        adminId={profile?.id ?? ""}
      />
    </PageContainer>
  );
}
