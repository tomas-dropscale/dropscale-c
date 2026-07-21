import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { PageContainer } from "@/components/ui/page-container";
import { ModulePlaceholder } from "@/components/admin/placeholder";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.placeholder.analytics.title };
}

export default async function AnalyticsPage() {
  const { d } = await getServerDictionary();

  return (
    <PageContainer title={d.placeholder.analytics.title} description={d.placeholder.analytics.subtitle}>
      <ModulePlaceholder
        icon={BarChart3}
        title={d.placeholder.analytics.heading}
        description={d.placeholder.analytics.description}
        planned={d.placeholder.analytics.tags}
        footnote={d.placeholder.notImplemented}
      />
    </PageContainer>
  );
}
