import type { Metadata } from "next";
import { PackageOpen } from "lucide-react";

import { fetchAccounts, fetchAccountMetrics } from "@/lib/portal/data";
import { aggregateMetrics } from "@/lib/portal/mock";
import { parseRange } from "@/lib/portal/range";
import { dateTime } from "@/lib/format";
import { MetricsGrid } from "@/components/portal/metric-card";
import { PageContainer } from "@/components/ui/page-container";
import { RangePicker } from "@/components/portal/range-picker";
import {
  StoreComparisonTable,
  type StoreComparisonRow,
} from "@/components/portal/store-comparison-table";
import { fmt } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.allStores };
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const range = parseRange(await searchParams);
  const [accounts, { d }] = await Promise.all([fetchAccounts(), getServerDictionary()]);

  // Per-account metrics run in parallel: each may be a live Google Ads call.
  const perAccount = await Promise.all(
    accounts.map(async (account) => ({
      account,
      metrics: await fetchAccountMetrics(account, range),
    })),
  );
  const totals = aggregateMetrics(perAccount.map((entry) => entry.metrics));

  const comparisonRows: StoreComparisonRow[] = perAccount.map(({ account, metrics }) => ({
    accountId: account.id,
    storeName: account.store_name,
    colorDot: account.color_dot,
    currency: account.currency,
    spend: metrics.spend,
    share: totals.spend > 0 ? metrics.spend / totals.spend : 0,
    roas: metrics.roas,
    conversions: metrics.conversions,
    cpa: metrics.costPerConversion,
    ctr: metrics.ctr,
    impressions: metrics.impressions,
    fee: metrics.fee,
  }));

  return (
    <PageContainer
      title={d.portal.allStores}
      description={fmt(d.portal.allStoresSubtitle, {
        time: dateTime(new Date().toISOString()),
      })}
      actions={<RangePicker current={range} />}
    >
      {accounts.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
          <PackageOpen className="size-8 text-[var(--text-muted)]" />
          <p className="text-[15px] font-medium text-[var(--text-primary)]">{d.portal.noStores}</p>
          <p className="max-w-[380px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {fmt(d.portal.noStoresHelp, {
              add: d.portal.addAccount,
              request: d.portal.requestAccount,
            })}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <MetricsGrid metrics={totals} currency={accounts[0]?.currency ?? "EUR"} />
          <StoreComparisonTable rows={comparisonRows} />
        </div>
      )}
    </PageContainer>
  );
}
