import type { Metadata } from "next";
import { Target } from "lucide-react";
import { PageContainer } from "@/components/ui/page-container";
import { ModulePlaceholder } from "@/components/admin/placeholder";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.placeholder.campaigns.title };
}

export default async function CampaignsPage() {
  const { d } = await getServerDictionary();

  return (
    <PageContainer title={d.placeholder.campaigns.title} description={d.placeholder.campaigns.subtitle}>
      <ModulePlaceholder
        icon={Target}
        title={d.placeholder.campaigns.heading}
        description={d.placeholder.campaigns.description}
        planned={d.placeholder.campaigns.tags}
        footnote={d.placeholder.notImplemented}
      />
    </PageContainer>
  );
}
