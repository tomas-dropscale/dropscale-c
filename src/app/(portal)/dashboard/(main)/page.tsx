import { UpdatedAt } from "@/components/portal/updated-at";
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

import { fetchAccounts, reportingMetricScope } from "@/lib/portal/data";
import { createClient } from "@/lib/supabase/server";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { GettingStartedGuide } from "@/components/portal/getting-started-guide";
import { ManagedAssetsNotice } from "@/components/portal/managed-assets-notice";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import {
  fetchDailyMetrics,
  freshness,
  groupByDay,
  sumMetrics,
} from "@/lib/metrics/queries";
import { fetchManualReferralRateSchedule } from "@/lib/billing/referral-rate-schedule";
import { manualReferralRateOnDay } from "@/lib/billing/referrals";
import { parseRange } from "@/lib/portal/range";
import { currencyScope, displayCurrency } from "@/lib/portal/currency";
import { MixedCurrencyNotice } from "@/components/portal/mixed-currency-notice";
import { compact, integer, money, multiplier, percent } from "@/lib/format";
import { MetricCard } from "@/components/portal/metric-card";
import { RefreshButton } from "@/components/portal/refresh-button";
import { DailyPerformanceChart, type ChartDay } from "@/components/portal/daily-performance-chart";
import { PageContainer } from "@/components/ui/page-container";
import { RangePicker } from "@/components/portal/range-picker";
import { StoreSelector } from "@/components/portal/store-selector";
import { fmt } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";
import { legacyAssetActionsBlocked } from "@/lib/portal/client-rollout";

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
  const [accounts, { d }, blockLegacyAssetActions] = await Promise.all([
    fetchAccounts(),
    getServerDictionary(),
    legacyAssetActionsBlocked(),
  ]);

  const selectedStore =
    typeof params.store === "string" && accounts.some((account) => account.id === params.store)
      ? params.store
      : null;
  const visible = selectedStore
    ? accounts.filter((account) => account.id === selectedStore)
    : accounts;

  const metricsScope = await reportingMetricScope(visible, {
    includeUnallocated: selectedStore === null,
  });
  const physicalAccounts = [...metricsScope.metricAccountsById.values()];
  // Coverage first so recompute sees the rows it just filled and skips the
  // overlap. The exact physical scope matters: all-store views also refresh
  // standalone Google spend, while a store filter never pulls it in.
  await ensureDailyCoverage(physicalAccounts, range.from);
  await recomputeDailyMetrics(physicalAccounts);

  const [rows, referralRateSchedule] = await Promise.all([
    fetchDailyMetrics(
      metricsScope.metricAccountIds,
      range.from,
      range.to,
    ),
    accounts[0]
      ? fetchManualReferralRateSchedule(accounts[0].client_id)
      : Promise.resolve([]),
  ]);
  const unallocatedIds = new Set(metricsScope.unallocatedGoogleAccountIds);
  const unallocatedSpend = sumMetrics(
    rows.filter((row) => unallocatedIds.has(row.ad_account_id)),
  ).adSpend;
  const unallocatedAccountCount = metricsScope.unallocatedGoogleAccountIds.length;
  const unallocatedAccountsLabel = fmt(
    unallocatedAccountCount === 1
      ? d.portal.unallocatedGoogleAccount
      : d.portal.unallocatedGoogleAccounts,
    { count: unallocatedAccountCount },
  );

  const totals = sumMetrics(rows);
  const { updatedAt } = freshness(rows);
  // Was `visible[0].currency`, which printed one symbol against a sum of two
  // currencies. The scope says whether that sum means anything.
  const scope = currencyScope(physicalAccounts);
  const currency = displayCurrency(scope);

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

  // A Monday referral decision changes that Monday onward only. Standard 10%
  // accounts use the sealed history. Legacy/custom contracts keep their own
  // current cache, and every portal fee display is explicitly an estimate;
  // only Payments/admin billing applies exact start/end counters and rounding.
  const fee = rows.reduce(
    (sum, row) => {
      const account = metricsScope.metricAccountsById.get(row.ad_account_id);
      const standardManualContract =
        Number(account?.list_commission_rate) === 10 && !account?.revenue_share_enabled;
      const rate = standardManualContract
        ? manualReferralRateOnDay(row.day, referralRateSchedule)
        : Number(account?.commission_rate ?? 0);
      return sum + (Number(row.ad_spend) * rate) / 100;
    },
    0,
  );
  /**
   * The full chain (spec: COGS moves PROFIT, never revenue):
   * net − COGS − payment fees − shipping − ad spend.
   *
   * Our management fee is NOT in it. It used to be, and that made this figure
   * answer a question the client never asked: a shop that traded to €50 of
   * profit made €50, whether or not it owes us €10 afterwards. The fee is still
   * shown — below, as its own line, billed separately — so nothing is hidden;
   * it simply stops being netted off the client's own trading result.
   *
   * Negative is a real outcome here and rendered in red rather than floored.
   */
  const netProfit = totals.profit;
  const totalCosts =
    totals.adSpend + totals.productCost + totals.paymentFees + totals.shippingCost;

  const chartDays: ChartDay[] = [...groupByDay(rows)]
    .map(([day, dayRows]) => {
      const daySums = sumMetrics(dayRows);
      // Fee-free too, so the curve and the Net profit figure are one measure.
      return {
        day,
        revenue: daySums.netRevenue,
        adSpend: daySums.adSpend,
        profit: daySums.profit,
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  return (
    <PageContainer
      title={d.portal.dashboard}
      description={
        updatedAt
          ? <UpdatedAt template={d.portal.allStoresSubtitle} updatedAt={updatedAt} />
          : d.portal.noData
      }
      actions={
        <>
          {accounts.length > 0 && (
            <RefreshButton
              accountIds={visible.map((account) => account.id)}
              includeUnallocated={selectedStore === null}
            />
          )}
          <StoreSelector accounts={accounts} current={selectedStore} />
          <RangePicker
            current={range}
            // The SHOP's return per euro spent (totals.mer), the same number as
            // the ROAS card below. Google's attributed figure only ever appears
            // as that card's hint — it counts what Google can see, which is not
            // what the store sold.
            footer={`${d.portal.roasTotal}: ${multiplier(totals.mer)}`}
          />
        </>
      }
    >
      {accounts.length === 0 ? (
        blockLegacyAssetActions ? (
          <ManagedAssetsNotice />
        ) : (
          /* No stores yet is the FIRST legacy onboarding state, not an empty
             page. V2-active clients use the secure Add Assets link above. */
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
        )
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
            blockLegacyAssetActions ? (
              <ManagedAssetsNotice />
            ) : (
              <GettingStartedGuide
                accounts={visible}
                costsSet={costsDone}
                showGoogle={needsGoogle}
              />
            )
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

          {/* Above the money, not below it: by the time someone has read a
              total in the wrong currency, the warning has come too late. */}
          <MixedCurrencyNotice scope={scope} />

          {unallocatedAccountCount > 0 && (
            <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold)]/8 px-4 py-3">
              <Info className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                <span className="font-semibold text-[var(--text-primary)]">
                  {d.portal.unallocatedGoogleSpend}: {money(unallocatedSpend, currency)}
                </span>{" "}
                {fmt(d.portal.unallocatedGoogleDashboardWarning, {
                  accounts: unallocatedAccountsLabel,
                })}
              </p>
            </div>
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
              {/* The Dropscale fee is deliberately NOT in this list: every line
                  here is subtracted to reach Net profit, and the fee no longer
                  is. It moves below the total, where it can be read without
                  making the arithmetic above it wrong. */}
              <dl className="space-y-3 text-[13px]">
                {(
                  [
                    ["Ad spend", totals.adSpend],
                    ["Product costs (COGS)", totals.productCost],
                    ["Payment fees", totals.paymentFees],
                    ["Shipping", totals.shippingCost],
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

              {/* Informational estimate outside the trading-profit chain. The
                  exact amount owed lives in Payments after boundary counters
                  and per-store weekly rounding have been applied. */}
              {fee > 0 && (
                <div className="mt-3 border-t border-[var(--border-subtle)] pt-3 text-[13px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[var(--text-secondary)]">
                      Estimated Dropscale fee
                    </span>
                    <span className="font-medium whitespace-nowrap text-[var(--text-primary)]">
                      {money(fee, currency)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                    Based on reported daily spend. The exact weekly invoice is in Payments and
                    is not deducted from the profit above.
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
