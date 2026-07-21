import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";

import { fetchAccount, fetchDeliveries } from "@/lib/portal/data";
import { Button } from "@/components/ui/button";
import { CreativesGrid } from "@/components/portal/creatives-grid";
import { PageContainer } from "@/components/ui/page-container";
import { fmt } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.creatives };
}

export default async function CreativesPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;

  const account = await fetchAccount(accountId);
  if (!account) notFound();

  const [deliveries, { d }] = await Promise.all([
    fetchDeliveries(account.id),
    getServerDictionary(),
  ]);

  return (
    <PageContainer
      title={d.portal.creatives}
      description={fmt(d.portal.creativesSubtitle, { store: account.store_name })}
      actions={
        // Placeholder — uploading needs file storage first
        <Button variant="primary" size="sm">
          <Plus />
          {d.portal.newDelivery}
        </Button>
      }
    >
      <CreativesGrid deliveries={deliveries} />
    </PageContainer>
  );
}
