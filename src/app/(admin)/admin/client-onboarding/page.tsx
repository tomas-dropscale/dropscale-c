import type { Metadata } from "next";

import { ClientOnboardingManager } from "@/components/admin/client-onboarding-manager";
import { PageContainer } from "@/components/ui/page-container";
import {
  listExistingClientRoster,
  type ExistingClientRosterDTO,
} from "@/lib/client-onboarding/legacy-roster";
import {
  listClientOnboardingSessions,
  type ClientOnboardingSessionDTO,
} from "@/lib/client-onboarding/sessions";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

/**
 * The V2 workspace lives inside the authenticated admin route group. During
 * transition it may read a deliberately narrow legacy projection for an
 * explicit reconnect, but never mutates or replaces the operational records
 * managed at /admin/clients.
 */
export default async function ClientOnboardingPage() {
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
  const [sessionBundle, rosterBundle] = await Promise.all([
    sessionsPromise,
    rosterPromise,
  ]);

  return (
    <PageContainer
      title="Clients"
      description="Create client-led onboarding links for portal access, Shopify stores and Google Ads accounts."
    >
      <ClientOnboardingManager
        initialSessions={sessionBundle.sessions}
        initialRoster={rosterBundle.roster}
        backendLoadFailed={sessionBundle.failed}
        rosterLoadFailed={rosterBundle.failed}
      />
    </PageContainer>
  );
}
