import type { Metadata } from "next";

import {
  ClientOnboardingManager,
  type LegacyClientSnapshot,
} from "@/components/admin/client-onboarding-manager";
import { PageContainer } from "@/components/ui/page-container";
import {
  listClientOnboardingSessions,
  type ClientOnboardingSessionDTO,
} from "@/lib/client-onboarding/sessions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

/**
 * The V2 workspace lives inside the authenticated admin route group. During
 * transition it may read a deliberately narrow legacy projection for an
 * explicit reconnect, but never mutates or replaces the operational records
 * managed at /admin/clients.
 */
export default async function ClientOnboardingPage() {
  const supabase = await createClient();
  const sessionsPromise: Promise<{
    sessions: ClientOnboardingSessionDTO[];
    failed: boolean;
  }> = listClientOnboardingSessions()
    .then((sessions) => ({ sessions, failed: false }))
    .catch(() => ({ sessions: [], failed: true }));
  const [clientsResult, accountsResult, sessionBundle] = await Promise.all([
    supabase
      .from("portal_clients")
      .select("id, full_name, email, approval_status")
      .order("full_name", { ascending: true }),
    supabase
      .from("ad_accounts")
      .select("id, client_id, shopify_connected, google_ads_connected"),
    sessionsPromise,
  ]);

  const legacyLoadFailed = Boolean(clientsResult.error || accountsResult.error);
  const countsByClient = new Map<
    string,
    { adAccountRows: number; shopifyConnected: number; googleConnected: number }
  >();

  if (!legacyLoadFailed) {
    for (const account of accountsResult.data ?? []) {
      const counts = countsByClient.get(account.client_id) ?? {
        adAccountRows: 0,
        shopifyConnected: 0,
        googleConnected: 0,
      };
      counts.adAccountRows += 1;
      if (account.shopify_connected) counts.shopifyConnected += 1;
      if (account.google_ads_connected) counts.googleConnected += 1;
      countsByClient.set(account.client_id, counts);
    }
  }

  const legacyClients: LegacyClientSnapshot[] = legacyLoadFailed
    ? []
    : (clientsResult.data ?? []).map((client) => ({
        id: client.id,
        fullName: client.full_name,
        email: client.email,
        approvalStatus: client.approval_status,
        ...(countsByClient.get(client.id) ?? {
          adAccountRows: 0,
          shopifyConnected: 0,
          googleConnected: 0,
        }),
      }));

  return (
    <PageContainer
      title="Clients"
      description="Create client-led onboarding links for portal access, Shopify stores and Google Ads accounts."
    >
      <ClientOnboardingManager
        initialSessions={sessionBundle.sessions}
        backendLoadFailed={sessionBundle.failed}
        legacyClients={legacyClients}
        legacyLoadFailed={legacyLoadFailed}
      />
    </PageContainer>
  );
}
