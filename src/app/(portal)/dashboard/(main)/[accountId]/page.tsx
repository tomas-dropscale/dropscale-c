import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileBarChart } from "lucide-react";

import { fetchAccount, fetchAccountMetrics, fetchCampaigns } from "@/lib/portal/data";
import { parseRange } from "@/lib/portal/range";
import { dateTime, nextSyncLabel, nowIso } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { MetricsGrid } from "@/components/portal/metric-card";
import { RangePicker } from "@/components/portal/range-picker";
import { SuspendedBanner } from "@/components/portal/suspended-banner";
import { ConnectAdsBanner } from "@/components/portal/connect-ads-banner";
import { CampaignsTable } from "@/components/portal/campaigns-table";
import { PageContainer } from "@/components/ui/page-container";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fmt } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";

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

  const [metrics, campaigns, { d }] = await Promise.all([
    fetchAccountMetrics(account, range),
    fetchCampaigns(account, range),
    getServerDictionary(),
  ]);

  return (
    <PageContainer
      title={account.store_name}
      description={fmt(d.portal.storeSubtitle, {
        time: dateTime(nowIso()),
        next: nextSyncLabel(),
      })}
      actions={
        <>
          <Button variant="secondary" size="sm" className="relative">
            <FileBarChart />
            {d.portal.report}
            {/* New-report indicator */}
            <span className="absolute -top-1 -right-1 size-2 rounded-full bg-[var(--accent-gold)]" />
          </Button>
          <RangePicker current={range} />
        </>
      }
    >
      <div className="space-y-6">
        {account.status === "suspended" && <SuspendedBanner />}
        {hasGoogleAdsEnv() && !account.google_ads_connected && <ConnectAdsBanner />}

        <MetricsGrid metrics={metrics} currency={account.currency} />

        <CampaignsTable campaigns={campaigns} currency={account.currency} />
      </div>
    </PageContainer>
  );
}
