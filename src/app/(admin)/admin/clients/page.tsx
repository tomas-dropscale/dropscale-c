import type { Metadata } from "next";
import { PageContainer } from "@/components/ui/page-container";
import { ClientsManager } from "@/components/admin/clients-manager";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { customerHasCard, stripeConfigured } from "@/lib/stripe/client";
import {
  ensureWeeklyInvoices,
  fetchBillingSummaries,
  reconcileInvoices,
} from "@/lib/billing/invoices";

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
  const { data: allAccounts } = await supabase.from("ad_accounts").select("client_id");
  const accountCount = new Map<string, number>();
  for (const row of allAccounts ?? []) {
    accountCount.set(row.client_id, (accountCount.get(row.client_id) ?? 0) + 1);
  }

  // Billing state per client. Generation and reconciliation run first, exactly
  // like the ledgers: opening this tab is what makes Monday's invoices exist.
  await ensureWeeklyInvoices();
  await reconcileInvoices();
  const billing = await fetchBillingSummaries();

  /**
   * Who will be charged on Monday, and who will merely be emailed a link.
   *
   * Asked of Stripe directly rather than cached in a column: a card can be
   * added or removed on Stripe's side at any moment, and a stale "will auto
   * charge" here is the kind of wrong that only shows up as an unpaid invoice
   * a week later. One GET per client with a Stripe customer, in parallel —
   * fine at agency scale, worth revisiting past a few hundred clients.
   */
  const withCustomer = clients.filter((client) => client.stripe_customer_id);
  const cardChecks = stripeConfigured()
    ? await Promise.all(
        withCustomer.map(async (client) => [
          client.id,
          await customerHasCard(client.stripe_customer_id!),
        ] as const),
      )
    : [];
  const hasCard = new Map(cardChecks);

  return (
    <PageContainer
      title="Clients"
      description="Portal access, pending stores and account requests."
    >
      <ClientsManager
        clients={clients.map((client) => ({
          ...client,
          accounts: accountCount.get(client.id) ?? 0,
          billing: billing.get(client.id) ?? null,
          hasCard: hasCard.get(client.id) ?? false,
        }))}
        stripeReady={stripeConfigured()}
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
        partnerOf={partnerOf}
        adminId={profile?.id ?? ""}
      />
    </PageContainer>
  );
}
