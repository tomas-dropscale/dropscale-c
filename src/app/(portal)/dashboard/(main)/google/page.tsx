import type { Metadata } from "next";
import { PackageOpen } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import {
  combineMetricSets,
  fetchDailyMetrics,
  freshness,
  groupByAccount,
  metricSetFromRows,
} from "@/lib/metrics/queries";
import { parseRange } from "@/lib/portal/range";
import { dateTime, multiplier } from "@/lib/format";
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
  return { title: `Google · ${d.portal.allStores}` };
}

/**
 * Google section, all stores: the 10-metric grid plus the store-comparison
 * table. Reads only daily_metrics; the sync runs before the read.
 */
export default async function GoogleAllStoresPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const range = parseRange(await searchParams);
  const [accounts, { d }] = await Promise.all([fetchAccounts(), getServerDictionary()]);

  await ensureDailyCoverage(accounts, range.from);
  await recomputeDailyMetrics(accounts);

  const rows = await fetchDailyMetrics(
    accounts.map((account) => account.id),
    range.from,
    range.to,
  );
  const byAccount = groupByAccount(rows);
  const { updatedAt } = freshness(rows);

  const perAccount = accounts.map((account) => ({
    account,
    metrics: metricSetFromRows(byAccount.get(account.id) ?? [], Number(account.commission_rate)),
  }));
  const totals = combineMetricSets(perAccount.map((entry) => entry.metrics));

  // One fee percentage is only honest when every store bills at the same rate.
  const rates = new Set(accounts.map((account) => Number(account.commission_rate)));
  const uniformFeeRate = rates.size === 1 ? [...rates][0] : null;

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
      description={
        updatedAt
          ? fmt(d.portal.allStoresSubtitle, { time: dateTime(updatedAt) })
          : d.portal.noData
      }
      actions={
        <RangePicker
          current={range}
          footer={`${d.portal.roasTotal}: ${multiplier(totals.roas)}`}
        />
      }
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
          <MetricsGrid
            metrics={totals}
            currency={accounts[0]?.currency ?? "EUR"}
            feeRate={uniformFeeRate}
          />
          <StoreComparisonTable rows={comparisonRows} />
        </div>
      )}
    </PageContainer>
  );
}
