import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileBarChart } from "lucide-react";

import { fetchAccount, fetchCampaigns } from "@/lib/portal/data";
import { mockMetrics } from "@/lib/portal/mock";
import { parseRange } from "@/lib/portal/range";
import { dateTime, nextSyncLabel, nowIso } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { MetricsGrid } from "@/components/portal/metric-card";
import { RangePicker } from "@/components/portal/range-picker";
import { SuspendedBanner } from "@/components/portal/suspended-banner";
import { CampaignsTable } from "@/components/portal/campaigns-table";

export const metadata: Metadata = { title: "Store performance" };

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { accountId } = await params;
  const range = parseRange((await searchParams).range);

  // RLS scopes the query to the signed-in client: someone else's accountId
  // (or a junk id) comes back null and 404s without leaking that it exists.
  const account = await fetchAccount(accountId);
  if (!account) notFound();

  const metrics = mockMetrics(account.id, range);
  const campaigns = await fetchCampaigns(account.id, range);

  return (
    <div className="space-y-6">
      {account.status === "suspended" && <SuspendedBanner />}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">
            {account.store_name}
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
            Updated {dateTime(nowIso())} · next update at {nextSyncLabel()}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" className="relative">
            <FileBarChart />
            Report
            {/* New-report indicator */}
            <span className="absolute -top-1 -right-1 size-2 rounded-full bg-[var(--accent-gold)]" />
          </Button>
          <RangePicker current={range} />
        </div>
      </div>

      <MetricsGrid metrics={metrics} currency={account.currency} />

      <CampaignsTable campaigns={campaigns} currency={account.currency} />
    </div>
  );
}
