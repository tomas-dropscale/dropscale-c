import type { Metadata } from "next";
import Link from "next/link";
import { BadgePercent } from "lucide-react";

import { ClientOnboardingManager } from "@/components/admin/client-onboarding-manager";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import {
  listAdminCommissionClients,
  type AdminCommissionClient,
} from "@/lib/admin/client-commissions";
import {
  listExistingClientRoster,
  type ExistingClientRosterDTO,
} from "@/lib/client-onboarding/legacy-roster";
import {
  listClientOnboardingSessions,
  type ClientOnboardingSessionDTO,
} from "@/lib/client-onboarding/sessions";
import { getSessionProfile } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

/** Client roster and onboarding remain primary; commercial terms stay inside each client. */
export default async function AdminClientsPage() {
  const sessionsPromise: Promise<{
    sessions: ClientOnboardingSessionDTO[];
    failed: boolean;
  }> = listClientOnboardingSessions()
    .then((sessions) => ({ sessions, failed: false }))
    .catch(() => ({ sessions: [], failed: true }));
  const rosterPromise: Promise<{
    roster: ExistingClientRosterDTO[];
    failed: boolean;
  }> = listExistingClientRoster()
    .then((roster) => ({ roster, failed: false }))
    .catch(() => ({ roster: [], failed: true }));
  const commissionsPromise: Promise<{
    clients: AdminCommissionClient[];
    failed: boolean;
  }> = listAdminCommissionClients()
    .then((clients) => ({ clients, failed: false }))
    .catch(() => ({ clients: [], failed: true }));

  const [sessionBundle, rosterBundle, commissionBundle, { profile }] = await Promise.all([
    sessionsPromise,
    rosterPromise,
    commissionsPromise,
    getSessionProfile(),
  ]);

  return (
    <PageContainer
      title="Clients"
      description="Create client-led onboarding links for portal access, Shopify stores and Google Ads accounts."
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link href="/admin/referrals">
            <BadgePercent aria-hidden />
            Referrals
          </Link>
        </Button>
      }
    >
      <ClientOnboardingManager
        initialSessions={sessionBundle.sessions}
        initialRoster={rosterBundle.roster}
        backendLoadFailed={sessionBundle.failed}
        rosterLoadFailed={rosterBundle.failed}
        initialCommissionClients={commissionBundle.clients}
        commissionLoadFailed={commissionBundle.failed}
        adminId={profile?.id ?? ""}
      />
    </PageContainer>
  );
}
