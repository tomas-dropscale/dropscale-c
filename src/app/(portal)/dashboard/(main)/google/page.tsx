import { UpdatedAt } from "@/components/portal/updated-at";
import type { Metadata } from "next";
import { Info, PackageOpen } from "lucide-react";

import { fetchAccounts, reportingMetricScope } from "@/lib/portal/data";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import {
  fetchDailyMetrics,
  freshness,
  groupByAccount,
  metricSetFromRows,
  sumMetrics,
} from "@/lib/metrics/queries";
import { parseRange } from "@/lib/portal/range";
import { fetchManualReferralRateSchedule } from "@/lib/billing/referral-rate-schedule";
import { manualReferralRateOnDay } from "@/lib/billing/referrals";
import { currencyScope, displayCurrency } from "@/lib/portal/currency";
import { MixedCurrencyNotice } from "@/components/portal/mixed-currency-notice";
import { multiplier } from "@/lib/format";
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

  const metricsScope = await reportingMetricScope(accounts, { includeUnallocated: true });
  const physicalAccounts = [...metricsScope.metricAccountsById.values()];
  await ensureDailyCoverage(physicalAccounts, range.from);
  await recomputeDailyMetrics(physicalAccounts);

  const [physicalRows, referralRateSchedule] = await Promise.all([
    fetchDailyMetrics(
      metricsScope.metricAccountIds,
      range.from,
      range.to,
    ),
    accounts[0]
      ? fetchManualReferralRateSchedule(accounts[0].client_id)
      : Promise.resolve([]),
  ]);
  const byPhysicalAccount = groupByAccount(physicalRows);
  const { updatedAt } = freshness(physicalRows);
  const referralRateForDay = (day: string) =>
    manualReferralRateOnDay(day, referralRateSchedule);
  const feeRate = (accountId: string, day: string) => {
    const account = metricsScope.metricAccountsById.get(accountId);
    return Number(account?.list_commission_rate) === 10 && !account?.revenue_share_enabled
      ? referralRateForDay(day)
      : Number(account?.commission_rate ?? 0);
  };
  // Totals here span every store, so they are only a real figure when the
  // stores share a currency.
  const scope = currencyScope(physicalAccounts);

  const perAccount = accounts.map((account) => {
    const accountRows = (metricsScope.metricIdsByStore.get(account.id) ?? []).flatMap(
      (id) => byPhysicalAccount.get(id) ?? [],
    );
    return {
      account,
      metrics: metricSetFromRows(accountRows, (row) => feeRate(row.ad_account_id, row.day)),
      // Store-wide totals from Shopify, alongside the Google-attributed ones.
      // The per-store table below reports the STORE's conversions, not
      // Google's: the shop sells through channels Google never sees, so the
      // attributed number understates what actually happened in there.
      store: sumMetrics(accountRows),
    };
  });
  const totals = metricSetFromRows(physicalRows, (row) =>
    feeRate(row.ad_account_id, row.day),
  );
  // Across every store: Shopify revenue over ad spend. One number, used by the
  // grid and the picker's footer, so the page can't contradict itself.
  const allStores = sumMetrics(physicalRows);
  const storeRoas = allStores.mer;
  const storeConversions = allStores.attributedOrders;
  const storeConversionValue = allStores.attributedRevenue;

  // One percentage is only honest if the selected historical rows all used
  // the same Monday-effective manual term.
  const rates = new Set(
    physicalRows.map((row) => feeRate(row.ad_account_id, row.day)),
  );
  const uniformFeeRate = rates.size === 1 ? [...rates][0] : null;

  const comparisonRows: StoreComparisonRow[] = perAccount.map(({ account, metrics, store }) => ({
    accountId: account.id,
    storeName: account.store_name,
    colorDot: account.color_dot,
    currency: account.currency,
    spend: metrics.spend,
    share: totals.spend > 0 ? metrics.spend / totals.spend : 0,
    // The store's own return, not Google's attributed one — same reason as
    // the conversions above.
    roas: store.mer,
    // Store conversions — orders minus the ones Instagram/Facebook referred
    // (0019) — and the ad spend each one cost. NOT Google's attributed count.
    // Falls back to all orders on history the sync has not recomputed yet, so
    // the column matches the grid above it either way.
    conversions: store.attributedOrders ?? store.orders,
    cpa: store.attributedOrders != null ? store.costPerAttributedOrder : store.costPerOrder,
    ctr: metrics.ctr,
    impressions: metrics.impressions,
    fee: metrics.fee,
  }));
  const unallocatedIds = new Set(metricsScope.unallocatedGoogleAccountIds);
  const unallocatedRows = physicalRows.filter((row) => unallocatedIds.has(row.ad_account_id));
  const unallocatedMetrics = metricSetFromRows(unallocatedRows, (row) =>
    feeRate(row.ad_account_id, row.day),
  );
  if (metricsScope.unallocatedGoogleAccountIds.length > 0) {
    comparisonRows.push({
      accountId: null,
      storeName: d.portal.unallocatedGoogleSpend,
      colorDot: "#d8a85b",
      currency: displayCurrency(
        currencyScope(
          metricsScope.unallocatedGoogleAccountIds.flatMap((id) => {
            const account = metricsScope.metricAccountsById.get(id);
            return account ? [account] : [];
          }),
        ),
      ),
      spend: unallocatedMetrics.spend,
      share: totals.spend > 0 ? unallocatedMetrics.spend / totals.spend : 0,
      roas: null,
      conversions: null,
      cpa: null,
      ctr: unallocatedMetrics.ctr,
      impressions: unallocatedMetrics.impressions,
      fee: unallocatedMetrics.fee,
    });
  }

  return (
    <PageContainer
      title={d.portal.allStores}
      description={
        updatedAt
          ? <UpdatedAt template={d.portal.allStoresSubtitle} updatedAt={updatedAt} />
          : d.portal.noData
      }
      actions={
        <RangePicker
          current={range}
          footer={`${d.portal.roasTotal}: ${multiplier(storeRoas)}`}
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
          <MixedCurrencyNotice scope={scope} />
          {metricsScope.unallocatedGoogleAccountIds.length > 0 && (
            <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold)]/8 px-4 py-3">
              <Info className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                <span className="font-semibold text-[var(--text-primary)]">
                  {fmt(
                    metricsScope.unallocatedGoogleAccountIds.length === 1
                      ? d.portal.unallocatedGoogleTableWarningOne
                      : d.portal.unallocatedGoogleTableWarningMany,
                    { count: metricsScope.unallocatedGoogleAccountIds.length },
                  )}
                </span>{" "}
                {d.portal.unallocatedGoogleTableBody}
              </p>
            </div>
          )}
          <MetricsGrid
            d={d}
            metrics={totals}
            currency={displayCurrency(scope)}
            feeRate={uniformFeeRate}
            storeRoas={storeRoas}
            storeConversions={storeConversions}
            storeConversionValue={storeConversionValue}
          />
          <StoreComparisonTable rows={comparisonRows} />
        </div>
      )}
    </PageContainer>
  );
}
