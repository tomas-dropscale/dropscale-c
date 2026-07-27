import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveCampaigns } from "@/lib/google-ads/portal";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import { ACCOUNT_COLUMNS } from "@/lib/portal/data";
import type { AdAccount, Campaign } from "@/lib/supabase/types";
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
  campaigns: Campaign[];
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
};

export type AdminClientCampaigns = {
  clientId: string;
  clientName: string;
  clientEmail: string;
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
  totals: { spend: number; commission: number; activeCampaigns: number; connectedAccounts: number };
};

type Owner = { name: string; email: string };

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

  const [accountsRes, clientsRes, adminsRes] = await Promise.all([
    supabase.from("ad_accounts").select(ACCOUNT_COLUMNS).order("created_at", { ascending: true }),
    supabase.from("portal_clients").select("id, full_name, email"),
    supabase.from("profiles").select("id").eq("role", "admin"),
  ]);

  // Staff-admins hold portal accounts too, but theirs are internal/test stores
  // — the agency doesn't bill itself, and their revenue is purged from the
  // ledger (lib/admin/commission-sync). They're kept apart here: listed at the
  // end of the page, never queried, and out of every total.
  const adminIds = new Set((adminsRes.data ?? []).map((row) => row.id));

  const allAccounts = (accountsRes.data as AdAccount[] | null) ?? [];
  const accounts = allAccounts.filter((account) => !adminIds.has(account.client_id));
  const internalAccounts = allAccounts.filter((account) => adminIds.has(account.client_id));
  const owners = new Map(
    (clientsRes.data ?? []).map((client) => [
      client.id,
      { name: client.full_name, email: client.email },
    ]),
  );

  const perAccount = await Promise.all(
    accounts.map(async (account): Promise<AdminAccountCampaigns> => {
      const connected =
        configured && account.google_ads_connected && Boolean(account.google_ads_customer_id);

      let campaigns: Campaign[] = [];
      let failed = false;
      let authRevoked = false;

      if (connected) {
        try {
          const { data } = await supabase
            .from("ad_accounts")
            .select("google_ads_refresh_token")
            .eq("id", account.id)
            .maybeSingle();
          const cipher = data?.google_ads_refresh_token;
          if (!cipher) throw new Error("token row missing");

          campaigns = await fetchLiveCampaigns(
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
    spend: 0,
    commission: 0,
  }));

  return {
    clients: groupByOwner(perAccount, owners),
    internal: groupByOwner(internalEntries, owners),
    configured,
    totals: {
      spend: perAccount.reduce((sum, entry) => sum + entry.spend, 0),
      commission: perAccount.reduce((sum, entry) => sum + entry.commission, 0),
      activeCampaigns: perAccount.reduce(
        (sum, entry) => sum + entry.campaigns.filter((c) => c.status === "active").length,
        0,
      ),
      connectedAccounts: perAccount.filter((entry) => entry.connected).length,
    },
  };
}
