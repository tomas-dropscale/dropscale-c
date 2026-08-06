import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveCampaignsDetailed, type LiveCampaign } from "@/lib/google-ads/portal";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import { fetchHstClientKeys } from "@/lib/admin/hst";
import { googleProfit, googleRoas } from "@/lib/admin/google-attribution";
import { fetchDailyMetrics, sumMetrics } from "@/lib/metrics/queries";
import { ACCOUNT_COLUMNS } from "@/lib/portal/data";
import type { AdAccount } from "@/lib/supabase/types";
import type { RangeSelection } from "@/lib/portal/range";

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
  campaigns: LiveCampaign[];
  connected: boolean;
  /** Live query attempted but failed — distinguishes "error" from "no spend". */
  failed: boolean;
  /**
   * The failure was Google refusing the client's authorisation. Separate from
   * `failed` because the fix is different and belongs to the CLIENT: nobody can
   * retry their way out of it, the account has to be reconnected.
   */
  authRevoked: boolean;
  /**
   * Live Google was unavailable (budget or transient error) and the figures
   * fall back to the daily_metrics rollup for the same range — correct totals,
   * just without the live campaign list.
   */
  cached: boolean;
  spend: number;
  commission: number;
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
    };
    group.accounts.push(entry);
    group.spend += entry.spend;
    group.commission += entry.commission;
    byClient.set(entry.account.client_id, group);
  }

  return [...byClient.values()].sort((a, b) => b.spend - a.spend);
}

export async function fetchAdminCampaigns(range: RangeSelection): Promise<AdminCampaignsOverview> {
  const supabase = await createClient();
  const configured = hasGoogleAdsEnv();

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
  const accounts = allAccounts.filter((account) => !adminIds.has(account.client_id));
  const internalAccounts = allAccounts.filter((account) => adminIds.has(account.client_id));
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

  // Rollup rows come first: they price the revenue strip below AND provide the
  // fallback figures when a live Google query cannot run (the Workers Free
  // plan caps external subrequests per invocation, and the whole fleet no
  // longer fits in one page render).
  const metricRows = await fetchDailyMetrics(
    accounts.map((account) => account.id),
    range.from,
    range.to,
  );
  const rollupSpendByAccount = new Map<string, number>();
  for (const row of metricRows) {
    rollupSpendByAccount.set(
      row.ad_account_id,
      (rollupSpendByAccount.get(row.ad_account_id) ?? 0) + Number(row.ad_spend),
    );
  }

  // One batched read instead of one SELECT per account: every saved
  // subrequest is budget the live Google queries below get to keep.
  const connectedIds = accounts
    .filter(
      (account) =>
        configured && account.google_ads_connected && Boolean(account.google_ads_customer_id),
    )
    .map((account) => account.id);
  const tokenByAccount = new Map<string, string>();
  if (connectedIds.length > 0) {
    const { data: tokenRows } = await supabase
      .from("ad_accounts")
      .select("id, google_ads_refresh_token")
      .in("id", connectedIds);
    for (const row of tokenRows ?? []) {
      if (row.google_ads_refresh_token) {
        tokenByAccount.set(row.id, row.google_ads_refresh_token);
      }
    }
  }

  const perAccount = await Promise.all(
    accounts.map(async (account): Promise<AdminAccountCampaigns> => {
      const connected =
        configured && account.google_ads_connected && Boolean(account.google_ads_customer_id);

      let campaigns: LiveCampaign[] = [];
      let failed = false;
      let authRevoked = false;

      if (connected) {
        try {
          const cipher = tokenByAccount.get(account.id);
          if (!cipher) throw new Error("token row missing");

          campaigns = await fetchLiveCampaignsDetailed(
            account.google_ads_customer_id!,
            await decryptToken(cipher),
            account.id,
            range,
          );
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
        }
      }

      // A failed live query falls back to the rollup's spend for the range —
      // the totals stay right even when Google is out of subrequest budget.
      const rollupSpend = rollupSpendByAccount.get(account.id) ?? 0;
      const cached = failed && !authRevoked && rollupSpend > 0;
      const spend = cached
        ? rollupSpend
        : campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
      return {
        account,
        campaigns,
        // Report what we just learned, not the stale row we read at the top.
        connected: connected && !authRevoked,
        failed,
        authRevoked,
        cached,
        spend,
        commission: (spend * Number(account.commission_rate)) / 100,
      };
    }),
  );

  // Admin-owned stores get an entry with no campaigns: they're shown as a
  // roster, and the page says outright that their campaigns aren't listed.
  const internalEntries: AdminAccountCampaigns[] = internalAccounts.map((account) => ({
    account,
    campaigns: [],
    connected:
      configured && account.google_ads_connected && Boolean(account.google_ads_customer_id),
    failed: false,
    authRevoked: false,
    cached: false,
    spend: 0,
    commission: 0,
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
    clients: groupByOwner(perAccount, owners),
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
