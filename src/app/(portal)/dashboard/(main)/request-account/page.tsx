import type { Metadata } from "next";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { RequestAccountPanel } from "@/components/portal/request-account-panel";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.requestAccount };
}

export default async function RequestAccountPage() {
  const [{ active }, { d }] = await Promise.all([getWorkspaceContext(), getServerDictionary()]);
  if (!active) return null; // gate already handled this

  return (
    <PageContainer
      title={d.portal.requestAccount}
      description={d.portal.requestAccountSubtitle}
    >
      <RequestAccountPanel clientId={active.id} />
    </PageContainer>
  );
}
