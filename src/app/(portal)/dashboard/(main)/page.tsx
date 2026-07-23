import type { Metadata } from "next";
import { PackageOpen, Database } from "lucide-react";
import {
  BadgeDollarSign,
  Coins,
  Crosshair,
  MousePointerClick,
  Percent,
  ShoppingBag,
  TrendingUp,
  Undo2,
  Wallet,
} from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { ConnectAdsBanner } from "@/components/portal/connect-ads-banner";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import {
  fetchDailyMetrics,
  freshness,
  groupByAccount,
  groupByDay,
  sumMetrics,
} from "@/lib/metrics/queries";
import { parseRange } from "@/lib/portal/range";
import { compact, dateTime, integer, money, multiplier, percent } from "@/lib/format";
import { MetricCard } from "@/components/portal/metric-card";
import { DailyPerformanceChart, type ChartDay } from "@/components/portal/daily-performance-chart";
import { PageContainer } from "@/components/ui/page-container";
import { RangePicker } from "@/components/portal/range-picker";
import { StoreSelector } from "@/components/portal/store-selector";
import { fmt } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.dashboard };
}

/**
 * The client's home: RevFlow-style revenue/profit overview. Reads ONLY the
 * pre-aggregated daily_metrics — the sync paths (recompute + coverage
 * backfill) are the sole callers of Google/Shopify, and they run before the
 * read, throttled, riding this viewer's session.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; store?: string }>;
}) {
  const params = await searchParams;
  const range = parseRange(params);
  const [accounts, { d }] = await Promise.all([fetchAccounts(), getServerDictionary()]);

  // Coverage first so the recompute's freshness check sees its rows and
  // skips the overlap; both are per-account no-ops on a warm cache.
  await ensureDailyCoverage(accounts, range.from);
  await recomputeDailyMetrics(accounts);

  const selectedStore =
    typeof params.store === "string" && accounts.some((account) => account.id === params.store)
      ? params.store
      : null;
  const visible = selectedStore
    ? accounts.filter((account) => account.id === selectedStore)
    : accounts;

  const rows = await fetchDailyMetrics(
    visible.map((account) => account.id),
    range.from,
    range.to,
  );

  const totals = sumMetrics(rows);
  const { updatedAt } = freshness(rows);
  const currency = visible[0]?.currency ?? "EUR";

  // Fee respects each account's own commission_rate.
  const rateById = new Map(accounts.map((account) => [account.id, Number(account.commission_rate)]));
  let fee = 0;
  for (const [accountId, accountRows] of groupByAccount(rows)) {
    const spend = accountRows.reduce((sum, row) => sum + Number(row.ad_spend), 0);
    fee += (spend * (rateById.get(accountId) ?? 0)) / 100;
  }
  const netProfit = totals.grossProfit - fee;
  const totalCosts = totals.adSpend + fee + totals.refunds;

  const chartDays: ChartDay[] = [...groupByDay(rows)]
    .map(([day, dayRows]) => {
      const daySums = sumMetrics(dayRows);
      return {
        day,
        revenue: daySums.netRevenue,
        adSpend: daySums.adSpend,
        profit: daySums.grossProfit,
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  return (
    <PageContainer
      title={d.portal.dashboard}
      description={
        updatedAt
          ? fmt(d.portal.allStoresSubtitle, { time: dateTime(updatedAt) })
          : d.portal.noData
      }
      actions={
        <>
          <StoreSelector accounts={accounts} current={selectedStore} />
          <RangePicker
            current={range}
            footer={`${d.portal.roasTotal}: ${multiplier(totals.roas)}`}
          />
        </>
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
        <div className="space-y-4">
          {/* Real zeroes beat a blank page: the dashboard always renders, and
              a missing connection explains itself instead of hiding it. */}
          {hasGoogleAdsEnv() &&
            visible.some((account) => !account.google_ads_connected) && <ConnectAdsBanner />}

          {rows.length === 0 && (
            <div className="panel flex items-center gap-3 px-4 py-3.5">
              <Database className="size-4 shrink-0 text-[var(--text-muted)]" />
              <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                {d.portal.noData} — {d.portal.noDataHelp}
              </p>
            </div>
          )}

          {/* Hero — the client's money, RevFlow-style: rev/profit lead. */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard
              label="Revenue"
              icon={BadgeDollarSign}
              value={money(totals.netRevenue, currency)}
              hint={`${integer(totals.orders)} orders`}
              glow
              highlight
            />
            <MetricCard
              label="Net Profit"
              icon={TrendingUp}
              value={money(netProfit, currency)}
              hint="after ad spend, fee & refunds"
            />
            <MetricCard
              label="Ad Spend"
              icon={Wallet}
              value={money(totals.adSpend, currency)}
              hint={`${compact(totals.impressions)} impressions`}
            />
            <MetricCard
              label="ROAS"
              icon={Crosshair}
              value={multiplier(totals.roas)}
              hint={`MER ${multiplier(totals.mer)}`}
            />
          </div>

          {/* Efficiency row */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="MER" icon={Percent} value={multiplier(totals.mer)} />
            <MetricCard label="AOV" icon={ShoppingBag} value={money(totals.aov, currency)} />
            <MetricCard
              label="Cost / Conversion"
              icon={Coins}
              value={money(totals.costPerConversion, currency)}
            />
            <MetricCard
              label="Conversion Rate"
              icon={MousePointerClick}
              value={percent(totals.conversionRate)}
            />
            <MetricCard label="Orders" icon={ShoppingBag} value={integer(totals.orders)} />
            <MetricCard
              label="Refunds"
              icon={Undo2}
              value={money(totals.refunds, currency)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_300px]">
            <DailyPerformanceChart days={chartDays} currency={currency} />

            {/* Cost breakdown — where the revenue went. */}
            <section className="panel flex flex-col p-5">
              <h2 className="mb-4 text-[15px] font-semibold text-[var(--text-primary)]">
                Cost breakdown
              </h2>
              <dl className="space-y-3 text-[13px]">
                {(
                  [
                    ["Ad spend", totals.adSpend],
                    ["Dropscale fee", fee],
                    ["Refunds", totals.refunds],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3">
                    <dt className="text-[var(--text-secondary)]">{label}</dt>
                    <dd className="font-medium whitespace-nowrap text-[var(--text-primary)]">
                      {money(value, currency)}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 space-y-3 border-t border-[var(--border-subtle)] pt-3 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--text-secondary)]">Total costs</span>
                  <span className="font-medium whitespace-nowrap text-[var(--text-primary)]">
                    {money(totalCosts, currency)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--text-secondary)]">Net profit</span>
                  <span
                    className={
                      netProfit >= 0
                        ? "font-semibold whitespace-nowrap text-[var(--success-green)]"
                        : "font-semibold whitespace-nowrap text-[var(--danger-red)]"
                    }
                  >
                    {money(netProfit, currency)}
                  </span>
                </div>
                <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  Margin{" "}
                  {totals.netRevenue > 0 ? percent(netProfit / totals.netRevenue) : "—"} of
                  net revenue.
                </p>
              </div>
            </section>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
