import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveCampaigns } from "@/lib/google-ads/portal";
import { ACCOUNT_COLUMNS } from "@/lib/portal/data";
import type { AdAccount, Campaign } from "@/lib/supabase/types";
import type { RangeKey } from "@/lib/portal/range";

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
  configured: boolean;
  totals: { spend: number; commission: number; activeCampaigns: number; connectedAccounts: number };
};

export async function fetchAdminCampaigns(range: RangeKey): Promise<AdminCampaignsOverview> {
  const supabase = await createClient();
  const configured = hasGoogleAdsEnv();

  const [accountsRes, clientsRes] = await Promise.all([
    supabase.from("ad_accounts").select(ACCOUNT_COLUMNS).order("created_at", { ascending: true }),
    supabase.from("portal_clients").select("id, full_name, email"),
  ]);

  const accounts = (accountsRes.data as AdAccount[] | null) ?? [];
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
          console.error(`Admin campaigns failed for ${account.id}:`, error);
          failed = true;
        }
      }

      const spend = campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
      return {
        account,
        campaigns,
        connected,
        failed,
        spend,
        commission: (spend * Number(account.commission_rate)) / 100,
      };
    }),
  );

  // Group by owner; clients with the most spend first, so the list reads as
  // "where the money is" rather than insertion order.
  const byClient = new Map<string, AdminClientCampaigns>();
  for (const entry of perAccount) {
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

  const clients = [...byClient.values()].sort((a, b) => b.spend - a.spend);

  return {
    clients,
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
