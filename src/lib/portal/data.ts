/**
 * Server-side data access for the portal pages.
 *
 * ad_accounts are always real (they drive the sidebar and routing). Campaigns
 * and deliveries come from the DB when rows exist and fall back to seeded
 * mocks otherwise — so the UI is fully browsable before the Google Ads /
 * Shopify sync jobs exist, and flips to real data the moment rows appear.
 */

import { createClient } from "@/lib/supabase/server";
import type { AdAccount, Campaign, CreativeDelivery } from "@/lib/supabase/types";
import { mockCampaigns, mockDeliveries } from "@/lib/portal/mock";
import type { RangeKey } from "@/lib/portal/range";

export async function fetchAccounts(): Promise<AdAccount[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select("*")
    .order("created_at", { ascending: true });
  return data ?? [];
}

/** One account, RLS-scoped: another client's id comes back null → 404. */
export async function fetchAccount(accountId: string): Promise<AdAccount | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();
  return data;
}

export async function fetchCampaigns(
  accountId: string,
  range: RangeKey,
): Promise<Campaign[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("campaigns")
    .select("*")
    .eq("ad_account_id", accountId)
    .order("spend", { ascending: false });

  if (data && data.length > 0) return data;
  return mockCampaigns(accountId, range);
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
