import "server-only";

import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import {
  fetchLiveCampaignsDetailed,
  fetchLiveGoogleDemandGenBreakdowns,
  fetchLiveGooglePmaxProductBreakdowns,
  type GoogleCampaignBreakdownRow,
  type LiveCampaign,
} from "@/lib/google-ads/portal";
import type { AdminStoreOverview } from "@/lib/admin/client-overview";
import {
  listCampaignActionActivity,
} from "@/lib/admin/campaign-actions";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";
import type { RangeSelection } from "@/lib/portal/range";
import { refreshAccountsNow } from "@/lib/metrics/recompute";
import {
  fetchGoogleReportingCampaigns,
  fetchGoogleReportingDemandGenAds,
  fetchGoogleReportingPmaxProducts,
} from "@/lib/reporting/google";
import {
  createLegacyShopifyReportingAdapter,
  createShopifyReportingAdapter,
  ShopifyReportingAdapterError,
  type ShopifyCampaignAttribution,
  type ShopifyCampaignProductAttribution,
  type ShopifyReportingAdapter,
} from "@/lib/reporting/shopify";
import {
  resolveReportingSources,
  type CanonicalReportingSource,
} from "@/lib/reporting/sources";
import { createServiceClient } from "@/lib/supabase/service";
import { hasWindsorEnv } from "@/lib/windsor/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROLLOUT_SURFACES = new Set([
  "legacy_only",
  "v2_onboarding",
  "v2_ready_for_cutover",
  "v2_active",
  "rollback_legacy",
]);

export type AdminAnalyticsFamily<T> =
  | { state: "ready" | "empty"; data: T; message?: string | null }
  | { state: "unavailable" | "failed"; message: string };

export type AdminAnalyticsFunnelDay = {
  day: string;
  sessions: number;
  addedToCart: number;
  reachedCheckout: number;
  completedCheckout: number;
};

export type AdminAnalyticsCampaignBreakdownRow = {
  provider: "google_ads" | "shopify";
  kind: "creative" | "product";
  id: string;
  name: string;
  detail: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  googleRevenue: number | null;
  shopifyProductId: string | null;
  shopifyUnits: number | null;
  /** campaign_products exposes net units, not product-level revenue. */
  shopifyRevenue: number | null;
};

export type AdminAnalyticsCampaignBreakdownSource = {
  provider: "google_ads" | "shopify";
  source:
    | "demand_gen_ads"
    | "pmax_products"
    | "campaign_products"
    | "unsupported_campaign_type";
  state: "ready" | "empty" | "unavailable" | "failed";
  reason: string | null;
};

export type AdminAnalyticsCampaignBreakdown =
  | {
      state: "ready" | "empty";
      rows: AdminAnalyticsCampaignBreakdownRow[];
      sources: AdminAnalyticsCampaignBreakdownSource[];
      reason: null;
    }
  | {
      state: "unavailable" | "failed";
      rows: [];
      sources: AdminAnalyticsCampaignBreakdownSource[];
      reason: string;
    };

export type AdminAnalyticsCampaign = {
  accountId: string;
  campaignId: string;
  name: string;
  status: string | null;
  type: string | null;
  shoppingFeed: boolean;
  budget: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  googleRevenue: number;
  shopifySessions: number | null;
  shopifyOrders: number | null;
  shopifyRevenue: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  googleRoas: number | null;
  realRoas: number | null;
  attributionState: "matched" | "unmatched" | "unavailable";
  breakdown: AdminAnalyticsCampaignBreakdown;
};

export type AdminAnalyticsCollectionProduct = {
  productId: string;
  title: string;
  revenue: number;
  units: number;
  spend?: number | null;
  roas?: number | null;
};

export type AdminAnalyticsCollection = {
  collectionId: string;
  title: string;
  products: AdminAnalyticsCollectionProduct[];
  revenue: number;
  units: number;
  spend: number | null;
  roas: number | null;
};

export type AdminStoreAnalytics = {
  clientId: string;
  storeAccountId: string;
  currency: string;
  range: { from: string; to: string };
  funnel: AdminAnalyticsFamily<{
    daily: AdminAnalyticsFunnelDay[];
    totals: {
      sessions: number;
      addedToCart: number;
      reachedCheckout: number;
      completedCheckout: number;
    };
  }>;
  campaigns: AdminAnalyticsFamily<{ rows: AdminAnalyticsCampaign[] }>;
  collections: AdminAnalyticsFamily<{ rows: AdminAnalyticsCollection[] }>;
  spend: AdminAnalyticsFamily<{ daily: Array<{ day: string; spend: number }> }>;
  rollupCoverage: AdminAnalyticsFamily<{ dayCount: number; refreshed: boolean }>;
  activity: AdminAnalyticsFamily<{
    rows: CampaignActionHistory[];
    truncated: boolean;
  }>;
};

export type FetchAdminStoreAnalyticsInput = {
  clientId: string;
  store: Pick<
    AdminStoreOverview,
    "accountId" | "activityAccountIds" | "currency" | "days"
  >;
  range: Pick<RangeSelection, "from" | "to">;
};

export type EnsureAdminAnalyticsRollupCoverageInput = {
  clientId: string;
  stores: Array<
    Pick<AdminStoreOverview, "accountId" | "activityAccountIds" | "currency">
  >;
  range: Pick<RangeSelection, "from" | "to">;
};

type StoreAccountRow = {
  id: string;
  client_id: string;
  currency: string;
  shopify_url: string | null;
  shopify_connected: boolean;
  shopify_client_id: string | null;
  shopify_admin_token: string | null;
  google_ads_customer_id: string | null;
  google_ads_refresh_token: string | null;
  google_ads_connected: boolean;
};

type StoreTopology =
  | {
      kind: "v2";
      service: NonNullable<ReturnType<typeof createServiceClient>>;
      anchor: CanonicalReportingSource;
      googleSources: CanonicalReportingSource[];
    }
  | {
      kind: "legacy";
      service: NonNullable<ReturnType<typeof createServiceClient>>;
      account: StoreAccountRow;
    };

type Attempt<T> =
  | { ok: true; value: T; message?: string | null }
  | { ok: false; state: "unavailable" | "failed"; message: string };

function isDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertInput(
  input: Pick<FetchAdminStoreAnalyticsInput, "clientId" | "range"> & {
    store: Pick<AdminStoreOverview, "accountId" | "activityAccountIds" | "currency">;
  },
) {
  if (
    !UUID.test(input.clientId) ||
    !UUID.test(input.store.accountId) ||
    input.store.activityAccountIds.length === 0 ||
    input.store.activityAccountIds.some((id) => !UUID.test(id)) ||
    !input.store.activityAccountIds.includes(input.store.accountId) ||
    !/^[A-Z]{3}$/.test(input.store.currency) ||
    !isDay(input.range.from) ||
    !isDay(input.range.to) ||
    input.range.from > input.range.to
  ) {
    throw new Error("The selected analytics scope is invalid.");
  }
}

function readyOrEmpty<T>(data: T, empty: boolean): AdminAnalyticsFamily<T> {
  return { state: empty ? "empty" : "ready", data, message: null };
}

function failed<T>(message: string): AdminAnalyticsFamily<T> {
  return { state: "failed", message };
}

function unavailable<T>(message: string): AdminAnalyticsFamily<T> {
  return { state: "unavailable", message };
}

function shopifyFailure<T>(error: unknown, operation: string): AdminAnalyticsFamily<T> {
  if (
    error instanceof ShopifyReportingAdapterError &&
    error.code === "missing_scope"
  ) {
    return unavailable(`Shopify has not granted the read-only scope required for ${operation}.`);
  }
  return failed(`Shopify could not load ${operation} for the selected period.`);
}

async function loadTopology(
  input: FetchAdminStoreAnalyticsInput,
): Promise<StoreTopology> {
  const service = createServiceClient();
  if (!service) throw new Error("The analytics reporting service is unavailable.");
  const accountIds = [...new Set(input.store.activityAccountIds)];
  const [accountsResult, rolloutResult] = await Promise.all([
    service
      .from("ad_accounts")
      .select(
        "id, client_id, currency, shopify_url, shopify_connected, shopify_client_id, shopify_admin_token, google_ads_customer_id, google_ads_refresh_token, google_ads_connected",
      )
      .in("id", accountIds),
    service
      .from("client_rollout_states")
      .select(
        "operational_surface, reporting_cutover_at, reporting_cutover_by, reporting_cutover_reason",
      )
      .eq("client_id", input.clientId)
      .maybeSingle(),
  ]);
  if (accountsResult.error || rolloutResult.error || !Array.isArray(accountsResult.data)) {
    throw new Error("The selected analytics scope could not be verified.");
  }
  const accounts = accountsResult.data as StoreAccountRow[];
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  if (
    accounts.length !== accountIds.length ||
    accounts.some(
      (account) =>
        account.client_id !== input.clientId ||
        account.currency !== input.store.currency,
    ) ||
    accountIds.some((id) => !accountById.has(id))
  ) {
    throw new Error("The selected analytics scope does not belong to this client.");
  }

  const rollout = rolloutResult.data;
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
    throw new Error("The client analytics rollout is inconsistent.");
  }
  const v2Active =
    rollout?.operational_surface === "v2_active" && markerComplete;

  if (!v2Active) {
    if (accountIds.length !== 1 || accountIds[0] !== input.store.accountId) {
      throw new Error("The legacy analytics scope is inconsistent.");
    }
    const account = accountById.get(input.store.accountId);
    if (!account) throw new Error("The selected store is unavailable.");
    return { kind: "legacy", service, account };
  }

  const sources = await resolveReportingSources({
    service,
    adAccountIds: accountIds,
    includeShopifyCredentials: true,
  });
  const allowedIds = new Set(accountIds);
  if (
    sources.length !== accountIds.length ||
    sources.some(
      (source) =>
        source.clientId !== input.clientId ||
        !allowedIds.has(source.adAccountId),
    )
  ) {
    throw new Error("The normalized analytics topology is incomplete.");
  }
  const anchors = sources.filter(
    (source) =>
      source.adAccountId === input.store.accountId &&
      source.shopify !== null &&
      source.group.shopifyAnchorBindingId === source.bindingId &&
      source.group.shopifyAnchorAdAccountId === source.adAccountId,
  );
  if (anchors.length !== 1) {
    throw new Error("The normalized store anchor is unavailable.");
  }
  const anchor = anchors[0];
  if (
    !anchor.shopify ||
    sources.some(
      (source) =>
        source.group.shopifyAnchorBindingId !== anchor.bindingId ||
        source.group.shopifyAnchorAdAccountId !== anchor.adAccountId,
    )
  ) {
    throw new Error("The normalized store group is inconsistent.");
  }
  return {
    kind: "v2",
    service,
    anchor,
    googleSources: sources.filter((source) => source.googleAds !== null),
  };
}

async function openShopify(topology: StoreTopology): Promise<Attempt<ShopifyReportingAdapter>> {
  try {
    if (topology.kind === "v2") {
      return { ok: true, value: await createShopifyReportingAdapter(topology.anchor) };
    }
    const account = topology.account;
    if (
      !account.shopify_connected ||
      !account.shopify_url ||
      !account.shopify_admin_token
    ) {
      return {
        ok: false,
        state: "unavailable",
        message: "This store has no connected Shopify reporting source.",
      };
    }
    return {
      ok: true,
      value: await createLegacyShopifyReportingAdapter({
        clientId: account.client_id,
        adAccountId: account.id,
        shopDomain: account.shopify_url,
        currency: account.currency,
        shopifyClientId: account.shopify_client_id,
        credentialCiphertext: account.shopify_admin_token,
      }),
    };
  } catch {
    return {
      ok: false,
      state: "failed",
      message: "The selected Shopify reporting connection could not be verified.",
    };
  }
}

async function loadGoogleCampaigns(
  topology: StoreTopology,
  range: Pick<RangeSelection, "from" | "to">,
): Promise<Attempt<LiveCampaign[]>> {
  if (topology.kind === "v2") {
    if (!hasWindsorEnv() || topology.googleSources.length === 0) {
      return {
        ok: false,
        state: "unavailable",
        message: "This store has no available Google Ads reporting source.",
      };
    }
    try {
      const results = await Promise.allSettled(
        topology.googleSources.map((source) =>
          fetchGoogleReportingCampaigns(source, range.from, range.to),
        ),
      );
      const succeeded = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []);
      if (succeeded.length === 0) {
        return {
          ok: false,
          state: "failed",
          message: "Google Ads could not load campaigns for the selected period.",
        };
      }
      return {
        ok: true,
        value: succeeded
          .flat()
          .sort((left, right) => right.spend - left.spend || left.id.localeCompare(right.id)),
        message: succeeded.length === results.length
          ? null
          : "Some Google Ads accounts could not load campaigns for the selected period.",
      };
    } catch {
      return {
        ok: false,
        state: "failed",
        message: "Google Ads could not load every campaign for the selected period.",
      };
    }
  }

  const account = topology.account;
  if (
    !hasGoogleAdsEnv() ||
    !account.google_ads_connected ||
    !account.google_ads_customer_id ||
    !account.google_ads_refresh_token
  ) {
    return {
      ok: false,
      state: "unavailable",
      message: "This store has no available Google Ads reporting source.",
    };
  }
  try {
    const refreshToken = await decryptToken(account.google_ads_refresh_token);
    return {
      ok: true,
      value: await fetchLiveCampaignsDetailed(
        account.google_ads_customer_id,
        refreshToken,
        account.id,
        range as RangeSelection,
        account.currency,
      ),
    };
  } catch {
    return {
      ok: false,
      state: "failed",
      message: "Google Ads could not load campaigns for the selected period.",
    };
  }
}

type GoogleBreakdownAccountAttempts = {
  creative: Attempt<GoogleCampaignBreakdownRow[]>;
  product: Attempt<GoogleCampaignBreakdownRow[]>;
};

type GoogleBreakdownAttempts = Map<string, GoogleBreakdownAccountAttempts>;

function breakdownAttempt<T>(
  result: PromiseSettledResult<T>,
  message: string,
): Attempt<T> {
  return result.status === "fulfilled"
    ? { ok: true, value: result.value }
    : { ok: false, state: "failed", message };
}

async function loadGoogleBreakdowns(
  topology: StoreTopology,
  range: Pick<RangeSelection, "from" | "to">,
): Promise<GoogleBreakdownAttempts> {
  if (topology.kind === "v2") {
    if (!hasWindsorEnv()) {
      return new Map(
        topology.googleSources.map((source) => [
          source.adAccountId,
          {
            creative: {
              ok: false as const,
              state: "unavailable" as const,
              message: "Windsor is not configured for Demand Gen ad reporting.",
            },
            product: {
              ok: false as const,
              state: "unavailable" as const,
              message: "Windsor is not configured for PMax product reporting.",
            },
          },
        ]),
      );
    }
    const results = await Promise.all(
      topology.googleSources.map(async (source) => {
        const [creative, product] = await Promise.allSettled([
          fetchGoogleReportingDemandGenAds(source, range.from, range.to),
          fetchGoogleReportingPmaxProducts(source, range.from, range.to),
        ]);
        return [
          source.adAccountId,
          {
            creative: breakdownAttempt(
              creative,
              "Windsor could not load Demand Gen ads for this account.",
            ),
            product: breakdownAttempt(
              product,
              "Windsor could not load PMax products for this account.",
            ),
          },
        ] as const;
      }),
    );
    return new Map(results);
  }

  const account = topology.account;
  if (
    !hasGoogleAdsEnv() ||
    !account.google_ads_connected ||
    !account.google_ads_customer_id ||
    !account.google_ads_refresh_token
  ) {
    return new Map([
      [
        account.id,
        {
          creative: {
            ok: false,
            state: "unavailable",
            message: "This account has no available Demand Gen ad source.",
          },
          product: {
            ok: false,
            state: "unavailable",
            message: "This account has no available PMax product source.",
          },
        },
      ],
    ]);
  }
  try {
    const refreshToken = await decryptToken(account.google_ads_refresh_token);
    const [creative, product] = await Promise.allSettled([
      fetchLiveGoogleDemandGenBreakdowns(
        account.google_ads_customer_id,
        refreshToken,
        account.id,
        range,
      ),
      fetchLiveGooglePmaxProductBreakdowns(
        account.google_ads_customer_id,
        refreshToken,
        account.id,
        range,
      ),
    ]);
    return new Map([
      [
        account.id,
        {
          creative: breakdownAttempt(
            creative,
            "Google Ads could not load Demand Gen ads for this account.",
          ),
          product: breakdownAttempt(
            product,
            "Google Ads could not load PMax products for this account.",
          ),
        },
      ],
    ]);
  } catch {
    return new Map([
      [
        account.id,
        {
          creative: {
            ok: false,
            state: "failed",
            message: "Google Ads could not verify the Demand Gen ad source.",
          },
          product: {
            ok: false,
            state: "failed",
            message: "Google Ads could not verify the PMax product source.",
          },
        },
      ],
    ]);
  }
}

type DailySpendRow = {
  ad_account_id: string;
  day: string;
  ad_spend: number | string;
  attributed_revenue: number | string | null;
  attributed_orders: number | string | null;
  computed_at: string | null;
};

function rangeDays(
  range: Pick<RangeSelection, "from" | "to">,
): string[] {
  const days: string[] = [];
  const cursor = new Date(`${range.from}T00:00:00.000Z`);
  const end = new Date(`${range.to}T00:00:00.000Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

async function readSpendRows(
  topology: StoreTopology,
  accountIds: string[],
  range: Pick<RangeSelection, "from" | "to">,
): Promise<DailySpendRow[]> {
  const { data, error } = await topology.service
    .from("daily_metrics")
    .select(
      "ad_account_id, day, ad_spend, attributed_revenue, attributed_orders, computed_at",
    )
    .in("ad_account_id", accountIds)
    .gte("day", range.from)
    .lte("day", range.to);
  if (error || !Array.isArray(data)) {
    throw new Error("The exact spend window could not be read.");
  }
  return data as DailySpendRow[];
}

function projectCompleteRollup(
  rows: DailySpendRow[],
  accountIds: string[],
  days: string[],
  revenueAccountId: string,
  refreshed: boolean,
): Pick<AdminStoreAnalytics, "spend" | "rollupCoverage"> | null {
  const allowedAccounts = new Set(accountIds);
  const expected = new Set(
    accountIds.flatMap((accountId) => days.map((day) => `${accountId}\u0000${day}`)),
  );
  const seen = new Set<string>();
  const byDay = new Map(days.map((day) => [day, 0]));
  for (const row of rows) {
    const spend = Number(row.ad_spend);
    const computedAt = row.computed_at ? Date.parse(row.computed_at) : Number.NaN;
    const key = `${row.ad_account_id}\u0000${row.day}`;
    if (
      !allowedAccounts.has(row.ad_account_id) ||
      !byDay.has(row.day) ||
      seen.has(key) ||
      !Number.isFinite(spend) ||
      spend < 0 ||
      !Number.isFinite(computedAt)
    ) {
      return null;
    }
    if (row.ad_account_id === revenueAccountId) {
      const revenue = Number(row.attributed_revenue);
      const orders = Number(row.attributed_orders);
      if (
        row.attributed_revenue === null ||
        row.attributed_orders === null ||
        !Number.isFinite(revenue) ||
        !Number.isSafeInteger(orders) ||
        orders < 0
      ) {
        return null;
      }
    }
    seen.add(key);
    byDay.set(row.day, byDay.get(row.day)! + spend);
  }
  if (seen.size !== expected.size || [...expected].some((key) => !seen.has(key))) {
    return null;
  }
  return {
    spend: {
      state: "ready",
      data: { daily: [...byDay].map(([day, spend]) => ({ day, spend })) },
      message: refreshed
        ? "The exact spend window was materialised on demand."
        : null,
    },
    rollupCoverage: {
      state: "ready",
      data: { dayCount: days.length, refreshed },
      message: refreshed
        ? "Shopify revenue and Google spend coverage were verified after an on-demand refresh."
        : "Shopify revenue and Google spend coverage are verified for the exact selected period.",
    },
  };
}

async function rollupFamilies(
  topology: StoreTopology,
  accountIds: string[],
  range: Pick<RangeSelection, "from" | "to">,
): Promise<Pick<AdminStoreAnalytics, "spend" | "rollupCoverage">> {
  const days = rangeDays(range);
  const revenueAccountId = topology.kind === "v2"
    ? topology.anchor.adAccountId
    : topology.account.id;
  try {
    let rows = await readSpendRows(topology, accountIds, range);
    const current = projectCompleteRollup(
      rows,
      accountIds,
      days,
      revenueAccountId,
      false,
    );
    if (current) return current;

    await refreshAccountsNow(accountIds, {
      client: topology.service,
      reportingClient: topology.service,
      from: range.from,
      to: range.to,
    });
    rows = await readSpendRows(topology, accountIds, range);
    return projectCompleteRollup(
      rows,
      accountIds,
      days,
      revenueAccountId,
      true,
    ) ?? {
      spend: failed(
        "Spend is incomplete because the selected period could not be fully materialised.",
      ),
      rollupCoverage: failed(
        "Shopify revenue and Google spend coverage could not be proved for every selected day.",
      ),
    };
  } catch {
    return {
      spend: failed("Spend could not be loaded for the complete selected period."),
      rollupCoverage: failed(
        "The selected-period Shopify revenue and Google spend coverage could not be verified.",
      ),
    };
  }
}

function campaignBreakdown(
  campaign: LiveCampaign,
  googleAttempts: GoogleBreakdownAccountAttempts | undefined,
  shopifyProducts: Attempt<ShopifyCampaignProductAttribution[]>,
  ambiguousCampaignId: boolean,
): AdminAnalyticsCampaignBreakdown {
  const isDemandGen = campaign.advertisingChannelType === "DEMAND_GEN";
  const isPmaxProduct =
    campaign.advertisingChannelType === "PERFORMANCE_MAX" && campaign.shoppingFeed;
  const supportedGoogleBreakdown = isDemandGen || isPmaxProduct;
  const googleAttempt = isDemandGen
    ? googleAttempts?.creative
    : isPmaxProduct
      ? googleAttempts?.product
      : undefined;
  const googleSourceType = isDemandGen
    ? "demand_gen_ads" as const
    : isPmaxProduct
      ? "pmax_products" as const
      : "unsupported_campaign_type" as const;
  let googleRows: AdminAnalyticsCampaignBreakdownRow[] = [];
  let googleSource: AdminAnalyticsCampaignBreakdownSource;
  if (!supportedGoogleBreakdown) {
    googleSource = {
      provider: "google_ads",
      source: googleSourceType,
      state: "unavailable",
      reason:
        "Google provides this bounded breakdown only for Demand Gen ads and shopping-feed PMax products.",
    };
  } else if (!googleAttempt) {
    googleSource = {
      provider: "google_ads",
      source: googleSourceType,
      state: "unavailable",
      reason: "No exact Google Ads reporting source is bound to this campaign.",
    };
  } else if (!googleAttempt.ok) {
    googleSource = {
      provider: "google_ads",
      source: googleSourceType,
      state: googleAttempt.state,
      reason: googleAttempt.message,
    };
  } else if (
    googleAttempt.value.some((row) => row.accountId !== campaign.ad_account_id)
  ) {
    googleSource = {
      provider: "google_ads",
      source: googleSourceType,
      state: "failed",
      reason: "Google campaign breakdown rows escaped their exact account scope.",
    };
  } else {
    googleRows = googleAttempt.value
      .filter((row) => row.campaignId === campaign.providerCampaignId)
      .map((row) => ({
        provider: "google_ads" as const,
        kind: row.kind,
        id: row.id,
        name: row.name?.trim() ||
          `${row.kind === "creative" ? "Google ad" : "Merchant product"} ${row.id}`,
        detail: row.detail,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
        googleRevenue: row.googleRevenue,
        shopifyProductId: null,
        shopifyUnits: null,
        shopifyRevenue: null,
      }));
    googleSource = {
      provider: "google_ads",
      source: googleSourceType,
      state: googleRows.length === 0 ? "empty" : "ready",
      reason: null,
    };
  }

  let productRows: AdminAnalyticsCampaignBreakdownRow[] = [];
  let shopifySource: AdminAnalyticsCampaignBreakdownSource;
  if (ambiguousCampaignId) {
    shopifySource = {
      provider: "shopify",
      source: "campaign_products",
      state: "unavailable",
      reason:
        "This Google campaign ID is repeated across store accounts, while Shopify UTM rows carry no ad-account identity.",
    };
  } else if (!shopifyProducts.ok) {
    shopifySource = {
      provider: "shopify",
      source: "campaign_products",
      state: shopifyProducts.state,
      reason: shopifyProducts.message,
    };
  } else {
    productRows = shopifyProducts.value
      .filter((row) => row.campaignId === campaign.providerCampaignId)
      .map((row) => ({
        provider: "shopify" as const,
        kind: "product" as const,
        id: row.productId,
        name: row.title,
        detail: "Last non-direct click · net units after returns",
        spend: null,
        impressions: null,
        clicks: null,
        conversions: null,
        googleRevenue: null,
        shopifyProductId: row.productId,
        shopifyUnits: row.units,
        // Shopify documents product units here, while campaign revenue lives
        // in campaign_sales and cannot be allocated to a product exactly.
        shopifyRevenue: null,
      }));
    shopifySource = {
      provider: "shopify",
      source: "campaign_products",
      state: productRows.length === 0 ? "empty" : "ready",
      reason: null,
    };
  }

  const rows = [...googleRows, ...productRows];
  const sources = [googleSource, shopifySource];
  if (rows.length > 0) return { state: "ready", rows, sources, reason: null };
  const failedSource = sources.find((source) => source.state === "failed");
  if (failedSource) {
    return {
      state: "failed",
      rows: [],
      sources,
      reason: failedSource.reason ?? "Campaign breakdown could not be loaded.",
    };
  }
  const unavailableSource = sources.find((source) => source.state === "unavailable");
  if (unavailableSource) {
    return {
      state: "unavailable",
      rows: [],
      sources,
      reason: unavailableSource.reason ?? "Campaign breakdown is unavailable.",
    };
  }
  return { state: "empty", rows: [], sources, reason: null };
}

function campaignFamily(
  google: Attempt<LiveCampaign[]>,
  breakdowns: GoogleBreakdownAttempts,
  attribution: Attempt<ShopifyCampaignAttribution[]>,
  shopifyProducts: Attempt<ShopifyCampaignProductAttribution[]>,
): AdminStoreAnalytics["campaigns"] {
  if (!google.ok) {
    return google.state === "unavailable"
      ? unavailable(google.message)
      : failed(google.message);
  }
  const attributionById = attribution.ok
    ? new Map(attribution.value.map((row) => [row.campaignId, row]))
    : new Map<string, ShopifyCampaignAttribution>();
  const campaignIdCounts = google.value.reduce((counts, campaign) => {
    counts.set(
      campaign.providerCampaignId,
      (counts.get(campaign.providerCampaignId) ?? 0) + 1,
    );
    return counts;
  }, new Map<string, number>());
  const rows: AdminAnalyticsCampaign[] = google.value.map((campaign) => {
    const ambiguousCampaignId =
      (campaignIdCounts.get(campaign.providerCampaignId) ?? 0) > 1;
    const matched = ambiguousCampaignId
      ? null
      : attributionById.get(campaign.providerCampaignId) ?? null;
    const spend = campaign.spend;
    return {
      accountId: campaign.ad_account_id,
      campaignId: campaign.providerCampaignId,
      name: campaign.name,
      status: campaign.status,
      type: campaign.advertisingChannelType || null,
      budget: campaign.daily_budget,
      spend,
      impressions: campaign.impressions,
      clicks: campaign.clicks,
      conversions: campaign.conversions,
      googleRevenue: campaign.conversionValue,
      shoppingFeed: campaign.shoppingFeed,
      shopifySessions: matched?.sessions ?? null,
      shopifyOrders: matched?.orders ?? null,
      shopifyRevenue: matched?.revenue ?? null,
      ctr: campaign.impressions > 0 ? campaign.clicks / campaign.impressions : null,
      cpc: campaign.clicks > 0 ? spend / campaign.clicks : null,
      cpm: campaign.impressions > 0 ? (spend / campaign.impressions) * 1000 : null,
      cpa: campaign.conversions > 0 ? spend / campaign.conversions : null,
      googleRoas: spend > 0 ? campaign.conversionValue / spend : null,
      realRoas:
        spend > 0 && matched?.revenue !== null && matched?.revenue !== undefined
          ? matched.revenue / spend
          : null,
      attributionState: !attribution.ok
        ? "unavailable"
        : matched
          ? "matched"
          : "unmatched",
      breakdown: campaignBreakdown(
        campaign,
        breakdowns.get(campaign.ad_account_id),
        shopifyProducts,
        ambiguousCampaignId,
      ),
    };
  });
  const messages = [
    google.message ?? null,
    attribution.ok
      ? null
      : "Google metrics are ready; Shopify last-non-direct-click UTM attribution matched to Google campaign IDs is unavailable.",
    [...campaignIdCounts.values()].some((count) => count > 1)
      ? "Shopify attribution was withheld for campaign IDs repeated across Google accounts."
      : null,
    rows.some((row) =>
      row.breakdown.sources.some((source) => source.state === "failed"))
      ? "Some campaign breakdown sources failed for the selected period."
      : null,
  ].filter((message): message is string => Boolean(message));
  return {
    state: rows.length === 0 ? "empty" : "ready",
    data: { rows },
    message: messages.length > 0 ? messages.join(" ") : null,
  };
}

async function shopifyFamilies(
  adapterAttempt: Attempt<ShopifyReportingAdapter>,
  range: Pick<RangeSelection, "from" | "to">,
  targetCurrency: string,
): Promise<{
  funnel: AdminStoreAnalytics["funnel"];
  attribution: Attempt<ShopifyCampaignAttribution[]>;
  products: Attempt<ShopifyCampaignProductAttribution[]>;
  collections: AdminStoreAnalytics["collections"];
}> {
  if (!adapterAttempt.ok) {
    const family = <T>(operation: string): AdminAnalyticsFamily<T> =>
      adapterAttempt.state === "unavailable"
        ? unavailable(`${adapterAttempt.message} ${operation} is unavailable.`)
        : failed(`${adapterAttempt.message} ${operation} could not be loaded.`);
    return {
      funnel: family("Shopify funnel"),
      attribution: adapterAttempt,
      products: adapterAttempt,
      collections: family("Collection sales"),
    };
  }
  const [funnelResult, attributionResult, productResult, collectionsResult] =
    await Promise.allSettled([
      adapterAttempt.value.fetchFunnel(range.from, range.to),
      adapterAttempt.value.fetchCampaignAttribution(range.from, range.to, targetCurrency),
      adapterAttempt.value.fetchCampaignProducts(range.from, range.to),
      adapterAttempt.value.fetchCollectionSales(range.from, range.to, targetCurrency),
    ]);

  let funnel: AdminStoreAnalytics["funnel"];
  if (funnelResult.status === "rejected") {
    funnel = shopifyFailure(funnelResult.reason, "the store funnel");
  } else {
    const daily = funnelResult.value;
    const totals = daily.reduce(
      (sum, day) => ({
        sessions: sum.sessions + day.sessions,
        addedToCart: sum.addedToCart + day.addedToCart,
        reachedCheckout: sum.reachedCheckout + day.reachedCheckout,
        completedCheckout: sum.completedCheckout + day.completedCheckout,
      }),
      { sessions: 0, addedToCart: 0, reachedCheckout: 0, completedCheckout: 0 },
    );
    funnel = readyOrEmpty(
      { daily, totals },
      totals.sessions === 0 &&
        totals.addedToCart === 0 &&
        totals.reachedCheckout === 0 &&
        totals.completedCheckout === 0,
    );
  }

  const attribution: Attempt<ShopifyCampaignAttribution[]> =
    attributionResult.status === "fulfilled"
      ? { ok: true, value: attributionResult.value }
      : attributionResult.reason instanceof ShopifyReportingAdapterError &&
          attributionResult.reason.code === "missing_scope"
        ? {
            ok: false,
            state: "unavailable",
            message: "Shopify has not granted campaign report access.",
          }
        : {
            ok: false,
            state: "failed",
            message: "Shopify campaign attribution could not be loaded.",
          };

  const products: Attempt<ShopifyCampaignProductAttribution[]> =
    productResult.status === "fulfilled"
      ? { ok: true, value: productResult.value }
      : productResult.reason instanceof ShopifyReportingAdapterError &&
          productResult.reason.code === "missing_scope"
        ? {
            ok: false,
            state: "unavailable",
            message: "Shopify has not granted campaign product report access.",
          }
        : {
            ok: false,
            state: "failed",
            message: "Shopify campaign products could not be loaded.",
          };

  let collections: AdminStoreAnalytics["collections"];
  if (collectionsResult.status === "rejected") {
    collections = shopifyFailure(collectionsResult.reason, "collection sales");
  } else {
    const rows = collectionsResult.value.map((collection) => ({
      collectionId: collection.collectionId,
      title: collection.title,
      revenue: collection.revenue,
      units: collection.units,
      spend: null,
      roas: null,
      products: collection.products.map((product) => ({
        ...product,
        spend: null,
        roas: null,
      })),
    }));
    collections = {
      state: rows.length === 0 ? "empty" : "ready",
      data: { rows },
      message:
        "Shopify net sales and net units use the selected reporting days and current official collection membership. A product can belong to more than one collection, so collection rows are not additive. Spend and ROAS require a verified Google offer-to-Shopify product mapping that is not configured.",
    };
  }
  return { funnel, attribution, products, collections };
}

/**
 * Purpose-bound analytics DAL. Authentication and exact ownership are proved
 * before service-role topology or encrypted credentials are read.
 */
export async function fetchAdminStoreAnalytics(
  input: FetchAdminStoreAnalyticsInput,
): Promise<AdminStoreAnalytics> {
  assertInput(input);
  await requireClientOnboardingAdmin();
  const topology = await loadTopology(input);

  const googlePromise = loadGoogleCampaigns(topology, input.range);
  const breakdownPromise = loadGoogleBreakdowns(topology, input.range);
  const shopifyPromise = openShopify(topology);
  const accountIds = [...new Set(input.store.activityAccountIds)];
  const rollupPromise = rollupFamilies(topology, accountIds, input.range);
  const activityPromise = listCampaignActionActivity(
    input.clientId,
    accountIds,
    input.range,
  );

  const [google, breakdowns, adapterAttempt, activityResult, rollup] = await Promise.all([
    googlePromise,
    breakdownPromise,
    shopifyPromise,
    activityPromise.then(
      (value): Attempt<typeof value> => ({ ok: true, value }),
      (): Attempt<never> => ({
        ok: false,
        state: "failed",
        message: "Campaign activity could not be loaded for the selected period.",
      }),
    ),
    rollupPromise,
  ]);
  const shopify = await shopifyFamilies(
    adapterAttempt,
    input.range,
    input.store.currency,
  );

  const activity: AdminStoreAnalytics["activity"] = activityResult.ok
    ? readyOrEmpty(
        { rows: activityResult.value.history, truncated: activityResult.value.truncated },
        activityResult.value.history.length === 0,
      )
    : failed(activityResult.message);

  return {
    clientId: input.clientId,
    storeAccountId: input.store.accountId,
    currency: input.store.currency,
    range: { from: input.range.from, to: input.range.to },
    funnel: shopify.funnel,
    campaigns: campaignFamily(
      google,
      breakdowns,
      shopify.attribution,
      shopify.products,
    ),
    collections: shopify.collections,
    spend: rollup.spend,
    rollupCoverage: rollup.rollupCoverage,
    activity,
  };
}

/**
 * Materialises and proves only the daily rollup needed by the All Stores
 * Analytics cards. It deliberately does not open ShopifyQL or campaign reads.
 */
export async function ensureAdminAnalyticsRollupCoverage(
  input: EnsureAdminAnalyticsRollupCoverageInput,
): Promise<AdminAnalyticsFamily<{ storeCount: number; dayCount: number; refreshed: boolean }>> {
  if (
    !UUID.test(input.clientId) ||
    !isDay(input.range.from) ||
    !isDay(input.range.to) ||
    input.range.from > input.range.to
  ) {
    throw new Error("The selected analytics coverage scope is invalid.");
  }
  const storeIds = new Set<string>();
  const physicalIds = new Set<string>();
  for (const store of input.stores) {
    assertInput({ clientId: input.clientId, store, range: input.range });
    if (storeIds.has(store.accountId)) {
      throw new Error("The selected analytics coverage repeats a store.");
    }
    storeIds.add(store.accountId);
    for (const accountId of store.activityAccountIds) {
      if (physicalIds.has(accountId)) {
        throw new Error("The selected analytics coverage overlaps store accounts.");
      }
      physicalIds.add(accountId);
    }
  }

  await requireClientOnboardingAdmin();
  if (input.stores.length === 0) {
    return {
      state: "empty",
      data: { storeCount: 0, dayCount: rangeDays(input.range).length, refreshed: false },
      message: "This client has no stores to materialise.",
    };
  }

  const results = await Promise.all(
    input.stores.map(async (store) => {
      const topology = await loadTopology({
        clientId: input.clientId,
        store: { ...store, days: [] },
        range: input.range,
      });
      return rollupFamilies(topology, [...new Set(store.activityAccountIds)], input.range);
    }),
  );
  const failedCoverage = results.find(
    (result) => result.rollupCoverage.state === "failed",
  );
  if (failedCoverage && failedCoverage.rollupCoverage.state === "failed") {
    return failed(
      "Shopify revenue and Google spend coverage could not be proved for every store and selected day.",
    );
  }
  const refreshed = results.some(
    (result) =>
      "data" in result.rollupCoverage && result.rollupCoverage.data.refreshed,
  );
  return {
    state: "ready",
    data: {
      storeCount: input.stores.length,
      dayCount: rangeDays(input.range).length,
      refreshed,
    },
    message: refreshed
      ? "All store rollups were verified after an on-demand refresh."
      : "All store rollups are verified for the exact selected period.",
  };
}
