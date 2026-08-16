import "server-only";

import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
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
  createLegacyShopifyReportingAdapter,
  createShopifyReportingAdapter,
  ShopifyReportingAdapterError,
  type ShopifyCampaignAttributionSeriesRow,
  type ShopifyCampaignProductAttribution,
  type ShopifyCampaignProductSeriesRow,
  type ShopifyReportingAdapter,
} from "@/lib/reporting/shopify";
import { collectionHandleFromUrl } from "@/lib/finance/rev-share";
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
  shopifyOrders: number | null;
  shopifyRevenue: number | null;
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
  shopifyProvenance?: "legacy" | "v2_cutover" | "supplemental_v2_shopify";
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
  } catch {
    return {
      ok: false,
      state: "failed",
      message: "The selected Shopify reporting connection could not be verified.",
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
          const [rows, timeline] = await Promise.all([
            fetchGoogleReportingCampaigns(source, range.from, range.to),
            fetchGoogleReportingCampaignTimeline(source, range.from, range.to),
          ]);
          return { rows, timeline };
        }),
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
          granularity: "day",
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

function campaignFamily(
  google: Attempt<GoogleCampaignLoad>,
  breakdowns: GoogleBreakdownAttempts,
  attribution: Attempt<ShopifyCampaignAttributionSeriesRow[]>,
  shopifyProducts: Attempt<ShopifyCampaignProductSeriesRow[]>,
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
    const buckets = [...new Set([
      ...googleTimeline.map((point) => point.bucket),
      ...shopifyTimeline.map((point) => point.bucket),
    ])].sort();
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
      timeline: buckets.map((bucket) => {
        const googlePoint = googleTimeline.find((point) => point.bucket === bucket);
        const shopifyPoint = shopifyTimeline.find((point) => point.bucket === bucket);
        const pointSpend = googlePoint?.spend ?? 0;
        const shopifyRevenue = attribution.ok
          ? shopifyPoint?.revenue ?? 0
          : null;
        const googleRevenue = googlePoint?.googleRevenue ?? 0;
        return {
          bucket,
          spend: pointSpend,
          impressions: googlePoint?.impressions ?? 0,
          clicks: googlePoint?.clicks ?? 0,
          conversions: googlePoint?.conversions ?? 0,
          shopifyRevenue,
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
  const partial = Boolean(google.message) ||
    !attribution.ok ||
    rows.some((row) =>
      row.breakdown.sources.some((source) => source.state === "failed"));
  if (partial) {
    return {
      state: "partial",
      data: { rows, granularity: google.value.granularity },
      message: messages.join(" ") || "Some campaign detail sources are partial.",
    };
  }
  return {
    state: rows.length === 0 ? "empty" : "ready",
    data: { rows, granularity: google.value.granularity },
    message: messages.length > 0 ? messages.join(" ") : null,
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
  const invoke = <T>(operation: () => Promise<T>) =>
    Promise.resolve().then(operation);
  const [funnelResult, attributionResult, productResult, collectionsResult] =
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
    ]);

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

  const attribution: Attempt<ShopifyCampaignAttributionSeriesRow[]> =
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

  const products: Attempt<ShopifyCampaignProductSeriesRow[]> =
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
  return { funnel, attribution, products, collections };
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
    const handles = new Set(
      [...(campaign.finalUrls ?? []), campaign.name]
        .map(collectionHandleFromUrl)
        .filter((handle): handle is string => Boolean(handle)),
    );
    const collectionHandle = handles.size === 1 ? handles.values().next().value : undefined;
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
    const mappedById = new Map(mapped.map((product) => [product.productId, product]));
    for (const point of google.value.timeline) {
      if (
        point.accountId !== campaign.ad_account_id ||
        point.campaignId !== campaign.providerCampaignId ||
        point.spend <= 0
      ) continue;
      const weights = candidates.map((product) => {
        const mappedProduct = mappedById.get(product.productId);
        const mappedPoint = mappedProduct?.timeline.find((entry) => entry.bucket === point.bucket);
        const salesPoint = product.timeline.find((entry) => entry.bucket === point.bucket);
        return Math.max(0,
          mappedPoint?.units ?? 0,
          mappedProduct?.units ?? 0,
          salesPoint?.revenue ?? 0,
          salesPoint?.units ?? 0,
          product.revenue,
          product.units,
        );
      });
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      candidates.forEach((product, index) => {
        const share = totalWeight > 0
          ? point.spend * weights[index] / totalWeight
          : point.spend / candidates.length;
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
      "Shopify sales use official collection membership. Ad spend is attributed only by an exact /collections/<handle> campaign URL or exact Google campaign UTM → Shopify product mapping, then deterministically split by attributed units, revenue, or stable product ID. Collection rows remain non-additive when a product belongs to more than one collection.",
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
  };
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
  const googlePromise = loadGoogleCampaigns(topology, input.range);
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

  const [google, breakdowns, shopify, activityResult, rollup] = await Promise.all([
    googlePromise,
    breakdownPromise,
    shopifyPromise,
    activityPromise,
    rollupPromise,
  ]);

  let campaigns: AdminStoreAnalytics["campaigns"];
  try {
    campaigns = campaignFamily(
      google,
      breakdowns,
      shopify.attribution,
      shopify.products,
    );
  } catch (error) {
    console.error("Admin store campaign analytics composition failed:", error);
    campaigns = failed("Campaign performance could not be loaded for this store.");
  }
  const collections = attributeCollectionSpend(
    shopify.collections,
    google,
    shopify.products,
  );
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
      shopifyRevenue,
      ctr: impressions && impressions > 0 && clicks !== null ? clicks / impressions : null,
      cpc: clicks && clicks > 0 ? spend / clicks : null,
      cpm: impressions && impressions > 0 ? (spend / impressions) * 1_000 : null,
      cpa: conversions && conversions > 0 ? spend / conversions : null,
      googleRoas: spend > 0 ? googleRevenue / spend : null,
      realRoas: spend > 0 && shopifyRevenue !== null ? shopifyRevenue / spend : null,
      attributionState: shopifyRevenue === null ? "unavailable" as const : campaign.attributionState,
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
  const trackingFrom = offsetDay(input.range.to, -29);
  const needsTrackingSnapshot = input.range.from > trackingFrom;
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
          to: input.range.to,
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
    ? trackingStored.get("store_campaign_performance") ?? missingStoredSelection({ from: trackingFrom, to: input.range.to })
    : campaignsSelection;
  const trackingCollectionSelection = needsTrackingSnapshot
    ? trackingStored.get("shopify_collection_sales") ?? missingStoredSelection({ from: trackingFrom, to: input.range.to })
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
    shopifyProvenance: topology.shopifyProvenance,
  };
}

function snapshotFamilyResult<T>(family: AdminAnalyticsFamily<T>) {
  if (family.state === "failed" || family.state === "not_synced") {
    throw new Error("The provider family failed during refresh.");
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
  return {
    state: family.state === "partial" ? "partial" as const : "ready" as const,
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
