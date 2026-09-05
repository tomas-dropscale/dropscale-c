import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveCampaignsDetailed, type LiveCampaign } from "@/lib/google-ads/portal";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import { fetchHstClientKeys } from "@/lib/admin/hst";
import { googleProfit, googleRoas } from "@/lib/admin/google-attribution";
import { fetchDailyMetrics, groupByAccount, sumMetrics } from "@/lib/metrics/queries";
import {
  refreshAccountsNow,
  refreshReportingSourcesNow,
} from "@/lib/metrics/recompute";
import { ACCOUNT_COLUMNS } from "@/lib/portal/data";
import type { AdAccount, Database, Json } from "@/lib/supabase/types";
import { rangeDays, type RangeSelection } from "@/lib/portal/range";
import { hasWindsorEnv } from "@/lib/windsor/client";
import { fetchGoogleReportingCampaigns } from "@/lib/reporting/google";
import { convertCampaigns, reportingMoneyRates } from "@/lib/reporting/google-currency";
import {
  resolveReportingSources,
  type CanonicalReportingSource,
} from "@/lib/reporting/sources";
import {
  adminReportingSnapshotIsStale,
  adminReportingAuthority,
  readAdminReportingSnapshots,
  refreshAdminReportingSnapshot,
  type AdminReportingAuthority,
  type AdminReportingSnapshotValue,
} from "@/lib/admin/reporting-snapshots";

/**
 * The admin zone's cross-client campaigns view.
 *
 * Deliberately NOT built on the portal data layer: the portal pins every
 * query to the signed-in user (that is the client-zone contract), while this
 * module reads unscoped and lets the admin RLS policies return every row.
 * Zone decides visibility — this file IS the admin zone's reader.
 */

type Supabase = SupabaseClient<Database>;

export type AdminCampaignProviderFreshness = {
  state: "live" | "ready" | "partial" | "not_synced" | "unavailable";
  refreshedAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  stale: boolean;
};

export type AdminAccountCampaigns = {
  account: AdAccount;
  /**
   * The live rows, not the DB shape: the page needs `startDate` to say how long
   * each collection has been running, and that is a Google field the campaigns
   * TABLE has no column for.
   */
  campaigns: AdminLiveCampaign[];
  connected: boolean;
  /** Live query attempted but failed — distinguishes "error" from "no spend". */
  failed: boolean;
  /**
   * The failure was Google refusing the client's authorisation. Separate from
   * `failed` because the fix is different and belongs to the CLIENT: nobody can
   * retry their way out of it, the account has to be reconnected.
   */
  authRevoked: boolean;
  /** Never collapse an upstream failure into an honest zero-campaign result. */
  campaignState:
    | "ready"
    | "empty"
    | "partial"
    | "failed"
    | "not_synced"
    | "disconnected";
  /** Exact-range snapshot status; provider failures never hide the last success. */
  providerFreshness?: AdminCampaignProviderFreshness;
  spend: number;
  commission: number;
  /** Reporting-rollup revenue for the exact store group in the selected window. */
  rollupRevenue: number | null;
  /** Reporting-rollup spend paired with rollupRevenue. */
  rollupSpend: number;
  /** This store has materialised rollup rows in one canonical currency. */
  rollupComplete: boolean;
  /** At least one exact daily_metrics row exists, even when the grid is partial. */
  rollupMaterialized?: boolean;
  /** At least one connected, active reporting source is expected to materialise. */
  rollupRequired: boolean;
  /** Canonical currencies of the physical metric accounts behind this store row. */
  rollupCurrencies: string[];
};

export type AdminLiveCampaign = LiveCampaign & {
  /** Only normalized V2 campaigns can be targeted by audited controls. */
  reportingBindingId: string | null;
  googleAdsConnectionId: string | null;
};

export type AdminClientCampaigns = {
  clientId: string;
  clientName: string;
  clientEmail: string;
  /**
   * HST already books supplier commission for this client.
   *
   * Only true on a real link — the CRM record this login points at has HST rows,
   * or the ERP's own tag for them is exactly their name. A client HST pays on
   * under a tag nobody connected shows as false, which is the honest answer:
   * "not linked" is what you can act on, "probably in" is not.
   */
  inHst: boolean;
  accounts: AdminAccountCampaigns[];
  spend: number | null;
  commission: number | null;
  revenue: number | null;
  rollupSpend: number | null;
  realRoas: number | null;
  currency: string | null;
  currencies: string[];
  rollupComplete: boolean;
};

export type AdminCampaignsOverview = {
  clients: AdminClientCampaigns[];
  /**
   * Staff-admins' own stores. Listed, never queried: they're internal/test
   * accounts the agency doesn't bill itself for, so pulling their campaigns
   * would cost a Google round trip to show numbers that mean nothing here.
   */
  internal: AdminClientCampaigns[];
  configured: boolean;
  totals: {
    spend: number | null;
    commission: number | null;
    activeCampaigns: number | null;
    connectedAccounts: number;
    /**
     * Portfolio revenue: every client store in the period, narrowed to orders
     * Instagram and Facebook did not refer (0019). Same rule as the client
     * report, so the strip and the sum of the reports agree — a headline that
     * quietly counted Meta's sales would be larger than every report under it
     * and there would be no way to see why.
     *
     * Null when no day in the window has had its attribution computed.
     */
    revenue: number | null;
    /**
     * The clients' combined trading profit on that revenue: less COGS, payment
     * fees, shipping and ad spend — but NOT our management fee, which is a
     * separate line and has its own card in this strip. Negative when the book
     * lost money, and shown that way.
     */
    profit: number | null;
    /**
     * Portfolio ROAS — total revenue ÷ total ad spend, NOT the mean of each
     * store's ROAS. Averaging the ratios would let a store that spent €5 and
     * got lucky count for as much as one spending €5,000, which is how a book
     * of business ends up reporting a return nobody actually earned.
     */
    roas: number | null;
    /** Rollup ad spend — the denominator above. See the note in fetchAdminCampaigns. */
    rollupSpend: number | null;
    currency: string | null;
    currencies: string[];
    rollupComplete: boolean;
  };
};

type Owner = { name: string; email: string; crmClientId: string | null; inHst: boolean };

type AdminAccountInventory = {
  account: AdAccount;
  /** True only for a physical Shopify store scope, never a standalone Google binding. */
  isStoreScope: boolean;
  googleSources: CanonicalReportingSource[] | null;
  /** Exact physical Google account IDs allowed inside this scope's campaign snapshot. */
  campaignAccountIds: string[];
  metricAccountIds: string[];
  metricCurrencies: string[];
  metricRefreshKind: "reporting" | "legacy" | null;
  commissionRateByMetricAccount: Map<string, number>;
  /** Campaign mutations remain marker-gated even when Windsor is used read-only before cutover. */
  campaignControlsEnabled: boolean;
  authority: AdminReportingAuthority;
};

async function campaignReportingAuthority(input: {
  account: AdAccount;
  operationalSurface: string;
  reportingCutoverAt: string | null;
  sources: CanonicalReportingSource[] | null;
}): Promise<AdminReportingAuthority> {
  const sources = input.sources
    ?.map((source) => ({
      bindingId: source.bindingId,
      clientId: source.clientId,
      adAccountId: source.adAccountId,
      kind: source.kind,
      anchorBindingId: source.group.shopifyAnchorBindingId,
      anchorAccountId: source.group.shopifyAnchorAdAccountId,
      shopifyConnectionId: source.shopify?.connectionId ?? null,
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
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId)) ?? null;
  return adminReportingAuthority({
    version: 1,
    purpose: "admin_google_campaigns",
    mode: input.sources === null ? "legacy" : "v2",
    clientId: input.account.client_id,
    scopeAccountId: input.account.id,
    operationalSurface: input.operationalSurface,
    reportingCutoverAt: input.reportingCutoverAt,
    legacyGoogle: input.sources === null
      ? {
          customerId: input.account.google_ads_customer_id,
          connected: input.account.google_ads_connected,
          currency: input.account.currency,
        }
      : null,
    sources: sources as unknown as Json,
  });
}

function projectedShopDomain(source: CanonicalReportingSource): string {
  return source.shopify!.primaryDomain?.trim().toLowerCase() || source.shopify!.domain;
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

function storeIdentity(clientId: string, shopifyDomain: string) {
  return `${clientId}\n${shopifyDomain}`;
}

async function verifiedPublicStoreDomains(
  accounts: AdAccount[],
  service: NonNullable<ReturnType<typeof createServiceClient>>,
): Promise<Map<string, string>> {
  const identities = new Set<string>();
  const clientIds = new Set<string>();
  for (const account of accounts) {
    const shopifyDomain = canonicalShopifyDomain(account.shopify_url);
    if (!shopifyDomain) continue;
    identities.add(storeIdentity(account.client_id, shopifyDomain));
    clientIds.add(account.client_id);
  }
  if (clientIds.size === 0) return new Map();

  const { data, error } = await service
    .from("client_shopify_connections")
    .select(
      "client_id, status, shopify_domain, primary_domain, last_verified_at, last_error_code",
    )
    .in("client_id", [...clientIds])
    .eq("status", "connected");
  if (error || !Array.isArray(data)) return new Map();

  const domains = new Map<string, string>();
  for (const row of data) {
    const shopifyDomain = canonicalShopifyDomain(row.shopify_domain);
    const primaryDomain = publicStoreDomain(row.primary_domain);
    const identity = shopifyDomain
      ? storeIdentity(row.client_id, shopifyDomain)
      : null;
    if (
      row.status !== "connected" ||
      !row.last_verified_at ||
      row.last_error_code !== null ||
      shopifyDomain !== row.shopify_domain ||
      !primaryDomain ||
      !identity ||
      !identities.has(identity)
    ) {
      continue;
    }
    domains.set(identity, primaryDomain);
  }
  return domains;
}

function withPublicStoreDomain(
  entry: AdminAccountCampaigns,
  domains: Map<string, string>,
): AdminAccountCampaigns {
  const shopifyDomain = canonicalShopifyDomain(entry.account.shopify_url);
  const primaryDomain = shopifyDomain
    ? domains.get(storeIdentity(entry.account.client_id, shopifyDomain))
    : null;
  return primaryDomain
    ? { ...entry, account: { ...entry.account, shopify_url: primaryDomain } }
    : entry;
}

async function adminAccountInventory(
  allAccounts: AdAccount[],
  adminIds: Set<string>,
  service: NonNullable<ReturnType<typeof createServiceClient>>,
): Promise<AdminAccountInventory[]> {
  const accounts = allAccounts.filter((account) => !adminIds.has(account.client_id));
  const clientIds = [...new Set(accounts.map((account) => account.client_id))];
  if (clientIds.length === 0) return [];

  const { data, error } = await service
    .from("client_rollout_states")
    .select("client_id, operational_surface, reporting_cutover_at")
    .in("client_id", clientIds);
  if (error || !Array.isArray(data)) {
    throw new Error("Admin reporting inventory is unavailable.");
  }

  const rollouts = new Map(data.map((row) => [row.client_id, row]));
  const v2ClientIds = clientIds.filter((clientId) => {
    const rollout = rollouts.get(clientId);
    return (
      rollout?.operational_surface === "v2_active" &&
      rollout.reporting_cutover_at !== null
    );
  });
  const unknown = data.some(
    (row) =>
      !clientIds.includes(row.client_id) ||
      ![
        "legacy_only",
        "v2_onboarding",
        "v2_ready_for_cutover",
        "v2_active",
        "rollback_legacy",
      ].includes(row.operational_surface) ||
      (row.reporting_cutover_at !== null &&
        Number.isNaN(Date.parse(row.reporting_cutover_at))),
  );
  if (unknown) throw new Error("Admin reporting inventory is unavailable.");

  const preCutoverClientIds = clientIds.filter((clientId) => {
    const rollout = rollouts.get(clientId);
    return (
      rollout !== undefined &&
      rollout.operational_surface !== "legacy_only" &&
      rollout.operational_surface !== "rollback_legacy" &&
      !v2ClientIds.includes(clientId)
    );
  });
  let preCutoverSources: CanonicalReportingSource[] = [];
  if (preCutoverClientIds.length > 0) {
    try {
      preCutoverSources = await resolveReportingSources({
        service,
        clientIds: preCutoverClientIds,
        includeShopifyCredentials: false,
      });
    } catch {
      // One malformed pre-cutover client must not hide every other client's
      // reporting. Resolve independently and retain only verified sources.
      const settled = await Promise.allSettled(
        preCutoverClientIds.map((clientId) =>
          resolveReportingSources({
            service,
            clientIds: [clientId],
            includeShopifyCredentials: false,
          }),
        ),
      );
      preCutoverSources = settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
    }
  }
  const preCutoverSourceIds = new Set(
    preCutoverSources.map((source) => source.adAccountId),
  );
  const legacy = await Promise.all(accounts
    .filter(
      (account) =>
        !v2ClientIds.includes(account.client_id) &&
        !preCutoverSourceIds.has(account.id),
    )
    .map(async (account) => {
      const legacyRefreshEligible =
        account.status !== "pending" &&
        ((account.google_ads_connected && Boolean(account.google_ads_customer_id)) ||
          (account.shopify_connected && Boolean(account.shopify_url)));
      const rollout = rollouts.get(account.client_id);
      return {
        account,
        isStoreScope: account.shopify_connected && Boolean(account.shopify_url),
        googleSources: null,
        campaignAccountIds:
          account.google_ads_connected && account.google_ads_customer_id ? [account.id] : [],
        metricAccountIds: [account.id],
        metricCurrencies: [account.currency],
        metricRefreshKind: legacyRefreshEligible ? ("legacy" as const) : null,
        commissionRateByMetricAccount: new Map([
          [account.id, Number(account.commission_rate)],
        ]),
        campaignControlsEnabled: false,
        authority: await campaignReportingAuthority({
          account,
          operationalSurface: rollout?.operational_surface ?? "legacy_only",
          reportingCutoverAt: rollout?.reporting_cutover_at ?? null,
          sources: null,
        }),
      };
    }));

  let v2Sources: CanonicalReportingSource[] = [];
  const unresolvedV2ClientIds = new Set<string>();
  if (v2ClientIds.length > 0) {
    try {
      v2Sources = await resolveReportingSources({
        service,
        clientIds: v2ClientIds,
        includeShopifyCredentials: false,
      });
    } catch {
      // One client's broken source — e.g. a revoked Shopify credential when a
      // client leaves — must not take down every other client's campaigns
      // (2026-08-19: FITTED's invalid_credentials killed the whole page).
      // Resolve independently and keep the clients that still verify.
      const settled = await Promise.allSettled(
        v2ClientIds.map((clientId) =>
          resolveReportingSources({
            service,
            clientIds: [clientId],
            includeShopifyCredentials: false,
          }),
        ),
      );
      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          unresolvedV2ClientIds.add(v2ClientIds[index]);
          console.error(
            `Admin campaigns: sources unavailable for client ${v2ClientIds[index]}:`,
            result.reason instanceof Error ? result.reason.message : result.reason,
          );
        }
      });
      v2Sources = settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
    }
  }
  const sources = [...preCutoverSources, ...v2Sources];
  if (sources.length === 0) return legacy;
  const baseById = new Map(accounts.map((account) => [account.id, account]));
  if (
    sources.some(
      (source) =>
        (!v2ClientIds.includes(source.clientId) &&
          !preCutoverClientIds.includes(source.clientId)) ||
        baseById.get(source.adAccountId)?.client_id !== source.clientId,
    )
  ) {
    throw new Error("Admin reporting inventory is unavailable.");
  }

  const v2: AdminAccountInventory[] = [];
  const usedSourceIds = new Set<string>();
  for (const anchor of sources.filter((source) => source.shopify !== null)) {
    const base = baseById.get(anchor.adAccountId);
    if (!base || !anchor.shopify || usedSourceIds.has(anchor.adAccountId)) {
      throw new Error("Admin reporting inventory is unavailable.");
    }
    const grouped = sources.filter(
      (source) => source.group.shopifyAnchorAdAccountId === anchor.adAccountId,
    );
    if (grouped.length === 0 || grouped.some((source) => usedSourceIds.has(source.adAccountId))) {
      throw new Error("Admin reporting inventory is unavailable.");
    }
    grouped.forEach((source) => usedSourceIds.add(source.adAccountId));
    const campaignControlsEnabled = v2ClientIds.includes(base.client_id);
    const rollout = rollouts.get(base.client_id);
    v2.push({
      account: {
        ...base,
        store_name: anchor.shopify.shopifyName,
        shopify_url: projectedShopDomain(anchor),
        currency: base.currency,
        status: campaignControlsEnabled
          ? base.status === "suspended" ? "suspended" : "active"
          : base.status,
        shopify_connected: true,
        google_ads_connected: grouped.some((source) => source.googleAds !== null),
        google_ads_customer_id: anchor.googleAds?.customerId ?? null,
      },
      isStoreScope: true,
      googleSources: grouped.filter((source) => source.googleAds !== null),
      campaignAccountIds: grouped
        .filter((source) => source.googleAds !== null)
        .map((source) => source.adAccountId),
      metricAccountIds: grouped.map((source) => source.adAccountId),
      metricCurrencies: [
        ...new Set(grouped.map((source) => baseById.get(source.adAccountId)!.currency)),
      ].sort(),
      metricRefreshKind: "reporting",
      commissionRateByMetricAccount: new Map(
        grouped.map((source) => [
          source.adAccountId,
          Number(baseById.get(source.adAccountId)!.commission_rate),
        ]),
      ),
      campaignControlsEnabled,
      authority: await campaignReportingAuthority({
        account: base,
        operationalSurface: rollout?.operational_surface ?? "legacy_only",
        reportingCutoverAt: rollout?.reporting_cutover_at ?? null,
        sources: grouped,
      }),
    });
  }

  // Google-only bindings still carry agency spend. Keep them visible without
  // pretending they are a Shopify store or attaching them to another anchor.
  for (const source of sources.filter(
    (candidate) =>
      candidate.googleAds !== null && candidate.group.shopifyAnchorAdAccountId === null,
  )) {
    const base = baseById.get(source.adAccountId);
    if (!base || !source.googleAds || usedSourceIds.has(source.adAccountId)) {
      throw new Error("Admin reporting inventory is unavailable.");
    }
    usedSourceIds.add(source.adAccountId);
    const campaignControlsEnabled = v2ClientIds.includes(base.client_id);
    const legacyStore =
      !campaignControlsEnabled && base.shopify_connected && Boolean(base.shopify_url);
    const rollout = rollouts.get(base.client_id);
    v2.push({
      account: {
        ...base,
        store_name: legacyStore ? base.store_name : source.googleAds.accountName,
        currency: source.googleAds.currency ?? base.currency,
        google_ads_connected: true,
        google_ads_customer_id: source.googleAds.customerId,
      },
      isStoreScope: legacyStore,
      googleSources: [source],
      campaignAccountIds: [source.adAccountId],
      metricAccountIds: [source.adAccountId],
      metricCurrencies: [base.currency],
      metricRefreshKind: "reporting",
      commissionRateByMetricAccount: new Map([
        [source.adAccountId, Number(base.commission_rate)],
      ]),
      campaignControlsEnabled,
      authority: await campaignReportingAuthority({
        account: base,
        operationalSurface: rollout?.operational_surface ?? "legacy_only",
        reportingCutoverAt: rollout?.reporting_cutover_at ?? null,
        sources: [source],
      }),
    });
  }

  // A cutover client with NO resolvable source is degraded to absent, exactly
  // like one whose resolve threw: an admin can revoke a departed client's last
  // binding through the sanctioned Remove-asset flow, which leaves the rollout
  // marker in place and the client sourceless. Treating that as fatal took the
  // whole campaigns page down for every admin and every other client — the
  // FITTED-class failure the tolerant resolve above already exists to prevent.
  const sourcelessV2ClientIds = v2ClientIds.filter(
    (clientId) =>
      !unresolvedV2ClientIds.has(clientId) &&
      !sources.some((source) => source.clientId === clientId),
  );
  if (sourcelessV2ClientIds.length > 0) {
    console.error(
      `Admin reporting inventory: ${sourcelessV2ClientIds.length} cutover client(s) have no active reporting source; showing the rest.`,
    );
  }
  // A source counted twice IS still fatal: it would double a store's spend.
  if (usedSourceIds.size !== sources.length) {
    throw new Error("Admin reporting inventory is unavailable.");
  }
  return [...legacy, ...v2].sort((left, right) =>
    left.account.created_at.localeCompare(right.account.created_at),
  );
}

/** Group accounts under their owner, biggest spender first. */
function groupByOwner(
  entries: AdminAccountCampaigns[],
  owners: Map<string, Owner>,
): AdminClientCampaigns[] {
  type Group = {
    clientId: string;
    clientName: string;
    clientEmail: string;
    inHst: boolean;
    accounts: AdminAccountCampaigns[];
    spend: number;
    commission: number;
    revenue: number | null;
    rollupSpend: number;
    currencies: Set<string>;
    complete: number;
    materialized: number;
    required: number;
  };
  const byClient = new Map<string, Group>();

  for (const entry of entries) {
    const owner = owners.get(entry.account.client_id);
    const group = byClient.get(entry.account.client_id) ?? {
      clientId: entry.account.client_id,
      clientName: owner?.name ?? "Unknown client",
      clientEmail: owner?.email ?? "",
      inHst: owner?.inHst ?? false,
      accounts: [],
      spend: 0,
      commission: 0,
      revenue: null,
      rollupSpend: 0,
      currencies: new Set<string>(),
      complete: 0,
      materialized: 0,
      required: 0,
    };
    group.accounts.push(entry);
    if (entry.rollupRequired) {
      group.required += 1;
      entry.rollupCurrencies.forEach((currency) => group.currencies.add(currency));
    }
    if (entry.rollupComplete) {
      group.complete += 1;
    }
    if (entry.rollupMaterialized ?? entry.rollupComplete) {
      group.materialized += 1;
      group.spend += entry.spend;
      group.commission += entry.commission;
      if (entry.rollupRevenue !== null) {
        group.revenue = (group.revenue ?? 0) + entry.rollupRevenue;
      }
      group.rollupSpend += entry.rollupSpend;
    }
    byClient.set(entry.account.client_id, group);
  }

  return [...byClient.values()]
    .map((group): AdminClientCampaigns => {
      const currencies = [...group.currencies].sort();
      const rollupComplete = group.required > 0 && group.complete === group.required;
      const financialReady = group.materialized > 0 && currencies.length === 1;
      return {
        clientId: group.clientId,
        clientName: group.clientName,
        clientEmail: group.clientEmail,
        inHst: group.inHst,
        accounts: group.accounts,
        spend: financialReady ? group.spend : null,
        commission: financialReady ? group.commission : null,
        revenue: financialReady ? group.revenue : null,
        rollupSpend: financialReady ? group.rollupSpend : null,
        realRoas:
          financialReady && group.revenue !== null && group.rollupSpend > 0
            ? googleRoas(group.revenue, group.rollupSpend)
            : null,
        currency: financialReady ? currencies[0] : null,
        currencies,
        rollupComplete,
      };
    })
    .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));
}

function campaignProviderFreshness(
  snapshot: AdminReportingSnapshotValue<unknown> | undefined,
  range: Pick<RangeSelection, "to">,
): AdminCampaignProviderFreshness {
  if (!snapshot) {
    return {
      state: "not_synced",
      refreshedAt: null,
      lastAttemptAt: null,
      lastErrorCode: null,
      stale: false,
    };
  }
  const stale = adminReportingSnapshotIsStale({
    to: range.to,
    refreshedAt: snapshot.refreshedAt,
  });
  return {
    state:
      snapshot.state === "not_synced"
        ? "not_synced"
        : snapshot.state === "unavailable"
          ? "unavailable"
          : snapshot.state === "partial" || snapshot.lastErrorCode !== null || stale
            ? "partial"
            : "ready",
    refreshedAt: snapshot.refreshedAt,
    lastAttemptAt: snapshot.lastAttemptAt,
    lastErrorCode: snapshot.lastErrorCode,
    stale,
  };
}

export async function fetchAdminCampaigns(
  range: RangeSelection,
  options: {
    campaignSource?: "live" | "snapshot";
    authenticate?: boolean;
    client?: Supabase;
    providerOnly?: boolean;
  } = {},
): Promise<AdminCampaignsOverview> {
  if (options.authenticate !== false) await requireClientOnboardingAdmin();
  const service = options.client ?? createServiceClient();
  if (!service) throw new Error("Admin reporting inventory is unavailable.");
  const supabase = options.client ?? (await createClient());
  const googleConfigured = hasGoogleAdsEnv();
  const windsorConfigured = hasWindsorEnv();
  const configured = googleConfigured || windsorConfigured;

  const [accountsRes, clientsRes, adminsRes, hstKeys] = await Promise.all([
    supabase.from("ad_accounts").select(ACCOUNT_COLUMNS).order("created_at", { ascending: true }),
    supabase.from("portal_clients").select("id, full_name, email, crm_client_id"),
    supabase.from("profiles").select("id").eq("role", "admin"),
    options.providerOnly
      ? Promise.resolve({ crmIds: new Set<string>(), names: new Set<string>() })
      : fetchHstClientKeys(),
  ]);

  // Staff-admins hold portal accounts too, but theirs are internal/test stores
  // — the agency doesn't bill itself, and their revenue is purged from the
  // ledger (lib/admin/commission-sync). They're kept apart here: listed at the
  // end of the page, never queried, and out of every total.
  const adminIds = new Set((adminsRes.data ?? []).map((row) => row.id));

  const allAccounts = (accountsRes.data as AdAccount[] | null) ?? [];
  const internalAccounts = allAccounts.filter((account) => adminIds.has(account.client_id));
  const [inventory, publicStoreDomains] = await Promise.all([
    adminAccountInventory(allAccounts, adminIds, service),
    verifiedPublicStoreDomains(allAccounts, service),
  ]);
  const owners = new Map<string, Owner>(
    (clientsRes.data ?? []).map((client) => [
      client.id,
      {
        name: client.full_name,
        email: client.email,
        crmClientId: client.crm_client_id,
        // Strong signal first: this login points at a CRM record HST books
        // against. Only then the ERP's own tag, matched exactly — HST names
        // clients from the shop string, which is a different convention, so
        // anything looser than an exact match would put the badge on the wrong
        // person.
        inHst:
          (client.crm_client_id != null && hstKeys.crmIds.has(client.crm_client_id)) ||
          hstKeys.names.has(client.full_name.trim().toLowerCase()),
      },
    ]),
  );

  const campaignSnapshots = options.campaignSource === "snapshot"
    ? await readAdminReportingSnapshots<AdminLiveCampaign>({
        client: service,
        family: "google_campaigns",
        scopes: inventory.map((entry) => ({
          accountId: entry.account.id,
          authorityKey: entry.authority.key,
        })),
        from: range.from,
        to: range.to,
      }).catch(() => new Map<string, AdminReportingSnapshotValue<AdminLiveCampaign>>())
    : new Map();

  const perAccount = await Promise.all(
    inventory.map(async ({
      account,
      googleSources,
      campaignAccountIds,
      campaignControlsEnabled,
    }): Promise<AdminAccountCampaigns> => {
      const connected = googleSources === null
        ? googleConfigured && account.google_ads_connected && Boolean(account.google_ads_customer_id)
        : windsorConfigured && googleSources.length > 0;

      let campaigns: AdminLiveCampaign[] = [];
      let failed = false;
      let authRevoked = false;
      let campaignState: AdminAccountCampaigns["campaignState"] = "disconnected";
      const snapshot = options.campaignSource === "snapshot"
        ? campaignSnapshots.get(account.id)
        : undefined;
      let providerFreshness: AdminCampaignProviderFreshness =
        options.campaignSource === "snapshot"
          ? campaignProviderFreshness(snapshot, range)
          : {
              state: "live",
              refreshedAt: null,
              lastAttemptAt: null,
              lastErrorCode: null,
              stale: false,
            };
      if (!connected && options.campaignSource === "snapshot") {
        providerFreshness = { ...providerFreshness, state: "unavailable" };
      }

      if (connected && options.campaignSource === "snapshot") {
        if (!snapshot || snapshot.state === "not_synced") {
          campaignState = "not_synced";
        } else if (snapshot.state === "unavailable") {
          campaignState = "disconnected";
        } else {
          const allowedPhysicalIds = new Set(campaignAccountIds);
          const escaped = snapshot.rows.some(
            (row: AdminLiveCampaign) => !allowedPhysicalIds.has(row.ad_account_id),
          );
          if (escaped) {
            failed = true;
            campaignState = "failed";
            providerFreshness = {
              ...providerFreshness,
              state: "partial",
              lastErrorCode: "scope_escape",
            };
          } else {
            campaigns = snapshot.rows;
            failed = snapshot.lastErrorCode !== null;
            campaignState =
              snapshot.lastErrorCode || snapshot.state === "partial" || providerFreshness.stale
              ? "partial"
              : snapshot.state === "empty"
                ? "empty"
                : "ready";
          }
        }
      } else if (connected) {
        if (googleSources === null) {
          try {
            const { data } = await supabase
              .from("ad_accounts")
              .select("google_ads_refresh_token")
              .eq("id", account.id)
              .maybeSingle();
            const cipher = data?.google_ads_refresh_token;
            if (!cipher) throw new Error("token row missing");

            campaigns = (await fetchLiveCampaignsDetailed(
              account.google_ads_customer_id!,
              await decryptToken(cipher),
              account.id,
              range,
              account.currency,
            )).map((campaign) => ({
              ...campaign,
              reportingBindingId: null,
              googleAdsConnectionId: null,
            }));
            campaignState = campaigns.length > 0 ? "ready" : "empty";
          } catch (error) {
            failed = true;
            // A revoked authorisation is permanent, so record it: the account
            // flips to disconnected and the client's own portal starts asking
            // them to reconnect. Without this the store just reads "query
            // failed" forever and only the server logs say why.
            authRevoked = await markIfAuthRevoked(supabase, account.id, error);
            if (!authRevoked) {
              console.error(`Admin campaigns failed for ${account.id}:`, error);
            }
            campaignState = authRevoked ? "disconnected" : "failed";
          }
        } else {
          const sourceResults = await Promise.allSettled(
            googleSources.map(async (source) => {
              const [rows, rates] = await Promise.all([
                fetchGoogleReportingCampaigns(source, range.from, range.to),
                reportingMoneyRates(source, account.currency, range.from, range.to),
              ]);
              // Money in the store's currency (see google-currency.ts); the
              // daily budget stays in the Google account's own, and says so.
              const converted = rates
                ? convertCampaigns(
                    rows,
                    rates,
                    null,
                    range.to,
                    source.googleAds?.currency ?? account.currency,
                  )
                : rows;
              return converted.map((campaign) => ({
                ...campaign,
                reportingBindingId: campaignControlsEnabled ? source.bindingId : null,
                googleAdsConnectionId: source.googleAds!.connectionId,
              }));
            }),
          );
          const succeeded: AdminLiveCampaign[][] = [];
          for (const result of sourceResults) {
            if (result.status === "fulfilled") succeeded.push(result.value);
          }
          const sourceFailed = succeeded.length !== sourceResults.length;
          campaigns = succeeded
            .flat()
            .sort((left, right) => right.spend - left.spend || left.id.localeCompare(right.id));
          failed = sourceFailed;
          campaignState =
            succeeded.length === 0
              ? "failed"
              : sourceFailed
                ? "partial"
                : campaigns.length > 0
                  ? "ready"
                  : "empty";
          if (sourceFailed) {
            // Windsor errors may contain upstream metadata. The page needs the
            // state, not the payload, so keep the log deliberately generic.
            console.error("Admin V2 campaign reporting failed");
          }
        }
      }

      const spend = campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
      return {
        account,
        campaigns,
        // Report what we just learned, not the stale row we read at the top.
        connected: connected && !authRevoked,
        failed,
        authRevoked,
        campaignState,
        providerFreshness,
        spend,
        commission: (spend * Number(account.commission_rate)) / 100,
        rollupRevenue: null,
        rollupSpend: 0,
        rollupComplete: false,
        rollupRequired: false,
        rollupCurrencies: [],
      };
    }),
  );

  // Admin-owned stores get an entry with no campaigns: they're shown as a
  // roster, and the page says outright that their campaigns aren't listed.
  const internalEntries: AdminAccountCampaigns[] = internalAccounts.map((account) => ({
    account,
    campaigns: [],
    connected:
      googleConfigured && account.google_ads_connected && Boolean(account.google_ads_customer_id),
    failed: false,
    authRevoked: false,
    campaignState: "disconnected",
    spend: 0,
    commission: 0,
    rollupRevenue: null,
    rollupSpend: 0,
    rollupComplete: false,
    rollupMaterialized: false,
    rollupRequired: false,
    rollupCurrencies: [],
  }));

  // Campaigns is a read-only portfolio view: use only the rollup rows already
  // materialised for this exact inclusive range. Provider refreshes belong to
  // sync/reporting jobs, never to an admin page render.
  const metricAccountIds = [
    ...new Set(inventory.flatMap((entry) => entry.metricAccountIds)),
  ];
  const metricRows = options.providerOnly
    ? []
    : await fetchDailyMetrics(metricAccountIds, range.from, range.to);
  const metricRowsByAccount = groupByAccount(metricRows);
  const accountsWithRollups = perAccount.map((entry, index) => {
    const inventoryEntry = inventory[index];
    const rows = inventoryEntry.metricAccountIds.flatMap(
      (accountId) => metricRowsByAccount.get(accountId) ?? [],
    );
    const requiredMetricAccountIds = inventoryEntry.metricRefreshKind === null
      ? inventoryEntry.metricAccountIds.filter(
          (accountId) => (metricRowsByAccount.get(accountId)?.length ?? 0) > 0,
        )
      : inventoryEntry.metricAccountIds;
    const coverageRows = new Set(
      rows.map((row) => `${row.ad_account_id}\n${row.day}`),
    ).size;
    const expectedRows = requiredMetricAccountIds.length * rangeDays(range);
    const rollupMaterialized = coverageRows > 0;
    const rollupComplete =
      expectedRows > 0 &&
      coverageRows === expectedRows &&
      inventoryEntry.metricCurrencies.length === 1;
    const totals = sumMetrics(rows);
    const commission = rollupMaterialized && inventoryEntry.metricCurrencies.length === 1
      ? inventoryEntry.metricAccountIds.reduce((total, accountId) => {
          const accountRate = inventoryEntry.commissionRateByMetricAccount.get(accountId);
          if (typeof accountRate !== "number" || !Number.isFinite(accountRate)) {
            throw new Error("Admin reporting inventory is unavailable.");
          }
          const accountTotals = sumMetrics(metricRowsByAccount.get(accountId) ?? []);
          return total + (accountTotals.adSpend * accountRate) / 100;
        }, 0)
      : 0;
    return {
      ...entry,
      spend: totals.adSpend,
      commission,
      rollupRevenue: totals.attributedRevenue,
      rollupSpend: totals.adSpend,
      rollupComplete,
      rollupMaterialized,
      rollupRequired: requiredMetricAccountIds.length > 0,
      rollupCurrencies:
        requiredMetricAccountIds.length > 0 ? inventoryEntry.metricCurrencies : [],
    };
  });
  const rollup = sumMetrics(metricRows);
  const revenue = rollup.attributedRevenue;

  const spend = accountsWithRollups.reduce((sum, entry) => sum + entry.spend, 0);
  const commission = accountsWithRollups.reduce((sum, entry) => sum + entry.commission, 0);
  const requiredMetricAccountIds = [
    ...new Set(inventory.flatMap((entry) =>
      entry.metricRefreshKind === null
        ? entry.metricAccountIds.filter(
            (accountId) => (metricRowsByAccount.get(accountId)?.length ?? 0) > 0,
          )
        : entry.metricAccountIds)),
  ];
  const requiredScopes = accountsWithRollups.filter((entry) => entry.rollupRequired);
  const portfolioCoverageRows = new Set(
    metricRows.map((row) => `${row.ad_account_id}\n${row.day}`),
  ).size;
  const expectedPortfolioRows = requiredMetricAccountIds.length * rangeDays(range);
  const rollupComplete =
    expectedPortfolioRows > 0 && portfolioCoverageRows === expectedPortfolioRows;
  const currencies = [
    ...new Set(requiredScopes.flatMap((entry) => entry.rollupCurrencies)),
  ].sort();
  const financialReady = metricRows.length > 0 && currencies.length === 1;
  const connectedCampaignAccounts = perAccount.filter((entry) => entry.connected);
  const materializedCampaignAccounts = connectedCampaignAccounts.filter(
    (entry) =>
      entry.campaignState === "ready" ||
      entry.campaignState === "empty" ||
      entry.campaignState === "partial",
  );

  // Costs are recorded per day for the whole shop, so only the Google share of
  // them is charged here — see lib/admin/google-attribution.ts. Our own fee is
  // not among them: see the note on `profit` in the type above.
  const profit = financialReady ? googleProfit(revenue, {
    revenue: rollup.revenue,
    refunds: rollup.refunds,
    productCost: rollup.productCost,
    paymentFees: rollup.paymentFees,
    shippingCost: rollup.shippingCost,
    adSpend: rollup.adSpend,
  }) : null;

  return {
    clients: groupByOwner(
      accountsWithRollups.map((entry) => withPublicStoreDomain(entry, publicStoreDomains)),
      owners,
    ),
    internal: groupByOwner(
      internalEntries.map((entry) => withPublicStoreDomain(entry, publicStoreDomains)),
      owners,
    ),
    configured,
    totals: {
      spend: financialReady ? spend : null,
      commission: financialReady ? commission : null,
      activeCampaigns:
        connectedCampaignAccounts.length > 0 && materializedCampaignAccounts.length === 0
          ? null
          : materializedCampaignAccounts.reduce(
            (sum, entry) =>
              sum + entry.campaigns.filter((campaign) => campaign.status === "active").length,
            0,
          ),
      connectedAccounts: accountsWithRollups.filter((entry) => entry.connected).length,
      revenue: financialReady ? revenue : null,
      profit,
      roas:
        financialReady && revenue !== null && rollup.adSpend > 0
          ? googleRoas(revenue, rollup.adSpend)
          : null,
      rollupSpend: financialReady ? rollup.adSpend : null,
      currency: financialReady ? currencies[0] : null,
      currencies,
      rollupComplete,
    },
  };
}

async function campaignSnapshotInventory(
  service: Supabase,
): Promise<AdminAccountInventory[]> {
  const [accountsResult, adminsResult] = await Promise.all([
    service.from("ad_accounts").select(ACCOUNT_COLUMNS).order("created_at", { ascending: true }),
    service.from("profiles").select("id").eq("role", "admin"),
  ]);
  if (accountsResult.error || adminsResult.error || !Array.isArray(accountsResult.data)) {
    throw new Error("Admin reporting inventory is unavailable.");
  }
  return adminAccountInventory(
    accountsResult.data as AdAccount[],
    new Set((adminsResult.data ?? []).map((row) => row.id)),
    service,
  );
}

export type AdminReportingStoreScope = {
  clientId: string;
  store: {
    accountId: string;
    activityAccountIds: string[];
    currency: string;
  };
};

/** DB-only inventory for hourly store snapshot refreshes. */
export async function listAdminReportingStoreScopes(
  service: Supabase,
): Promise<AdminReportingStoreScope[]> {
  return (await campaignSnapshotInventory(service))
    .filter((entry) => entry.isStoreScope)
    .map((entry) => ({
      clientId: entry.account.client_id,
      store: {
        accountId: entry.account.id,
        activityAccountIds:
          entry.metricRefreshKind === null ? [] : [...entry.metricAccountIds],
        currency: entry.account.currency,
      },
    }));
}

/** Explicit provider sync; page renders use campaignSource=snapshot. */
export async function refreshAdminCampaignSnapshots(
  range: RangeSelection,
  options: {
    authenticate?: boolean;
    client?: Supabase;
    refreshMetrics?: boolean;
  } = {},
) {
  if (options.authenticate !== false) await requireClientOnboardingAdmin();
  const service = options.client ?? createServiceClient();
  if (!service) throw new Error("Admin reporting inventory is unavailable.");

  const inventory = await campaignSnapshotInventory(service);
  const metricAccountIds = [
    ...new Set(inventory.flatMap((entry) => entry.metricAccountIds)),
  ];
  let metricCoverage: {
    state: "ready" | "partial";
    accounts: number;
    expectedRows: number;
    rows: number;
  } | null = null;
  if (options.refreshMetrics) {
    const preCutover = inventory.filter(
      (entry) => entry.metricRefreshKind !== "reporting",
    );
    const preCutoverByAccount = new Map(
      preCutover.map((entry) => [entry.account.id, entry.account]),
    );
    const { data: preCutoverBindings, error: preCutoverBindingsError } =
      preCutoverByAccount.size === 0
        ? { data: [], error: null }
        : await service
            .from("client_reporting_bindings")
            .select("id, client_id, ad_account_id, shopify_anchor_binding_id")
            .eq("status", "active")
            .in("ad_account_id", [...preCutoverByAccount.keys()]);
    if (
      preCutoverBindingsError ||
      preCutoverBindings.some((binding) => {
        const account = preCutoverByAccount.get(binding.ad_account_id);
        return !account || account.client_id !== binding.client_id;
      })
    ) {
      throw new Error("Admin reporting inventory is unavailable.");
    }
    const preCutoverBoundIds = new Set(
      preCutoverBindings.map((binding) => binding.ad_account_id),
    );
    const reportingMetricAccountIds = [
      ...new Set([
        ...inventory
          .filter((entry) => entry.metricRefreshKind === "reporting")
          .flatMap((entry) => entry.metricAccountIds),
        ...preCutoverBoundIds,
      ]),
    ];
    const legacyMetricAccountIds = [
      ...new Set(inventory
        .filter(
          (entry) =>
            entry.metricRefreshKind === "legacy" &&
            !preCutoverBoundIds.has(entry.account.id),
        )
        .flatMap((entry) => entry.metricAccountIds)),
    ];
    const selectedBindingIds = new Set(
      preCutoverBindings.map((binding) => binding.id),
    );
    const preCutoverReportingRoots = preCutoverBindings
      .filter(
        (binding) =>
          !binding.shopify_anchor_binding_id ||
          !selectedBindingIds.has(binding.shopify_anchor_binding_id),
      )
      .map((binding) => binding.ad_account_id);
    await Promise.allSettled([
      ...[
        ...new Set([
          ...inventory
            .filter((entry) => entry.metricRefreshKind === "reporting")
            .map((entry) => entry.account.id),
          ...preCutoverReportingRoots,
        ]),
      ].map((accountId) =>
        refreshReportingSourcesNow([accountId], {
          client: service,
          from: range.from,
          to: range.to,
        }),
      ),
      ...legacyMetricAccountIds.map((accountId) =>
        refreshAccountsNow([accountId], {
          client: service,
          reportingClient: service,
          from: range.from,
          to: range.to,
        }),
      ),
    ]);
    const { data, error } = metricAccountIds.length === 0
      ? { data: [], error: null }
      : await service
          .from("daily_metrics")
          .select("ad_account_id, day")
          .in("ad_account_id", metricAccountIds)
          .gte("day", range.from)
          .lte("day", range.to);
    if (error || !Array.isArray(data)) {
      throw new Error("The exact campaign metric coverage could not be verified.");
    }
    const allowed = new Set(metricAccountIds);
    const coverageAccountIds = new Set([
      ...reportingMetricAccountIds,
      ...legacyMetricAccountIds,
      ...data.map((row) => row.ad_account_id).filter((id) => allowed.has(id)),
    ]);
    const unique = new Set(
      data
        .filter(
          (row) =>
            coverageAccountIds.has(row.ad_account_id) &&
            row.day >= range.from &&
            row.day <= range.to,
        )
        .map((row) => `${row.ad_account_id}\n${row.day}`),
    );
    const expectedRows = coverageAccountIds.size * rangeDays(range);
    metricCoverage = {
      state: unique.size === expectedRows ? "ready" : "partial",
      accounts: coverageAccountIds.size,
      expectedRows,
      rows: unique.size,
    };
  }
  let livePromise: Promise<AdminCampaignsOverview> | null = null;
  const live = () => {
    livePromise ??= fetchAdminCampaigns(range, {
      campaignSource: "live",
      authenticate: false,
      client: service,
      providerOnly: true,
    });
    return livePromise;
  };
  let verifiedInventory: Promise<Map<string, AdminAccountInventory>> | null = null;
  const verified = () => {
    verifiedInventory ??= campaignSnapshotInventory(service).then(
      (entries) => new Map(entries.map((entry) => [entry.account.id, entry])),
    );
    return verifiedInventory;
  };

  const settled = await Promise.allSettled(
    inventory.map((entry) =>
      refreshAdminReportingSnapshot<AdminLiveCampaign>({
        client: service,
        family: "google_campaigns",
        accountId: entry.account.id,
        from: range.from,
        to: range.to,
        authority: entry.authority,
        verifyAuthority: async () => {
          const current = (await verified()).get(entry.account.id);
          if (!current) {
            return adminReportingAuthority({ removedAccountId: entry.account.id });
          }
          return current.authority;
        },
        load: async () => {
          const overview = await live();
          const liveByAccount = new Map(
            overview.clients
              .flatMap((client) => client.accounts)
              .map((result) => [result.account.id, result]),
          );
          const result = liveByAccount.get(entry.account.id);
          if (!result) throw new Error("The live campaign scope disappeared.");
          if (result.campaignState === "failed" || result.campaignState === "not_synced") {
            throw new Error("Google campaign reporting failed.");
          }
          if (result.campaignState === "disconnected") {
            return {
              state: "unavailable",
              rows: [],
              message: "Campaign reporting is unavailable until this Google Ads connection is restored.",
            };
          }
          if (result.campaignState === "empty") {
            return { state: "empty", rows: [], message: null };
          }
          return {
            state: result.campaignState === "partial" ? "partial" : "ready",
            rows: result.campaigns,
            message: result.campaignState === "partial"
              ? "Some Google Ads sources failed; this snapshot is partial."
              : null,
          };
        },
      })),
  );
  const results = settled.map((result) =>
    result.status === "fulfilled"
      ? result.value
      : { state: "failed" as const, errorCode: "snapshot_failed" },
  );

  return {
    from: range.from,
    to: range.to,
    accounts: inventory.length,
    metricCoverage,
    refreshed: results.filter((result) => result.state === "refreshed").length,
    partial: results.filter(
      (result) => result.state === "refreshed" && result.snapshotState === "partial",
    ).length,
    busy: results.filter((result) => result.state === "busy").length,
    failed: results.filter((result) => result.state === "failed").length,
  };
}
