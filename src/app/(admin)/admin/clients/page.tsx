import type { Metadata } from "next";

import { ClientsManager } from "@/components/admin/clients-manager";
import { PageContainer } from "@/components/ui/page-container";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import type {
  AccountRequest,
  AdAccount,
  AdAccountBillingEnd,
  AdAccountBillingStart,
  Client,
  Profile,
} from "@/lib/supabase/types";

export const metadata: Metadata = { title: "Clients (Legacy)" };

/**
 * Portal-client management: who can sign in, what is waiting for approval.
 * All reads ride the admin RLS policies (is_admin()) — nothing here would
 * return rows for a non-admin even if the layout gate were bypassed.
 *
 * This route stays operational during the V2 onboarding transition. Billing,
 * approvals and existing client assets continue to be managed here until an
 * explicit cutover moves each client to the new workflow.
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
    supabase
      .from("portal_clients")
      .select(
        "id, full_name, email, avatar_url, crm_client_id, approval_status, approved_at, approved_by, created_at, stripe_customer_id, referral_code, referred_by",
      )
      .order("created_at", { ascending: true }),
    supabase
      .from("profiles")
      .select("id, full_name, email, avatar_url, role, created_at")
      .order("created_at", { ascending: true }),
    supabase
      .from("ad_accounts")
      .select(
        "id, client_id, store_name, google_ads_customer_id, status, currency, breakeven_roas, lifetime_ads_budget_usd, shopify_url, shopify_connected, shopify_client_id, shopify_scopes, color_dot, created_at, google_ads_connected_email, google_ads_connected, commission_rate, list_commission_rate, shopify_token_last4, shopify_connected_at, default_product_cost_pct, payment_fee_pct, payment_fee_fixed, shipping_cost_per_order, revenue_share_enabled",
      )
      .order("created_at", { ascending: true }),
    supabase
      .from("ad_account_billing_starts")
      .select(
        "id, ad_account_id, google_ads_customer_id, google_local_date, google_time_zone, currency, baseline_cost_micros, capture_started_at, captured_at, capture_id, source, reviewed_by, created_at",
      ),
    supabase
      .from("ad_account_billing_ends")
      .select(
        "id, ad_account_id, billing_start_id, google_ads_customer_id, google_local_date, google_time_zone, currency, end_cost_micros, capture_started_at, captured_at, capture_id, source, reviewed_by, created_at",
      ),
    supabase
      .from("account_requests")
      .select(
        "id, client_id, request_type, google_ads_customer_id, store_name, shopify_collaborator_code, myshopify_url, status, created_at",
      )
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    getSessionProfile(),
  ]);

  const allClients = (clientsRes.data ?? []) as Client[];
  const profiles = (profilesRes.data ?? []) as Profile[];
  // Keep both encrypted legacy credential columns server-side. ClientsManager
  // needs the historic row shape, but never the ciphertext.
  const allAccounts = (accountsRes.data ?? []).map(
    (account) =>
      ({
        ...account,
        google_ads_refresh_token: null,
        shopify_admin_token: null,
      }) satisfies AdAccount,
  );
  // Internal/admin-owned stores are useful for operations and testing, but are
  // deliberately outside the agency billing contract and its Google boundary UI.
  const adminIds = new Set(
    profiles.filter((profile) => profile.role === "admin").map((profile) => profile.id),
  );
  const pendingAccounts = allAccounts.filter((account) => account.status === "pending");
  const pendingRequests = (requestsRes.data ?? []) as AccountRequest[];
  const nameById = new Map(allClients.map((client) => [client.id, client.full_name]));
  const billingStartByAccount = new Map(
    ((billingStartsRes.data ?? []) as AdAccountBillingStart[]).map((start) => [
      start.ad_account_id,
      start,
    ]),
  );
  const billingEndByAccount = new Map(
    ((billingEndsRes.data ?? []) as AdAccountBillingEnd[]).map((end) => [
      end.ad_account_id,
      end,
    ]),
  );
  // Fail closed if the evidence table cannot be read. Treating an empty/error
  // response as "every legacy account is missing" would invite duplicate live
  // captures and turn a database fault into misleading review work.
  const billingStartAuditFailed = Boolean(
    accountsRes.error || profilesRes.error || billingStartsRes.error,
  );
  const billingBoundaryAuditFailed = Boolean(
    accountsRes.error || profilesRes.error || billingStartsRes.error || billingEndsRes.error,
  );
  const untrackedAccounts = billingStartAuditFailed
    ? []
    : allAccounts.filter(
        (account) =>
          (account.status === "active" || account.status === "suspended") &&
          !adminIds.has(account.client_id) &&
          !billingStartByAccount.has(account.id),
      );
  const billingAccounts = billingBoundaryAuditFailed
    ? []
    : allAccounts.flatMap((account) => {
        if (account.status !== "active" && account.status !== "suspended") return [];
        if (adminIds.has(account.client_id)) return [];
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
      title="Clients (Legacy)"
      description="Portal access, billing boundaries, pending stores and account requests."
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
