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
import type { AdAccount, Campaign, CreativeDelivery } from "@/lib/supabase/types";
import { aggregateMetrics, mockCampaigns, mockDeliveries, mockMetrics } from "@/lib/portal/mock";
import type { MetricSet } from "@/lib/portal/mock";
import type { RangeKey } from "@/lib/portal/range";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { decryptToken } from "@/lib/google-ads/crypto";
import { fetchLiveCampaigns, fetchLiveMetrics } from "@/lib/google-ads/portal";

// Every column except the encrypted token, which must not leave the server
// inside an account payload.
const ACCOUNT_COLUMNS =
  "id, client_id, store_name, google_ads_customer_id, status, currency, breakeven_roas, " +
  "lifetime_ads_budget_usd, shopify_url, shopify_connected, shopify_client_id, shopify_scopes, " +
  "color_dot, created_at, google_ads_connected_email, google_ads_connected";

export async function fetchAccounts(): Promise<AdAccount[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select(ACCOUNT_COLUMNS)
    .order("created_at", { ascending: true });
  return (data as AdAccount[] | null) ?? [];
}

/** One account, RLS-scoped: another client's id comes back null → 404. */
export async function fetchAccount(accountId: string): Promise<AdAccount | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .maybeSingle();
  return (data as AdAccount | null) ?? null;
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

export async function fetchCampaigns(account: AdAccount, range: RangeKey): Promise<Campaign[]> {
  if (isGoogleAdsConnected(account)) {
    try {
      const token = await accountRefreshToken(account.id);
      if (!token) return [];
      return await fetchLiveCampaigns(account.google_ads_customer_id!, token, account.id, range);
    } catch (error) {
      // Connected but the query failed — surface nothing, never mock.
      console.error(`Google Ads campaigns failed for ${account.id}:`, error);
      return [];
    }
  }

  // Configured but this account isn't connected → honest empty, never fake.
  // Mock is the DEMO state, reserved for when the API isn't set up at all.
  if (hasGoogleAdsEnv()) return [];
  return mockCampaigns(account.id, range);
}

export async function fetchAccountMetrics(account: AdAccount, range: RangeKey): Promise<MetricSet> {
  if (isGoogleAdsConnected(account)) {
    try {
      const token = await accountRefreshToken(account.id);
      if (!token) return aggregateMetrics([]);
      return await fetchLiveMetrics(account.google_ads_customer_id!, token, range);
    } catch (error) {
      console.error(`Google Ads metrics failed for ${account.id}:`, error);
      return aggregateMetrics([]); // all-zero MetricSet
    }
  }

  // Configured but not connected → zeroes, not fabricated numbers.
  if (hasGoogleAdsEnv()) return aggregateMetrics([]);
  return mockMetrics(account.id, range);
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
