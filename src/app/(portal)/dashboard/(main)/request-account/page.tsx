import type { Metadata } from "next";
import { getSessionClient } from "@/lib/supabase/server";
import { RequestAccountPanel } from "@/components/portal/request-account-panel";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.requestAccount };
}

export default async function RequestAccountPage() {
  const [{ client }, { d }] = await Promise.all([getSessionClient(), getServerDictionary()]);
  if (!client) return null; // gate already handled this

  return (
    <PageContainer
      title={d.portal.requestAccount}
      description={d.portal.requestAccountSubtitle}
    >
      <RequestAccountPanel clientId={client.id} />
    </PageContainer>
  );
}
