import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Info, PackageOpen, Database } from "lucide-react";
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
import { createClient } from "@/lib/supabase/server";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { GettingStartedGuide } from "@/components/portal/getting-started-guide";
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
import { RefreshButton } from "@/components/portal/refresh-button";
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

  // Setup state drives the first-run guide. It does NOT vanish after the first
  // connection: it stays, ticking each step off, until EVERY applicable step is
  // done. Every check below reads THIS client's own rows (RLS scopes them), so
  // the guide can only ever describe the account you're signed into.
  const googleConnected = visible.some((account) => account.google_ads_connected);
  const shopifyConnected = visible.some((account) => account.shopify_connected);

  const supabase = await createClient();

  // Products of the visible stores, and how many still have NO cost (no manual
  // cost and not in a bundle) — those fall back to the default percentage.
  const { data: productRows } =
    visible.length > 0
      ? await supabase.from("store_products").select("id").in("ad_account_id", visible.map((a) => a.id))
      : { data: [] as { id: string }[] };
  const products = productRows ?? [];

  let uncostedCount = 0;
  let hasAnyCost = false;
  if (products.length > 0) {
    const productIds = products.map((product) => product.id);
    const [costsRes, membersRes] = await Promise.all([
      supabase.from("product_costs").select("product_id").in("product_id", productIds),
      supabase.from("cogs_collection_members").select("product_id").in("product_id", productIds),
    ]);
    const costed = new Set<string>();
    for (const row of costsRes.data ?? []) costed.add(row.product_id);
    for (const row of membersRes.data ?? []) costed.add(row.product_id);
    hasAnyCost = (costsRes.data ?? []).length > 0;
    uncostedCount = products.filter((product) => !costed.has(product.id)).length;
  }

  // The costs step is done when THIS client has real costs: either a saved
  // product cost, or every synced product covered by a bundle. It used to also
  // accept a "visited the Costs page" cookie, but a cookie belongs to the
  // browser, not to the account — visiting Costs on one Dropscale account
  // ticked the step off on every other account signed in from that browser,
  // and reported costs that were never set.
  const costsDone = hasAnyCost || (products.length > 0 && uncostedCount === 0);

  const needsGoogle = hasGoogleAdsEnv();
  const setupComplete =
    accounts.length > 0 &&
    (needsGoogle ? googleConnected : true) &&
    shopifyConnected &&
    costsDone;

  // Fee respects each account's own commission_rate.
  const rateById = new Map(accounts.map((account) => [account.id, Number(account.commission_rate)]));
  let fee = 0;
  for (const [accountId, accountRows] of groupByAccount(rows)) {
    const spend = accountRows.reduce((sum, row) => sum + Number(row.ad_spend), 0);
    fee += (spend * (rateById.get(accountId) ?? 0)) / 100;
  }
  // The full chain (spec: COGS moves PROFIT, never revenue):
  // net − COGS − payment fees − shipping − ad spend − Dropscale fee.
  const netProfit = totals.profit - fee;
  const totalCosts =
    totals.adSpend + totals.productCost + totals.paymentFees + totals.shippingCost + fee;

  const chartDays: ChartDay[] = [...groupByDay(rows)]
    .map(([day, dayRows]) => {
      const daySums = sumMetrics(dayRows);
      const dayFee = dayRows.reduce(
        (sum, row) => sum + (Number(row.ad_spend) * (rateById.get(row.ad_account_id) ?? 0)) / 100,
        0,
      );
      return {
        day,
        revenue: daySums.netRevenue,
        adSpend: daySums.adSpend,
        profit: daySums.profit - dayFee,
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
          {accounts.length > 0 && <RefreshButton accountIds={visible.map((account) => account.id)} />}
          <StoreSelector accounts={accounts} current={selectedStore} />
          <RangePicker
            current={range}
            footer={`${d.portal.roasTotal}: ${multiplier(totals.roas)}`}
          />
        </>
      }
    >
      {accounts.length === 0 ? (
        /* No stores yet is the FIRST onboarding state, not an empty page: the
           guide is what someone landing here needs, and it already knows how
           to walk them from "no store" to Shopify, ads and costs. */
        <div className="space-y-4">
          <GettingStartedGuide accounts={[]} costsSet={costsDone} showGoogle={needsGoogle} />

          <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center">
            <PackageOpen className="size-7 text-[var(--text-muted)]" />
            <p className="text-[14px] font-medium text-[var(--text-primary)]">
              {d.portal.noStores}
            </p>
            <p className="max-w-[380px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {fmt(d.portal.noStoresHelp, {
                add: d.portal.addAccount,
                request: d.portal.requestAccount,
              })}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* While any product has no cost, nudge — those sales use the default
              percentage, so profit isn't exact until they're filled in. */}
          {uncostedCount > 0 && (
            <Link
              href="/dashboard/costs"
              className="transition-smooth flex items-center gap-3 rounded-[var(--radius-card)] border border-[#5b93d6]/30 bg-[#5b93d6]/12 px-4 py-3.5 hover:border-[#5b93d6]/55"
            >
              <Info className="size-4 shrink-0 text-[#7db0ea]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-[var(--text-primary)]">
                  {uncostedCount} {uncostedCount === 1 ? "product has" : "products have"} no cost set
                </span>
                <span className="block text-[12.5px] text-[var(--text-secondary)]">
                  They fall back to the default percentage — set their cost for exact profit and margin.
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-[#7db0ea]">
                Set costs
                <ArrowRight className="size-3.5" />
              </span>
            </Link>
          )}

          {/* Setup still in progress → keep the guide up, ticking off each
              step as it's done. Once everything's set but data is still
              syncing, the quiet banner. */}
          {!setupComplete ? (
            <GettingStartedGuide accounts={visible} costsSet={costsDone} showGoogle={needsGoogle} />
          ) : (
            rows.length === 0 && (
              <div className="panel flex items-center gap-3 px-4 py-3.5">
                <Database className="size-4 shrink-0 text-[var(--text-muted)]" />
                <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                  {d.portal.noData} — {d.portal.noDataHelp}
                </p>
              </div>
            )
          )}

          {/* Hero — the client's money, RevFlow-style: rev/profit lead. */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard
              d={d}
              label={d.metrics.revenue}
              icon={BadgeDollarSign}
              value={money(totals.netRevenue, currency)}
              hint={fmt(d.metrics.ordersHint, { count: integer(totals.orders) })}
              glow
              highlight
            />
            <MetricCard
              d={d}
              label={d.metrics.netProfit}
              icon={TrendingUp}
              value={money(netProfit, currency)}
              hint={fmt(d.metrics.marginHint, {
                value: totals.netRevenue > 0 ? percent(netProfit / totals.netRevenue) : "—",
              })}
              valueClassName={netProfit >= 0 ? "text-neon-green" : "text-[var(--danger-red)]"}
            />
            <MetricCard
              d={d}
              label={d.metrics.adSpend}
              icon={Wallet}
              value={money(totals.adSpend, currency)}
              hint={fmt(d.metrics.impressionsHint, { count: compact(totals.impressions) })}
            />
            {/* The client's ROAS is what their SHOP returned per euro spent —
                totals.mer. Google's attributed figure moves to the hint: it
                counts only sales Google can see, so it reads 0.00x for an
                account without conversion tracking, beside real revenue. */}
            <MetricCard
              d={d}
              label={d.metrics.roas}
              icon={Crosshair}
              value={multiplier(totals.mer)}
              hint={fmt(d.metrics.roasHintAttributed, { value: multiplier(totals.roas) })}
            />
          </div>

          {/* Efficiency row */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard d={d} label={d.metrics.mer} icon={Percent} value={multiplier(totals.mer)} />
            <MetricCard
              d={d}
              label={d.metrics.aov}
              icon={ShoppingBag}
              value={money(totals.aov, currency)}
            />
            {/* Conversions here are the STORE's orders, not Google's attributed
                conversions — the Google numbers live in the Google section. */}
            <MetricCard
              d={d}
              label={d.metrics.costPerConversion}
              icon={Coins}
              value={money(totals.costPerOrder, currency)}
              hint={d.metrics.costPerOrderHint}
            />
            <MetricCard
              d={d}
              label={d.metrics.conversionRate}
              icon={MousePointerClick}
              value={percent(totals.orderConversionRate)}
              hint={d.metrics.conversionRateHint}
            />
            <MetricCard
              d={d}
              label={d.metrics.orders}
              icon={ShoppingBag}
              value={integer(totals.orders)}
            />
            <MetricCard
              d={d}
              label={d.metrics.refunds}
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
                    ["Product costs (COGS)", totals.productCost],
                    ["Payment fees", totals.paymentFees],
                    ["Shipping", totals.shippingCost],
                    ["Dropscale fee", fee],
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
