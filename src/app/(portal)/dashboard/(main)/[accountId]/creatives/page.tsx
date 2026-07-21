import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";

import { fetchAccount, fetchDeliveries } from "@/lib/portal/data";
import { Button } from "@/components/ui/button";
import { CreativesGrid } from "@/components/portal/creatives-grid";

export const metadata: Metadata = { title: "Creatives" };

export default async function CreativesPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;

  const account = await fetchAccount(accountId);
  if (!account) notFound();

  const deliveries = await fetchDeliveries(account.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">
            Creatives
          </h1>
          <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
            Deliveries for {account.store_name}
          </p>
        </div>

        {/* Placeholder — uploading needs file storage first */}
        <Button variant="primary" size="sm">
          <Plus />
          New Delivery
        </Button>
      </div>

      <CreativesGrid deliveries={deliveries} />
    </div>
  );
}
