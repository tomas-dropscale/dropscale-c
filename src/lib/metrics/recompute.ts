/**
 * recomputeDailyMetrics — fills/refreshes the daily_metrics read model.
 *
 * Legacy accounts still ride the viewer's session. Active V2 reporting
 * bindings are deliberately service-only: their connection credentials never
 * enter the legacy row and their pending ad_accounts surrogate is operational
 * only through that audited binding. Both paths self-throttle per account so
 * most page loads cost zero upstream calls.
 *
 * The 15-minute throttle is also the UI's freshness contract: pages show
 * "next update at ..." as newest computed_at + 15 min.
 *
 * ensureDailyCoverage handles the other axis: a freshly connected store has
 * no history, so a 30-day range would show a near-empty chart. It backfills
 * from the selected range's start (capped) up to where coverage begins —
 * once, because after that the coverage check finds nothing missing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { presetSelection } from "../portal/range";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import {
  fetchCampaignNames,
  fetchLiveDailyBreakdown,
  type DailyBreakdown,
} from "@/lib/google-ads/portal";
import {
  fetchCollectionProductKeys,
  fetchDailySales,
  resolveAdminToken,
  type DailySales,
  type SyncedOrder,
} from "@/lib/shopify/client";
import { fxDailyRates, rateOn } from "@/lib/shopify/fx";
import { orderCogs, paymentFee } from "@/lib/cogs/engine";
import { loadCostContext, registerSoldProducts } from "@/lib/cogs/context";
import { addHstTariffs, applyHstOrderCosts } from "@/lib/cogs/hst-tariff";
import { dealsFromCampaigns, orderRevShare, type AttributionDeal } from "@/lib/finance/rev-share";
import type { DailyMetricRow } from "./queries";
import {
  mergeDailyMetricFamilies,
  type ReportingFamilyResult,
  type ShopifyDailyMetric,
} from "../reporting/daily-metrics";
import { fetchGoogleReportingDailyMetrics } from "../reporting/google";
import { createShopifyReportingAdapter } from "../reporting/shopify";
import {
  ReportingSourceResolutionError,
  resolveReportingSources,
  resolveStagedReportingSource,
  type CanonicalReportingSource,
} from "../reporting/sources";
import type { AdAccount, Database } from "@/lib/supabase/types";

export const RECOMPUTE_INTERVAL_MS = 15 * 60 * 1000;

/** How far back the incremental sync heals on every run. */
const WINDOW_DAYS = 7;

/** Hard cap on how far back a range-driven backfill may reach. */
const BACKFILL_LIMIT_DAYS = 90;

type Supabase = SupabaseClient<Database>;

type ReportingOptions = {
  /** A service-role client for the service-only V2 binding graph. */
  reportingClient?: Supabase;
};

type ResolvedReportingScope = {
  accounts: AdAccount[];
  sources: CanonicalReportingSource[];
};

type RuntimeReportingScope = ResolvedReportingScope & {
  legacyAccounts: AdAccount[];
};

function assertCompleteReportingScope(scope: ResolvedReportingScope): void {
  const sourceAccountIds = scope.sources.map((source) => source.adAccountId);
  const uniqueSourceAccountIds = new Set(sourceAccountIds);
  if (
    sourceAccountIds.length !== scope.accounts.length ||
    uniqueSourceAccountIds.size !== sourceAccountIds.length ||
    scope.accounts.some((account) => !uniqueSourceAccountIds.has(account.id))
  ) {
    throw new Error("The requested V2 reporting scope is incomplete.");
  }
}

/** The Google-sourced columns of daily_metrics, carried forward when Google
 *  can't be reached. Kept as its own type so the carry-forward below can't
 *  silently fall out of step with the row it feeds. */
type DailyMetricAdColumns = {
  ad_spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
};

// Per-isolate memo of the last run per account, so a burst of navigation
// doesn't even query for freshness.
const lastRunByAccount = new Map<string, number>();

function isoDay(offsetDays: number): string {
  return addDays(presetSelection("today").to, offsetDays);
}

function dayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type SecretColumns = {
  google_ads_refresh_token: string | null;
  shopify_admin_token: string | null;
};

function syncable(account: AdAccount): boolean {
  // Pending accounts are connected but not yet approved by the team — no
  // data flows until an admin activates them (the approval IS the product
  // gate). The lazy sync picks them up on the first page view after
  // activation, history included via the coverage backfill.
  if (account.status === "pending") return false;
  return (
    (account.google_ads_connected && Boolean(account.google_ads_customer_id)) ||
    account.shopify_connected
  );
}

/** The encrypted secrets, fetched on their own — never inside page payloads. */
async function fetchSecrets(
  supabase: Supabase,
  accountIds: string[],
): Promise<Map<string, SecretColumns>> {
  if (accountIds.length === 0) return new Map();
  const ids = [...new Set(accountIds)];
  const { data, error } = await supabase
    .from("ad_accounts")
    .select("id, google_ads_refresh_token, shopify_admin_token")
    .in("id", ids);
  if (error || !Array.isArray(data)) {
    throw error ?? new Error("Reporting credentials could not be loaded.");
  }
  const secrets = new Map(
    (data as unknown as ({ id: string } & SecretColumns)[]).map((row) => [row.id, row]),
  );
  if (secrets.size !== ids.length || ids.some((id) => !secrets.has(id))) {
    throw new Error("A requested reporting credential row is missing.");
  }
  return secrets;
}

function reportingClient(explicit?: Supabase, fallback?: Supabase): Supabase {
  const service = explicit ?? createServiceClient() ?? fallback;
  if (!service) {
    throw new Error("The V2 reporting service is not configured.");
  }
  return service;
}

async function resolveRequestedReportingSources(
  service: Supabase,
  accounts: AdAccount[],
): Promise<ResolvedReportingScope> {
  if (accounts.length === 0) return { accounts: [], sources: [] };
  const clientIds = [...new Set(accounts.map((account) => account.client_id))];
  const selected = await resolveReportingSources({
    service,
    adAccountIds: [...new Set(accounts.map((account) => account.id))],
    clientIds,
  });
  const anchorBindingIds = [
    ...new Set(
      selected.flatMap((source) =>
        source.shopify && source.group.shopifyAnchorBindingId === source.bindingId
          ? [source.bindingId]
          : [],
      ),
    ),
  ];
  if (anchorBindingIds.length === 0) return { accounts, sources: selected };

  // A store projection contains its Shopify anchor, while Google accounts are
  // metric children. Expand only children pointing at one of the exact anchor
  // bindings selected above; client scope is repeated at the database boundary
  // so a malformed cross-owner edge cannot widen this refresh.
  const { data: children, error: childError } = await service
    .from("client_reporting_bindings")
    .select("ad_account_id")
    .eq("status", "active")
    .in("client_id", clientIds)
    .in("shopify_anchor_binding_id", anchorBindingIds);
  if (childError) throw childError;
  const childIds = [
    ...new Set((children ?? []).map((row) => row.ad_account_id)),
  ].filter((id) => !selected.some((source) => source.adAccountId === id));
  if (childIds.length === 0) return { accounts, sources: selected };

  const { data: childAccounts, error: childAccountsError } = await service
    .from("ad_accounts")
    .select("*")
    .in("id", childIds)
    .in("client_id", clientIds);
  if (childAccountsError) throw childAccountsError;
  const expandedAccounts = (childAccounts as AdAccount[] | null) ?? [];
  if (expandedAccounts.length !== childIds.length) {
    throw new Error("A bound Google child account is missing from its store group.");
  }

  const expanded = await resolveReportingSources({
    service,
    adAccountIds: expandedAccounts.map((account) => account.id),
    clientIds,
  });
  return { accounts: [...accounts, ...expandedAccounts], sources: [...selected, ...expanded] };
}

async function resolveRuntimeReportingScope(
  service: Supabase,
  accounts: AdAccount[],
): Promise<RuntimeReportingScope> {
  if (accounts.length === 0) {
    return { accounts: [], sources: [], legacyAccounts: [] };
  }
  const clientIds = [...new Set(accounts.map((account) => account.client_id))];
  const { data, error } = await service
    .from("client_rollout_states")
    .select("client_id, operational_surface, reporting_cutover_at")
    .in("client_id", clientIds);
  if (error || !Array.isArray(data)) {
    throw error ?? new Error("Client reporting rollout state is unavailable.");
  }
  const rolloutByClient = new Map(data.map((row) => [row.client_id, row]));
  if (
    [...rolloutByClient.values()].some(
      (rollout) =>
        ![
          "legacy_only",
          "v2_onboarding",
          "v2_ready_for_cutover",
          "v2_active",
          "rollback_legacy",
        ].includes(rollout.operational_surface) ||
        (rollout.reporting_cutover_at !== null &&
          Number.isNaN(Date.parse(rollout.reporting_cutover_at))),
    )
  ) {
    throw new Error("Client reporting rollout state is invalid.");
  }

  const v2Accounts = accounts.filter((account) => {
    const rollout = rolloutByClient.get(account.client_id);
    return (
      rollout?.operational_surface === "v2_active" &&
      rollout.reporting_cutover_at !== null
    );
  });
  const v2AccountIds = new Set(v2Accounts.map((account) => account.id));
  const legacyAccounts = accounts.filter((account) => !v2AccountIds.has(account.id));
  const scope = await resolveRequestedReportingSources(service, v2Accounts);
  // An active rollout may never silently fall through to legacy merely
  // because a binding disappeared or became unreadable.
  assertCompleteReportingScope(scope);
  return { ...scope, legacyAccounts };
}

async function fetchExistingWindow(
  service: Supabase,
  adAccountId: string,
  from: string,
  to: string,
): Promise<DailyMetricRow[]> {
  const { data, error } = await service
    .from("daily_metrics")
    .select("*")
    .eq("ad_account_id", adAccountId)
    .gte("day", from)
    .lte("day", to);
  if (error) throw error;
  return (data as DailyMetricRow[] | null) ?? [];
}

async function reportingFamily<T>(
  label: "Google" | "Shopify",
  adAccountId: string,
  read: (() => Promise<T[]>) | null,
): Promise<ReportingFamilyResult<T>> {
  if (!read) return { state: "not_applicable" };
  try {
    return { state: "succeeded", rows: await read() };
  } catch (error) {
    // Adapter errors are deliberately reduced to their class here: upstream
    // messages can contain request metadata and must never leak credentials.
    // Resolver errors are the exception — their messages are curated safe
    // strings, and hiding them made a rejected binding silently stop a
    // store's sync for hours (Lia Singapura, 2026-08-18).
    const kind = error instanceof Error ? error.name : "unknown";
    const safeDetail =
      error instanceof ReportingSourceResolutionError ? ` — ${error.message}` : "";
    console.error(`${label} V2 reporting failed for ${adAccountId}: ${kind}${safeDetail}`);
    return { state: "failed" };
  }
}

async function fetchShopifyReportingDailyMetrics(
  service: Supabase,
  account: AdAccount,
  source: CanonicalReportingSource,
  from: string,
  to: string,
): Promise<ShopifyDailyMetric[]> {
  if (
    !source.shopify ||
    source.group.shopifyAnchorBindingId !== source.bindingId ||
    source.group.shopifyAnchorAdAccountId !== source.adAccountId
  ) {
    throw new Error("A V2 Shopify source must be its store anchor.");
  }
  // Collection revenue-share is invoice input, not a Windsor reporting
  // metric. Until its campaign-name source is normalized, preserving the
  // stored family is safer than silently underbilling with invented zeros.
  if (account.revenue_share_enabled) {
    throw new Error("V2 revenue-share reporting is not available.");
  }

  const adapter = await createShopifyReportingAdapter(source);
  const result = await adapter.fetchDailySales(from, to);
  let sales = result.days;
  const costByDay = new Map<string, { product: number; fees: number; shipping: number }>();

  const needsFx = Boolean(result.currency && result.currency !== account.currency);
  const rates =
    needsFx && (sales.length > 0 || result.orders.length > 0)
      ? await fxDailyRates(result.currency!, account.currency, from, to)
      : null;
  if (rates) {
    sales = sales.map((day) => {
      const rate = rateOn(rates, day.date);
      return {
        ...day,
        revenue: day.revenue * rate,
        refunds: day.refunds * rate,
        attributedRevenue: day.attributedRevenue * rate,
      };
    });
  }

  if (result.orders.length > 0) {
    await registerSoldProducts(
      service,
      account.id,
      result.orders,
      result.currency ?? account.currency,
    );
    const ctx = await loadCostContext(
      service,
      account.id,
      Number(account.default_product_cost_pct),
      account.currency,
    );
    for (const order of result.orders as SyncedOrder[]) {
      const rate = rates ? rateOn(rates, order.date) : 1;
      const lines = order.lines.map((line) => ({
        productKey: line.productKey,
        quantity: line.quantity,
        unitPrice: line.unitPrice * rate,
      }));
      const entry = costByDay.get(order.date) ?? { product: 0, fees: 0, shipping: 0 };
      entry.product += orderCogs(lines, order.date, ctx);
      entry.fees += paymentFee(
        order.total * rate,
        Number(account.payment_fee_pct),
        Number(account.payment_fee_fixed),
      );
      entry.shipping += Number(account.shipping_cost_per_order);
      costByDay.set(order.date, entry);
    }
  }

  // The supplier's per-order import duty, for stores bought through HST. A
  // no-op for every other store — see cogs/hst-tariff.ts.
  await addHstTariffs({
    service,
    adAccountId: account.id,
    from,
    to,
    reportingCurrency: account.currency,
    costByDay,
  });

  // For an HST store, replace the per-product COGS estimate with the supplier's
  // actual per-order cost, aligned to the store's own days. No-op elsewhere and
  // until 0091 has stored our_cost.
  if (account.hst_shop_id) {
    await applyHstOrderCosts({
      service,
      adAccountId: account.id,
      from,
      to,
      reportingCurrency: account.currency,
      timeZone: result.timeZone || "UTC",
      costByDay,
    });
  }

  // The untouched store-currency revenue (pre-FX) lives on result.days; sales is
  // the EUR-converted copy. Keep both so the read side can show the exact Shopify
  // figure and still convert for an EUR total.
  const rawByDay = new Map(result.days.map((day) => [day.date, day]));
  const storeCurrency = result.currency ?? account.currency;

  return sales.map((day) => {
    const costs = costByDay.get(day.date);
    const raw = rawByDay.get(day.date);
    return {
      day: day.date,
      revenue: day.revenue,
      orders_count: day.orders,
      units_sold: day.units,
      attributed_orders: day.attributedOrders,
      attributed_revenue: day.attributedRevenue,
      refunds_amount: day.refunds,
      product_cost: costs?.product ?? 0,
      payment_fees: costs?.fees ?? 0,
      shipping_cost: costs?.shipping ?? 0,
      revenue_share_base: 0,
      revenue_share_amount: 0,
      revenue_store: raw?.revenue ?? day.revenue,
      refunds_store: raw?.refunds ?? day.refunds,
      attributed_revenue_store: raw?.attributedRevenue ?? day.attributedRevenue,
      store_currency: storeCurrency,
    };
  });
}

function assertReportingSourceSyncable(
  account: AdAccount,
  source: CanonicalReportingSource,
): void {
  if (source.adAccountId !== account.id || source.clientId !== account.client_id) {
    throw new Error("A V2 reporting source does not match its requested account.");
  }
  const roleMatchesSource =
    account.reporting_role === "legacy_hybrid" ||
    (account.reporting_role === "shopify_anchor" && Boolean(source.shopify)) ||
    (account.reporting_role === "google_spend" && !source.shopify && Boolean(source.googleAds));
  if (!roleMatchesSource) {
    throw new Error("A V2 reporting source does not match its account role.");
  }
  if (
    source.shopify &&
    (source.group.shopifyAnchorBindingId !== source.bindingId ||
      source.group.shopifyAnchorAdAccountId !== source.adAccountId)
  ) {
    throw new Error("A Google child cannot read its Shopify anchor.");
  }
  // Currency must be VERIFIED, not equal: a Google account billing in USD is
  // syncable because syncReportingSourceWindow converts every money column to
  // the reporting currency with the day's ECB rate. Unknown currency stays a
  // hard stop — conversion cannot start from a currency nobody has confirmed.
  if (
    source.googleAds &&
    (!source.googleAds.currency || !source.googleAds.timeZone?.trim())
  ) {
    throw new Error("A V2 Google Ads source has incomplete reporting metadata.");
  }
}


async function syncReportingSourceWindow(
  service: Supabase,
  account: AdAccount,
  source: CanonicalReportingSource,
  from: string,
  to: string,
  lifecycle: "active" | "staged" = "active",
): Promise<void> {
  assertReportingSourceSyncable(account, source);

  const existing = await fetchExistingWindow(service, account.id, from, to);
  // A partial source used to be rejected here outright: before the merge
  // carried stored values for a not_applicable family, syncing a
  // legacy_hybrid account whose source lost one side would have zeroed that
  // side's recorded history. mergeDailyMetricFamilies now carries the stored
  // family instead (see its tests), which is exactly what a store handover
  // needs: the old account keeps its Google history while only its Shopify
  // side keeps refreshing.
  const [google, shopify] = await Promise.all([
    reportingFamily(
      "Google",
      account.id,
      source.googleAds
        ? async () => {
            // A latched health-probe failure degrades THIS family only: it
            // fails here so the merge keeps the stored figures, while the
            // other family and the portal stay alive. Clears on the next
            // successful admin test or reconnect.
            if (source.googleAds!.healthError) {
              throw new Error(
                `The bound Google Ads connection is marked unhealthy (${source.googleAds!.healthError}).`,
              );
            }
            const rows = await fetchGoogleReportingDailyMetrics(source, from, to);
            // Google reports money in the ad account's own billing currency;
            // daily_metrics is kept in the reporting currency. Convert every
            // money column with the day's ECB rate, exactly as the Shopify
            // side does. An FX failure fails the family — the sync then keeps
            // the stored figures rather than booking dollars as euros.
            const googleCurrency = source.googleAds!.currency;
            if (!googleCurrency || googleCurrency === account.currency || rows.length === 0) {
              return rows;
            }
            const rates = await fxDailyRates(googleCurrency, account.currency, from, to);
            return rows.map((row) => {
              const rate = rateOn(rates, row.day);
              return {
                ...row,
                ad_spend: row.ad_spend * rate,
                conversion_value: row.conversion_value * rate,
              };
            });
          }
        : null,
    ),
    reportingFamily(
      "Shopify",
      account.id,
      source.shopify
        ? async () => {
            if (source.shopify!.healthError) {
              throw new Error(
                `The bound Shopify connection is marked unhealthy (${source.shopify!.healthError}).`,
              );
            }
            return fetchShopifyReportingDailyMetrics(service, account, source, from, to);
          }
        : null,
    ),
  ]);
  if (
    lifecycle === "staged" &&
    ((source.googleAds && google.state !== "succeeded") ||
      (source.shopify && shopify.state !== "succeeded"))
  ) {
    throw new Error("Every staged reporting family must succeed before its window is committed.");
  }
  const rows = mergeDailyMetricFamilies({
    adAccountId: account.id,
    from,
    to,
    existing,
    google,
    shopify,
    computedAt: new Date().toISOString(),
  });
  if (lifecycle === "staged") {
    // The staged commit RPC (0056) validates its rows against a fixed key
    // whitelist that predates the store-currency columns (0092), and rejects
    // the whole window with "unsupported field" if they are present — which
    // silently killed every staged Shopify sync, i.e. every restage. The
    // staged window carries the reporting-currency figures only; the *_store
    // values are refilled by the normal sync once the source is promoted.
    const stagedRows = rows.map((row) => ({
      ad_account_id: row.ad_account_id,
      day: row.day,
      ad_spend: row.ad_spend,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      conversion_value: row.conversion_value,
      revenue: row.revenue,
      orders_count: row.orders_count,
      units_sold: row.units_sold,
      attributed_orders: row.attributed_orders,
      attributed_revenue: row.attributed_revenue,
      refunds_amount: row.refunds_amount,
      product_cost: row.product_cost,
      payment_fees: row.payment_fees,
      shipping_cost: row.shipping_cost,
      revenue_share_base: row.revenue_share_base,
      revenue_share_amount: row.revenue_share_amount,
      computed_at: row.computed_at,
    }));
    const { data, error } = await service.rpc("commit_client_staged_reporting_metrics", {
      p_binding_id: source.bindingId,
      p_success_from: from,
      p_success_to: to,
      p_rows: stagedRows,
    });
    if (error || data !== source.bindingId) {
      throw error ?? new Error("A staged reporting window was not committed.");
    }
  } else {
    const { error } = await service
      .from("daily_metrics")
      .upsert(rows, { onConflict: "ad_account_id,day" });
    if (error) throw error;
  }

  // Receipts are the rollout gate's evidence, not a best-effort side effect.
  // A rolling deploy where the RPC is absent therefore leaves the binding
  // unready even if compatibility rows were already refreshed.
  for (const [sourceType, family, currency] of [
    ["google_ads", google, source.googleAds?.currency],
    ["shopify", shopify, source.shopify?.currency],
  ] as const) {
    if (family.state !== "succeeded") continue;
    if (!currency) {
      throw new Error("A succeeded V2 reporting family has no source currency.");
    }
    const { data, error: receiptError } = await service.rpc(
      lifecycle === "staged"
        ? "record_client_staged_reporting_sync_success"
        : "record_client_reporting_sync_success",
      {
        p_binding_id: source.bindingId,
        p_source_type: sourceType,
        p_success_from: from,
        p_success_to: to,
        p_source_currency: currency,
        p_row_count: family.rows.length,
      },
    );
    if (receiptError || data !== source.bindingId) {
      throw receiptError ?? new Error("A V2 reporting receipt was not committed.");
    }
  }
}

/**
 * Force-refresh one exact staged binding. The normal active refresh primitive
 * has no staged option, and promotion remains impossible until this call has
 * committed the full window plus every applicable native-currency receipt.
 */
export async function refreshStagedReportingSourceNow(
  bindingId: string,
  opts: {
    client: Supabase;
    from?: string;
    to?: string;
  },
): Promise<void> {
  const source = await resolveStagedReportingSource({
    service: opts.client,
    bindingId,
  });
  const { data, error } = await opts.client
    .from("ad_accounts")
    .select("*")
    .in("id", [source.adAccountId])
    .in("client_id", [source.clientId]);
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw error ?? new Error("The staged reporting account does not exist.");
  }
  const account = data[0] as AdAccount;
  assertReportingSourceSyncable(account, source);
  const from = opts.from ?? isoDay(-BACKFILL_LIMIT_DAYS);
  const to = opts.to ?? isoDay(-1);
  if (from > to || addDays(from, 365) < to) {
    throw new Error("A staged reporting sync window must be between 1 and 366 days.");
  }

  // An abandoned identity retains its immutable read-model rows. On explicit
  // restage, overwrite every older day in bounded chunks before the final
  // 90-day receipt; otherwise historical rows from the prior stage could
  // reappear as soon as the binding is promoted.
  const { data: oldestRows, error: oldestError } = await opts.client
    .from("daily_metrics")
    .select("day")
    .eq("ad_account_id", account.id)
    .order("day", { ascending: true })
    .limit(1);
  if (oldestError) throw oldestError;
  const oldest = oldestRows?.[0]?.day;
  let cursor = oldest && oldest < from ? oldest : from;
  while (cursor < from) {
    const chunkTo = [addDays(cursor, 365), dayBefore(from)].sort()[0];
    await syncReportingSourceWindow(
      opts.client,
      account,
      source,
      cursor,
      chunkTo,
      "staged",
    );
    cursor = addDays(chunkTo, 1);
  }
  await syncReportingSourceWindow(opts.client, account, source, from, to, "staged");
}

/**
 * Force-refresh exact active V2 bindings through a service-role client.
 * This is the narrow primitive used by rollout verification and by portal
 * routes once they have scoped account ids to the signed-in workspace.
 */
export async function refreshReportingSourcesNow(
  accountIds: string[],
  opts: {
    client: Supabase;
    from?: string;
    to?: string;
  },
): Promise<void> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return;
  const { data, error } = await opts.client.from("ad_accounts").select("*").in("id", ids);
  if (error) throw error;
  const accounts = (data as AdAccount[] | null) ?? [];
  const foundIds = new Set(accounts.map((account) => account.id));
  if (accounts.length !== ids.length || ids.some((id) => !foundIds.has(id))) {
    throw new Error("A requested reporting account does not exist.");
  }
  const scope = await resolveRequestedReportingSources(opts.client, accounts);
  assertCompleteReportingScope(scope);
  const byId = new Map(scope.accounts.map((account) => [account.id, account]));
  // The explicit pre-cutover primitive must cover the activation gate's full
  // parity horizon; normal incremental refreshes remain seven days below.
  const from = opts.from ?? isoDay(-BACKFILL_LIMIT_DAYS);
  const to = opts.to ?? isoDay(0);

  // Validate the complete graph before any adapter starts. This prevents a
  // malformed second source from turning an exact refresh into partial work.
  for (const source of scope.sources) {
    const account = byId.get(source.adAccountId);
    if (!account) throw new Error("A bound reporting account is missing.");
    assertReportingSourceSyncable(account, source);
  }

  await Promise.all(
    scope.sources.map((source) => {
      const account = byId.get(source.adAccountId);
      if (!account) throw new Error("A bound reporting account is missing.");
      return syncReportingSourceWindow(opts.client, account, source, from, to);
    }),
  );
}

/** Pulls [from, to] from Google + Shopify for one account and upserts it. */
async function syncAccountWindow(
  supabase: Supabase,
  account: AdAccount,
  secret: SecretColumns | undefined,
  from: string,
  to: string,
): Promise<void> {
  if (
    account.google_ads_connected &&
    (!account.google_ads_customer_id || !secret?.google_ads_refresh_token)
  ) {
    throw new Error("A connected legacy Google Ads source has no credential.");
  }
  if (
    account.shopify_connected &&
    (!account.shopify_url || !secret?.shopify_admin_token)
  ) {
    throw new Error("A connected legacy Shopify source has no credential.");
  }

  let google: DailyBreakdown[] = [];
  // Whether Google actually answered for this window. Decides, further down,
  // between "no spend that day" (a real zero) and "we have no idea" (carry the
  // stored figures forward).
  let googleSynced = false;

  if (
    hasGoogleAdsEnv() &&
    account.google_ads_connected &&
    account.google_ads_customer_id &&
    secret?.google_ads_refresh_token
  ) {
    const token = await decryptToken(secret.google_ads_refresh_token);
    try {
      google = await fetchLiveDailyBreakdown(
        account.google_ads_customer_id,
        token,
        from,
        to,
        account.currency,
      );
      googleSynced = true;
    } catch (error) {
      // A revoked authorisation can't be retried, so stop pretending the
      // account is connected — the portal then prompts for a reconnect. Any
      // other Google failure still throws: it may be transient, and swallowing
      // it would let the carry-forward below quietly stand in for real data.
      if (!(await markIfAuthRevoked(supabase, account.id, error))) throw error;
    }
  }

  let sales: DailySales[] = [];
  let shopifySynced = false;
  // The revenue side in the store's own currency (pre-FX) — the untouched
  // Shopify figures, kept so the read side can show the exact number and convert
  // for a EUR total. Populated below when Shopify answers.
  let rawSalesByDay = new Map<string, DailySales>();
  let storeCurrency = account.currency;
  // Per-day cost chain (reporting currency): COGS, payment fees, shipping.
  const costByDay = new Map<string, { product: number; fees: number; shipping: number }>();
  // Per-day revenue share (reporting currency): base revenue + billed amount.
  const revShareByDay = new Map<string, { base: number; amount: number }>();

  if (account.shopify_connected && account.shopify_url && secret?.shopify_admin_token) {
    // The stored credential may be a direct shpat_ token or the app's shpss_
    // secret; resolveAdminToken exchanges the latter (cached ~24h).
    const credential = await decryptToken(secret.shopify_admin_token);
    const token = await resolveAdminToken(
      account.shopify_url,
      credential,
      account.shopify_client_id,
    );
    const result = await fetchDailySales(account.shopify_url, token, from, to);
    sales = result.days;
    shopifySynced = true;
    // Capture the raw store-currency figures before the FX pass below rewrites
    // `sales` into EUR.
    rawSalesByDay = new Map(result.days.map((day) => [day.date, day]));
    storeCurrency = result.currency ?? account.currency;

    // Order amounts arrive in the STORE's base currency; daily_metrics is
    // kept in the account's reporting currency. Convert with the day's ECB
    // rate. An FX failure throws — this account's sync skips rather than
    // booking forints as euros.
    const needsFx = Boolean(result.currency && result.currency !== account.currency);
    const rates =
      needsFx && (sales.length > 0 || result.orders.length > 0)
        ? await fxDailyRates(result.currency!, account.currency, from, to)
        : null;
    if (rates) {
      sales = sales.map((day) => {
        const rate = rateOn(rates, day.date);
        // Every MONEY field, attributedRevenue included — miss one and a store
        // billing in forints reports that column as if it were euros. Counts
        // (orders, units, attributedOrders) are deliberately untouched.
        return {
          ...day,
          revenue: day.revenue * rate,
          refunds: day.refunds * rate,
          attributedRevenue: day.attributedRevenue * rate,
        };
      });
    }

    // ---- COGS + fees, per ORDER (tiers depend on units bought together) ---
    // The principle: none of this touches revenue. It only writes the cost
    // columns, so a cost edit moves profit by exactly the cost delta.
    if (result.orders.length > 0) {
      await registerSoldProducts(supabase, account.id, result.orders, result.currency ?? account.currency);
      const ctx = await loadCostContext(
        supabase,
        account.id,
        Number(account.default_product_cost_pct),
        account.currency,
      );

      for (const order of result.orders as SyncedOrder[]) {
        const rate = rates ? rateOn(rates, order.date) : 1;
        const lines = order.lines.map((line) => ({
          productKey: line.productKey,
          quantity: line.quantity,
          unitPrice: line.unitPrice * rate,
        }));

        const entry = costByDay.get(order.date) ?? { product: 0, fees: 0, shipping: 0 };
        entry.product += orderCogs(lines, order.date, ctx);
        entry.fees += paymentFee(
          order.total * rate,
          Number(account.payment_fee_pct),
          Number(account.payment_fee_fixed),
        );
        entry.shipping += Number(account.shipping_cost_per_order);
        costByDay.set(order.date, entry);
      }

      // The supplier's per-order import duty, for stores bought through HST.
      await addHstTariffs({
        service: supabase,
        adAccountId: account.id,
        from,
        to,
        reportingCurrency: account.currency,
        costByDay,
      });

      // For an HST store, replace the per-product COGS estimate with the
      // supplier's actual per-order cost, on the store's own days. No-op
      // elsewhere and until 0091 has stored our_cost.
      if (account.hst_shop_id) {
        await applyHstOrderCosts({
          service: supabase,
          adAccountId: account.id,
          from,
          to,
          reportingCurrency: account.currency,
          timeZone: result.timeZone || "UTC",
          costByDay,
        });
      }
    }

    // ---- revenue share (collection-based), reporting currency -------------
    // Deals come from the Google Ads campaign NAMES (collection URL + rate);
    // attribution is by collection membership or landing page. Fully isolated:
    // a failure here never blocks the revenue/COGS rollup.
    if (
      account.revenue_share_enabled &&
      result.orders.length > 0 &&
      hasGoogleAdsEnv() &&
      account.google_ads_connected &&
      account.google_ads_customer_id &&
      secret?.google_ads_refresh_token
    ) {
      try {
        const googleToken = await decryptToken(secret.google_ads_refresh_token);
        const names = await fetchCampaignNames(account.google_ads_customer_id, googleToken);
        const dealMap = dealsFromCampaigns(names);

        if (dealMap.size > 0) {
          const deals: AttributionDeal[] = [];
          for (const deal of dealMap.values()) {
            const productKeys = await fetchCollectionProductKeys(
              account.shopify_url!,
              token,
              deal.handle,
            );
            deals.push({ ...deal, productKeys });
          }

          for (const order of result.orders as SyncedOrder[]) {
            // The revenue share is billed on PAID revenue only.
            if (!order.paid) continue;
            const rate = rates ? rateOn(rates, order.date) : 1;
            const attributed = orderRevShare(
              {
                total: order.total * rate,
                landingPath: order.landingPath,
                lines: order.lines.map((line) => ({
                  productKey: line.productKey,
                  revenue: line.unitPrice * line.quantity * rate,
                })),
              },
              deals,
            );
            if (attributed.amount <= 0 && attributed.base <= 0) continue;
            const entry = revShareByDay.get(order.date) ?? { base: 0, amount: 0 };
            entry.base += attributed.base;
            entry.amount += attributed.amount;
            revShareByDay.set(order.date, entry);
          }
        }
      } catch (error) {
        console.error(`revenue-share sync failed for ${account.id}:`, error);
      }
    }
  }

  // A successful empty response proves a real zero only for that family.
  // Never let Shopify activity manufacture Google zeroes (or vice versa)
  // while a connected provider is unavailable.
  if (
    (account.google_ads_connected && !googleSynced) ||
    (account.shopify_connected && !shopifySynced) ||
    (!googleSynced && !shopifySynced)
  ) {
    return;
  }

  const salesByDay = new Map(sales.map((day) => [day.date, day]));
  const googleByDay = new Map(google.map((day) => [day.date, day]));
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);

  /**
   * Ad figures already stored for this window, read ONLY when Google didn't
   * answer.
   *
   * The upsert below replaces whole rows, so a Shopify-only pass would write
   * ad_spend 0 over spend that was synced correctly last week — and the
   * commission ledger and the weekly invoice are both built on that number.
   * A store that is Shopify-connected but not Google-connected legitimately
   * has zero spend; a store whose authorisation just expired does not, and
   * from here the two are indistinguishable. So when we didn't ask Google,
   * we keep what we last knew rather than asserting a zero.
   */
  const carried = new Map<string, DailyMetricAdColumns>();
  if (!googleSynced) {
    const { data } = await supabase
      .from("daily_metrics")
      .select("day, ad_spend, impressions, clicks, conversions, conversion_value")
      .eq("ad_account_id", account.id)
      .gte("day", from)
      .lte("day", to);

    for (const row of data ?? []) {
      carried.set(row.day, {
        ad_spend: Number(row.ad_spend),
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        conversions: Number(row.conversions),
        conversion_value: Number(row.conversion_value),
      });
    }
  }

  const rows = days.map((day) => {
    const ads = googleByDay.get(day);
    const shop = salesByDay.get(day);
    const costs = costByDay.get(day);
    const rev = revShareByDay.get(day);
    const raw = rawSalesByDay.get(day);
    // Empty whenever Google DID answer, so a genuine no-spend day still
    // resolves to 0 rather than resurrecting an older figure.
    const prior = carried.get(day);
    return {
      ad_account_id: account.id,
      day,
      ad_spend: ads?.spend ?? prior?.ad_spend ?? 0,
      impressions: ads?.impressions ?? prior?.impressions ?? 0,
      clicks: ads?.clicks ?? prior?.clicks ?? 0,
      conversions: ads?.conversions ?? prior?.conversions ?? 0,
      conversion_value: ads?.conversionValue ?? prior?.conversion_value ?? 0,
      revenue: shop?.revenue ?? 0,
      orders_count: shop?.orders ?? 0,
      // Units, not money — the FX pass above leaves it alone on purpose.
      units_sold: shop?.units ?? 0,
      // Orders minus the ones Instagram/Facebook referred: the conversions
      // figure the store cards show beside Google ad spend. A day Shopify did
      // not answer for writes 0, not null — null is reserved for "never
      // computed", which is what the backfill below looks for.
      attributed_orders: shop?.attributedOrders ?? 0,
      attributed_revenue: shop?.attributedRevenue ?? 0,
      refunds_amount: shop?.refunds ?? 0,
      product_cost: costs?.product ?? 0,
      payment_fees: costs?.fees ?? 0,
      shipping_cost: costs?.shipping ?? 0,
      revenue_share_base: rev?.base ?? 0,
      revenue_share_amount: rev?.amount ?? 0,
      computed_at: new Date().toISOString(),
      // The revenue side in the store's own currency — the exact Shopify figure.
      revenue_store: raw?.revenue ?? shop?.revenue ?? 0,
      refunds_store: raw?.refunds ?? shop?.refunds ?? 0,
      attributed_revenue_store: raw?.attributedRevenue ?? shop?.attributedRevenue ?? 0,
      store_currency: storeCurrency,
    };
  });

  const { error } = await supabase
    .from("daily_metrics")
    .upsert(rows, { onConflict: "ad_account_id,day" });
  if (error) throw error;
}

/**
 * Refresh the recent window for these accounts. Never throws: a dashboard
 * must render with yesterday's numbers rather than die on an upstream error.
 */
export async function recomputeDailyMetrics(
  accounts: AdAccount[],
  opts?: ReportingOptions & {
    /** Ignore both freshness checks — the nightly close wants today final. */
    force?: boolean;
    /**
     * Supabase to work through. Page loads pass nothing and ride the viewer's
     * session; the cron has none and passes the service-role client, because
     * writing daily_metrics requires owning the account or being an admin, and
     * a request with no session is neither.
     */
    client?: Supabase;
  },
): Promise<void> {
  const now = Date.now();
  const candidates = accounts.filter(
    (account) =>
      opts?.force || now - (lastRunByAccount.get(account.id) ?? 0) >= RECOMPUTE_INTERVAL_MS,
  );
  if (candidates.length === 0) return;

  try {
    const supabase = opts?.client ?? (await createClient());
    const service = reportingClient(opts?.reportingClient, supabase);
    const scope = await resolveRuntimeReportingScope(service, candidates);
    const sources = scope.sources;
    const scopedAccounts = [...scope.accounts, ...scope.legacyAccounts];
    const sourceByAccount = new Map(sources.map((source) => [source.adAccountId, source]));
    // Only a receipt-gated reporting cutover lets binding authority win before
    // status/legacy credentials are considered. Historical lifecycle-only
    // `v2_active` clients remain legacy until the purpose-bound marker exists.
    const stale = scopedAccounts.filter(
      (account) => sourceByAccount.has(account.id) || syncable(account),
    );
    if (stale.length === 0) return;

    // Cross-isolate freshness: newest computed_at per account decides.
    const { data: freshRows, error: freshnessError } = opts?.force
      ? { data: [], error: null }
      : await service
          .from("daily_metrics")
          .select("ad_account_id, computed_at")
          .in("ad_account_id", stale.map((account) => account.id))
          .gte("computed_at", new Date(now - RECOMPUTE_INTERVAL_MS).toISOString());
    if (freshnessError) throw freshnessError;
    const fresh = new Set((freshRows ?? []).map((row) => row.ad_account_id));

    const toRun = stale.filter((account) => !fresh.has(account.id));
    for (const account of stale) {
      if (fresh.has(account.id)) lastRunByAccount.set(account.id, now);
    }
    if (toRun.length === 0) return;

    const legacy = toRun.filter((account) => !sourceByAccount.has(account.id));
    const secrets = await fetchSecrets(supabase, legacy.map((account) => account.id));
    const from = isoDay(-(WINDOW_DAYS - 1));
    const to = isoDay(0);

    await Promise.all(
      toRun.map(async (account) => {
        try {
          const source = sourceByAccount.get(account.id);
          if (source) {
            await syncReportingSourceWindow(service, account, source, from, to);
          } else {
            await syncAccountWindow(supabase, account, secrets.get(account.id), from, to);
          }
          lastRunByAccount.set(account.id, Date.now());
        } catch (error) {
          console.error(`daily_metrics recompute failed for ${account.id}:`, error);
        }
      }),
    );
  } catch (error) {
    console.error("daily_metrics recompute failed:", error);
  }
}

/**
 * Full resync of ONE account, bypassing throttle and coverage checks. For the
 * moment a connection is (re)made: coverage and freshness are tracked per
 * ACCOUNT, so an account that already had rows from one source would
 * otherwise never fetch the newly connected source's history — the gap check
 * sees "covered" and the throttle sees "fresh". An explicit connect is the
 * user asking for their data; sync it now, back to the backfill horizon.
 *
 * Throws on failure — the caller is an API route that wants to surface it.
 */
export async function resyncAccountNow(
  accountId: string,
  opts?: ReportingOptions & { client?: Supabase },
): Promise<void> {
  const supabase = opts?.client ?? (await createClient());
  const service = reportingClient(opts?.reportingClient, supabase);

  // V2 bindings are service-only and may deliberately target a pending
  // ad_accounts surrogate. Resolve that authority before reading any legacy
  // token columns or applying the legacy pending-status gate.
  const { data: reportingAccount, error: reportingAccountError } = await service
    .from("ad_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();
  if (reportingAccountError) throw reportingAccountError;
  if (reportingAccount) {
    const scope = await resolveRuntimeReportingScope(
      service,
      [reportingAccount],
    );
    if (scope.sources.length > 0) {
      const byId = new Map(scope.accounts.map((account) => [account.id, account]));
      await Promise.all(
        scope.sources.map((source) => {
          const account = byId.get(source.adAccountId);
          if (!account) throw new Error("A bound reporting account is missing.");
          return syncReportingSourceWindow(
            service,
            account,
            source,
            isoDay(-BACKFILL_LIMIT_DAYS),
            isoDay(0),
          );
        }),
      );
      for (const account of scope.accounts) {
        lastRunByAccount.set(account.id, Date.now());
      }
      return;
    }
  }

  // Unbound accounts keep the original viewer-scoped legacy path.
  const { data: account } = await supabase
    .from("ad_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();
  if (!account || !syncable(account)) return;

  await syncAccountWindow(
    supabase,
    account,
    {
      google_ads_refresh_token: account.google_ads_refresh_token,
      shopify_admin_token: account.shopify_admin_token,
    },
    isoDay(-BACKFILL_LIMIT_DAYS),
    isoDay(0),
  );
  lastRunByAccount.set(accountId, Date.now());
}

/**
 * Force-refresh the RECENT window for a set of accounts NOW, bypassing the
 * 15-minute throttle — this backs the dashboard's "Refresh" button. Lighter
 * than resyncAccountNow: it re-pulls only the incremental window, enough to
 * bring today's revenue and spend current on demand. Never throws per account;
 * one store's upstream hiccup mustn't fail the whole refresh.
 */
export async function refreshAccountsNow(
  accountIds: string[],
  opts?: ReportingOptions & {
    /**
     * Supabase to work through. A page load passes nothing and rides the
     * viewer's session; a caller with no session at all — the keyed daily
     * report — passes the service-role client, since without it every write
     * here is silently refused by RLS and the refresh "succeeds" over nothing.
     */
    client?: Supabase;
    /** Explicit window. Defaults to the rolling incremental one. */
    from?: string;
    to?: string;
  },
): Promise<void> {
  if (accountIds.length === 0) return;
  const supabase = opts?.client ?? (await createClient());
  const service = reportingClient(opts?.reportingClient, supabase);
  const ids = [...new Set(accountIds)];

  const { data: reportingRows, error: reportingRowsError } = await service
    .from("ad_accounts")
    .select("*")
    .in("id", ids);
  if (reportingRowsError) throw reportingRowsError;
  const reportingAccounts = (reportingRows as AdAccount[] | null) ?? [];
  const scope = await resolveRuntimeReportingScope(service, reportingAccounts);
  const sources = scope.sources;
  const scopedReportingAccounts = scope.accounts;
  const sourceByAccount = new Map(sources.map((source) => [source.adAccountId, source]));

  // Legacy rows stay viewer-scoped. A bound id is removed even if the V2
  // upstream later fails, so failure can never trigger a second legacy fetch.
  const { data: legacyRows, error: legacyRowsError } = await supabase
    .from("ad_accounts")
    .select("*")
    .in("id", ids);
  if (legacyRowsError) throw legacyRowsError;
  const legacyAccounts = ((legacyRows ?? []) as AdAccount[]).filter(
    (account) =>
      scope.legacyAccounts.some((legacy) => legacy.id === account.id) &&
      !sourceByAccount.has(account.id) &&
      syncable(account),
  );
  if (sources.length === 0 && legacyAccounts.length === 0) return;

  const from = opts?.from ?? isoDay(-(WINDOW_DAYS - 1));
  const to = opts?.to ?? isoDay(0);
  const reportingById = new Map(
    scopedReportingAccounts.map((account) => [account.id, account]),
  );

  await Promise.all(
    [
      ...sources.map((source) => ({
        account: reportingById.get(source.adAccountId),
        source,
      })),
      ...legacyAccounts.map((account) => ({ account, source: null })),
    ].map(async ({ account, source }) => {
      if (!account) return;
      try {
        if (source) {
          await syncReportingSourceWindow(service, account, source, from, to);
        } else {
          await syncAccountWindow(
            supabase,
            account,
            {
              google_ads_refresh_token: account.google_ads_refresh_token,
              shopify_admin_token: account.shopify_admin_token,
            },
            from,
            to,
          );
        }
        lastRunByAccount.set(account.id, Date.now());
      } catch (error) {
        console.error(`manual refresh failed for ${account.id}:`, error);
      }
    }),
  );
}

// Accounts whose historical Shopify columns this isolate has already re-synced.
const backfillAttempted = new Set<string>();

/**
 * Re-sync days written before a Shopify column existed — units_sold (0016) and
 * attributed_orders (0019).
 *
 * Every pre-aggregated table needs this the moment it gains a column, and
 * neither existing path covers it: the rolling 7-day window heals only recent
 * days, and the coverage backfill fills only days EARLIER than the first row.
 * Every day in between keeps its default forever — which is how the cards came
 * to read "0 sold" over months that plainly had orders.
 *
 * Two markers, both meaning "the sync never wrote this day":
 *   attributed_orders IS NULL — exact, which is why 0019 has no default. 0 is a
 *                               real answer (every order came from Meta).
 *   units_sold = 0 with orders — 0016 does have a default, so this leans on an
 *                               order always carrying at least one line item.
 *
 * Attempted at most once per account per isolate, so a store that somehow does
 * have orders with no line items can't turn this into a re-sync on every load.
 */
async function healShopifyColumns(
  supabase: Supabase,
  accounts: AdAccount[],
  from: string,
): Promise<void> {
  const candidates = accounts.filter(
    (account) => account.shopify_connected && !backfillAttempted.has(account.id),
  );
  if (candidates.length === 0) return;

  const { data, error: queryError } = await supabase
    .from("daily_metrics")
    .select("ad_account_id, day")
    .in("ad_account_id", candidates.map((account) => account.id))
    .gte("day", from)
    .lte("day", isoDay(0))
    .gt("orders_count", 0)
    .or("units_sold.eq.0,attributed_orders.is.null");

  // An error here is almost always a column that does not exist yet, i.e. 0016
  // or 0019 has not been applied. Nothing to heal either way.
  if (queryError || !data || data.length === 0) return;

  // One window per account — first to last stale day, so a month of gaps costs
  // one Shopify pass instead of thirty.
  const spans = new Map<string, { from: string; to: string }>();
  for (const row of data) {
    const span = spans.get(row.ad_account_id);
    if (!span) {
      spans.set(row.ad_account_id, { from: row.day, to: row.day });
      continue;
    }
    if (row.day < span.from) span.from = row.day;
    if (row.day > span.to) span.to = row.day;
  }

  const byId = new Map(candidates.map((account) => [account.id, account]));
  const secrets = await fetchSecrets(supabase, [...spans.keys()]);

  await Promise.all(
    [...spans.entries()].map(async ([accountId, span]) => {
      const account = byId.get(accountId);
      if (!account) return;
      // Marked before the attempt, not after: a store whose sync keeps failing
      // must not re-run a 90-day Shopify pass on every page load.
      backfillAttempted.add(accountId);
      try {
        await syncAccountWindow(supabase, account, secrets.get(accountId), span.from, span.to);
      } catch (error) {
        console.error(`Shopify column backfill failed for ${accountId}:`, error);
      }
    }),
  );
}

/**
 * Backfill so the selected range has history to show. Runs once per gap: the
 * next call finds coverage already reaching `from` and does nothing. Ranges
 * older than BACKFILL_LIMIT_DAYS are served from whatever exists.
 */
export async function ensureDailyCoverage(accounts: AdAccount[], from: string): Promise<void> {
  if (accounts.length === 0) return;

  const floor = isoDay(-BACKFILL_LIMIT_DAYS);
  const start = from < floor ? floor : from;

  try {
    const supabase = await createClient();
    const service = reportingClient(undefined, supabase);
    const scope = await resolveRuntimeReportingScope(service, accounts);
    const sources = scope.sources;
    const scopedAccounts = [...scope.accounts, ...scope.legacyAccounts];
    const sourceByAccount = new Map(sources.map((source) => [source.adAccountId, source]));
    const candidates = scopedAccounts.filter(
      (account) => sourceByAccount.has(account.id) || syncable(account),
    );
    if (candidates.length === 0) return;

    // Days that exist but predate a column — a different problem from days that
    // are missing, so it runs whatever the range is, today-only included.
    await healShopifyColumns(
      supabase,
      candidates.filter((account) => !sourceByAccount.has(account.id)),
      start,
    );

    if (start >= isoDay(0)) return; // today is the recompute window's job

    // Earliest covered day per account, one query.
    const { data: earliestRows, error: earliestError } = await service
      .from("daily_metrics")
      .select("ad_account_id, day")
      .in("ad_account_id", candidates.map((account) => account.id))
      .order("day", { ascending: true });
    if (earliestError) throw earliestError;
    const earliest = new Map<string, string>();
    for (const row of earliestRows ?? []) {
      if (!earliest.has(row.ad_account_id)) earliest.set(row.ad_account_id, row.day);
    }

    const gaps = candidates
      .map((account) => {
        const covered = earliest.get(account.id);
        // No rows at all → fill start..today; rows → fill start..coveredStart-1.
        if (!covered) return { account, from: start, to: isoDay(0) };
        if (start < covered) return { account, from: start, to: dayBefore(covered) };
        return null;
      })
      .filter((gap): gap is NonNullable<typeof gap> => gap !== null && gap.from <= gap.to);
    if (gaps.length === 0) return;

    const secrets = await fetchSecrets(
      supabase,
      gaps
        .filter((gap) => !sourceByAccount.has(gap.account.id))
        .map((gap) => gap.account.id),
    );

    await Promise.all(
      gaps.map(async ({ account, from: gapFrom, to: gapTo }) => {
        try {
          const source = sourceByAccount.get(account.id);
          if (source) {
            await syncReportingSourceWindow(service, account, source, gapFrom, gapTo);
          } else {
            await syncAccountWindow(
              supabase,
              account,
              secrets.get(account.id),
              gapFrom,
              gapTo,
            );
          }
        } catch (error) {
          console.error(`daily_metrics backfill failed for ${account.id}:`, error);
        }
      }),
    );
  } catch (error) {
    console.error("daily_metrics backfill failed:", error);
  }
}
