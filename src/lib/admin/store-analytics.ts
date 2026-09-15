import "server-only";

import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { ShopifyReportingError } from "@/lib/client-onboarding/shopify";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import {
  fetchLiveCampaignsDetailed,
  fetchLiveCampaignTimeline,
  fetchLiveGoogleDemandGenBreakdowns,
  fetchLiveGooglePmaxProductBreakdowns,
  type GoogleCampaignBreakdownRow,
  type GoogleCampaignTimelinePoint,
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
  fetchGoogleReportingCampaignTimeline,
  fetchGoogleReportingDemandGenAds,
  fetchGoogleReportingPmaxProducts,
} from "@/lib/reporting/google";
import {
  convertBreakdownAtParentRate,
  convertCampaignTimeline,
  convertCampaigns,
  reportingMoneyRates,
} from "@/lib/reporting/google-currency";
import {
  createLegacyShopifyReportingAdapter,
  createShopifyReportingAdapter,
  ShopifyReportingAdapterError,
  type ShopifyCampaignAttributionSeriesRow,
  type ShopifyCampaignProductAttribution,
  type ShopifyCampaignProductSeriesRow,
  type ShopifyCollectionSalesSeriesRow,
  type ShopifyLandingSessionsRow,
  type ShopifyReportingAdapter,
} from "@/lib/reporting/shopify";
import { collectionHandleFromUrl, decodePercentEscapes, normalizePath } from "@/lib/finance/rev-share";
import { loadCostContext } from "@/lib/cogs/context";
import { orderCogs, type CostContext } from "@/lib/cogs/engine";
import { fxDailyRates, rateOn } from "@/lib/shopify/fx";
import { ShopifyError, type SyncedOrder } from "@/lib/shopify/client";
import {
  resolveReportingSources,
  type CanonicalReportingSource,
} from "@/lib/reporting/sources";
import {
  adminReportingSnapshotIsStale,
  adminReportingAuthority,
  readAdminReportingSnapshotFamilySelections,
  refreshAdminReportingSnapshot,
  type AdminReportingAuthority,
  type AdminReportingSnapshotSelection,
  type AdminReportingSnapshotValue,
} from "@/lib/admin/reporting-snapshots";
import { createServiceClient } from "@/lib/supabase/service";
import type { ClientShopifyConnection, Json } from "@/lib/supabase/types";
import { fetchGoogleAdsLandingPages, hasWindsorEnv } from "@/lib/windsor/client";

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
  | { state: "partial"; data: T; message: string }
  | { state: "not_synced" | "unavailable" | "failed"; message: string };

export type AdminAnalyticsFunnelDay = {
  day: string;
  bucket: string;
  sessions: number;
  addedToCart: number;
  reachedCheckout: number;
  completedCheckout: number;
};

export type AdminAnalyticsGranularity = "hour" | "day";

export type AdminAnalyticsCampaignTimelinePoint = {
  bucket: string;
  spend: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  shopifyRevenue: number | null;
  /** Shopify last-non-direct-click sessions, cart additions and orders; null when attribution is unavailable. */
  shopifySessions?: number | null;
  addedToCart?: number | null;
  shopifyOrders?: number | null;
  /** Net units after returns across the campaign's products; null when the product series is unavailable. */
  units?: number | null;
  /**
   * Sales of the collection this campaign lands on, read from the orders the
   * way the client's own sheet reads them (see attributeCampaignCollections)
   * and split between the campaigns that land there by their share of the
   * day's spend; ATC is the Google sessions that landed on that collection
   * page. null when the campaign lands on no single collection the store has.
   */
  collectionRevenue?: number | null;
  collectionUnits?: number | null;
  collectionOrders?: number | null;
  collectionAddedToCart?: number | null;
  /**
   * How the collection's sales arrived. The campaign advertises a collection
   * PAGE, so the sheet splits its own total by whether the buyer came in
   * through that page: collectionLanded* is the part of collectionRevenue,
   * Units and Orders bought by customers whose FIRST visit landed there,
   * collectionUnknown* is the part whose first visit Shopify does not report
   * at all, and what is left of the total is the part measured to have
   * arrived some other way.
   *
   * collectionBrought* is the money the page made that the collection total
   * never sees: orders that landed on the page and bought NOTHING of the
   * collection, counted whole, the way an order is read everywhere else.
   * Those orders are outside collectionRevenue by design and must never be
   * added to it. Both mixes are real and vary enormously by store: one store
   * has 95% of a collection's revenue from people who landed on its page,
   * another has 100% of it from people who never saw that page.
   *
   * Shared between campaigns landing on the same page, and null, exactly as
   * collectionRevenue is.
   */
  collectionLandedRevenue?: number | null;
  collectionLandedUnits?: number | null;
  collectionLandedOrders?: number | null;
  /**
   * The part of the same total whose arrival was never measured: Shopify
   * reports no customer journey for the order, so it neither landed on the
   * page nor is known to have come in elsewhere. It is its own figure and not
   * folded into either, because the field can be absent for a whole store or
   * an older period, and a sheet that hands those sales to "found the items
   * another way" claims the advertised page did nothing on no evidence at all.
   */
  collectionUnknownRevenue?: number | null;
  collectionUnknownOrders?: number | null;
  collectionBroughtRevenue?: number | null;
  collectionBroughtOrders?: number | null;
  /** Cost of the collection units attributed here, from the store's product costs; null when costs could not be read. */
  cogs?: number | null;
  googleRevenue: number;
  realRoas: number | null;
  googleRoas: number | null;
};

export type AdminAnalyticsReturnTimelinePoint = {
  bucket: string;
  revenue: number;
  units: number;
  spend: number;
  roas: number | null;
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
  /** Exact provider thumbnail; null/absent is rendered as a neutral asset tile. */
  thumbnailUrl?: string | null;
  assetKind?: "image" | "video" | null;
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
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  googleRevenue: number;
  shopifySessions: number | null;
  addedToCart?: number | null;
  shopifyOrders: number | null;
  shopifyRevenue: number | null;
  /** Net units after returns across the campaign's products; null when unavailable. */
  shopifyUnits?: number | null;
  /**
   * The collection page the campaign sends people to: the one its final URLs
   * name (or its name does, when the URLs name none, or where its clicks
   * landed when neither says), provided the store has that collection. Set
   * whether or not the collection sold in the period.
   */
  collectionHandle?: string | null;
  /** Which evidence named that collection, so the sheet can say so; absent when there is none. */
  collectionSource?: CampaignCollectionSource;
  /** How many campaigns land on that same collection, this one included. */
  collectionSharedWith?: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  googleRoas: number | null;
  realRoas: number | null;
  attributionState: "matched" | "unmatched" | "unavailable";
  timeline: AdminAnalyticsCampaignTimelinePoint[];
  trackingTimeline?: AdminAnalyticsCampaignTimelinePoint[];
  breakdown: AdminAnalyticsCampaignBreakdown;
};

export type AdminAnalyticsCollectionProduct = {
  productId: string;
  title: string;
  revenue: number;
  units: number;
  spend?: number | null;
  roas?: number | null;
  timeline: AdminAnalyticsReturnTimelinePoint[];
  trackingTimeline?: AdminAnalyticsReturnTimelinePoint[];
};

export type AdminAnalyticsCollection = {
  collectionId: string;
  title: string;
  products: AdminAnalyticsCollectionProduct[];
  revenue: number;
  units: number;
  spend: number | null;
  roas: number | null;
  handle?: string | null;
  timeline: AdminAnalyticsReturnTimelinePoint[];
  trackingTimeline?: AdminAnalyticsReturnTimelinePoint[];
};

export type AdminStoreAnalytics = {
  clientId: string;
  storeAccountId: string;
  currency: string;
  range: { from: string; to: string };
  funnel: AdminAnalyticsFamily<{
    granularity: AdminAnalyticsGranularity;
    daily: AdminAnalyticsFunnelDay[];
    totals: {
      sessions: number;
      addedToCart: number;
      reachedCheckout: number;
      completedCheckout: number;
    };
  }>;
  campaigns: AdminAnalyticsFamily<{
    granularity: AdminAnalyticsGranularity;
    rows: AdminAnalyticsCampaign[];
    /** The store's current local day; null when its zone could not be read. */
    storeToday?: string | null;
    /**
     * The store's per-order fee settings, for the sheet's fee and profit
     * columns; null when they could not be read, absent on a snapshot taken
     * before they were carried.
     */
    fees?: CampaignSheetFees | null;
  }>;
  collections: AdminAnalyticsFamily<{
    granularity: AdminAnalyticsGranularity;
    rows: AdminAnalyticsCollection[];
  }>;
  spend: AdminAnalyticsFamily<{
    granularity: AdminAnalyticsGranularity;
    daily: Array<{ day: string; bucket: string; spend: number }>;
  }>;
  rollupCoverage: AdminAnalyticsFamily<{
    dayCount: number;
    refreshed: boolean;
    materializedAccountDays?: number;
    expectedAccountDays?: number;
  }>;
  activity: AdminAnalyticsFamily<{
    rows: CampaignActionHistory[];
    truncated: boolean;
  }>;
  providerFreshness?: AdminProviderFreshness;
  /**
   * The campaigns family's own row: when its shown snapshot was taken and
   * what the last refresh recorded. The aggregate above mixes three families,
   * so a funnel failure would otherwise read as a campaign one.
   */
  campaignsFreshness?: AdminProviderFreshness;
  shopifyProvenance?: "legacy" | "v2_cutover" | "supplemental_v2_shopify";
};

/**
 * The per-order settings the campaign sheet estimates its fees with: the
 * same ones the store's own rollup applies to every order (see
 * metrics/recompute and cogs/engine's paymentFee), plus the agency fee.
 *
 * The agency fee is the account's `commission_rate`, in percent of ad spend
 * as the account stores it (10 for 10%). The portal P&L prices a referred
 * account on the 10% list rate through its referral schedule instead, so
 * the figure the sheet derives from this is an estimate of the fee, not
 * the invoice.
 */
export type CampaignSheetFees = {
  /** Payment fee, percent of the order's net (Shopify Payments' 1.7%). */
  paymentFeePct: number;
  /** Payment fee, fixed amount per order in the store's reporting currency. */
  paymentFeeFixed: number;
  /** Shipping cost per order, reporting currency. */
  shippingCostPerOrder: number;
  /** Agency fee, percent of ad spend. */
  agencyFeeRate: number;
};

export type AdminProviderFreshness = {
    state: "live" | "ready" | "partial" | "not_synced";
    refreshedAt: string | null;
    lastAttemptAt: string | null;
    lastErrorCode: string | null;
    stale: boolean;
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
      authority: AdminReportingAuthority;
      shopifyProvenance: "v2_cutover";
    }
  | {
      kind: "legacy";
      service: NonNullable<ReturnType<typeof createServiceClient>>;
      account: StoreAccountRow;
      authority: AdminReportingAuthority;
      supplementalShopify: CanonicalReportingSource | null;
      shopifyProvenance: "legacy" | "supplemental_v2_shopify";
    };

type Attempt<T> =
  | { ok: true; value: T; message?: string | null }
  | { ok: false; state: "unavailable" | "failed"; message: string };

type RolloutRow = {
  operational_surface: string;
  reporting_cutover_at: string | null;
  reporting_cutover_by: string | null;
  reporting_cutover_reason: string | null;
};

type SupplementalShopifyManifest = {
  provenance: "supplemental_v2_shopify";
  connectionId: string;
  shopId: string;
  domain: string;
  currency: string;
  verifiedAt: string;
  connectionUpdatedAt: string;
  scopeProfile: string;
  grantedScopes: string[];
  credentialHint: string;
  shopifyClientId: string;
  credentialUpdatedAt: string;
  credentialKey: string;
};

function isDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const LISBON_CALENDAR = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The ROAS tracking window is FIXED: the last 30 Lisbon days, whatever range
 * the page is showing. Owner rule (2026-08-18): tracking reads the data the
 * platform already holds — it never depends on the reviewed timeframe. */
function lisbonToday(): string {
  return LISBON_CALENDAR.format(new Date());
}

function offsetDay(value: string, offset: number): string {
  const day = new Date(`${value}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
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

function notSynced<T>(message: string): AdminAnalyticsFamily<T> {
  return { state: "not_synced", message };
}

async function legacyAuthority(
  input: FetchAdminStoreAnalyticsInput,
  rollout: RolloutRow | null,
  account: StoreAccountRow,
  supplemental: SupplementalShopifyManifest | null,
): Promise<AdminReportingAuthority> {
  return adminReportingAuthority({
    version: 1,
    mode: "legacy",
    clientId: input.clientId,
    storeAccountId: input.store.accountId,
    operationalSurface: rollout?.operational_surface ?? "legacy_only",
    cutoverAt: rollout?.reporting_cutover_at ?? null,
    cutoverBy: rollout?.reporting_cutover_by ?? null,
    cutoverReason: rollout?.reporting_cutover_reason ?? null,
    account: {
      id: account.id,
      currency: account.currency,
      shopifyUrl: account.shopify_url,
      shopifyConnected: account.shopify_connected,
      googleAdsCustomerId: account.google_ads_customer_id,
      googleAdsConnected: account.google_ads_connected,
    },
    shopifyProvider: supplemental as unknown as Json,
  });
}

function canonicalLegacyShopifyDomain(value: string | null): string | null {
  const domain = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
}

async function credentialKey(ciphertext: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ciphertext),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function supplementalShopifySource(
  service: NonNullable<ReturnType<typeof createServiceClient>>,
  input: FetchAdminStoreAnalyticsInput,
  rollout: RolloutRow | null,
  account: StoreAccountRow,
): Promise<{
  source: CanonicalReportingSource;
  manifest: SupplementalShopifyManifest;
} | null> {
  if (rollout?.operational_surface !== "v2_ready_for_cutover") return null;
  const domain = canonicalLegacyShopifyDomain(account.shopify_url);
  if (!domain) return null;

  const { data, error } = await service
    .from("client_shopify_connections")
    .select(
      "id, client_id, status, shopify_shop_id, shopify_name, shopify_domain, primary_domain, shopify_currency, credential_hint, granted_scopes, scope_profile, updated_at, last_verified_at, last_error_code",
    )
    .eq("client_id", input.clientId)
    .eq("status", "connected")
    .eq("shopify_domain", domain);
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  const connection = data[0] as Pick<
    ClientShopifyConnection,
    | "id"
    | "client_id"
    | "status"
    | "shopify_shop_id"
    | "shopify_name"
    | "shopify_domain"
    | "primary_domain"
    | "shopify_currency"
    | "credential_hint"
    | "granted_scopes"
    | "scope_profile"
    | "updated_at"
    | "last_verified_at"
    | "last_error_code"
  >;
  const scopes = [...new Set(connection.granted_scopes)].sort();
  if (
    connection.client_id !== input.clientId ||
    connection.status !== "connected" ||
    connection.shopify_domain !== domain ||
    connection.shopify_currency !== account.currency ||
    connection.shopify_currency !== input.store.currency ||
    !/^gid:\/\/shopify\/Shop\/\d+$/.test(connection.shopify_shop_id) ||
    !connection.shopify_name.trim() ||
    connection.scope_profile !== "client-reporting-read-v1" ||
    !connection.credential_hint ||
    !connection.last_verified_at ||
    !Number.isFinite(Date.parse(connection.last_verified_at)) ||
    connection.last_error_code !== null ||
    !scopes.includes("read_reports") ||
    !scopes.includes("read_products") ||
    scopes.some((scope) => scope.startsWith("write_"))
  ) {
    return null;
  }

  const credentialResult = await service
    .from("client_shopify_credentials")
    .select("connection_id, shopify_client_id, client_secret_ciphertext, updated_at")
    .eq("connection_id", connection.id)
    .maybeSingle();
  const credential = credentialResult.data;
  if (
    credentialResult.error ||
    !credential ||
    credential.connection_id !== connection.id ||
    !credential.shopify_client_id.trim() ||
    !credential.client_secret_ciphertext.trim()
  ) {
    return null;
  }

  const source: CanonicalReportingSource = {
    bindingId: connection.id,
    clientId: input.clientId,
    adAccountId: account.id,
    kind: "shopify",
    group: {
      id: connection.id,
      shopifyAnchorBindingId: connection.id,
      shopifyAnchorAdAccountId: account.id,
    },
    shopify: {
      connectionId: connection.id,
      shopId: connection.shopify_shop_id,
      shopifyName: connection.shopify_name.trim(),
      domain,
      primaryDomain: connection.primary_domain,
      currency: connection.shopify_currency,
      credential: {
        shopifyClientId: credential.shopify_client_id.trim(),
        clientSecretCiphertext: credential.client_secret_ciphertext.trim(),
      },
      // The guard above already refused any connection with a recorded probe
      // failure, so this supplemental source is healthy by construction.
      healthError: null,
    },
    googleAds: null,
  };
  return {
    source,
    manifest: {
      provenance: "supplemental_v2_shopify",
      connectionId: connection.id,
      shopId: connection.shopify_shop_id,
      domain,
      currency: connection.shopify_currency,
      verifiedAt: connection.last_verified_at,
      connectionUpdatedAt: connection.updated_at,
      scopeProfile: connection.scope_profile,
      grantedScopes: scopes,
      credentialHint: connection.credential_hint,
      shopifyClientId: credential.shopify_client_id,
      credentialUpdatedAt: credential.updated_at,
      credentialKey: await credentialKey(credential.client_secret_ciphertext),
    },
  };
}

async function v2Authority(
  input: FetchAdminStoreAnalyticsInput,
  rollout: RolloutRow,
  sources: CanonicalReportingSource[],
): Promise<AdminReportingAuthority> {
  const manifestSources = sources
    .map((source) => ({
      bindingId: source.bindingId,
      clientId: source.clientId,
      adAccountId: source.adAccountId,
      kind: source.kind,
      anchorBindingId: source.group.shopifyAnchorBindingId,
      anchorAccountId: source.group.shopifyAnchorAdAccountId,
      shopify: source.shopify
        ? {
            connectionId: source.shopify.connectionId,
            domain: source.shopify.domain,
            currency: source.shopify.currency,
          }
        : null,
      googleAds: source.googleAds
        ? {
            connectionId: source.googleAds.connectionId,
            accountId: source.googleAds.accountId,
            customerId: source.googleAds.customerId,
            currency: source.googleAds.currency,
            timeZone: source.googleAds.timeZone,
          }
        : null,
    }))
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  return adminReportingAuthority({
    version: 1,
    mode: "v2",
    clientId: input.clientId,
    storeAccountId: input.store.accountId,
    operationalSurface: rollout.operational_surface,
    cutoverAt: rollout.reporting_cutover_at,
    cutoverBy: rollout.reporting_cutover_by,
    cutoverReason: rollout.reporting_cutover_reason,
    sources: manifestSources as unknown as Json,
  });
}

/** The stored snapshot message allows at most this many characters (0062). */
const FAMILY_MESSAGE_LIMIT = 1_000;
/** How much of a provider's own error text travels into a family message. */
const PROVIDER_CAUSE_LIMIT = 200;
/** How many Shopify reads one store has in flight at once. */
const SHOPIFY_READ_CONCURRENCY = 2;

/**
 * The fixed sentence plus what Shopify itself said, when the failure is one
 * of its own errors. Four stores with the reporting app uninstalled read
 * exactly like a passing throttle without it: the same sentence on the row,
 * nothing in the logs.
 */
function withProviderCause(sentence: string, error: unknown): string {
  if (
    !(error instanceof ShopifyReportingError) &&
    !(error instanceof ShopifyReportingAdapterError) &&
    !(error instanceof ShopifyError)
  ) {
    return sentence;
  }
  const cause = error.message.trim().slice(0, PROVIDER_CAUSE_LIMIT);
  if (!cause) return sentence;
  return `${sentence.replace(/\.$/, "")} (${cause}).`;
}

/**
 * At most `limit` of the wrapped tasks run at once; the rest wait their turn
 * in call order, and every outcome still reaches its caller. Shopify's cost
 * throttle is per shop, so six reads fired together for one store spend each
 * other's budget and the last ones fail as throttled; two at a time keeps
 * every read inside it.
 */
export function concurrencyLimiter(
  limit: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("The concurrency limit must be a positive integer.");
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // The slot is handed to the next waiter directly. Releasing it first
      // would let a newcomer take it before the waiter wakes and exceed the
      // limit by one.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function shopifyFailure<T>(error: unknown, operation: string): AdminAnalyticsFamily<T> {
  if (
    error instanceof ShopifyReportingAdapterError &&
    error.code === "missing_scope"
  ) {
    return unavailable(`Shopify has not granted the read-only scope required for ${operation}.`);
  }
  // Same blind spot as the snapshot catch: without this the family reads
  // provider_failed downstream with the actual Shopify error discarded. The
  // cause travels in the message so the snapshot row keeps it (0073).
  console.error(`Shopify ${operation} failed:`, error);
  const cause = error instanceof Error ? error.message : String(error);
  return failed(
    `Shopify could not load ${operation} for the selected period. (${cause.slice(0, 220)})`,
  );
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

  const rollout = rolloutResult.data as RolloutRow | null;
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
    const supplemental = await supplementalShopifySource(
      service,
      input,
      rollout,
      account,
    );
    return {
      kind: "legacy",
      service,
      account,
      authority: await legacyAuthority(input, rollout, account, supplemental?.manifest ?? null),
      supplementalShopify: supplemental?.source ?? null,
      shopifyProvenance: supplemental ? "supplemental_v2_shopify" : "legacy",
    };
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
    authority: await v2Authority(input, rollout!, sources),
    shopifyProvenance: "v2_cutover",
  };
}

async function openShopify(topology: StoreTopology): Promise<Attempt<ShopifyReportingAdapter>> {
  try {
    if (topology.kind === "v2") {
      return { ok: true, value: await createShopifyReportingAdapter(topology.anchor) };
    }
    if (topology.supplementalShopify) {
      return {
        ok: true,
        value: await createShopifyReportingAdapter(topology.supplementalShopify),
      };
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
  } catch (error) {
    // Without this line the failure was unobservable: the fixed sentence
    // below was all the row and the logs ever held.
    console.error("Shopify reporting connection could not be opened:", error);
    return {
      ok: false,
      state: "failed",
      message: withProviderCause(
        "The selected Shopify reporting connection could not be verified.",
        error,
      ),
    };
  }
}

type GoogleCampaignLoad = {
  rows: LiveCampaign[];
  timeline: GoogleCampaignTimelinePoint[];
  granularity: AdminAnalyticsGranularity;
};

async function loadGoogleCampaigns(
  topology: StoreTopology,
  range: Pick<RangeSelection, "from" | "to">,
  /** The store's reporting currency: every money figure returned is in it. */
  targetCurrency: string,
): Promise<Attempt<GoogleCampaignLoad>> {
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
        topology.googleSources.map(async (source) => {
          const [rows, timeline, rates] = await Promise.all([
            // The sheet is the one reader of where the clicks landed, so it
            // is the one caller that asks for them.
            fetchGoogleReportingCampaigns(source, range.from, range.to, fetchGoogleAdsLandingPages),
            fetchGoogleReportingCampaignTimeline(source, range.from, range.to),
            reportingMoneyRates(source, targetCurrency, range.from, range.to),
          ]);
          // A Google account billing in another currency than its store: its
          // money is converted with the same per-day ECB rates the sync uses,
          // so Real ROAS divides like by like and the store's label tells the
          // truth. Same currency: returned untouched.
          if (!rates) return { rows, timeline };
          return {
            rows: convertCampaigns(
              rows,
              rates,
              timeline,
              range.to,
              source.googleAds?.currency ?? targetCurrency,
            ),
            timeline: convertCampaignTimeline(timeline, rates),
          };
        }),
      );
      const succeeded = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []);
      if (succeeded.length === 0) {
        // Persist the first real provider error (0073) — the generic sentence
        // cost a deploy round-trip every time this family failed.
        const firstRejection = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )?.reason;
        const cause = firstRejection instanceof Error
          ? firstRejection.message
          : String(firstRejection ?? "unknown");
        console.error("Google campaigns family failed:", firstRejection);
        return {
          ok: false,
          state: "failed",
          message: `Google Ads could not load campaigns for the selected period. (${cause.slice(0, 220)})`,
        };
      }
      return {
        ok: true,
        value: {
          rows: succeeded
          .flatMap((result) => result.rows)
          .sort((left, right) => right.spend - left.spend || left.id.localeCompare(right.id)),
          timeline: succeeded
            .flatMap((result) => result.timeline)
            .sort((left, right) =>
              left.bucket.localeCompare(right.bucket) ||
              left.accountId.localeCompare(right.accountId) ||
              left.campaignId.localeCompare(right.campaignId)),
          granularity: range.from === range.to ? "hour" : "day",
        },
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
    const [rows, timeline] = await Promise.all([
      fetchLiveCampaignsDetailed(
        account.google_ads_customer_id,
        refreshToken,
        account.id,
        range as RangeSelection,
        account.currency,
        // The sheet is the one reader of where the clicks landed.
        { landingPages: true },
      ),
      fetchLiveCampaignTimeline(
        account.google_ads_customer_id,
        refreshToken,
        account.id,
        range,
        account.currency,
      ),
    ]);
    return {
      ok: true,
      value: {
        rows,
        timeline,
        granularity: range.from === range.to ? "hour" : "day",
      },
    };
  } catch (error) {
    console.error("Google campaigns family failed:", error);
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      state: "failed",
      message: `Google Ads could not load campaigns for the selected period. (${cause.slice(0, 220)})`,
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

function projectRollup(
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
  const allowedDays = new Set(days);
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const spend = Number(row.ad_spend);
    const computedAt = row.computed_at ? Date.parse(row.computed_at) : Number.NaN;
    const key = `${row.ad_account_id}\u0000${row.day}`;
    if (
      !allowedAccounts.has(row.ad_account_id) ||
      !allowedDays.has(row.day) ||
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
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + spend);
  }
  const complete = seen.size === expected.size && [...expected].every((key) => seen.has(key));
  const missing = expected.size - seen.size;
  const partialMessage = `${missing} of ${expected.size} account-days are not materialised; showing available spend only.`;
  const spendData = {
    granularity: "day" as const,
    daily: [...byDay]
      .map(([day, spend]) => ({ day, bucket: day, spend }))
      .sort((left, right) => left.day.localeCompare(right.day)),
  };
  const coverageData = {
    dayCount: days.length,
    refreshed,
    materializedAccountDays: seen.size,
    expectedAccountDays: expected.size,
  };
  if (!complete) {
    return {
      spend: { state: "partial", data: spendData, message: partialMessage },
      rollupCoverage: { state: "partial", data: coverageData, message: partialMessage },
    };
  }
  return {
    spend: {
      state: "ready",
      data: spendData,
      message: refreshed ? "The exact spend window was materialised on demand." : null,
    },
    rollupCoverage: {
      state: "ready",
      data: coverageData,
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
  refreshMissing = false,
): Promise<Pick<AdminStoreAnalytics, "spend" | "rollupCoverage">> {
  const days = rangeDays(range);
  const revenueAccountId = topology.kind === "v2"
    ? topology.anchor.adAccountId
    : topology.account.id;
  try {
    let rows = await readSpendRows(topology, accountIds, range);
    const current = projectRollup(
      rows,
      accountIds,
      days,
      revenueAccountId,
      false,
    );
    if (current?.rollupCoverage.state === "ready" || (current && !refreshMissing)) {
      return current;
    }
    if (!current && !refreshMissing) {
      return {
        spend: failed("Stored spend rows are invalid for the selected period."),
        rollupCoverage: failed("The selected-period reporting rollup could not be verified."),
      };
    }

    await refreshAccountsNow(accountIds, {
      client: topology.service,
      reportingClient: topology.service,
      from: range.from,
      to: range.to,
    });
    rows = await readSpendRows(topology, accountIds, range);
    return projectRollup(
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
    // Breakdown money converts at the parent campaign's own rate, so ads and
    // products still add up to the campaign they sit under.
    googleRows = convertBreakdownAtParentRate(
      googleAttempt.value.filter((row) => row.campaignId === campaign.providerCampaignId),
      campaign,
    )
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
        thumbnailUrl: row.thumbnailUrl ?? null,
        assetKind: row.assetKind ?? null,
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

/**
 * The reads behind the sheet's collection basis. A failed one leaves the
 * basis incomplete: null figures, or a campaign without its handle, which the
 * sheet captions as landing on no collection the store has. The family must
 * then be partial, because the snapshot refresh keeps the last good sheet on
 * a partial and records the failure, where a ready family would replace that
 * sheet and leave nothing on the row to say why.
 */
type CollectionBasisSources = {
  collectionSales: Attempt<unknown>;
  landing: Attempt<unknown>;
  orders: Attempt<unknown>;
  /** Handles whose product lookup failed, as opposed to collections the store lacks. */
  failedLookups: readonly string[];
};

function campaignFamily(
  google: Attempt<GoogleCampaignLoad>,
  breakdowns: GoogleBreakdownAttempts,
  attribution: Attempt<ShopifyCampaignAttributionSeriesRow[]>,
  shopifyProducts: Attempt<ShopifyCampaignProductSeriesRow[]>,
  storeToday: string | null = null,
  collectionAttribution: CampaignCollectionAttribution | null = null,
  basis: CollectionBasisSources | null = null,
  fees: CampaignSheetFees | null = null,
): AdminStoreAnalytics["campaigns"] {
  if (!google.ok) {
    return google.state === "unavailable"
      ? unavailable(google.message)
      : failed(google.message);
  }
  const attributionById = attribution.ok
    ? new Map(attribution.value.map((row) => [row.campaignId, row]))
    : new Map<string, ShopifyCampaignAttributionSeriesRow>();
  const campaignIdCounts = google.value.rows.reduce((counts, campaign) => {
    counts.set(
      campaign.providerCampaignId,
      (counts.get(campaign.providerCampaignId) ?? 0) + 1,
    );
    return counts;
  }, new Map<string, number>());
  const rows: AdminAnalyticsCampaign[] = google.value.rows.map((campaign) => {
    const ambiguousCampaignId =
      (campaignIdCounts.get(campaign.providerCampaignId) ?? 0) > 1;
    const matched = ambiguousCampaignId
      ? null
      : attributionById.get(campaign.providerCampaignId) ?? null;
    const spend = campaign.spend;
    const googleTimeline = google.value.timeline.filter(
      (point) =>
        point.accountId === campaign.ad_account_id &&
        point.campaignId === campaign.providerCampaignId,
    );
    const shopifyTimeline = matched?.timeline ?? [];
    // Units per bucket come from the campaign's product rows, which Shopify
    // reports per product; summed here they answer for the whole campaign.
    // Unavailable when the product series failed, or when the campaign id is
    // repeated across accounts and the UTM rows cannot be told apart.
    // Product rows are keyed by the same utm_campaign as the sales, so a
    // campaign Shopify never matched has none - and "none" is not a measured
    // zero. Units follow the match, like every other Shopify column.
    const unitRows = matched && shopifyProducts.ok
      ? shopifyProducts.value.filter((row) => row.campaignId === campaign.providerCampaignId)
      : null;
    const unitsByBucket = new Map<string, number>();
    for (const row of unitRows ?? []) {
      for (const point of row.timeline) {
        unitsByBucket.set(point.bucket, (unitsByBucket.get(point.bucket) ?? 0) + point.units);
      }
    }
    const landed = collectionAttribution?.get(`${campaign.ad_account_id}:${campaign.providerCampaignId}`) ?? null;
    const ownBuckets = [...new Set([
      ...googleTimeline.map((point) => point.bucket),
      ...shopifyTimeline.map((point) => point.bucket),
      ...unitsByBucket.keys(),
    ])];
    // Collection figures are per DAY. A day the campaign has no bucket for
    // joins the timeline as its own day bucket - on a daily timeline only: an
    // hourly one keeps its hours, and a day-shaped bucket among them would be
    // a point the charts never asked for.
    const hourly = ownBuckets.some((bucket) => bucket.length > 10);
    const buckets = [...new Set([
      ...ownBuckets,
      ...(landed && !hourly ? [...landed.byDay.keys()] : []),
    ])].sort();
    // On an hourly timeline the day's figures ride on its first bucket, so a
    // sheet that folds hours into days sums them exactly once; every other
    // bucket of that day carries zero - or null, when the day's own answer is
    // null, so an unknown never folds into a measured zero.
    const firstBucketOfDay = new Map<string, string>();
    for (const bucket of buckets) {
      const day = bucket.slice(0, 10);
      if (!firstBucketOfDay.has(day)) firstBucketOfDay.set(day, bucket);
    }
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
      addedToCart: matched?.addedToCart ?? null,
      shopifyOrders: matched?.orders ?? null,
      shopifyRevenue: matched?.revenue ?? null,
      shopifyUnits: unitRows ? unitRows.reduce((sum, row) => sum + row.units, 0) : null,
      collectionHandle: landed?.handle ?? null,
      ...(landed ? { collectionSource: landed.source } : {}),
      collectionSharedWith: landed?.sharedWith ?? null,
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
      timeline: buckets.map((bucket) => {
        const googlePoint = googleTimeline.find((point) => point.bucket === bucket);
        const shopifyPoint = shopifyTimeline.find((point) => point.bucket === bucket);
        const pointSpend = googlePoint?.spend ?? 0;
        // A day Shopify answered for is a number, zero included. A campaign
        // with no match - the attribution never loaded, the UTM never matched,
        // or the id is repeated across accounts and was withheld - has no
        // answer, and its days read null all the way to the sheet's "—".
        // Gating on the load alone printed zeros for the withheld case, next
        // to a header row that said "—" for the same campaign.
        const shopifyRevenue = matched ? shopifyPoint?.revenue ?? 0 : null;
        const googleRevenue = googlePoint?.googleRevenue ?? 0;
        return {
          bucket,
          spend: pointSpend,
          impressions: googlePoint?.impressions ?? 0,
          clicks: googlePoint?.clicks ?? 0,
          conversions: googlePoint?.conversions ?? 0,
          shopifyRevenue,
          shopifySessions: matched ? shopifyPoint?.sessions ?? 0 : null,
          addedToCart: matched ? shopifyPoint?.addedToCart ?? 0 : null,
          shopifyOrders: matched ? shopifyPoint?.orders ?? 0 : null,
          units: unitRows ? unitsByBucket.get(bucket) ?? 0 : null,
          ...(landed
            ? (() => {
                const day = bucket.slice(0, 10);
                const carries = firstBucketOfDay.get(day) === bucket;
                const dayFigures = landed.byDay.get(day) ?? null;
                const figures = carries ? dayFigures : null;
                // A day the collection has no figures for is a real zero
                // only when the source it would have read was readable.
                const nothing = (known: boolean) => (known ? 0 : null);
                const salesKnown = dayFigures ? dayFigures.revenue !== null : landed.salesKnown;
                const landingKnown = dayFigures ? dayFigures.addedToCart !== null : landed.landingKnown;
                const cogsKnown = dayFigures
                  ? dayFigures.cogs !== null
                  : landed.costsKnown && landed.salesKnown;
                return {
                  collectionRevenue: figures ? figures.revenue : nothing(salesKnown),
                  collectionUnits: figures ? figures.units : nothing(salesKnown),
                  collectionOrders: figures ? figures.orders : nothing(salesKnown),
                  // How the same total arrived, and what the page brought in
                  // beside it: read from the orders, so they are known
                  // exactly when the sales are.
                  collectionLandedRevenue: figures ? figures.landedRevenue : nothing(salesKnown),
                  collectionLandedUnits: figures ? figures.landedUnits : nothing(salesKnown),
                  collectionLandedOrders: figures ? figures.landedOrders : nothing(salesKnown),
                  collectionUnknownRevenue: figures ? figures.unknownRevenue : nothing(salesKnown),
                  collectionUnknownOrders: figures ? figures.unknownOrders : nothing(salesKnown),
                  collectionBroughtRevenue: figures ? figures.broughtRevenue : nothing(salesKnown),
                  collectionBroughtOrders: figures ? figures.broughtOrders : nothing(salesKnown),
                  collectionAddedToCart: figures ? figures.addedToCart : nothing(landingKnown),
                  cogs: figures ? figures.cogs : nothing(cogsKnown),
                };
              })()
            : {
                collectionRevenue: null,
                collectionUnits: null,
                collectionOrders: null,
                collectionLandedRevenue: null,
                collectionLandedUnits: null,
                collectionLandedOrders: null,
                collectionUnknownRevenue: null,
                collectionUnknownOrders: null,
                collectionBroughtRevenue: null,
                collectionBroughtOrders: null,
                collectionAddedToCart: null,
                cogs: null,
              }),
          googleRevenue,
          realRoas: pointSpend > 0 && shopifyRevenue !== null
            ? shopifyRevenue / pointSpend
            : null,
          googleRoas: pointSpend > 0 ? googleRevenue / pointSpend : null,
        };
      }),
      breakdown: campaignBreakdown(
        campaign,
        breakdowns.get(campaign.ad_account_id),
        shopifyProducts,
        ambiguousCampaignId,
      ),
    };
  });
  // The basis is only in use where a campaign lands on a collection. A store
  // whose campaigns name none has no collection column to lose, so a failed
  // orders read there is the collections family's failure, not this one's,
  // and this sheet stays fresh. A missing scope is not a failure: the
  // columns it withholds stay withheld on every refresh, so there is no
  // better sheet to keep.
  const failedBasisReads: string[] = [];
  let failedLookupsMessage: string | null = null;
  if (basis && google.value.rows.some((campaign) => campaignCollectionHandle(campaign) !== null)) {
    for (const attempt of [basis.collectionSales, basis.landing, basis.orders]) {
      if (!attempt.ok && attempt.state === "failed") failedBasisReads.push(attempt.message);
    }
    if (basis.failedLookups.length > 0) {
      const count = basis.failedLookups.length === 1
        ? "one collection"
        : `${basis.failedLookups.length} collections`;
      failedLookupsMessage =
        `The products of ${count} could not be read from Shopify (${basis.failedLookups.join(", ")}), ` +
        "so the campaigns landing there have no collection basis in this refresh.";
    }
  }
  const messages = [
    google.message ?? null,
    attribution.ok
      ? null
      : "Google metrics are ready; Shopify last-non-direct-click UTM attribution matched to Google campaign IDs is unavailable. " +
        attribution.message,
    [...campaignIdCounts.values()].some((count) => count > 1)
      ? "Shopify attribution was withheld for campaign IDs repeated across Google accounts."
      : null,
    ...failedBasisReads,
    failedLookupsMessage,
    rows.some((row) =>
      row.breakdown.sources.some((source) => source.state === "failed"))
      ? "Some campaign breakdown sources failed for the selected period."
      : null,
  ].filter((message): message is string => Boolean(message));
  const partial = Boolean(google.message) ||
    !attribution.ok ||
    failedBasisReads.length > 0 ||
    failedLookupsMessage !== null ||
    rows.some((row) =>
      row.breakdown.sources.some((source) => source.state === "failed"));
  // The provider causes appended above can push the join past what the
  // snapshot row stores; a message over the limit fences the whole family.
  const message = messages.join(" ").slice(0, FAMILY_MESSAGE_LIMIT);
  if (partial) {
    return {
      state: "partial",
      data: { rows, granularity: google.value.granularity, storeToday, fees },
      message: message || "Some campaign detail sources are partial.",
    };
  }
  return {
    state: rows.length === 0 ? "empty" : "ready",
    data: { rows, granularity: google.value.granularity, storeToday, fees },
    message: messages.length > 0 ? message : null,
  };
}

async function shopifyFamilies(
  adapterAttempt: Attempt<ShopifyReportingAdapter>,
  range: Pick<RangeSelection, "from" | "to">,
  targetCurrency: string,
): Promise<{
  funnel: AdminStoreAnalytics["funnel"];
  attribution: Attempt<ShopifyCampaignAttributionSeriesRow[]>;
  products: Attempt<ShopifyCampaignProductSeriesRow[]>;
  collections: AdminStoreAnalytics["collections"];
  /** The raw collection sales, kept for the campaign sheet's collection attribution. */
  collectionSales: Attempt<ShopifyCollectionSalesSeriesRow[]>;
  /** Google sessions by landing page, for the same attribution. */
  landing: Attempt<ShopifyLandingSessionsRow[]>;
  /** The range's orders with the page each one landed on, in the store's base currency. */
  orders: Attempt<{ currency: string; orders: SyncedOrder[] }>;
  /**
   * The product keys of one collection the sales left out, by handle, or
   * null when the store has no such collection or the read failed. Read on
   * demand, only for the collections campaigns land on.
   */
  collectionProductKeys: (handle: string) => Promise<ReadonlySet<string> | null>;
  /**
   * The handles whose product lookup failed, filled in as the lookups run.
   * A failed lookup is not a collection the store lacks: the campaigns family
   * reads this list once the attribution has run and goes partial on it.
   */
  failedCollectionLookups: readonly string[];
  /** The store's verified IANA zone, or null when the store could not be opened. */
  timeZone: string | null;
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
      collectionSales: adapterAttempt,
      landing: adapterAttempt,
      orders: adapterAttempt,
      collectionProductKeys: async () => null,
      failedCollectionLookups: [],
      timeZone: null,
    };
  }
  // Two reads at a time per shop; every outcome is still collected below.
  const invoke = concurrencyLimiter(SHOPIFY_READ_CONCURRENCY);
  const [funnelResult, attributionResult, productResult, collectionsResult, landingResult, ordersResult] =
    await Promise.allSettled([
      invoke(() => adapterAttempt.value.fetchFunnelSeries(range.from, range.to)),
      invoke(() =>
        adapterAttempt.value.fetchCampaignAttributionSeries(
          range.from,
          range.to,
          targetCurrency,
        )),
      invoke(() => adapterAttempt.value.fetchCampaignProductSeries(range.from, range.to)),
      invoke(() =>
        adapterAttempt.value.fetchCollectionSalesSeries(
          range.from,
          range.to,
          targetCurrency,
        )),
      invoke(() => adapterAttempt.value.fetchLandingSessionsSeries(range.from, range.to)),
      invoke(async () => {
        const sales = await adapterAttempt.value.fetchDailySales(range.from, range.to);
        return { currency: String(sales.currency ?? "").trim().toUpperCase(), orders: sales.orders };
      }),
    ]);
  const settledAttempt = <T,>(
    result: PromiseSettledResult<T>,
    failedMessage: string,
    unavailableMessage: string,
  ): Attempt<T> => {
    if (result.status === "fulfilled") return { ok: true, value: result.value };
    if (
      result.reason instanceof ShopifyReportingAdapterError &&
      result.reason.code === "missing_scope"
    ) {
      return { ok: false, state: "unavailable", message: unavailableMessage };
    }
    // The cause travels in the message so the snapshot row keeps it (0073);
    // the fixed sentence alone made a throttle and an uninstalled app
    // indistinguishable.
    console.error(`Shopify read failed (${failedMessage})`, result.reason);
    return {
      ok: false,
      state: "failed",
      message: withProviderCause(failedMessage, result.reason),
    };
  };
  const collectionSales = settledAttempt(
    collectionsResult,
    "Shopify collection sales could not be loaded.",
    "Shopify has not granted product or report access.",
  );
  const landing = settledAttempt(
    landingResult,
    "Shopify landing page sessions could not be loaded.",
    "Shopify has not granted report access.",
  );
  const orders = settledAttempt(
    ordersResult,
    "Shopify orders could not be loaded.",
    "Shopify has not granted order access.",
  );

  let funnel: AdminStoreAnalytics["funnel"];
  if (funnelResult.status === "rejected") {
    funnel = shopifyFailure(funnelResult.reason, "the store funnel");
  } else {
    const daily = funnelResult.value.points;
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
      { daily, totals, granularity: funnelResult.value.granularity },
      totals.sessions === 0 &&
        totals.addedToCart === 0 &&
        totals.reachedCheckout === 0 &&
        totals.completedCheckout === 0,
    );
  }

  const attribution = settledAttempt(
    attributionResult,
    "Shopify campaign attribution could not be loaded.",
    "Shopify has not granted campaign report access.",
  );

  const products = settledAttempt(
    productResult,
    "Shopify campaign products could not be loaded.",
    "Shopify has not granted campaign product report access.",
  );

  let collections: AdminStoreAnalytics["collections"];
  if (collectionsResult.status === "rejected") {
    collections = shopifyFailure(collectionsResult.reason, "collection sales");
  } else {
    const rows = collectionsResult.value.map((collection) => ({
      collectionId: collection.collectionId,
      handle: collection.handle,
      title: collection.title,
      revenue: collection.revenue,
      units: collection.units,
      spend: null,
      roas: null,
      timeline: collection.timeline.map((point) => ({
        ...point,
        spend: 0,
        roas: null,
      })),
      products: collection.products.map((product) => ({
        productId: product.productId,
        title: product.title,
        revenue: product.revenue,
        units: product.units,
        spend: null,
        roas: null,
        timeline: product.timeline.map((point) => ({
          ...point,
          spend: 0,
          roas: null,
        })),
      })),
    }));
    collections = {
      state: rows.length === 0 ? "empty" : "ready",
      data: {
        rows,
        granularity: range.from === range.to ? "hour" : "day",
      },
      message:
        "Shopify net sales and net units use the selected reporting days and current official collection membership. A product can belong to more than one collection, so collection rows are not additive. Spend and ROAS require a verified Google offer-to-Shopify product mapping that is not configured.",
    };
  }
  const failedCollectionLookups: string[] = [];
  return {
    funnel,
    attribution,
    products,
    collections,
    collectionSales,
    landing,
    orders,
    collectionProductKeys: async (handle) => {
      try {
        // Null is the store's own answer: it has no collection by that
        // handle, so the campaign landing there has no basis. A set, even an
        // empty one, is a collection the store has.
        return await adapterAttempt.value.readCollectionProductKeys(handle);
      } catch (error) {
        // A read that failed (a throttle, a timeout) says nothing about the
        // collection. The campaign keeps its skip for this refresh, and the
        // handle goes on the list that marks the campaigns family partial,
        // so the last good sheet is kept rather than replaced by one that
        // claims the store has no such collection.
        console.error(
          `Admin store analytics could not read the products of collection "${handle}":`,
          error,
        );
        failedCollectionLookups.push(handle);
        return null;
      }
    },
    failedCollectionLookups,
    timeZone: adapterAttempt.value.timeZone,
  };
}

const GOOGLE_LANDING_PLATFORMS = new Set(["google", "alphabet"]);

export type CampaignCollectionDay = {
  /**
   * What the collection's items earned, the way the client's own sheet reads
   * it: every order's collection lines at what they were charged, net of
   * what was refunded on them (see attributeCampaignCollections). null when
   * the range's orders could not be read: unknown, not none.
   */
  revenue: number | null;
  /** The collection's units sold, less the ones refunded; null with revenue. */
  units: number | null;
  /** Orders holding at least one collection item; null with revenue. */
  orders: number | null;
  /**
   * The same three figures restricted to the orders whose customer FIRST
   * landed on the collection's own page: the part of the total the advertised
   * page can be said to have carried. null with revenue.
   */
  landedRevenue: number | null;
  landedUnits: number | null;
  landedOrders: number | null;
  /**
   * The part of the total the split cannot speak for: Shopify reports no
   * customer journey for the order, so where it came in was never measured.
   * Kept apart from the landed figures rather than left to be inferred from
   * them, so what is left of the total is only the orders actually measured
   * to have arrived some other way. There is no unknownUnits: the sheet
   * prints money and orders for this part, and a units figure nobody reads
   * would still have to be carried through every sum. null with revenue.
   */
  unknownRevenue: number | null;
  unknownOrders: number | null;
  /**
   * Orders that landed on the collection's page and bought NOTHING of the
   * collection, counted whole (what the customer paid, less what came back),
   * because no line of theirs belongs to the collection and the sheet has no
   * other honest way to size them. This is money the page made that the
   * collection total does not contain, so it is kept apart from revenue,
   * units and orders and never added to them. null with revenue.
   */
  broughtRevenue: number | null;
  broughtOrders: number | null;
  /** null when the landing sessions could not be read. */
  addedToCart: number | null;
  /** null when the store's costs could not be read. */
  cogs: number | null;
};

export type CampaignCollectionAttribution = Map<
  string,
  {
    handle: string;
    /** Which evidence named the handle: final URLs, the campaign name, or where its clicks landed. */
    source: CampaignCollectionSource;
    sharedWith: number;
    /** Whether the store's product costs were readable at all. */
    costsKnown: boolean;
    /** Whether the range's orders were readable: a day without figures is a real zero only then. */
    salesKnown: boolean;
    /** Whether the landing sessions were readable, for the same reason. */
    landingKnown: boolean;
    /** Keyed by reporting DAY, never by hour. */
    byDay: Map<string, CampaignCollectionDay>;
  }
>;

/**
 * A ShopifyQL landing path, decoded and lower-cased, without query, hash or
 * trailing slash. Decoded because the report percent-encodes a non-ASCII
 * page, and the handle it is compared with is plain.
 */
function normalizedLandingPath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? "";
  return decodePercentEscapes(bare).trim().toLowerCase().replace(/\/+$/, "");
}

/** Which evidence named a campaign's collection, in the order it is consulted. */
export type CampaignCollectionSource = "final_url" | "name" | "landing";

/**
 * The collection a campaign's clicks predominantly landed on, or null.
 *
 * Performance Max and Shopping campaigns carry no ad-level final URL, so the
 * only page evidence they have is where their clicks went. Clicks are grouped
 * by the collection their landing page names (query strings, trailing slashes
 * and percent-escapes fall away in the helper), and a collection counts as
 * the campaign's when it took at least two thirds of EVERY landing click,
 * homepage and product pages included. A feed campaign that scatters its
 * clicks over product pages, or lands most of them on the homepage, names
 * nothing: its sales cannot be read from one collection. The threshold also
 * rules out a tie, since two collections cannot both hold two thirds.
 *
 * The host is not checked here: a page on another store's domain never
 * arrives, because the reporting read drops it by the owner rule (see
 * landingPagesByCampaign in reporting/google), and the live read serves an
 * account that is the store's own.
 */
export function dominantLandedCollection(
  landingPages: ReadonlyArray<{ url: string; clicks: number }> | null | undefined,
): string | null {
  if (!landingPages?.length) return null;
  let total = 0;
  const clicksByHandle = new Map<string, number>();
  for (const page of landingPages) {
    const clicks = Number.isFinite(page.clicks) && page.clicks > 0 ? page.clicks : 0;
    total += clicks;
    const handle = collectionHandleFromUrl(page.url);
    if (handle) clicksByHandle.set(handle, (clicksByHandle.get(handle) ?? 0) + clicks);
  }
  if (total <= 0) return null;
  let top: { handle: string; clicks: number } | null = null;
  for (const [handle, clicks] of clicksByHandle) {
    if (!top || clicks > top.clicks) top = { handle, clicks };
  }
  return top && top.clicks * 3 >= total * 2 ? top.handle : null;
}

/**
 * The one collection a campaign lands on, with the evidence that named it,
 * or null.
 *
 * The final URLs decide: exactly one collection among them names the page.
 * Only when the URLs name none does the campaign name stand in - a revenue
 * share names its deal there ("... /collections/b 5%"), and a name that
 * differs from the URLs must not cancel them, as it did when both were read
 * together. When neither says, the page most of the clicks landed on does
 * (see dominantLandedCollection), which is how a Performance Max campaign
 * with no final URL at all still gets a collection basis. Two or more
 * collections in the URLs land nowhere in particular, whatever the name or
 * the clicks say.
 */
export function campaignCollection(
  campaign: Pick<LiveCampaign, "name" | "finalUrls" | "landingPages">,
): { handle: string; source: CampaignCollectionSource } | null {
  const fromUrls = new Set(
    (campaign.finalUrls ?? [])
      .map(collectionHandleFromUrl)
      .filter((handle): handle is string => Boolean(handle)),
  );
  if (fromUrls.size > 1) return null;
  const fromUrl = fromUrls.values().next().value;
  if (fromUrl) return { handle: fromUrl, source: "final_url" };
  const fromName = collectionHandleFromUrl(campaign.name);
  if (fromName) return { handle: fromName, source: "name" };
  const landed = dominantLandedCollection(campaign.landingPages);
  return landed ? { handle: landed, source: "landing" } : null;
}

/** The handle alone - see campaignCollection for the rule. Every reader of the collection basis goes through here. */
export function campaignCollectionHandle(
  campaign: Pick<LiveCampaign, "name" | "finalUrls" | "landingPages">,
): string | null {
  return campaignCollection(campaign)?.handle ?? null;
}

/** Runs one lookup per item with at most `limit` in flight at once, keeping the order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Which collection each campaign lands on, and what that collection earned
 * each day, shared out between the campaigns that land there.
 *
 * The campaign's final URLs name the collection page (one handle, else its
 * name, else the page most of its clicks landed on, else the campaign is
 * left out - see campaignCollection). The
 * collection must exist: the sales report only lists collections whose
 * products sold in the window, so a page it left out is looked up in the
 * store, and a collection the store has keeps its sheet with real zeros
 * where nothing sold, whatever the window.
 *
 * What the collection earned is read from the orders themselves, the way
 * the client reads it in the P&L sheet they keep per collection, which this
 * sheet exists to match: every order of the range, whatever page it landed
 * on and whatever channel it came through, counts the lines whose product
 * is in the collection, and nothing else.
 *  - revenue is what those lines were charged after discounts, less what
 *    was refunded on them (never below zero for a line);
 *  - units are the lines' quantities, less the units refunded;
 *  - an order counts once when it holds at least one such line.
 * An order that landed on the collection page but bought something else
 * earns the collection nothing; shipping and the other collections' items
 * of an order never count. The revenue-share ledger reads a landed order
 * whole, shipping and all, because that is the contractual rule the agency
 * bills by - a different rule, kept in finance/rev-share.ts, that this
 * sheet does not follow: read that way, the sheet over-read the client's
 * figures by 40% and more.
 *
 * That total is then split by HOW the sale arrived, because the campaign
 * advertises a collection PAGE and the owner wants to know whether the page
 * is doing the work. Each order is classified by the page its customer first
 * landed on: landedRevenue, landedUnits and landedOrders are the part of the
 * same total bought by customers who landed on /collections/<handle> (or a
 * page under it). Measured on production, the mix is nothing like uniform:
 * one store's collection took 95% of its revenue from people who landed on
 * its page, while another's took every last sale from people who never saw
 * it, so neither path can be assumed away.
 *
 * unknownRevenue and unknownOrders are the third state, and the reason the
 * split cannot be read as a straight two-way one: Shopify reports no customer
 * journey for plenty of orders (and can report none for a whole store or an
 * older period), and such an order landed nowhere the sheet can see. It is
 * counted apart so that what is left of the total after landed and unknown is
 * only the orders measured to have arrived some other way, rather than every
 * order the journey field failed to describe.
 *
 * broughtRevenue and broughtOrders are the third figure, and the reason the
 * split is worth having: orders that landed on the collection page and
 * bought NOTHING of the collection. They hold no line the sheet could read,
 * so they are counted whole - what the customer paid less what came back,
 * the way an order is read everywhere else - and kept strictly apart from
 * revenue, units and orders, which stay the client's own figures to the
 * cent. On one store that was half a million forint of sales the campaign
 * made that the collection sheet reads as zero.
 *
 * Cart additions are the Google sessions that landed on the collection
 * page. COGS is what the collection lines cost, priced by the store's own
 * product costs order by order - manual cost, tiers and cost collections
 * included, exactly as the store's P&L prices them; a refunded unit was
 * still bought and keeps its cost, as it does in that P&L.
 *
 * Amounts arrive in the store's base currency and are converted to the
 * reporting currency with the day's ECB rate, like every other Shopify
 * figure on this page; costs are priced in the reporting currency directly,
 * from lines converted first. Campaigns sharing a page split each day by
 * their share of that day's Google spend, equally when none of them spent.
 *
 * Within one collection the shares sum to one. Across collections the lines
 * are additive: an order holding two collections' items credits each with
 * its own lines.
 */
export async function attributeCampaignCollections(input: {
  google: Attempt<GoogleCampaignLoad>;
  collectionSales: Attempt<ShopifyCollectionSalesSeriesRow[]>;
  /**
   * The product keys of a collection the sales report left out, or null when
   * the store has no such collection (or the read failed). A set, even an
   * empty one, means the collection exists and its zeros are real.
   */
  collectionProductKeys: (handle: string) => Promise<ReadonlySet<string> | null>;
  landing: Attempt<ShopifyLandingSessionsRow[]>;
  orders: Attempt<{ currency: string; orders: SyncedOrder[] }>;
  costs: CostContext | null;
  targetCurrency: string;
  range: Pick<RangeSelection, "from" | "to">;
}): Promise<CampaignCollectionAttribution> {
  const attribution: CampaignCollectionAttribution = new Map();
  if (!input.google.ok || !input.collectionSales.ok) return attribution;
  const collectionByHandle = new Map(
    input.collectionSales.value.flatMap((row) => (row.handle ? [[row.handle, row] as const] : [])),
  );

  // Which collection each campaign names, and by what evidence.
  const namedByCampaign = new Map<string, string>();
  const sourceByCampaign = new Map<string, CampaignCollectionSource>();
  for (const campaign of input.google.value.rows) {
    const named = campaignCollection(campaign);
    if (!named) continue;
    const key = `${campaign.ad_account_id}:${campaign.providerCampaignId}`;
    namedByCampaign.set(key, named.handle);
    sourceByCampaign.set(key, named.source);
  }

  // The products of each named collection. The sales report knows the ones
  // that sold; the rest are asked of the store, once per handle and two at a
  // time, and a handle the store does not know stays out.
  const productKeysByHandle = new Map<string, ReadonlySet<string>>();
  for (const [handle, collection] of collectionByHandle) {
    productKeysByHandle.set(handle, new Set(collection.products.flatMap((product) => product.costKeys)));
  }
  const lookups = new Map<string, Promise<ReadonlySet<string> | null>>();
  const lookup = (handle: string) => {
    let pending = lookups.get(handle);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => input.collectionProductKeys(handle))
        .catch(() => null);
      lookups.set(handle, pending);
    }
    return pending;
  };
  const unlisted = [...new Set(namedByCampaign.values())].filter((handle) => !collectionByHandle.has(handle));
  const found = await mapWithConcurrency(unlisted, 2, lookup);
  unlisted.forEach((handle, index) => {
    const keys = found[index];
    if (keys) productKeysByHandle.set(handle, keys);
  });

  // Which campaigns land where, among the collections the store has.
  const handleByCampaign = new Map<string, string>();
  const campaignsByHandle = new Map<string, string[]>();
  for (const [key, handle] of namedByCampaign) {
    if (!productKeysByHandle.has(handle)) continue;
    handleByCampaign.set(key, handle);
    campaignsByHandle.set(handle, [...(campaignsByHandle.get(handle) ?? []), key]);
  }
  if (handleByCampaign.size === 0) return attribution;

  // Each campaign's Google spend per DAY, for the shares.
  const spendByCampaignDay = new Map<string, number>();
  for (const point of input.google.value.timeline) {
    const key = `${point.accountId}:${point.campaignId}`;
    if (!handleByCampaign.has(key)) continue;
    const dayKey = `${key}|${point.bucket.slice(0, 10)}`;
    spendByCampaignDay.set(dayKey, (spendByCampaignDay.get(dayKey) ?? 0) + point.spend);
  }

  // Google sessions that landed on each collection page, per day.
  const landingByHandleDay = new Map<string, { addedToCart: number; completedCheckout: number }>();
  if (input.landing.ok) {
    for (const row of input.landing.value) {
      if (!GOOGLE_LANDING_PLATFORMS.has(row.platform)) continue;
      const path = normalizedLandingPath(row.landingPath);
      for (const handle of campaignsByHandle.keys()) {
        const page = `/collections/${handle}`;
        if (path !== page && !path.startsWith(`${page}/`)) continue;
        const key = `${handle}|${row.bucket}`;
        const current = landingByHandleDay.get(key) ?? { addedToCart: 0, completedCheckout: 0 };
        current.addedToCart += row.addedToCart;
        current.completedCheckout += row.completedCheckout;
        landingByHandleDay.set(key, current);
      }
    }
  }

  // What each collection earned per day, from the orders, by the client's
  // rule, plus how those sales arrived and what the page brought in beside
  // them. The landed, unknown and brought figures never touch revenue, units,
  // orders or cogs: those stay the client's own total to the cent.
  type EarnedDay = {
    revenue: number;
    units: number;
    orders: number;
    cogs: number | null;
    landedRevenue: number;
    landedUnits: number;
    landedOrders: number;
    unknownRevenue: number;
    unknownOrders: number;
    broughtRevenue: number;
    broughtOrders: number;
  };
  const emptyEarnedDay = (): EarnedDay => ({
    revenue: 0,
    units: 0,
    orders: 0,
    cogs: input.costs ? 0 : null,
    landedRevenue: 0,
    landedUnits: 0,
    landedOrders: 0,
    unknownRevenue: 0,
    unknownOrders: 0,
    broughtRevenue: 0,
    broughtOrders: 0,
  });
  const earnedByHandleDay = new Map<string, EarnedDay>();
  if (input.orders.ok) {
    const rates = input.orders.value.currency === input.targetCurrency || input.orders.value.orders.length === 0
      ? null
      : await fxDailyRates(input.orders.value.currency, input.targetCurrency, input.range.from, input.range.to);
    const convert = (amount: number, day: string) => amount * (rates ? rateOn(rates, day) : 1);
    const collections = [...campaignsByHandle.keys()].map((handle) => ({
      handle,
      productKeys: productKeysByHandle.get(handle) ?? new Set<string>(),
    }));
    for (const order of input.orders.value.orders) {
      // Where the customer FIRST came in, decoded and stripped the same way
      // the collection page is spelled, so a non-ASCII handle that Shopify
      // percent-encodes in the landing page still matches its plain handle.
      // Null is not "somewhere else": Shopify reports no journey at all for
      // plenty of orders, and the order is counted as unmeasured below.
      const landing = normalizePath(order.landingPath);
      const journeyKnown = landing !== null;
      for (const collection of collections) {
        const page = `/collections/${collection.handle}`;
        const landedHere = landing !== null && (landing === page || landing.startsWith(`${page}/`));
        const lines = order.lines.filter((line) => collection.productKeys.has(line.productKey));
        if (lines.length === 0) {
          // Landed on the page and bought none of it. The collection earns
          // nothing here - that is the client's rule and it stays - but the
          // page did bring the order in, so it is counted whole, apart.
          if (!landedHere) continue;
          const key = `${collection.handle}|${order.date}`;
          const current = earnedByHandleDay.get(key) ?? emptyEarnedDay();
          current.broughtRevenue += convert(Math.max(0, order.total - order.refunded), order.date);
          current.broughtOrders += 1;
          earnedByHandleDay.set(key, current);
          continue;
        }
        // Each line at what it was charged, less what came back on it. A
        // refund booked on no line (a custom amount) stays with the order
        // and does not reach the collection, as it does not in the client's
        // sheet either.
        const revenue = lines.reduce(
          (sum, line) => sum + Math.max(0, line.lineTotal - line.refundedAmount),
          0,
        );
        const units = lines.reduce(
          (sum, line) => sum + Math.max(0, line.quantity - line.refundedQuantity),
          0,
        );
        const key = `${collection.handle}|${order.date}`;
        const current = earnedByHandleDay.get(key) ?? emptyEarnedDay();
        const converted = convert(revenue, order.date);
        current.revenue += converted;
        current.units += units;
        current.orders += 1;
        if (landedHere) {
          current.landedRevenue += converted;
          current.landedUnits += units;
          current.landedOrders += 1;
        } else if (!journeyKnown) {
          current.unknownRevenue += converted;
          current.unknownOrders += 1;
        }
        if (current.cogs !== null && input.costs) {
          // The cost context is already in the reporting currency - a manual
          // cost is stored in euros on a forint store - so the engine must run
          // there: convert the line PRICES first and take its answer as it is,
          // exactly as the store's own P&L prices an order. Converting the
          // result instead would rate a euro cost a second time.
          const priced = lines.map((line) => ({
            ...line,
            unitPrice: convert(line.unitPrice, order.date),
          }));
          current.cogs += orderCogs(priced, order.date, input.costs);
        }
        earnedByHandleDay.set(key, current);
      }
    }
  }

  for (const [handle, campaignKeys] of campaignsByHandle) {
    // Every campaign that lands on a collection the store has gets its entry,
    // days or none: the handle names the sheet's basis even before the
    // campaign has spent, landed or sold anything in the window.
    for (const key of campaignKeys) {
      attribution.set(key, {
        handle,
        source: sourceByCampaign.get(key) ?? "final_url",
        sharedWith: campaignKeys.length,
        costsKnown: input.costs !== null,
        salesKnown: input.orders.ok,
        landingKnown: input.landing.ok,
        byDay: new Map<string, CampaignCollectionDay>(),
      });
    }
    const days = new Set<string>([
      ...[...spendByCampaignDay.keys()]
        .filter((dayKey) => campaignKeys.some((key) => dayKey.startsWith(`${key}|`)))
        .map((dayKey) => dayKey.slice(dayKey.indexOf("|") + 1)),
      ...[...landingByHandleDay.keys()]
        .filter((key) => key.startsWith(`${handle}|`))
        .map((key) => key.slice(handle.length + 1)),
      ...[...earnedByHandleDay.keys()]
        .filter((key) => key.startsWith(`${handle}|`))
        .map((key) => key.slice(handle.length + 1)),
    ]);
    for (const day of days) {
      const spends = campaignKeys.map((key) => spendByCampaignDay.get(`${key}|${day}`) ?? 0);
      const totalSpend = spends.reduce((sum, value) => sum + value, 0);
      const shares = campaignKeys.map((_key, index) =>
        totalSpend > 0 ? (spends[index] ?? 0) / totalSpend : 1 / campaignKeys.length,
      );
      const earned = earnedByHandleDay.get(`${handle}|${day}`) ?? emptyEarnedDay();
      const landed = landingByHandleDay.get(`${handle}|${day}`) ?? { addedToCart: 0, completedCheckout: 0 };

      campaignKeys.forEach((key, index) => {
        const share = shares[index] ?? 0;
        const entry = attribution.get(key);
        if (!entry) return;
        entry.byDay.set(day, {
          revenue: input.orders.ok ? earned.revenue * share : null,
          units: input.orders.ok ? earned.units * share : null,
          orders: input.orders.ok ? earned.orders * share : null,
          landedRevenue: input.orders.ok ? earned.landedRevenue * share : null,
          landedUnits: input.orders.ok ? earned.landedUnits * share : null,
          landedOrders: input.orders.ok ? earned.landedOrders * share : null,
          unknownRevenue: input.orders.ok ? earned.unknownRevenue * share : null,
          unknownOrders: input.orders.ok ? earned.unknownOrders * share : null,
          broughtRevenue: input.orders.ok ? earned.broughtRevenue * share : null,
          broughtOrders: input.orders.ok ? earned.broughtOrders * share : null,
          addedToCart: input.landing.ok ? landed.addedToCart * share : null,
          cogs: earned.cogs === null || !input.orders.ok ? null : earned.cogs * share,
        });
      });
    }
  }
  return attribution;
}

/** Attribute spend only through exact provider URLs or verified Shopify product IDs. */
export function attributeCollectionSpend(
  family: AdminStoreAnalytics["collections"],
  google: Attempt<GoogleCampaignLoad>,
  campaignProducts: Attempt<ShopifyCampaignProductSeriesRow[]>,
): AdminStoreAnalytics["collections"] {
  if (!("data" in family) || !google.ok) return family;
  const rows = family.data.rows;
  const collectionByHandle = new Map(
    rows.flatMap((row) => row.handle ? [[row.handle, row] as const] : []),
  );
  const productsById = new Map<string, AdminAnalyticsCollectionProduct>();
  for (const collection of rows) {
    for (const product of collection.products) productsById.set(product.productId, product);
  }
  const mappedByCampaign = new Map<string, ShopifyCampaignProductSeriesRow[]>();
  if (campaignProducts.ok) {
    for (const product of campaignProducts.value) {
      const list = mappedByCampaign.get(product.campaignId) ?? [];
      list.push(product);
      mappedByCampaign.set(product.campaignId, list);
    }
  }
  const spendByProductBucket = new Map<string, number>();
  for (const campaign of google.value.rows) {
    const collectionHandle = campaignCollectionHandle(campaign);
    const target = collectionHandle ? collectionByHandle.get(collectionHandle) ?? null : null;
    const mapped = mappedByCampaign.get(campaign.providerCampaignId) ?? [];
    let candidates = mapped
      .map((row) => productsById.get(row.productId))
      .filter((row): row is AdminAnalyticsCollectionProduct => Boolean(row));
    if (target) {
      const allowed = new Set(target.products.map((product) => product.productId));
      candidates = candidates.filter((product) => allowed.has(product.productId));
      if (candidates.length === 0) candidates = target.products;
    }
    candidates = [...new Map(candidates.map((product) => [product.productId, product])).values()]
      .sort((left, right) => left.productId.localeCompare(right.productId));
    if (candidates.length === 0) continue;
    for (const point of google.value.timeline) {
      if (
        point.accountId !== campaign.ad_account_id ||
        point.campaignId !== campaign.providerCampaignId ||
        point.spend <= 0
      ) continue;
      // Owner rule (2026-08-18): Demand Gen splits the campaign budget EQUALLY
      // between its products by default, and each product's Real ROAS is its
      // revenue over that equal share. Weighting by revenue/units made every
      // product's ROAS identical to the campaign's — mathematically true and
      // commercially useless.
      candidates.forEach((product) => {
        const share = point.spend / candidates.length;
        const key = `${product.productId}\u0000${point.bucket}`;
        spendByProductBucket.set(key, (spendByProductBucket.get(key) ?? 0) + share);
      });
    }
  }

  const enriched = rows.map((collection) => {
    const products = collection.products.map((product) => {
      const buckets = [...new Set([
        ...product.timeline.map((point) => point.bucket),
        ...[...spendByProductBucket.keys()]
          .filter((key) => key.startsWith(`${product.productId}\u0000`))
          .map((key) => key.slice(product.productId.length + 1)),
      ])].sort();
      const timeline = buckets.map((bucket) => {
        const sales = product.timeline.find((point) => point.bucket === bucket);
        const spend = spendByProductBucket.get(`${product.productId}\u0000${bucket}`) ?? 0;
        const revenue = sales?.revenue ?? 0;
        return {
          bucket,
          revenue,
          units: sales?.units ?? 0,
          spend,
          roas: spend > 0 ? revenue / spend : null,
        };
      });
      const attributed = timeline.some((point) => point.spend > 0);
      const spend = attributed
        ? timeline.reduce((sum, point) => sum + point.spend, 0)
        : null;
      return {
        ...product,
        timeline,
        spend,
        roas: spend && spend > 0 ? product.revenue / spend : null,
      };
    });
    const buckets = [...new Set(products.flatMap((product) =>
      product.timeline.map((point) => point.bucket)))].sort();
    const timeline = buckets.map((bucket) => {
      const points = products.flatMap((product) => {
        const point = product.timeline.find((entry) => entry.bucket === bucket);
        return point ? [point] : [];
      });
      const revenue = points.reduce((sum, point) => sum + point.revenue, 0);
      const units = points.reduce((sum, point) => sum + point.units, 0);
      const spend = points.reduce((sum, point) => sum + point.spend, 0);
      return { bucket, revenue, units, spend, roas: spend > 0 ? revenue / spend : null };
    });
    const attributed = products.some((product) => product.spend !== null);
    const spend = attributed
      ? products.reduce((sum, product) => sum + (product.spend ?? 0), 0)
      : null;
    return {
      ...collection,
      products,
      timeline,
      spend,
      roas: spend && spend > 0 ? collection.revenue / spend : null,
    };
  });
  return {
    ...family,
    data: { ...family.data, rows: enriched },
    message:
      "Shopify sales use official collection membership. Ad spend is attributed only by an exact /collections/<handle> campaign URL or exact Google campaign UTM → Shopify product mapping, then split equally between the campaign's products (Demand Gen default). Collection rows remain non-additive when a product belongs to more than one collection.",
  };
}

type ShopifyFamilies = Awaited<ReturnType<typeof shopifyFamilies>>;

function failedShopifyFamilies(): ShopifyFamilies {
  return {
    funnel: failed("Shopify funnel data could not be loaded for this store."),
    attribution: {
      ok: false,
      state: "failed",
      message: "Shopify campaign attribution could not be loaded.",
    },
    products: {
      ok: false,
      state: "failed",
      message: "Shopify campaign products could not be loaded.",
    },
    collections: failed("Collection performance could not be loaded for this store."),
    collectionSales: {
      ok: false,
      state: "failed",
      message: "Shopify collection sales could not be loaded.",
    },
    landing: {
      ok: false,
      state: "failed",
      message: "Shopify landing page sessions could not be loaded.",
    },
    orders: {
      ok: false,
      state: "failed",
      message: "Shopify orders could not be loaded.",
    },
    collectionProductKeys: async () => null,
    failedCollectionLookups: [],
    timeZone: null,
  };
}

/** A stored setting as a number; anything unreadable is a zero fee, not a NaN one. */
function feeSetting(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The store's product costs, for the campaign sheet's COGS column, and its
 * per-order fee settings, for the sheet's fee columns. Both read on a
 * best-effort basis: a store whose settings cannot be read still gets its
 * sheet, with those columns reading as unknown. The fee settings are one row read;
 * the costs need the cost tables on top, so they can be missing on their
 * own while the fees are known.
 */
async function loadStoreCostContext(
  service: NonNullable<ReturnType<typeof createServiceClient>>,
  accountId: string,
  currency: string,
): Promise<{ costs: CostContext | null; fees: CampaignSheetFees | null }> {
  let fees: CampaignSheetFees;
  let defaultPct: number;
  try {
    const { data, error } = await service
      .from("ad_accounts")
      .select("default_product_cost_pct, payment_fee_pct, payment_fee_fixed, shipping_cost_per_order, commission_rate")
      .eq("id", accountId)
      .maybeSingle();
    if (error) throw error;
    const storedPct = Number(data?.default_product_cost_pct ?? 30);
    defaultPct = Number.isFinite(storedPct) ? storedPct : 30;
    fees = {
      paymentFeePct: feeSetting(data?.payment_fee_pct),
      paymentFeeFixed: feeSetting(data?.payment_fee_fixed),
      shippingCostPerOrder: feeSetting(data?.shipping_cost_per_order),
      agencyFeeRate: feeSetting(data?.commission_rate),
    };
  } catch (error) {
    console.error("Admin store analytics could not read the store's cost settings:", error);
    return { costs: null, fees: null };
  }
  try {
    return { costs: await loadCostContext(service, accountId, defaultPct, currency), fees };
  } catch (error) {
    console.error("Admin store analytics could not read product costs:", error);
    return { costs: null, fees };
  }
}

/** Today's date in a zone, as the ISO day the reporting buckets use. */
function localDayIn(timeZone: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

function failedStoreAnalytics(input: FetchAdminStoreAnalyticsInput): AdminStoreAnalytics {
  return {
    clientId: input.clientId,
    storeAccountId: input.store.accountId,
    currency: input.store.currency,
    range: { from: input.range.from, to: input.range.to },
    funnel: failed("Shopify funnel data could not be loaded for this store."),
    campaigns: failed("Campaign performance could not be loaded for this store."),
    collections: failed("Collection performance could not be loaded for this store."),
    spend: failed("Spend could not be loaded for this store."),
    rollupCoverage: failed("The reporting rollup could not be loaded for this store."),
    activity: failed("Campaign activity could not be loaded for this store."),
    providerFreshness: {
      state: "not_synced",
      refreshedAt: null,
      lastAttemptAt: null,
      lastErrorCode: "topology_failed",
      stale: false,
    },
  };
}

async function buildLiveAdminStoreAnalytics(
  input: FetchAdminStoreAnalyticsInput,
  topology: StoreTopology,
): Promise<AdminStoreAnalytics> {
  const accountIds = [...new Set(input.store.activityAccountIds)];
  const googlePromise = loadGoogleCampaigns(topology, input.range, input.store.currency);
  const breakdownPromise = loadGoogleBreakdowns(topology, input.range);
  // Shopify used to start only after Google, breakdown, activity and rollup
  // completed. Keep every independent provider in the same request phase.
  const shopifyPromise = openShopify(topology)
    .then((adapter) => shopifyFamilies(adapter, input.range, input.store.currency))
    .catch((error): ShopifyFamilies => {
      console.error("Admin store Shopify analytics composition failed:", error);
      return failedShopifyFamilies();
    });
  const rollupPromise = rollupFamilies(topology, accountIds, input.range);
  const costsPromise = loadStoreCostContext(
    topology.service,
    input.store.accountId,
    input.store.currency,
  );
  const activityPromise = listCampaignActionActivity(
    input.clientId,
    accountIds,
    input.range,
  ).then(
    (value): Attempt<typeof value> => ({ ok: true, value }),
    (): Attempt<never> => ({
      ok: false,
      state: "failed",
      message: "Campaign activity could not be loaded for the selected period.",
    }),
  );

  const [google, breakdowns, shopify, activityResult, rollup, { costs, fees }] = await Promise.all([
    googlePromise,
    breakdownPromise,
    shopifyPromise,
    activityPromise,
    rollupPromise,
    costsPromise,
  ]);

  let campaigns: AdminStoreAnalytics["campaigns"];
  try {
    const collectionAttribution = await attributeCampaignCollections({
      google,
      collectionSales: shopify.collectionSales,
      collectionProductKeys: shopify.collectionProductKeys,
      landing: shopify.landing,
      orders: shopify.orders,
      costs,
      targetCurrency: input.store.currency,
      range: input.range,
    });
    campaigns = campaignFamily(
      google,
      breakdowns,
      shopify.attribution,
      shopify.products,
      shopify.timeZone ? localDayIn(shopify.timeZone) : null,
      collectionAttribution,
      {
        collectionSales: shopify.collectionSales,
        landing: shopify.landing,
        orders: shopify.orders,
        // Filled while the attribution above ran its lookups.
        failedLookups: shopify.failedCollectionLookups,
      },
      fees,
    );
  } catch (error) {
    console.error("Admin store campaign analytics composition failed:", error);
    campaigns = failed("Campaign performance could not be loaded for this store.");
  }
  let collections: AdminStoreAnalytics["collections"];
  try {
    collections = attributeCollectionSpend(
      shopify.collections,
      google,
      shopify.products,
    );
  } catch (error) {
    // Spend attribution is an enrichment. A malformed campaign-product
    // projection must not erase the sound Shopify collection sales family.
    console.error("Admin store collection spend attribution failed:", error);
    collections = shopify.collections;
  }
  let spend = rollup.spend;
  if (google.ok && google.value.granularity === "hour") {
    const byBucket = new Map<string, number>();
    for (const point of google.value.timeline) {
      byBucket.set(point.bucket, (byBucket.get(point.bucket) ?? 0) + point.spend);
    }
    const daily = [...byBucket.entries()]
      .map(([bucket, value]) => ({ day: bucket.slice(0, 10), bucket, spend: value }))
      .sort((left, right) => left.bucket.localeCompare(right.bucket));
    spend = google.message
      ? { state: "partial", data: { granularity: "hour", daily }, message: google.message }
      : readyOrEmpty({ granularity: "hour", daily }, daily.length === 0);
  }

  let activity: AdminStoreAnalytics["activity"];
  try {
    activity = activityResult.ok
      ? readyOrEmpty(
          { rows: activityResult.value.history, truncated: activityResult.value.truncated },
          activityResult.value.history.length === 0,
        )
      : failed(activityResult.message);
  } catch (error) {
    console.error("Admin store campaign activity composition failed:", error);
    activity = failed("Campaign activity could not be loaded for this store.");
  }

  return {
    clientId: input.clientId,
    storeAccountId: input.store.accountId,
    currency: input.store.currency,
    range: { from: input.range.from, to: input.range.to },
    funnel: shopify.funnel,
    campaigns,
    collections,
    spend,
    rollupCoverage: rollup.rollupCoverage,
    activity,
    providerFreshness: {
      state: "live",
      refreshedAt: null,
      lastAttemptAt: null,
      lastErrorCode: null,
      stale: false,
    },
    shopifyProvenance: topology.shopifyProvenance,
  };
}

/**
 * Purpose-bound live builder used only by explicit sync jobs. Page renders use
 * fetchCachedAdminStoreAnalytics below and never wait on a provider.
 */
export async function fetchAdminStoreAnalytics(
  input: FetchAdminStoreAnalyticsInput,
  options: { authenticate?: boolean } = {},
): Promise<AdminStoreAnalytics> {
  assertInput(input);
  if (options.authenticate !== false) await requireClientOnboardingAdmin();
  try {
    return await buildLiveAdminStoreAnalytics(input, await loadTopology(input));
  } catch (error) {
    console.error("Admin store analytics load failed:", error);
    return failedStoreAnalytics(input);
  }
}

function storedFamily<T>(
  snapshot: AdminReportingSnapshotValue<unknown>,
  emptyData: T,
): AdminAnalyticsFamily<T> {
  const failedAttempt = snapshot.lastErrorCode
    ? ` The last refresh failed (${snapshot.lastErrorCode}); showing the last successful snapshot.`
    : "";
  if (snapshot.state === "not_synced") {
    return notSynced("Sync this exact reporting period to load this provider data.");
  }
  if (snapshot.state === "unavailable") {
    return unavailable(snapshot.message || "This provider family is unavailable.");
  }
  if (snapshot.state === "empty") {
    return {
      state: "empty",
      data: emptyData,
      message: `${snapshot.message ?? ""}${failedAttempt}`.trim() || null,
    };
  }
  if (snapshot.rows.length !== 1) {
    return notSynced("The stored provider snapshot is invalid. Sync this exact period again.");
  }
  const message = `${snapshot.message ?? ""}${failedAttempt}`.trim();
  if (snapshot.state === "partial") {
    return {
      state: "partial",
      data: snapshot.rows[0] as T,
      message: message || "This provider snapshot is partial.",
    };
  }
  return { state: "ready", data: snapshot.rows[0] as T, message: message || null };
}

type FunnelSnapshotData = {
  granularity: AdminAnalyticsGranularity;
  daily: AdminAnalyticsFunnelDay[];
  totals: {
    sessions: number;
    addedToCart: number;
    reachedCheckout: number;
    completedCheckout: number;
  };
};

type CampaignSnapshotData = {
  granularity: AdminAnalyticsGranularity;
  rows: AdminAnalyticsCampaign[];
  storeToday?: string | null;
  fees?: CampaignSheetFees | null;
};

type CollectionSnapshotData = {
  granularity: AdminAnalyticsGranularity;
  rows: AdminAnalyticsCollection[];
};

function bucketInRange(bucket: string, from: string, to: string): boolean {
  const day = bucket.slice(0, 10);
  return isDay(day) && day >= from && day <= to;
}

function fallbackPeriodMessage(
  selection: AdminReportingSnapshotSelection<unknown>,
  buckets: string[],
): string {
  const days = buckets.map((bucket) => bucket.slice(0, 10)).filter(isDay).sort();
  const from = days[0] ?? selection.availableFrom;
  const to = days.at(-1) ?? selection.availableTo;
  return `Showing materialized provider data available for ${from} → ${to} from the synced ${selection.sourceFrom} → ${selection.sourceTo} snapshot. Sync the selected period for an exact provider view.`;
}

function slicedFunnelFamily(
  family: AdminAnalyticsFamily<FunnelSnapshotData>,
  selection: AdminReportingSnapshotSelection<unknown>,
): AdminAnalyticsFamily<FunnelSnapshotData> {
  if (selection.exact || !("data" in family)) return family;
  const daily = family.data.daily.filter((point) =>
    bucketInRange(point.bucket || point.day, selection.availableFrom, selection.availableTo));
  const totals = daily.reduce((sum, point) => ({
    sessions: sum.sessions + point.sessions,
    addedToCart: sum.addedToCart + point.addedToCart,
    reachedCheckout: sum.reachedCheckout + point.reachedCheckout,
    completedCheckout: sum.completedCheckout + point.completedCheckout,
  }), { sessions: 0, addedToCart: 0, reachedCheckout: 0, completedCheckout: 0 });
  if (daily.length === 0) {
    return { state: "empty", data: { ...family.data, daily, totals }, message: fallbackPeriodMessage(selection, []) };
  }
  return {
    state: "partial",
    data: { ...family.data, daily, totals },
    message: fallbackPeriodMessage(selection, daily.map((point) => point.bucket || point.day)),
  };
}

function sumOptionalCampaignMetric(
  points: AdminAnalyticsCampaignTimelinePoint[],
  key: "impressions" | "clicks" | "conversions",
): number | null {
  return points.every((point) => typeof point[key] === "number" && Number.isFinite(point[key]))
    ? points.reduce((sum, point) => sum + (point[key] ?? 0), 0)
    : null;
}

function slicedCampaignFamily(
  family: AdminAnalyticsFamily<CampaignSnapshotData>,
  selection: AdminReportingSnapshotSelection<unknown>,
): AdminAnalyticsFamily<CampaignSnapshotData> {
  if (selection.exact || !("data" in family)) return family;
  const rows = family.data.rows.flatMap((campaign) => {
    const timeline = campaign.timeline.filter((point) =>
      bucketInRange(point.bucket, selection.availableFrom, selection.availableTo));
    if (timeline.length === 0) return [];
    const spend = timeline.reduce((sum, point) => sum + point.spend, 0);
    const googleRevenue = timeline.reduce((sum, point) => sum + point.googleRevenue, 0);
    const shopifyRevenue = timeline.every((point) => point.shopifyRevenue !== null)
      ? timeline.reduce((sum, point) => sum + (point.shopifyRevenue ?? 0), 0)
      : null;
    const impressions = sumOptionalCampaignMetric(timeline, "impressions");
    const clicks = sumOptionalCampaignMetric(timeline, "clicks");
    const conversions = sumOptionalCampaignMetric(timeline, "conversions");
    const addedToCart = timeline.every((point) => typeof point.addedToCart === "number")
      ? timeline.reduce((sum, point) => sum + (point.addedToCart ?? 0), 0)
      : null;
    const shopifyUnits = timeline.every((point) => typeof point.units === "number")
      ? timeline.reduce((sum, point) => sum + (point.units ?? 0), 0)
      : null;
    const breakdown: AdminAnalyticsCampaignBreakdown =
      campaign.breakdown.state === "ready" || campaign.breakdown.state === "empty"
        ? {
          ...campaign.breakdown,
          rows: campaign.breakdown.rows.map((row) => ({
            ...row,
            spend: null,
            impressions: null,
            clicks: null,
            conversions: null,
            googleRevenue: null,
            shopifyUnits: null,
            shopifyRevenue: null,
          })),
        }
        : campaign.breakdown;
    return [{
      ...campaign,
      spend,
      impressions,
      clicks,
      conversions,
      googleRevenue,
      shopifySessions: null,
      shopifyOrders: null,
      addedToCart,
      shopifyUnits,
      shopifyRevenue,
      ctr: impressions && impressions > 0 && clicks !== null ? clicks / impressions : null,
      cpc: clicks && clicks > 0 ? spend / clicks : null,
      cpm: impressions && impressions > 0 ? (spend / impressions) * 1_000 : null,
      cpa: conversions && conversions > 0 ? spend / conversions : null,
      googleRoas: spend > 0 ? googleRevenue / spend : null,
      realRoas: spend > 0 && shopifyRevenue !== null ? shopifyRevenue / spend : null,
      // A match whose sliced days lost their revenue is unavailable here. An
      // unmatched campaign stays unmatched: its revenue was null to begin
      // with, and a data gap is not a provider outage - the sheet's caption
      // tells the two apart.
      attributionState: shopifyRevenue === null && campaign.attributionState === "matched"
        ? "unavailable" as const
        : campaign.attributionState,
      timeline,
      breakdown,
    }];
  });
  const buckets = rows.flatMap((row) => row.timeline.map((point) => point.bucket));
  if (rows.length === 0) {
    return { state: "empty", data: { ...family.data, rows }, message: fallbackPeriodMessage(selection, []) };
  }
  return {
    state: "partial",
    data: { ...family.data, rows },
    message: fallbackPeriodMessage(selection, buckets),
  };
}

function slicedCollectionFamily(
  family: AdminAnalyticsFamily<CollectionSnapshotData>,
  selection: AdminReportingSnapshotSelection<unknown>,
): AdminAnalyticsFamily<CollectionSnapshotData> {
  if (selection.exact || !("data" in family)) return family;
  const rows = family.data.rows.flatMap((collection) => {
    const timeline = collection.timeline.filter((point) =>
      bucketInRange(point.bucket, selection.availableFrom, selection.availableTo));
    const products = collection.products.flatMap((product) => {
      const productTimeline = product.timeline.filter((point) =>
        bucketInRange(point.bucket, selection.availableFrom, selection.availableTo));
      if (productTimeline.length === 0) return [];
      const revenue = productTimeline.reduce((sum, point) => sum + point.revenue, 0);
      const units = productTimeline.reduce((sum, point) => sum + point.units, 0);
      const spend = product.spend === null || product.spend === undefined
        ? null
        : productTimeline.reduce((sum, point) => sum + point.spend, 0);
      return [{
        ...product,
        revenue,
        units,
        spend,
        roas: spend && spend > 0 ? revenue / spend : null,
        timeline: productTimeline,
      }];
    });
    if (timeline.length === 0 && products.length === 0) return [];
    const revenue = timeline.reduce((sum, point) => sum + point.revenue, 0);
    const units = timeline.reduce((sum, point) => sum + point.units, 0);
    const spend = collection.spend === null
      ? null
      : timeline.reduce((sum, point) => sum + point.spend, 0);
    return [{
      ...collection,
      products,
      revenue,
      units,
      spend,
      roas: spend && spend > 0 ? revenue / spend : null,
      timeline,
    }];
  });
  const buckets = rows.flatMap((row) => row.timeline.map((point) => point.bucket));
  if (rows.length === 0) {
    return { state: "empty", data: { ...family.data, rows }, message: fallbackPeriodMessage(selection, []) };
  }
  return {
    state: "partial",
    data: { ...family.data, rows },
    message: fallbackPeriodMessage(selection, buckets),
  };
}

function addTrackingTimelines(
  campaigns: AdminAnalyticsFamily<CampaignSnapshotData>,
  campaignTracking: AdminAnalyticsFamily<CampaignSnapshotData>,
  collections: AdminAnalyticsFamily<CollectionSnapshotData>,
  collectionTracking: AdminAnalyticsFamily<CollectionSnapshotData>,
) {
  const campaignTimelines = new Map(
    "data" in campaignTracking
      ? campaignTracking.data.rows.map((row) => [
          `${row.accountId}:${row.campaignId}`,
          row.timeline,
        ] as const)
      : [],
  );
  const collectionTimelines = new Map(
    "data" in collectionTracking
      ? collectionTracking.data.rows.map((row) => [row.collectionId, row.timeline] as const)
      : [],
  );
  const productTimelines = new Map(
    "data" in collectionTracking
      ? collectionTracking.data.rows.flatMap((row) => row.products.map((product) => [
          `${row.collectionId}:${product.productId}`,
          product.timeline,
        ] as const))
      : [],
  );

  const trackedCampaigns = "data" in campaigns
    ? {
        ...campaigns,
        data: {
          ...campaigns.data,
          rows: campaigns.data.rows.map((row) => ({
            ...row,
            trackingTimeline: campaignTimelines.get(`${row.accountId}:${row.campaignId}`) ?? row.timeline,
          })),
        },
      }
    : campaigns;
  const trackedCollections = "data" in collections
    ? {
        ...collections,
        data: {
          ...collections.data,
          rows: collections.data.rows.map((row) => ({
            ...row,
            trackingTimeline: collectionTimelines.get(row.collectionId) ?? row.timeline,
            products: row.products.map((product) => ({
              ...product,
              trackingTimeline: productTimelines.get(`${row.collectionId}:${product.productId}`) ?? product.timeline,
            })),
          })),
        },
      }
    : collections;

  return { campaigns: trackedCampaigns, collections: trackedCollections };
}

function providerFreshness(
  snapshots: AdminReportingSnapshotValue<unknown>[],
  range: Pick<RangeSelection, "to">,
): AdminProviderFreshness {
  const refreshed = snapshots
    .flatMap((snapshot) => snapshot.refreshedAt ? [snapshot.refreshedAt] : [])
    .sort();
  const attempted = snapshots
    .flatMap((snapshot) => snapshot.lastAttemptAt ? [snapshot.lastAttemptAt] : [])
    .sort();
  const error = snapshots.find((snapshot) => snapshot.lastErrorCode)?.lastErrorCode ?? null;
  const missing = snapshots.filter((snapshot) => snapshot.state === "not_synced").length;
  const partial = snapshots.some((snapshot) => snapshot.state === "partial");
  const refreshedAt = refreshed[0] ?? null;
  const stale = adminReportingSnapshotIsStale({ to: range.to, refreshedAt });
  return {
    state: missing === snapshots.length
      ? "not_synced"
      : missing > 0 || partial || error || stale
        ? "partial"
        : "ready",
    // Oldest success is the conservative point at which every ready family is fresh.
    refreshedAt,
    lastAttemptAt: attempted.at(-1) ?? null,
    lastErrorCode: error,
    stale,
  };
}

function missingStoredSnapshot(): AdminReportingSnapshotValue<unknown> {
  return {
    state: "not_synced",
    rows: [],
    message: "This exact reporting period has not been synced yet.",
    refreshedAt: null,
    lastAttemptAt: null,
    lastErrorCode: null,
    revision: 0,
  };
}

function missingStoredSelection(
  range: Pick<RangeSelection, "from" | "to">,
): AdminReportingSnapshotSelection<unknown> {
  return {
    snapshot: missingStoredSnapshot(),
    sourceFrom: range.from,
    sourceTo: range.to,
    availableFrom: range.from,
    availableTo: range.to,
    exact: true,
  };
}

async function currentActivity(
  input: FetchAdminStoreAnalyticsInput,
): Promise<AdminStoreAnalytics["activity"]> {
  try {
    const result = await listCampaignActionActivity(
      input.clientId,
      [...new Set(input.store.activityAccountIds)],
      input.range,
    );
    return readyOrEmpty(
      { rows: result.history, truncated: result.truncated },
      result.history.length === 0,
    );
  } catch {
    return failed("Campaign activity could not be loaded for the selected period.");
  }
}

/** Fast page read: internal rollups/activity plus exact-range provider snapshots. */
export async function fetchCachedAdminStoreAnalytics(
  input: FetchAdminStoreAnalyticsInput,
): Promise<AdminStoreAnalytics> {
  assertInput(input);
  await requireClientOnboardingAdmin();
  let topology: StoreTopology;
  try {
    topology = await loadTopology(input);
  } catch (error) {
    console.error("Admin cached store analytics topology failed:", error);
    return failedStoreAnalytics(input);
  }

  const families = [
    "shopify_funnel",
    "store_campaign_performance",
    "shopify_collection_sales",
  ] as const;
  const trackingTo = lisbonToday();
  const trackingFrom = offsetDay(trackingTo, -29);
  const needsTrackingSnapshot =
    input.range.from !== trackingFrom || input.range.to !== trackingTo;
  const [stored, trackingStored, rollup, activity] = await Promise.all([
    readAdminReportingSnapshotFamilySelections({
      client: topology.service,
      families: [...families],
      accountId: input.store.accountId,
      authorityKey: topology.authority.key,
      from: input.range.from,
      to: input.range.to,
    }).catch(() => new Map()),
    needsTrackingSnapshot
      ? readAdminReportingSnapshotFamilySelections({
          client: topology.service,
          families: ["store_campaign_performance", "shopify_collection_sales"],
          accountId: input.store.accountId,
          authorityKey: topology.authority.key,
          from: trackingFrom,
          to: trackingTo,
        }).catch(() => new Map())
      : Promise.resolve(new Map()),
    rollupFamilies(
      topology,
      [...new Set(input.store.activityAccountIds)],
      input.range,
    ),
    currentActivity(input),
  ]);
  const selections = families.map(
    (family) => stored.get(family) ?? missingStoredSelection(input.range),
  );
  const snapshots = selections.map((selection) => selection.snapshot);
  const [funnelSnapshot, campaignsSnapshot, collectionsSnapshot] = snapshots;
  const [funnelSelection, campaignsSelection, collectionsSelection] = selections;
  const trackingCampaignSelection = needsTrackingSnapshot
    ? trackingStored.get("store_campaign_performance") ?? missingStoredSelection({ from: trackingFrom, to: trackingTo })
    : campaignsSelection;
  const trackingCollectionSelection = needsTrackingSnapshot
    ? trackingStored.get("shopify_collection_sales") ?? missingStoredSelection({ from: trackingFrom, to: trackingTo })
    : collectionsSelection;
  const funnel = slicedFunnelFamily(storedFamily<FunnelSnapshotData>(funnelSnapshot, {
    granularity: "day" as const,
    daily: [],
    totals: { sessions: 0, addedToCart: 0, reachedCheckout: 0, completedCheckout: 0 },
  }), funnelSelection);
  const selectedCampaigns = slicedCampaignFamily(storedFamily<CampaignSnapshotData>(campaignsSnapshot, {
    granularity: "day" as const,
    rows: [],
  }), campaignsSelection);
  const selectedCollections = slicedCollectionFamily(storedFamily<CollectionSnapshotData>(collectionsSnapshot, {
    granularity: "day" as const,
    rows: [],
  }), collectionsSelection);
  const campaignTracking = slicedCampaignFamily(storedFamily<CampaignSnapshotData>(trackingCampaignSelection.snapshot, {
    granularity: "day" as const,
    rows: [],
  }), trackingCampaignSelection);
  const collectionTracking = slicedCollectionFamily(storedFamily<CollectionSnapshotData>(trackingCollectionSelection.snapshot, {
    granularity: "day" as const,
    rows: [],
  }), trackingCollectionSelection);
  const { campaigns, collections } = addTrackingTimelines(
    selectedCampaigns,
    campaignTracking,
    selectedCollections,
    collectionTracking,
  );
  let spend = rollup.spend;
  if (
    "data" in campaigns &&
    campaigns.data.granularity === "hour"
  ) {
    const byBucket = new Map<string, number>();
    for (const campaign of campaigns.data.rows) {
      for (const point of campaign.timeline ?? []) {
        byBucket.set(point.bucket, (byBucket.get(point.bucket) ?? 0) + point.spend);
      }
    }
    const daily = [...byBucket.entries()]
      .map(([bucket, value]) => ({ day: bucket.slice(0, 10), bucket, spend: value }))
      .sort((left, right) => left.bucket.localeCompare(right.bucket));
    spend = readyOrEmpty({ granularity: "hour", daily }, daily.length === 0);
  }
  const freshness = providerFreshness(snapshots, input.range);
  const campaignsFreshness = providerFreshness([campaignsSnapshot], input.range);
  return {
    clientId: input.clientId,
    storeAccountId: input.store.accountId,
    currency: input.store.currency,
    range: { from: input.range.from, to: input.range.to },
    funnel,
    campaigns,
    collections,
    spend,
    rollupCoverage: rollup.rollupCoverage,
    activity,
    providerFreshness: selections.some((selection) => !selection.exact) && freshness.state === "ready"
      ? { ...freshness, state: "partial" }
      : freshness,
    campaignsFreshness: !campaignsSelection.exact && campaignsFreshness.state === "ready"
      ? { ...campaignsFreshness, state: "partial" }
      : campaignsFreshness,
    shopifyProvenance: topology.shopifyProvenance,
  };
}

/**
 * Just the Shopify funnel for one store, for the client's own view of it.
 *
 * The admin analytics screen owns the full store picture; a client only needs
 * to see the same funnel for a store that is theirs. This reads the exact same
 * stored `shopify_funnel` snapshot the admin path reads — one query, no live
 * provider call — so the two never disagree, and reuses loadTopology, which
 * re-proves through the service role that the account belongs to input.clientId
 * before touching a snapshot.
 *
 * Authorisation is the caller's to enforce: the portal has already RLS-scoped
 * the account to the signed-in workspace before it gets here, and passes that
 * workspace as clientId. loadTopology's own client/currency check is the
 * fail-closed backstop, so a mismatched pair reads nothing rather than another
 * store's numbers.
 */
export async function fetchClientStoreFunnel(input: {
  clientId: string;
  accountId: string;
  activityAccountIds: string[];
  currency: string;
  range: { from: string; to: string };
}): Promise<AdminStoreAnalytics["funnel"]> {
  // `days` is the admin overview's own spend series and the funnel snapshot
  // read ignores it (loadTopology never reads it), so the client caller need
  // not carry it — an empty series stands in.
  const scoped: FetchAdminStoreAnalyticsInput = {
    clientId: input.clientId,
    store: {
      accountId: input.accountId,
      activityAccountIds: input.activityAccountIds,
      currency: input.currency,
      days: [],
    },
    range: input.range,
  };
  assertInput(scoped);
  let topology: StoreTopology;
  try {
    topology = await loadTopology(scoped);
  } catch (error) {
    console.error("Client store funnel topology failed:", error);
    return failed("The store funnel could not be loaded.");
  }

  const stored = await readAdminReportingSnapshotFamilySelections({
    client: topology.service,
    families: ["shopify_funnel"],
    accountId: input.accountId,
    authorityKey: topology.authority.key,
    from: input.range.from,
    to: input.range.to,
  }).catch(() => new Map());
  const funnelSelection =
    stored.get("shopify_funnel") ?? missingStoredSelection(input.range);

  return slicedFunnelFamily(
    storedFamily<FunnelSnapshotData>(funnelSelection.snapshot, {
      granularity: "day" as const,
      daily: [],
      totals: { sessions: 0, addedToCart: 0, reachedCheckout: 0, completedCheckout: 0 },
    }),
    funnelSelection,
  );
}

function snapshotFamilyResult<T>(family: AdminAnalyticsFamily<T>) {
  if (family.state === "failed" || family.state === "not_synced") {
    // Carry the provider's own message: the refresh's failure path persists
    // this text onto the snapshot row (0073) — a generic wrapper here made
    // every provider failure indistinguishable.
    throw new Error(
      family.message || "The provider family failed during refresh.",
    );
  }
  if (family.state === "unavailable") {
    return { state: "unavailable" as const, rows: [], message: family.message };
  }
  if (family.state === "empty") {
    return { state: "empty" as const, rows: [], message: family.message ?? null };
  }
  if (!("data" in family)) {
    throw new Error("The provider family returned an invalid ready state.");
  }
  if (family.state === "partial") {
    // A live partial always means a provider failed part-way (a throttle, a
    // timeout, an uninstalled app). The code lets the refresh keep a recent
    // ready snapshot instead of replacing it with this dashed one.
    return {
      state: "partial" as const,
      rows: [family.data],
      message: family.message ?? null,
      degraded: { code: "provider_partial" },
    };
  }
  return {
    state: "ready" as const,
    rows: [family.data],
    message: family.message ?? null,
  };
}

/** Explicit sync path. The shared live promise prevents three provider fanouts. */
export async function refreshAdminStoreAnalyticsSnapshots(
  input: FetchAdminStoreAnalyticsInput,
  options: { authenticate?: boolean } = {},
) {
  assertInput(input);
  if (options.authenticate !== false) await requireClientOnboardingAdmin();
  const topology = await loadTopology(input);
  let livePromise: Promise<AdminStoreAnalytics> | null = null;
  const live = () => {
    livePromise ??= buildLiveAdminStoreAnalytics(input, topology);
    return livePromise;
  };
  let verification: Promise<AdminReportingAuthority> | null = null;
  const verifyAuthority = () => {
    verification ??= loadTopology(input).then((current) => current.authority);
    return verification;
  };
  const definitions = [
    {
      family: "shopify_funnel" as const,
      load: async () => snapshotFamilyResult((await live()).funnel),
    },
    {
      family: "store_campaign_performance" as const,
      load: async () => snapshotFamilyResult((await live()).campaigns),
    },
    {
      family: "shopify_collection_sales" as const,
      load: async () => snapshotFamilyResult((await live()).collections),
    },
  ];
  const results = await Promise.all(
    definitions.map((definition) =>
      refreshAdminReportingSnapshot<unknown>({
        client: topology.service,
        family: definition.family,
        accountId: input.store.accountId,
        from: input.range.from,
        to: input.range.to,
        authority: topology.authority,
        verifyAuthority,
        load: definition.load,
      })),
  );
  return {
    accountId: input.store.accountId,
    from: input.range.from,
    to: input.range.to,
    refreshed: results.filter((result) => result.state === "refreshed").length,
    partial: results.filter(
      (result) => result.state === "refreshed" && result.snapshotState === "partial",
    ).length,
    busy: results.filter((result) => result.state === "busy").length,
    failed: results.filter((result) => result.state === "failed").length,
  };
}

/**
 * Materialises and proves only the daily rollup needed by the All Stores
 * Analytics cards. It deliberately does not open ShopifyQL or campaign reads.
 */
export async function ensureAdminAnalyticsRollupCoverage(
  input: EnsureAdminAnalyticsRollupCoverageInput,
  options: { authenticate?: boolean } = {},
): Promise<AdminAnalyticsFamily<{
  storeCount: number;
  dayCount: number;
  refreshed: boolean;
  materializedAccountDays: number;
  expectedAccountDays: number;
}>> {
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

  if (options.authenticate !== false) await requireClientOnboardingAdmin();
  if (input.stores.length === 0) {
    return {
      state: "empty",
      data: {
        storeCount: 0,
        dayCount: rangeDays(input.range).length,
        refreshed: false,
        materializedAccountDays: 0,
        expectedAccountDays: 0,
      },
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
      return rollupFamilies(
        topology,
        [...new Set(store.activityAccountIds)],
        input.range,
        true,
      );
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
  const days = rangeDays(input.range);
  const materializedAccountDays = results.reduce(
    (sum, result) =>
      sum + ("data" in result.rollupCoverage
        ? result.rollupCoverage.data.materializedAccountDays ?? 0
        : 0),
    0,
  );
  const expectedAccountDays = physicalIds.size * days.length;
  const partialCoverage = results.filter(
    (result) => result.rollupCoverage.state === "partial",
  );
  if (partialCoverage.length > 0) {
    return {
      state: "partial",
      data: {
        storeCount: input.stores.length,
        dayCount: days.length,
        refreshed,
        materializedAccountDays,
        expectedAccountDays,
      },
      message: `${materializedAccountDays} of ${expectedAccountDays} account-days are materialised after the exact-range refresh.`,
    };
  }
  return {
    state: "ready",
    data: {
      storeCount: input.stores.length,
      dayCount: days.length,
      refreshed,
      materializedAccountDays,
      expectedAccountDays,
    },
    message: refreshed
      ? "All store rollups were verified after an on-demand refresh."
      : "All store rollups are verified for the exact selected period.",
  };
}
