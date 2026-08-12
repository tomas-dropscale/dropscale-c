import type { Metadata } from "next";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { RequestAccountPanel } from "@/components/portal/request-account-panel";
import { ManagedAssetsNotice } from "@/components/portal/managed-assets-notice";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";
import { legacyAssetActionsBlocked } from "@/lib/portal/client-rollout";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.requestAccount };
}

export default async function RequestAccountPage() {
  const [{ active }, { d }, blockLegacyAssetActions] = await Promise.all([
    getWorkspaceContext(),
    getServerDictionary(),
    legacyAssetActionsBlocked(),
  ]);
  if (!active) return null; // gate already handled this

  return (
    <PageContainer
      title={d.portal.requestAccount}
      description={d.portal.requestAccountSubtitle}
    >
      {blockLegacyAssetActions ? (
        <ManagedAssetsNotice />
      ) : (
        <RequestAccountPanel clientId={active.id} />
      )}
    </PageContainer>
  );
}
