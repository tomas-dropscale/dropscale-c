import type { Metadata } from "next";
import { PackageOpen } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { aggregateMetrics, mockMetrics } from "@/lib/portal/mock";
import { parseRange } from "@/lib/portal/range";
import { dateTime } from "@/lib/format";
import { MetricsGrid } from "@/components/portal/metric-card";
import { RangePicker } from "@/components/portal/range-picker";
import {
  StoreComparisonTable,
  type StoreComparisonRow,
} from "@/components/portal/store-comparison-table";

export const metadata: Metadata = { title: "All Stores" };

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseRange((await searchParams).range);
  const accounts = await fetchAccounts();

  const perAccount = accounts.map((account) => ({
    account,
    metrics: mockMetrics(account.id, range),
  }));
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">
            All Stores
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
            Updated {dateTime(new Date().toISOString())}
          </p>
        </div>
        <RangePicker current={range} />
      </div>

      {accounts.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
          <PackageOpen className="size-8 text-[var(--text-muted)]" />
          <p className="text-[15px] font-medium text-[var(--text-primary)]">
            No stores linked yet
          </p>
          <p className="max-w-[380px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
            Use <span className="text-[var(--text-primary)]">Add Account</span> in the
            sidebar to link an existing Google Ads account, or{" "}
            <span className="text-[var(--text-primary)]">Request Account</span> to have
            the team set one up for you.
          </p>
        </div>
      ) : (
        <>
          <MetricsGrid metrics={totals} currency={accounts[0]?.currency ?? "EUR"} />
          <StoreComparisonTable rows={comparisonRows} />
        </>
      )}
    </div>
  );
}
