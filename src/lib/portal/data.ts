/**
 * Server-side data access for the portal pages.
 *
 * ad_accounts are always real (they drive the sidebar and routing). Campaigns
 * and metrics come from the Google Ads API when an account is connected — the
 * client has authorised it and it has a customer id — and fall back to seeded
 * mocks only when it is NOT connected, so the UI stays browsable in a demo
 * state.
 *
 * The honest-data rule: a connected account NEVER shows mock numbers. If a
 * live query fails we log and return empty/zeroes rather than fabricating,
 * because fake figures dressed as real is the worst outcome for a client.
 *
 * The encrypted refresh token is deliberately excluded from these selects, so
 * the ciphertext is never shipped to the browser as part of an account's data.
 * It is read on its own, server-side, only when a live query needs it.
 */

import { createClient } from "@/lib/supabase/server";
import { activeWorkspaceId } from "@/lib/portal/workspace";
import type {
  AdAccount,
  Campaign,
  CreativeDelivery,
  CreativeSubmission,
} from "@/lib/supabase/types";
import { aggregateMetrics, mockCampaigns, mockDeliveries, mockMetrics } from "@/lib/portal/mock";
import type { MetricSet } from "@/lib/portal/mock";
import type { RangeSelection } from "@/lib/portal/range";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { decryptToken } from "@/lib/google-ads/crypto";
import {
  fetchLiveCampaigns,
  fetchLiveCreatives,
  fetchLiveMetrics,
  type CreativeAsset,
} from "@/lib/google-ads/portal";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import { clientReportingAuthority } from "@/lib/portal/client-rollout";
import {
  resolveReportingSources,
  type CanonicalReportingSource,
} from "@/lib/reporting/sources";
import { fetchGoogleReportingCampaigns } from "@/lib/reporting/google";
import { createServiceClient } from "@/lib/supabase/service";
import { cache } from "react";

// Every column except the encrypted token, which must not leave the server
// inside an account payload.
export const ACCOUNT_COLUMNS =
  "id, client_id, store_name, google_ads_customer_id, status, reporting_role, currency, breakeven_roas, lifetime_ads_budget_usd, shopify_url, shopify_connected, shopify_client_id, shopify_scopes, color_dot, created_at, google_ads_connected_email, google_ads_connected, commission_rate, list_commission_rate, shopify_token_last4, shopify_connected_at, default_product_cost_pct, payment_fee_pct, payment_fee_fixed, shipping_cost_per_order, revenue_share_enabled" as const;

type PortalAccountProjection = {
  accounts: AdAccount[];
  metricIdsByStore: Map<string, string[]>;
  metricAccountsById: Map<string, AdAccount>;
  unallocatedGoogleAccountIds: string[];
  googleSourcesByStore: Map<string, CanonicalReportingSource[]>;
};

export type PortalMetricScope = {
  metricAccountIds: string[];
  metricIdsByStore: Map<string, string[]>;
  metricAccountsById: Map<string, AdAccount>;
  /** Google spend included in client totals but deliberately assigned to no store. */
  unallocatedGoogleAccountIds: string[];
};

class PortalProjectionError extends Error {
  constructor(readonly code: "service_unavailable" | "database_error" | "invalid_sources") {
    super("Portal reporting projection is unavailable.");
    this.name = "PortalProjectionError";
  }
}

function projectedShopDomain(source: CanonicalReportingSource): string {
  const primary = source.shopify?.primaryDomain?.trim().toLowerCase();
  return primary || source.shopify!.domain;
}

/**
 * V2 is store-first: only Shopify anchors become portal stores. Google-only
 * sources remain reporting inputs and never masquerade as stores.
 */
const fetchV2Projection = cache(async function fetchV2Projection(
  clientId: string,
): Promise<PortalAccountProjection> {
  const service = createServiceClient();
  if (!service) throw new PortalProjectionError("service_unavailable");

  const sources = await resolveReportingSources({
    service,
    clientIds: [clientId],
    includeShopifyCredentials: false,
  });
  if (sources.some((source) => source.clientId !== clientId)) {
    throw new PortalProjectionError("invalid_sources");
  }

  const sourceAccountIds = sources.map((source) => source.adAccountId);
  if (new Set(sourceAccountIds).size !== sourceAccountIds.length) {
    throw new PortalProjectionError("invalid_sources");
  }
  const anchors = sources.filter(
    (source) =>
      source.shopify !== null &&
      source.group.shopifyAnchorBindingId === source.bindingId &&
      source.group.shopifyAnchorAdAccountId === source.adAccountId,
  );
  const anchorBindingIds = new Set(anchors.map((source) => source.bindingId));
  // A second Shopify source inside a group would make its physical row carry
  // revenue too, so summing anchor + children would double-count the shop.
  // Treat that impossible topology as corruption rather than guessing which
  // Shopify source wins.
  if (
    sources.some(
      (source) => source.shopify !== null && !anchorBindingIds.has(source.bindingId),
    )
  ) {
    throw new PortalProjectionError("invalid_sources");
  }
  const anchorIds = anchors.map((source) => source.adAccountId);
  if (new Set(anchorIds).size !== anchorIds.length) {
    throw new PortalProjectionError("invalid_sources");
  }
  if (anchorIds.length === 0) {
    return {
      accounts: [],
      metricIdsByStore: new Map(),
      metricAccountsById: new Map(),
      unallocatedGoogleAccountIds: [],
      googleSourcesByStore: new Map(),
    };
  }

  const { data, error } = await service
    .from("ad_accounts")
    .select(ACCOUNT_COLUMNS)
    .in("id", sourceAccountIds)
    .eq("client_id", clientId);
  if (error || !Array.isArray(data) || data.length !== sourceAccountIds.length) {
    throw new PortalProjectionError("database_error");
  }

  const metricAccountsById = new Map(
    (data as AdAccount[]).map((account) => [account.id, account]),
  );
  const metricIdsByStore = new Map<string, string[]>();
  const googleSourcesByStore = new Map<string, CanonicalReportingSource[]>();
  const assignedSourceIds = new Set<string>();
  const accounts = anchors
    .map((anchor) => {
      const base = metricAccountsById.get(anchor.adAccountId);
      if (!base || base.client_id !== clientId || !anchor.shopify) {
        throw new PortalProjectionError("invalid_sources");
      }

      const groupedSources = sources.filter(
        (source) => source.group.shopifyAnchorAdAccountId === anchor.adAccountId,
      );
      if (
        groupedSources.length === 0 ||
        groupedSources.some((source) => assignedSourceIds.has(source.adAccountId))
      ) {
        throw new PortalProjectionError("invalid_sources");
      }
      groupedSources.forEach((source) => assignedSourceIds.add(source.adAccountId));
      const googleConnected = groupedSources.some((source) => source.googleAds !== null);
      googleSourcesByStore.set(
        anchor.adAccountId,
        groupedSources.filter((source) => source.googleAds !== null),
      );
      metricIdsByStore.set(anchor.adAccountId, [
        anchor.adAccountId,
        ...groupedSources
          .filter((source) => source.adAccountId !== anchor.adAccountId)
          .map((source) => source.adAccountId),
      ]);

      return {
        ...base,
        store_name: anchor.shopify.shopifyName,
        shopify_url: projectedShopDomain(anchor),
        // daily_metrics is normalized into the immutable ad-account reporting
        // currency. Shopify's shopMoney may differ and is converted per day
        // before the write, so labelling these rows with the shop currency
        // would make already-converted figures look like raw JPY/DKK/AUD.
        currency: base.currency,
        status: base.status === "suspended" ? "suspended" : "active",
        shopify_connected: true,
        google_ads_connected: googleConnected,
        google_ads_customer_id: anchor.googleAds?.customerId ?? null,
      } satisfies AdAccount;
    })
    .sort((left, right) => left.created_at.localeCompare(right.created_at));

  const unallocatedGoogleAccountIds = sources
    .filter(
      (source) =>
        source.googleAds !== null && source.group.shopifyAnchorAdAccountId === null,
    )
    .map((source) => source.adAccountId);
  if (
    unallocatedGoogleAccountIds.some((id) => assignedSourceIds.has(id)) ||
    assignedSourceIds.size + unallocatedGoogleAccountIds.length !== sources.length
  ) {
    throw new PortalProjectionError("invalid_sources");
  }

  return {
    accounts,
    metricIdsByStore,
    metricAccountsById,
    unallocatedGoogleAccountIds,
    googleSourcesByStore,
  };
});

async function v2ProjectionOrNull(clientId: string): Promise<PortalAccountProjection | null> {
  try {
    return await fetchV2Projection(clientId);
  } catch (error) {
    const code = error instanceof PortalProjectionError ? error.code : "source_resolution_error";
    // Deliberately omit ids, upstream messages and objects: they can contain
    // customer metadata or credential-adjacent details.
    console.error("portal V2 reporting projection failed:", code);
    return null;
  }
}

/**
 * The portal is the CLIENT's zone, so every read here is pinned to the ACTIVE
 * workspace's client_id — explicitly, not via RLS alone. RLS is deliberately
 * wider than one workspace: it carries an `or is_admin()` escape hatch for the
 * admin area, and since migration 0015 it also allows every workspace a sócio
 * belongs to. Which data you see is decided by the zone you are in and the
 * workspace you picked, never by your role.
 */

export async function fetchAccounts(): Promise<AdAccount[]> {
  const clientId = await activeWorkspaceId();
  if (!clientId) return [];

  const reporting = await clientReportingAuthority(clientId);
  if (reporting === "unavailable") return [];
  if (reporting === "v2") {
    return (await v2ProjectionOrNull(clientId))?.accounts ?? [];
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  return (data as AdAccount[] | null) ?? [];
}

/**
 * One account of the ACTIVE workspace; an id from another workspace (even one
 * the viewer could switch to, and even for an admin) comes back null → 404.
 */
export async function fetchAccount(accountId: string): Promise<AdAccount | null> {
  const clientId = await activeWorkspaceId();
  if (!clientId) return null;

  const reporting = await clientReportingAuthority(clientId);
  if (reporting === "unavailable") return null;
  if (reporting === "v2") {
    const projection = await v2ProjectionOrNull(clientId);
    return projection?.accounts.find((account) => account.id === accountId) ?? null;
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("client_id", clientId)
    .maybeSingle();
  return (data as AdAccount | null) ?? null;
}

/**
 * Expands selected portal stores to their physical daily_metrics rows. Legacy
 * stores remain one-to-one; a V2 anchor includes each mapped Google child.
 */
export async function reportingMetricAccountIds(
  accountsOrAccountId: readonly Pick<AdAccount, "id">[] | string,
): Promise<string[]> {
  const requested =
    typeof accountsOrAccountId === "string"
      ? [accountsOrAccountId]
      : accountsOrAccountId.map((account) => account.id);
  if (requested.length === 0) return [];

  const clientId = await activeWorkspaceId();
  if (!clientId) return [];
  const reporting = await clientReportingAuthority(clientId);
  if (reporting === "unavailable") return [];
  if (reporting !== "v2") return [...new Set(requested)];

  const projection = await v2ProjectionOrNull(clientId);
  if (!projection) return [];
  return [
    ...new Set(requested.flatMap((id) => projection.metricIdsByStore.get(id) ?? [])),
  ];
}

/**
 * Physical metric scope for a portal view. Store groups never receive an
 * unallocated Google row; only an explicit full-client view includes that
 * spend as its own bucket.
 */
export async function reportingMetricScope(
  accounts: readonly AdAccount[],
  options: { includeUnallocated?: boolean } = {},
): Promise<PortalMetricScope> {
  const requested = [...new Set(accounts.map((account) => account.id))];
  const empty = (): PortalMetricScope => ({
    metricAccountIds: [],
    metricIdsByStore: new Map(),
    metricAccountsById: new Map(),
    unallocatedGoogleAccountIds: [],
  });
  if (requested.length === 0) return empty();

  const clientId = await activeWorkspaceId();
  if (!clientId || accounts.some((account) => account.client_id !== clientId)) return empty();
  const reporting = await clientReportingAuthority(clientId);
  if (reporting === "unavailable") return empty();
  if (reporting !== "v2") {
    return {
      metricAccountIds: requested,
      metricIdsByStore: new Map(requested.map((id) => [id, [id]])),
      metricAccountsById: new Map(accounts.map((account) => [account.id, account])),
      unallocatedGoogleAccountIds: [],
    };
  }

  const projection = await v2ProjectionOrNull(clientId);
  if (!projection) return empty();
  const requestedSet = new Set(requested);
  if (requested.some((id) => !projection.metricIdsByStore.has(id))) return empty();
  if (
    options.includeUnallocated &&
    (requestedSet.size !== projection.accounts.length ||
      projection.accounts.some((account) => !requestedSet.has(account.id)))
  ) {
    throw new PortalProjectionError("invalid_sources");
  }

  const metricIdsByStore = new Map(
    requested.map((id) => [id, projection.metricIdsByStore.get(id) ?? []]),
  );
  const unallocatedGoogleAccountIds = options.includeUnallocated
    ? projection.unallocatedGoogleAccountIds
    : [];
  const metricAccountIds = [
    ...new Set([
      ...[...metricIdsByStore.values()].flat(),
      ...unallocatedGoogleAccountIds,
    ]),
  ];
  return {
    metricAccountIds,
    metricIdsByStore,
    metricAccountsById: new Map(
      metricAccountIds.flatMap((id) => {
        const account = projection.metricAccountsById.get(id);
        return account ? [[id, account] as const] : [];
      }),
    ),
    unallocatedGoogleAccountIds,
  };
}

/** Connected = the client authorised Google Ads and the API is configured. */
export function isGoogleAdsConnected(account: AdAccount): boolean {
  return (
    hasGoogleAdsEnv() && account.google_ads_connected && Boolean(account.google_ads_customer_id)
  );
}

/**
 * Reads and decrypts one account's refresh token. Server-only and fetched on
 * its own so the ciphertext is never part of a normal account payload.
 */
async function accountRefreshToken(accountId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select("google_ads_refresh_token")
    .eq("id", accountId)
    .maybeSingle();

  const cipher = data?.google_ads_refresh_token;
  if (!cipher) return null;

  try {
    return await decryptToken(cipher);
  } catch (error) {
    console.error(`Could not decrypt Google Ads token for ${accountId}:`, error);
    return null;
  }
}

export async function fetchCampaigns(account: AdAccount, range: RangeSelection): Promise<Campaign[]> {
  const clientId = await activeWorkspaceId();
  if (!clientId || account.client_id !== clientId) return [];

  const reporting = await clientReportingAuthority(clientId);
  if (reporting === "unavailable") return [];
  if (reporting === "v2") {
    const projection = await v2ProjectionOrNull(clientId);
    const sources = projection?.googleSourcesByStore.get(account.id);
    if (!sources) return [];

    try {
      return (await Promise.all(
        sources.map((source) =>
          fetchGoogleReportingCampaigns(source, range.from, range.to),
        ),
      ))
        .flat()
        .sort((left, right) => right.spend - left.spend || left.id.localeCompare(right.id));
    } catch {
      console.error("portal V2 campaign reporting failed");
      return [];
    }
  }

  if (isGoogleAdsConnected(account)) {
    try {
      const token = await accountRefreshToken(account.id);
      if (!token) return [];
      return await fetchLiveCampaigns(account.google_ads_customer_id!, token, account.id, range);
    } catch (error) {
      // Connected but the query failed — surface nothing, never mock. A
      // revoked authorisation additionally flips the account to disconnected,
      // which is what puts the "Connect Google Ads" button back in front of
      // the one person who can fix it.
      if (!(await markIfAuthRevoked(await createClient(), account.id, error))) {
        console.error(`Google Ads campaigns failed for ${account.id}:`, error);
      }
      return [];
    }
  }

  // Configured but this account isn't connected → honest empty, never fake.
  // Mock is the DEMO state, reserved for when the API isn't set up at all.
  if (hasGoogleAdsEnv()) return [];
  return mockCampaigns(account.id, range);
}

export async function fetchAccountMetrics(account: AdAccount, range: RangeSelection): Promise<MetricSet> {
  const reporting = await clientReportingAuthority(account.client_id);
  if (reporting !== "legacy") return aggregateMetrics([]);

  if (isGoogleAdsConnected(account)) {
    try {
      const token = await accountRefreshToken(account.id);
      if (!token) return aggregateMetrics([]);
      return await fetchLiveMetrics(account.google_ads_customer_id!, token, range);
    } catch (error) {
      if (!(await markIfAuthRevoked(await createClient(), account.id, error))) {
        console.error(`Google Ads metrics failed for ${account.id}:`, error);
      }
      return aggregateMetrics([]); // all-zero MetricSet
    }
  }

  // Configured but not connected → zeroes, not fabricated numbers.
  if (hasGoogleAdsEnv()) return aggregateMetrics([]);
  return mockMetrics(account.id, range);
}

/**
 * Live creatives for a connected account.
 *
 * Returns null when Google Ads isn't configured at all — the caller then falls
 * back to the demo deliveries grid. Configured-but-not-connected (or a failed
 * query) returns an empty list: honest nothing, never fake creatives.
 */
export async function fetchCreativeAssets(account: AdAccount): Promise<CreativeAsset[] | null> {
  const reporting = await clientReportingAuthority(account.client_id);
  if (reporting !== "legacy") return [];

  if (!hasGoogleAdsEnv()) return null;

  if (!isGoogleAdsConnected(account)) return [];

  try {
    const token = await accountRefreshToken(account.id);
    if (!token) return [];
    return await fetchLiveCreatives(account.google_ads_customer_id!, token);
  } catch (error) {
    if (!(await markIfAuthRevoked(await createClient(), account.id, error))) {
      console.error(`Google Ads creatives failed for ${account.id}:`, error);
    }
    return [];
  }
}

/**
 * Creatives this store's people have handed in (migration 0018).
 *
 * No mock fallback and no Google involvement: these are the client's own rows,
 * so an empty list is the truth and always has been.
 */
export async function fetchCreativeSubmissions(accountId: string): Promise<CreativeSubmission[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("creative_submissions")
    .select("*")
    .eq("ad_account_id", accountId)
    .order("created_at", { ascending: false });
  return (data as CreativeSubmission[] | null) ?? [];
}

export async function fetchDeliveries(accountId: string): Promise<CreativeDelivery[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("creative_deliveries")
    .select("*")
    .eq("ad_account_id", accountId)
    .order("created_at", { ascending: false });

  if (data && data.length > 0) return data;
  return mockDeliveries(accountId);
}
