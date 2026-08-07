import { UpdatedAt } from "@/components/portal/updated-at";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileBarChart, Hourglass } from "lucide-react";

import { fetchAccount, fetchCampaigns } from "@/lib/portal/data";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import {
  fetchDailyMetrics,
  freshness,
  metricSetFromRows,
  sumMetrics,
} from "@/lib/metrics/queries";
import { parseRange } from "@/lib/portal/range";
import { multiplier } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { MetricsGrid } from "@/components/portal/metric-card";
import { RangePicker } from "@/components/portal/range-picker";
import { SuspendedBanner } from "@/components/portal/suspended-banner";
import { ConnectAdsBanner } from "@/components/portal/connect-ads-banner";
import { CampaignsTable } from "@/components/portal/campaigns-table";
import { PageContainer } from "@/components/ui/page-container";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";

import { getServerDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Store performance" };

/**
 * Per-store Google page (the "Lorena Taller" format): 10-metric grid from
 * daily_metrics, freshness line from real computed_at. The campaigns table is
 * the one deliberate exception to the pre-aggregated rule — campaign-level
 * rows are not in daily_metrics, and folding them in is its own migration.
 */
export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const { accountId } = await params;
  const range = parseRange(await searchParams);

  // RLS scopes the query to the signed-in client: someone else's accountId
  // (or a junk id) comes back null and 404s without leaking that it exists.
  const account = await fetchAccount(accountId);
  if (!account) notFound();

  await ensureDailyCoverage([account], range.from);
  await recomputeDailyMetrics([account]);

  const [rows, campaigns, { d }] = await Promise.all([
    fetchDailyMetrics([account.id], range.from, range.to),
    fetchCampaigns(account, range),
    getServerDictionary(),
  ]);

  // Deliberately NO manual-referral schedule fetch here: this page hides its
  // fee card (showFee=false below — the fee belongs to the whole-client
  // dashboard and the invoice), and the unconditional schedule RPC was the
  // page's only remaining throw path — one transient Supabase blip rendered
  // the entire store page as a 500 for the client.
  const uniformFeeRate = Number(account.commission_rate);
  const metrics = metricSetFromRows(rows, uniformFeeRate);
  const totals = sumMetrics(rows);
  // This store's own return: its Shopify revenue over its own ad spend.
  const storeRoas = totals.mer;
  const storeConversions = totals.attributedOrders;
  const storeConversionValue = totals.attributedRevenue;
  const { updatedAt, nextUpdateAt } = freshness(rows);

  return (
    <PageContainer
      title={account.store_name}
      description={
        updatedAt && nextUpdateAt ? (
          <UpdatedAt
            template={d.portal.storeSubtitle}
            updatedAt={updatedAt}
            nextUpdateAt={nextUpdateAt}
          />
        ) : (
          d.portal.noData
        )
      }
      actions={
        <>
          <Button variant="secondary" size="sm" className="relative">
            <FileBarChart />
            {d.portal.report}
            {/* New-report indicator */}
            <span className="absolute -top-1 -right-1 size-2 rounded-full bg-[var(--accent-gold)]" />
          </Button>
          <RangePicker
            current={range}
            // This store's own return (Shopify revenue ÷ its ad spend), so the
            // footer agrees with the ROAS card instead of quoting Google's
            // attributed number next to it.
            footer={`${d.portal.roasTotal}: ${multiplier(storeRoas)}`}
          />
        </>
      }
    >
      <div className="space-y-6">
        {account.status === "suspended" && <SuspendedBanner />}
        {account.status === "pending" && (
          <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] px-4 py-3.5">
            <Hourglass className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" />
            <div>
              <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                Waiting for team approval
              </p>
              <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                This account is connected but not active yet. Data starts syncing the
                moment the Dropscale team approves it — history included.
              </p>
            </div>
          </div>
        )}
        {account.status !== "pending" &&
          hasGoogleAdsEnv() &&
          !account.google_ads_connected && <ConnectAdsBanner d={d} />}

        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Metrics</h2>
          <MetricsGrid
            d={d}
            metrics={metrics}
            currency={account.currency}
            feeRate={uniformFeeRate}
            storeRoas={storeRoas}
            storeConversions={storeConversions}
            storeConversionValue={storeConversionValue}
            // One store: ROAS in the fee's place. The fee is a whole-client
            // figure and lives on the dashboard and the invoice.
            showFee={false}
            // Units sold closes the grid back to ten — how much left the shelf,
            // with the order count under it (one order can be five units).
            unitsSold={totals.units}
            orders={totals.orders}
          />
        </section>

        <CampaignsTable campaigns={campaigns} currency={account.currency} />
      </div>
    </PageContainer>
  );
}
