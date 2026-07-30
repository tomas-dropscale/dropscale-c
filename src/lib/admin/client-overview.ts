/**
 * One client's dashboard, as the AGENCY sees it.
 *
 * Backs the campaigns page's "Open dashboard" popup: the same figures the
 * client sees on their own dashboard, plus what the agency earns on them —
 * which is the part a client's view will never show.
 *
 * Built on `daily_metrics`, the pre-aggregated join of Google spend and Shopify
 * revenue.
 *
 * It REFRESHES that rollup before reading, and has to: the recompute otherwise
 * runs only from the client's own portal pages, so a client who rarely logs in
 * has a stale — or empty — table, and this popup would report their revenue as
 * zero while their shop is plainly selling. The recompute is throttled per
 * account, so reopening the popup costs nothing; only a genuinely cold client
 * pays the round trip, which is the case that would otherwise be wrong.
 *
 * Like lib/admin/campaigns, this reads UNSCOPED and lets the admin RLS
 * policies decide. The route above it is what checks the caller is an admin.
 */

import { createClient } from "@/lib/supabase/server";
import { ACCOUNT_COLUMNS } from "@/lib/portal/data";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import {
  fetchDailyMetrics,
  freshness,
  groupByAccount,
  groupByDay,
  sumMetrics,
  type MetricTotals,
} from "@/lib/metrics/queries";
import type { AdAccount } from "@/lib/supabase/types";
import type { RangeSelection } from "@/lib/portal/range";

/** One of the client's stores, focused on ad spend and what it earns us. */
export type AdminStoreOverview = {
  accountId: string;
  storeName: string;
  colorDot: string;
  currency: string;
  connected: boolean;
  adSpend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  /** Google-attributed conversions. Kept as the hint, like googleRoas below. */
  conversions: number;
  conversionValue: number;
  costPerConversion: number;
  /**
   * The STORE's conversions: real orders minus the ones Instagram or Facebook
   * referred (migration 0019). This is what belongs next to Google ad spend —
   * see lib/shopify/referrer.ts. Null on history the sync has not recomputed
   * yet, so the dialog falls back to Google's count rather than claiming zero.
   */
  storeConversions: number | null;
  /** Ad spend ÷ storeConversions — the CPA matching the figure above. */
  costPerStoreConversion: number;
  /** What those conversions were worth: gross revenue of the same orders. */
  storeConversionValue: number | null;
  /**
   * The STORE's return: Shopify revenue ÷ ad spend. Matches what the client
   * sees on their own dashboard — an admin looking at this popup to answer
   * "why does my client say their ROAS is wrong" must be reading their number.
   */
  roas: number;
  /**
   * What Google attributes. Kept alongside so a broken conversion-tracking
   * setup stays visible here, which is exactly the diagnosis an admin needs.
   */
  googleRoas: number;
  /** Store-side, from Shopify. */
  netRevenue: number;
  orders: number;
  /** What the agency bills on this store for the period. */
  commissionRate: number;
  commission: number;
  revShareEnabled: boolean;
  revShare: number;
};

export type AdminClientOverview = {
  clientId: string;
  clientName: string;
  clientEmail: string;
  currency: string;
  range: { from: string; to: string };
  totals: MetricTotals & {
    /** Ad-spend commission across the client's stores, at each store's rate. */
    commission: number;
    revShare: number;
    /** commission + revShare — the agency's total take for the period. */
    agencyRevenue: number;
    /** The client's profit AFTER our fee — what they actually keep. */
    netProfitAfterFee: number;
  };
  stores: AdminStoreOverview[];
  days: { day: string; revenue: number; adSpend: number; profit: number }[];
  /** When the underlying rollup last ran; null when there is nothing yet. */
  updatedAt: string | null;
};

export async function fetchClientOverview(
  clientId: string,
  range: RangeSelection,
): Promise<AdminClientOverview | null> {
  const supabase = await createClient();

  const [clientRes, accountsRes] = await Promise.all([
    supabase
      .from("portal_clients")
      .select("id, full_name, email")
      .eq("id", clientId)
      .maybeSingle(),
    supabase.from("ad_accounts").select(ACCOUNT_COLUMNS).eq("client_id", clientId),
  ]);

  const client = clientRes.data;
  if (!client) return null;

  const accounts = (accountsRes.data as AdAccount[] | null) ?? [];

  // Bring this client's rollup current before reading it — see the note at the
  // top. Never let a sync failure take the popup down: a partial view of a
  // client is far better than an error where their numbers should be.
  try {
    await ensureDailyCoverage(accounts, range.from);
    await recomputeDailyMetrics(accounts);
  } catch (error) {
    console.error(`Client overview refresh failed for ${clientId}:`, error);
  }

  const rows = await fetchDailyMetrics(
    accounts.map((account) => account.id),
    range.from,
    range.to,
  );

  const byAccount = groupByAccount(rows);
  const rateById = new Map(
    accounts.map((account) => [account.id, Number(account.commission_rate)]),
  );

  const stores: AdminStoreOverview[] = accounts
    .map((account) => {
      const totals = sumMetrics(byAccount.get(account.id) ?? []);
      const rate = rateById.get(account.id) ?? 0;
      return {
        accountId: account.id,
        storeName: account.store_name,
        colorDot: account.color_dot,
        currency: account.currency,
        connected: account.google_ads_connected,
        adSpend: totals.adSpend,
        impressions: totals.impressions,
        clicks: totals.clicks,
        ctr: totals.ctr,
        cpc: totals.cpc,
        conversions: totals.conversions,
        conversionValue: totals.conversionValue,
        costPerConversion: totals.costPerConversion,
        storeConversions: totals.attributedOrders,
        costPerStoreConversion: totals.costPerAttributedOrder,
        storeConversionValue: totals.attributedRevenue,
        roas: totals.mer,
        googleRoas: totals.roas,
        netRevenue: totals.netRevenue,
        orders: totals.orders,
        commissionRate: rate,
        commission: (totals.adSpend * rate) / 100,
        revShareEnabled: account.revenue_share_enabled,
        revShare: (byAccount.get(account.id) ?? []).reduce(
          (sum, row) => sum + Number(row.revenue_share_amount),
          0,
        ),
      };
    })
    // Biggest spender first: an agency reads this list looking for where the
    // money is, not alphabetically.
    .sort((a, b) => b.adSpend - a.adSpend);

  const totals = sumMetrics(rows);
  const commission = stores.reduce((sum, store) => sum + store.commission, 0);
  const revShare = stores.reduce((sum, store) => sum + store.revShare, 0);

  const days = [...groupByDay(rows)]
    .map(([day, dayRows]) => {
      const daySums = sumMetrics(dayRows);
      // The fee respects each store's own rate, so it has to be summed per
      // account rather than applied to the day's total spend.
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

  return {
    clientId: client.id,
    clientName: client.full_name,
    clientEmail: client.email,
    // Stores can differ in currency; the client-level strip uses the first
    // store's, which is what the client's own dashboard does too.
    currency: accounts[0]?.currency ?? "EUR",
    range: { from: range.from, to: range.to },
    totals: {
      ...totals,
      commission,
      revShare,
      agencyRevenue: commission + revShare,
      netProfitAfterFee: totals.profit - commission - revShare,
    },
    stores,
    days,
    updatedAt: freshness(rows).updatedAt,
  };
}
