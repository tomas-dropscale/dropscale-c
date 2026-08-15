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
 * Like lib/admin/campaigns, the client/account read is UNSCOPED and lets admin
 * RLS decide. Normalized binding authority is read separately with the
 * service client only after the route above has checked the caller is admin.
 */

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { ACCOUNT_COLUMNS } from "@/lib/portal/data";
import { currencyScope, displayCurrency } from "@/lib/portal/currency";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import {
  googleProfit,
  googleRoas,
  googleShare,
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
import {
  resolveReportingSources,
  type CanonicalReportingSource,
} from "@/lib/reporting/sources";

type OverviewScope = {
  stores: AdAccount[];
  recomputeAccounts: AdAccount[];
  metricIdsByStore: Map<string, string[]>;
  allMetricIds: string[];
  googleConnectedByStore: Map<string, boolean>;
  service: NonNullable<ReturnType<typeof createServiceClient>>;
};

const ROLLOUT_SURFACES = new Set([
  "legacy_only",
  "v2_onboarding",
  "v2_ready_for_cutover",
  "v2_active",
  "rollback_legacy",
]);

function projectedShopDomain(source: CanonicalReportingSource): string {
  return source.shopify?.primaryDomain?.trim().toLowerCase() || source.shopify!.domain;
}

function normalizedStoreDomain(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function canonicalShopifyDomain(value: string | null | undefined): string | null {
  const domain = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
}

function publicStoreDomain(value: string | null): string | null {
  const domain = value?.trim().toLowerCase();
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  return labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
    ? domain
    : null;
}

async function storesWithPublicDomains(
  service: OverviewScope["service"],
  clientId: string,
  accounts: AdAccount[],
): Promise<AdAccount[]> {
  const { data, error } = await service
    .from("client_shopify_connections")
    .select(
      "client_id, status, shopify_domain, primary_domain, last_verified_at, last_error_code",
    )
    .eq("client_id", clientId)
    .eq("status", "connected");
  if (error || !Array.isArray(data)) return accounts;

  const publicDomainByShopify = new Map<string, string>();
  for (const row of data) {
    const shopifyDomain = canonicalShopifyDomain(row.shopify_domain);
    const primaryDomain = publicStoreDomain(row.primary_domain);
    if (
      row.client_id !== clientId ||
      row.status !== "connected" ||
      !row.last_verified_at ||
      row.last_error_code !== null ||
      shopifyDomain !== row.shopify_domain ||
      !primaryDomain
    ) {
      continue;
    }
    publicDomainByShopify.set(shopifyDomain, primaryDomain);
  }

  return accounts.map((account) => {
    const shopifyDomain = canonicalShopifyDomain(account.shopify_url);
    const primaryDomain = shopifyDomain
      ? publicDomainByShopify.get(shopifyDomain)
      : null;
    return primaryDomain ? { ...account, shopify_url: primaryDomain } : account;
  });
}

function estimatedGoogleCog(
  googleRevenue: number | null,
  grossRevenue: number,
  productCost: number,
): number | null {
  return googleRevenue === null
    ? null
    : productCost * googleShare(googleRevenue, grossRevenue);
}

async function reportingScope(
  clientId: string,
  accounts: AdAccount[],
): Promise<OverviewScope> {
  const service = createServiceClient();
  if (!service) throw new Error("The reporting service is unavailable.");

  const { data: rollout, error } = await service
    .from("client_rollout_states")
    .select(
      "operational_surface, reporting_cutover_at, reporting_cutover_by, reporting_cutover_reason",
    )
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error("The client reporting rollout is unavailable.");
  const marker = rollout
    ? [
        rollout.reporting_cutover_at,
        rollout.reporting_cutover_by,
        rollout.reporting_cutover_reason,
      ]
    : [];
  const markerComplete = marker.length > 0 && marker.every(Boolean);
  if (
    rollout &&
    (!ROLLOUT_SURFACES.has(rollout.operational_surface) ||
      (marker.some(Boolean) && !markerComplete))
  ) {
    throw new Error("The client reporting rollout is inconsistent.");
  }

  // `v2_active` existed before normalized reporting. Only the durable marker
  // proves this client passed the exact binding/backfill cutover gate.
  if (!rollout || rollout.operational_surface !== "v2_active" || !markerComplete) {
    const ids = accounts.map((account) => account.id);
    return {
      stores: await storesWithPublicDomains(service, clientId, accounts),
      recomputeAccounts: accounts,
      metricIdsByStore: new Map(accounts.map((account) => [account.id, [account.id]])),
      allMetricIds: [...new Set(ids)],
      googleConnectedByStore: new Map(
        accounts.map((account) => [account.id, account.google_ads_connected]),
      ),
      service,
    };
  }

  const sources = await resolveReportingSources({
    service,
    clientIds: [clientId],
    includeShopifyCredentials: false,
  });
  if (sources.length === 0 || sources.some((source) => source.clientId !== clientId)) {
    throw new Error("The client reporting topology is incomplete.");
  }

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  if (
    accountById.size !== accounts.length ||
    sources.some((source) => !accountById.has(source.adAccountId))
  ) {
    throw new Error("The client reporting accounts are inconsistent.");
  }

  const anchors = sources.filter(
    (source) =>
      source.shopify !== null &&
      source.group.shopifyAnchorBindingId === source.bindingId &&
      source.group.shopifyAnchorAdAccountId === source.adAccountId,
  );
  if (anchors.length === 0) {
    throw new Error("The client reporting topology has no Shopify anchor.");
  }
  const anchorByBindingId = new Map(anchors.map((source) => [source.bindingId, source]));
  if (anchorByBindingId.size !== anchors.length) {
    throw new Error("The client reporting topology repeats a Shopify anchor.");
  }

  const metricIdsByStore = new Map(
    anchors.map((anchor) => [anchor.adAccountId, [anchor.adAccountId]]),
  );
  const googleConnectedByStore = new Map(
    anchors.map((anchor) => [anchor.adAccountId, anchor.googleAds !== null]),
  );
  const claimedMetricIds = new Set(anchors.map((anchor) => anchor.adAccountId));

  for (const source of sources) {
    if (source.shopify || source.group.shopifyAnchorBindingId === null) continue;
    const anchor = anchorByBindingId.get(source.group.shopifyAnchorBindingId);
    if (
      !anchor ||
      source.group.shopifyAnchorAdAccountId !== anchor.adAccountId ||
      claimedMetricIds.has(source.adAccountId)
    ) {
      throw new Error("The client reporting store group is inconsistent.");
    }
    claimedMetricIds.add(source.adAccountId);
    metricIdsByStore.get(anchor.adAccountId)!.push(source.adAccountId);
    if (source.googleAds) googleConnectedByStore.set(anchor.adAccountId, true);
  }

  const stores = anchors.map((anchor) => {
    const base = accountById.get(anchor.adAccountId);
    if (!base || !anchor.shopify) {
      throw new Error("A Shopify anchor account is unavailable.");
    }
    return {
      ...base,
      store_name: anchor.shopify.shopifyName,
      shopify_url: projectedShopDomain(anchor),
      currency: base.currency,
      shopify_connected: true,
      google_ads_connected: googleConnectedByStore.get(anchor.adAccountId) ?? false,
    } satisfies AdAccount;
  });

  const recomputeAccounts = sources.map((source) => {
    const account = accountById.get(source.adAccountId);
    if (!account) throw new Error("A bound reporting account is unavailable.");
    return account;
  });

  return {
    stores,
    recomputeAccounts,
    metricIdsByStore,
    // Standalone Google bindings cannot be attributed to a store, but their
    // spend is still agency spend and must remain in client totals/commission.
    allMetricIds: recomputeAccounts.map((account) => account.id),
    googleConnectedByStore,
    service,
  };
}

/** One of the client's stores, focused on ad spend and what it earns us. */
export type AdminStoreOverview = {
  accountId: string;
  /** Exact anchor + Google child account IDs used to scope store activity. */
  activityAccountIds: string[];
  /** Freshness of this exact store group; null means no verified rollup rows. */
  updatedAt: string | null;
  storeName: string;
  storeDomain: string;
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
  /** Product cost apportioned to the non-Meta revenue slice. */
  estimatedCog: number | null;
  /** Trading profit on the same slice, before the agency fee. */
  profit: number | null;
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
  /**
   * This store's day-by-day spend and Google revenue, oldest first.
   *
   * Spend-only days remain present so store charts do not silently hide Google
   * delivery while Shopify attribution is still unavailable for that day.
   */
  days: { day: string; adSpend: number; revenue: number }[];
};

export type AdminClientOverview = {
  clientId: string;
  clientName: string;
  clientEmail: string;
  /** Every exact physical reporting account in the client scope, including
   *  standalone Google spend that cannot be attributed to one store. */
  activityAccountIds: string[];
  currency: string;
  /** True when the client's stores trade in more than one currency, so the
   *  client-level totals below are sums of unlike amounts. */
  mixedCurrency: boolean;
  currencies: string[];
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
    /** Product cost apportioned to the non-Meta revenue slice. */
    estimatedCog: number | null;
    /** Google's own attributed return — the tracking-health hint. */
    trackedRoas: number;
    /** Ad-spend commission across the client's stores, at each store's rate. */
    commission: number;
    revShare: number;
    /** commission + revShare — the agency's total take for the period. */
    agencyRevenue: number;
    /**
     * The client's profit on the Google slice: revenue less COGS, payment fees,
     * shipping and ad spend.
     *
     * Our management fee is NOT deducted, by explicit instruction. It is the
     * client's trading result, and what they owe us afterwards is a separate
     * line — a client with €50 of profit and a €10 fee has made €50, not €40.
     * The fee has its own card in the Agency section, so nothing is hidden by
     * leaving it out here; putting it in would make this figure disagree with
     * what the client sees on their own dashboard.
     *
     * Goes NEGATIVE and is rendered as such — a losing period has to be legible
     * as a loss, not floored at zero. Costs are apportioned, not measured; see
     * google-attribution.ts. Null when attribution has never been computed.
     */
    profit: number | null;
    /** profit ÷ googleRevenue, likewise before our fee. */
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

  if (clientRes.error || accountsRes.error) {
    throw new Error("The client reporting accounts could not be loaded.");
  }
  const client = clientRes.data;
  if (!client) return null;

  const accounts = (accountsRes.data as AdAccount[] | null) ?? [];
  const scope = await reportingScope(clientId, accounts);
  const currencies = currencyScope(scope.recomputeAccounts);

  // Bring this client's rollup current before reading it — see the note at the
  // top. Never let a sync failure take the popup down: a partial view of a
  // client is far better than an error where their numbers should be.
  try {
    // A normalized store anchor is the safe public recompute scope: the
    // runtime expands its exact Google children from binding authority.
    await ensureDailyCoverage(scope.recomputeAccounts, range.from);
    await recomputeDailyMetrics(scope.recomputeAccounts, {
      client: scope.service,
      reportingClient: scope.service,
    });
  } catch (error) {
    console.error(`Client overview refresh failed for ${clientId}:`, error);
  }

  const rows = await fetchDailyMetrics(
    scope.allMetricIds,
    range.from,
    range.to,
  );
  const allowedMetricIds = new Set(scope.allMetricIds);
  if (rows.some((row) => !allowedMetricIds.has(row.ad_account_id))) {
    throw new Error("The client reporting metrics escaped their exact scope.");
  }

  const byAccount = groupByAccount(rows);
  const rateById = new Map(
    accounts.map((account) => [account.id, Number(account.commission_rate)]),
  );

  const stores: AdminStoreOverview[] = scope.stores
    .map((account) => {
      const metricIds = scope.metricIdsByStore.get(account.id);
      if (!metricIds) throw new Error("A client reporting store group is missing.");
      const accountRows = metricIds.flatMap((id) => byAccount.get(id) ?? []);
      const totals = sumMetrics(accountRows);
      const commission = metricIds.reduce((sum, id) => {
        const physicalSpend = sumMetrics(byAccount.get(id) ?? []).adSpend;
        return sum + (physicalSpend * (rateById.get(id) ?? 0)) / 100;
      }, 0);
      const rate = totals.adSpend > 0
        ? (commission / totals.adSpend) * 100
        : (rateById.get(account.id) ?? 0);
      const revenue = totals.attributedRevenue;
      const costs: DayCosts = {
        revenue: totals.revenue,
        refunds: totals.refunds,
        productCost: totals.productCost,
        paymentFees: totals.paymentFees,
        shippingCost: totals.shippingCost,
        adSpend: totals.adSpend,
      };

      return {
        accountId: account.id,
        activityAccountIds: [...metricIds],
        updatedAt: freshness(accountRows).updatedAt,
        storeName: account.store_name,
        storeDomain: normalizedStoreDomain(account.shopify_url),
        colorDot: account.color_dot,
        currency: account.currency,
        connected: scope.googleConnectedByStore.get(account.id) ?? false,
        adSpend: totals.adSpend,
        impressions: totals.impressions,
        clicks: totals.clicks,
        ctr: totals.ctr,
        cpc: totals.cpc,
        googleRevenue: revenue,
        googleOrders: totals.attributedOrders,
        costPerGoogleOrder: totals.costPerAttributedOrder,
        roas: googleRoas(revenue, totals.adSpend),
        estimatedCog: estimatedGoogleCog(revenue, totals.revenue, totals.productCost),
        profit: googleProfit(revenue, costs),
        trackedRoas: totals.roas,
        conversions: totals.conversions,
        conversionValue: totals.conversionValue,
        costPerConversion: totals.costPerConversion,
        commissionRate: rate,
        commission,
        revShareEnabled: account.revenue_share_enabled,
        revShare: accountRows.reduce(
          (sum, row) => sum + Number(row.revenue_share_amount),
          0,
        ),
        days: [...groupByDay(accountRows)]
          .map(([day, dayRows]) => {
            const dayTotals = sumMetrics(dayRows);
            return {
              day,
              adSpend: dayTotals.adSpend,
              revenue: dayTotals.attributedRevenue ?? 0,
            };
          })
          .sort((a, b) => a.day.localeCompare(b.day)),
      };
    })
    // Biggest spender first: an agency reads this list looking for where the
    // money is, not alphabetically.
    .sort((a, b) => b.adSpend - a.adSpend);

  const totals = sumMetrics(rows);
  const commission = scope.allMetricIds.reduce((sum, id) => {
    const physicalSpend = sumMetrics(byAccount.get(id) ?? []).adSpend;
    return sum + (physicalSpend * (rateById.get(id) ?? 0)) / 100;
  }, 0);
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
  // Before our fee — see the note on `profit` in the type above.
  const profit = googleProfit(revenue, costs);

  const days = [...groupByDay(rows)]
    // A day nobody has attributed yet is not a day of zero sales, and plotting
    // it as one would draw a trough in the chart that never happened.
    .filter(([, dayRows]) => dayRows.some((row) => row.attributed_orders !== null))
    .map(([day, dayRows]) => {
      const daySums = sumMetrics(dayRows);
      const dayProfit = googleProfit(daySums.attributedRevenue, {
        revenue: daySums.revenue,
        refunds: daySums.refunds,
        productCost: daySums.productCost,
        paymentFees: daySums.paymentFees,
        shippingCost: daySums.shippingCost,
        adSpend: daySums.adSpend,
      });

      // The chart plots the client's trading result, fee excluded, so its line
      // and the "Their profit" card above it are the same measure.
      return {
        day,
        revenue: daySums.attributedRevenue ?? 0,
        adSpend: daySums.adSpend,
        profit: dayProfit ?? 0,
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    clientId: client.id,
    clientName: client.full_name,
    clientEmail: client.email,
    activityAccountIds: [...scope.allMetricIds],
    // Stores can differ in currency; the client-level strip uses the first
    // store's, which is what the client's own dashboard does too.
    // One currency across the client's stores, or the first as a fallback with
    // `mixedCurrency` set — the client-level strip sums across stores, and a
    // sum of EUR and GBP is not a figure in either.
    currency: displayCurrency(currencies),
    mixedCurrency: currencies.mixed,
    currencies: currencies.currencies,
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
      estimatedCog: estimatedGoogleCog(revenue, totals.revenue, totals.productCost),
      trackedRoas: totals.roas,
      commission,
      revShare,
      agencyRevenue: commission + revShare,
      profit,
      margin: profit !== null && revenue !== null && revenue > 0 ? profit / revenue : null,
    },
    stores,
    days,
    updatedAt: freshness(rows).updatedAt,
  };
}
