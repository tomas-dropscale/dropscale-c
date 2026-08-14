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
import { ACCOUNT_COLUMNS } from "@/lib/portal/data";
import type { AdAccount } from "@/lib/supabase/types";
import type { RangeSelection } from "@/lib/portal/range";
import { hasWindsorEnv } from "@/lib/windsor/client";
import { fetchGoogleReportingCampaigns } from "@/lib/reporting/google";
import {
  resolveReportingSources,
  type CanonicalReportingSource,
} from "@/lib/reporting/sources";

/**
 * The admin zone's cross-client campaigns view.
 *
 * Deliberately NOT built on the portal data layer: the portal pins every
 * query to the signed-in user (that is the client-zone contract), while this
 * module reads unscoped and lets the admin RLS policies return every row.
 * Zone decides visibility — this file IS the admin zone's reader.
 */

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
  spend: number;
  commission: number;
  /** Reporting-rollup revenue for the exact store group in the selected window. */
  rollupRevenue: number | null;
  /** Reporting-rollup spend paired with rollupRevenue. */
  rollupSpend: number;
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
  spend: number;
  commission: number;
  revenue: number | null;
  rollupSpend: number;
  realRoas: number;
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
    spend: number;
    commission: number;
    activeCampaigns: number;
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
    roas: number;
    /** Rollup ad spend — the denominator above. See the note in fetchAdminCampaigns. */
    rollupSpend: number;
  };
};

type Owner = { name: string; email: string; crmClientId: string | null; inHst: boolean };

type AdminAccountInventory = {
  account: AdAccount;
  googleSources: CanonicalReportingSource[] | null;
  metricAccountIds: string[];
};

function projectedShopDomain(source: CanonicalReportingSource): string {
  return source.shopify!.primaryDomain?.trim().toLowerCase() || source.shopify!.domain;
}

async function adminAccountInventory(
  allAccounts: AdAccount[],
  adminIds: Set<string>,
): Promise<AdminAccountInventory[]> {
  const accounts = allAccounts.filter((account) => !adminIds.has(account.client_id));
  const clientIds = [...new Set(accounts.map((account) => account.client_id))];
  if (clientIds.length === 0) return [];

  const service = createServiceClient();
  if (!service) throw new Error("Admin reporting inventory is unavailable.");
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

  const legacy = accounts
    .filter((account) => !v2ClientIds.includes(account.client_id))
    .map((account) => ({
      account,
      googleSources: null,
      metricAccountIds: [account.id],
    }));
  if (v2ClientIds.length === 0) return legacy;

  const sources = await resolveReportingSources({
    service,
    clientIds: v2ClientIds,
    includeShopifyCredentials: false,
  });
  const baseById = new Map(accounts.map((account) => [account.id, account]));
  if (
    sources.some(
      (source) =>
        !v2ClientIds.includes(source.clientId) ||
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
    v2.push({
      account: {
        ...base,
        store_name: anchor.shopify.shopifyName,
        shopify_url: projectedShopDomain(anchor),
        currency: base.currency,
        status: base.status === "suspended" ? "suspended" : "active",
        shopify_connected: true,
        google_ads_connected: grouped.some((source) => source.googleAds !== null),
        google_ads_customer_id: anchor.googleAds?.customerId ?? null,
      },
      googleSources: grouped.filter((source) => source.googleAds !== null),
      metricAccountIds: grouped.map((source) => source.adAccountId),
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
    v2.push({
      account: {
        ...base,
        store_name: source.googleAds.accountName,
        currency: source.googleAds.currency ?? base.currency,
        google_ads_connected: true,
        google_ads_customer_id: source.googleAds.customerId,
      },
      googleSources: [source],
      metricAccountIds: [source.adAccountId],
    });
  }

  if (
    v2ClientIds.some((clientId) => !sources.some((source) => source.clientId === clientId)) ||
    usedSourceIds.size !== sources.length
  ) {
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
  const byClient = new Map<string, AdminClientCampaigns>();

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
      realRoas: 0,
    };
    group.accounts.push(entry);
    group.spend += entry.spend;
    group.commission += entry.commission;
    if (entry.rollupRevenue !== null) {
      group.revenue = (group.revenue ?? 0) + entry.rollupRevenue;
    }
    group.rollupSpend += entry.rollupSpend;
    byClient.set(entry.account.client_id, group);
  }

  return [...byClient.values()]
    .map((client) => ({
      ...client,
      realRoas: googleRoas(client.revenue, client.rollupSpend),
    }))
    .sort((a, b) => b.spend - a.spend);
}

export async function fetchAdminCampaigns(range: RangeSelection): Promise<AdminCampaignsOverview> {
  await requireClientOnboardingAdmin();
  const supabase = await createClient();
  const googleConfigured = hasGoogleAdsEnv();
  const windsorConfigured = hasWindsorEnv();
  const configured = googleConfigured || windsorConfigured;

  const [accountsRes, clientsRes, adminsRes, hstKeys] = await Promise.all([
    supabase.from("ad_accounts").select(ACCOUNT_COLUMNS).order("created_at", { ascending: true }),
    supabase.from("portal_clients").select("id, full_name, email, crm_client_id"),
    supabase.from("profiles").select("id").eq("role", "admin"),
    fetchHstClientKeys(),
  ]);

  // Staff-admins hold portal accounts too, but theirs are internal/test stores
  // — the agency doesn't bill itself, and their revenue is purged from the
  // ledger (lib/admin/commission-sync). They're kept apart here: listed at the
  // end of the page, never queried, and out of every total.
  const adminIds = new Set((adminsRes.data ?? []).map((row) => row.id));

  const allAccounts = (accountsRes.data as AdAccount[] | null) ?? [];
  const internalAccounts = allAccounts.filter((account) => adminIds.has(account.client_id));
  const inventory = await adminAccountInventory(allAccounts, adminIds);
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

  const perAccount = await Promise.all(
    inventory.map(async ({ account, googleSources }): Promise<AdminAccountCampaigns> => {
      const connected = googleSources === null
        ? googleConfigured && account.google_ads_connected && Boolean(account.google_ads_customer_id)
        : windsorConfigured && googleSources.length > 0;

      let campaigns: AdminLiveCampaign[] = [];
      let failed = false;
      let authRevoked = false;

      if (connected) {
        try {
          if (googleSources === null) {
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
            )).map((campaign) => ({
              ...campaign,
              reportingBindingId: null,
              googleAdsConnectionId: null,
            }));
          } else {
            campaigns = (await Promise.all(
              googleSources.map(async (source) =>
                (await fetchGoogleReportingCampaigns(source, range.from, range.to)).map(
                  (campaign) => ({
                    ...campaign,
                    reportingBindingId: source.bindingId,
                    googleAdsConnectionId: source.googleAds!.connectionId,
                  }),
                ),
              ),
            ))
              .flat()
              .sort((left, right) => right.spend - left.spend || left.id.localeCompare(right.id));
          }
        } catch (error) {
          failed = true;

          if (googleSources === null) {
            // A revoked authorisation is permanent, so record it: the account
            // flips to disconnected and the client's own portal starts asking
            // them to reconnect. Without this the store just reads "query
            // failed" forever and only the server logs say why.
            authRevoked = await markIfAuthRevoked(supabase, account.id, error);
            if (!authRevoked) {
              console.error(`Admin campaigns failed for ${account.id}:`, error);
            }
          } else {
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
        spend,
        commission: (spend * Number(account.commission_rate)) / 100,
        rollupRevenue: null,
        rollupSpend: 0,
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
    spend: 0,
    commission: 0,
    rollupRevenue: null,
    rollupSpend: 0,
  }));

  /**
   * Revenue for the strip, from the rollup rather than from Google.
   *
   * Everything above this line is a LIVE Google Ads query, but Google knows
   * nothing about what the shops sold — revenue only exists in daily_metrics,
   * joined there from Shopify. So the portfolio figures are read, not fetched.
   *
   * Deliberately no recompute first, unlike the client report: this page holds
   * every client at once, and refreshing them all would turn one page load into
   * dozens of Google and Shopify round trips. The hourly cron already keeps the
   * rollup current, and opening a client's own report refreshes that client.
   *
   * The consequence is that ROAS and profit divide by the ROLLUP's ad spend,
   * not the live figure in the "Ad spend" card beside them. Both come from the
   * same Google account and converge once the rollup runs; using the live spend
   * as the denominator for rollup revenue would be worse — two sources, one
   * ratio, and a number that moves when neither the revenue nor the spend did.
   */
  const metricRows = await fetchDailyMetrics(
    inventory.flatMap((entry) => entry.metricAccountIds),
    range.from,
    range.to,
  );
  const metricRowsByAccount = groupByAccount(metricRows);
  const accountsWithRollups = perAccount.map((entry, index) => {
    const rows = inventory[index].metricAccountIds.flatMap(
      (accountId) => metricRowsByAccount.get(accountId) ?? [],
    );
    const totals = sumMetrics(rows);
    return {
      ...entry,
      rollupRevenue: totals.attributedRevenue,
      rollupSpend: totals.adSpend,
    };
  });
  const rollup = sumMetrics(metricRows);
  const revenue = rollup.attributedRevenue;

  const spend = perAccount.reduce((sum, entry) => sum + entry.spend, 0);
  const commission = perAccount.reduce((sum, entry) => sum + entry.commission, 0);

  // Costs are recorded per day for the whole shop, so only the Google share of
  // them is charged here — see lib/admin/google-attribution.ts. Our own fee is
  // not among them: see the note on `profit` in the type above.
  const profit = googleProfit(revenue, {
    revenue: rollup.revenue,
    refunds: rollup.refunds,
    productCost: rollup.productCost,
    paymentFees: rollup.paymentFees,
    shippingCost: rollup.shippingCost,
    adSpend: rollup.adSpend,
  });

  return {
    clients: groupByOwner(accountsWithRollups, owners),
    internal: groupByOwner(internalEntries, owners),
    configured,
    totals: {
      spend,
      commission,
      activeCampaigns: perAccount.reduce(
        (sum, entry) => sum + entry.campaigns.filter((c) => c.status === "active").length,
        0,
      ),
      connectedAccounts: perAccount.filter((entry) => entry.connected).length,
      revenue,
      profit,
      roas: googleRoas(revenue, rollup.adSpend),
      rollupSpend: rollup.adSpend,
    },
  };
}
