import type { Metadata } from "next";
import { Users } from "lucide-react";
import { PageContainer } from "@/components/ui/page-container";
import { ModulePlaceholder } from "@/components/admin/placeholder";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.placeholder.leads.title };
}

export default async function LeadsPage() {
  const { d } = await getServerDictionary();

  return (
    <PageContainer title={d.placeholder.leads.title} description={d.placeholder.leads.subtitle}>
      <ModulePlaceholder
        icon={Users}
        title={d.placeholder.leads.heading}
        description={d.placeholder.leads.description}
        planned={d.placeholder.leads.tags}
        footnote={d.placeholder.notImplemented}
      />
    </PageContainer>
  );
}
