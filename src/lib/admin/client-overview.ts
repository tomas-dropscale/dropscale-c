/**
 * One client's dashboard, as the AGENCY sees it.
 *
 * Backs the campaigns page's "Report" popup: what the agency earns on a client,
 * and what the client earned from the work we actually do for them.
 *
 * GOOGLE ONLY. Every revenue figure here is narrowed to orders that Instagram
 * and Facebook did not refer (migration 0019, lib/shopify/referrer.ts). The
 * agency sells Google ads; a report that answered "what did we make you" with
 * the shop's total revenue would be crediting our spend with Meta's sales, and
 * a client comparing that against their Shopify admin would rightly stop
 * trusting the whole page. Ad spend, impressions and clicks come from Google
 * Ads directly, so they need no narrowing.
 *
 * The blended figures are not merely unused here — `netRevenue` and `orders`
 * are deliberately absent from the exported types, so the report cannot render
 * them by accident. Where costs cannot be split by referrer they are
 * apportioned; see lib/admin/google-attribution.ts for that reasoning.
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
  googleProfit,
  googleRoas,
  type DayCosts,
} from "@/lib/admin/google-attribution";
import {
  fetchDailyMetrics,
  freshness,
  groupByAccount,
  groupByDay,
  sumMetrics,
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
  /**
   * Shopify revenue on orders Instagram and Facebook did NOT refer — the
   * store's real return on our ads. Null when no day in the window has had its
   * attribution computed yet, so the report shows a dash rather than asserting
   * a number it cannot stand behind.
   */
  googleRevenue: number | null;
  /** How many orders that revenue came from. Null follows googleRevenue. */
  googleOrders: number | null;
  /** Ad spend ÷ googleOrders — the CPA that matches the figures above. */
  costPerGoogleOrder: number;
  /** googleRevenue ÷ ad spend. The store's headline return. */
  roas: number;
  /**
   * What Google's OWN conversion tracking claims, from the Ads API. Kept beside
   * the real figure because a 0.00x here over healthy revenue is the signature
   * of a broken conversion tag — exactly the diagnosis an admin opens this for.
   */
  trackedRoas: number;
  /** Google-attributed conversions, same provenance and same caveat. */
  conversions: number;
  conversionValue: number;
  costPerConversion: number;
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
  totals: {
    /** Non-Meta Shopify revenue across the client's stores. Null = uncomputed. */
    googleRevenue: number | null;
    googleOrders: number | null;
    /** googleRevenue ÷ googleOrders. */
    aov: number;
    adSpend: number;
    impressions: number;
    clicks: number;
    ctr: number;
    cpc: number;
    conversions: number;
    /** googleRevenue ÷ ad spend. */
    roas: number;
    /** Google's own attributed return — the tracking-health hint. */
    trackedRoas: number;
    /** Ad-spend commission across the client's stores, at each store's rate. */
    commission: number;
    revShare: number;
    /** commission + revShare — the agency's total take for the period. */
    agencyRevenue: number;
    /**
     * The client's profit on the Google slice AFTER our fee. Costs are
     * apportioned, not measured — see google-attribution.ts. Null when the
     * window's attribution has never been computed.
     */
    netProfitAfterFee: number | null;
    /** netProfitAfterFee ÷ googleRevenue. Null for the same reason. */
    margin: number | null;
  };
  stores: AdminStoreOverview[];
  /** Only days whose attribution has been computed — a false zero would read
   *  on the chart as a day the shop sold nothing. */
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
      const accountRows = byAccount.get(account.id) ?? [];
      const totals = sumMetrics(accountRows);
      const rate = rateById.get(account.id) ?? 0;
      const revenue = totals.attributedRevenue;

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
        googleRevenue: revenue,
        googleOrders: totals.attributedOrders,
        costPerGoogleOrder: totals.costPerAttributedOrder,
        roas: googleRoas(revenue, totals.adSpend),
        trackedRoas: totals.roas,
        conversions: totals.conversions,
        conversionValue: totals.conversionValue,
        costPerConversion: totals.costPerConversion,
        commissionRate: rate,
        commission: (totals.adSpend * rate) / 100,
        revShareEnabled: account.revenue_share_enabled,
        revShare: accountRows.reduce(
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

  const revenue = totals.attributedRevenue;
  const orders = totals.attributedOrders;

  // Costs belong to the whole shop; only the Google slice of them is charged
  // against the Google slice of revenue. The blended `revenue` is the
  // denominator of that split and never a figure the report displays.
  const costs: DayCosts = {
    revenue: totals.revenue,
    refunds: totals.refunds,
    productCost: totals.productCost,
    paymentFees: totals.paymentFees,
    shippingCost: totals.shippingCost,
    adSpend: totals.adSpend,
  };
  const profit = googleProfit(revenue, costs);
  const netProfitAfterFee = profit === null ? null : profit - commission - revShare;

  const days = [...groupByDay(rows)]
    // A day nobody has attributed yet is not a day of zero sales, and plotting
    // it as one would draw a trough in the chart that never happened.
    .filter(([, dayRows]) => dayRows.some((row) => row.attributed_orders !== null))
    .map(([day, dayRows]) => {
      const daySums = sumMetrics(dayRows);
      // The fee respects each store's own rate, so it has to be summed per
      // account rather than applied to the day's total spend.
      const dayFee = dayRows.reduce(
        (sum, row) => sum + (Number(row.ad_spend) * (rateById.get(row.ad_account_id) ?? 0)) / 100,
        0,
      );
      const dayProfit = googleProfit(daySums.attributedRevenue, {
        revenue: daySums.revenue,
        refunds: daySums.refunds,
        productCost: daySums.productCost,
        paymentFees: daySums.paymentFees,
        shippingCost: daySums.shippingCost,
        adSpend: daySums.adSpend,
      });

      return {
        day,
        revenue: daySums.attributedRevenue ?? 0,
        adSpend: daySums.adSpend,
        profit: (dayProfit ?? 0) - dayFee,
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
      googleRevenue: revenue,
      googleOrders: orders,
      aov: revenue !== null && orders && orders > 0 ? revenue / orders : 0,
      adSpend: totals.adSpend,
      impressions: totals.impressions,
      clicks: totals.clicks,
      ctr: totals.ctr,
      cpc: totals.cpc,
      conversions: totals.conversions,
      roas: googleRoas(revenue, totals.adSpend),
      trackedRoas: totals.roas,
      commission,
      revShare,
      agencyRevenue: commission + revShare,
      netProfitAfterFee,
      margin:
        netProfitAfterFee !== null && revenue !== null && revenue > 0
          ? netProfitAfterFee / revenue
          : null,
    },
    stores,
    days,
    updatedAt: freshness(rows).updatedAt,
  };
}
