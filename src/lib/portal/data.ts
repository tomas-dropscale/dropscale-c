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
import type { RangeSelection } from "@/lib/portal/range";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { decryptToken } from "@/lib/google-ads/crypto";
import {
  fetchLiveCampaigns,
  fetchLiveCreatives,
  fetchLiveMetrics,
  type CreativeAsset,
} from "@/lib/google-ads/portal";

// Every column except the encrypted token, which must not leave the server
// inside an account payload.
export const ACCOUNT_COLUMNS =
  "id, client_id, store_name, google_ads_customer_id, status, currency, breakeven_roas, " +
  "lifetime_ads_budget_usd, shopify_url, shopify_connected, shopify_client_id, shopify_scopes, " +
  "color_dot, created_at, google_ads_connected_email, google_ads_connected, commission_rate, " +
  "shopify_token_last4, shopify_connected_at, " +
  "default_product_cost_pct, payment_fee_pct, payment_fee_fixed, shipping_cost_per_order";

/**
 * The portal is the CLIENT's zone, so every read here is pinned to the
 * signed-in user's own client_id — explicitly, not via RLS alone. RLS carries
 * an `or is_admin()` escape hatch for the admin area, which means an admin
 * browsing the portal would otherwise see every account in the system. Which
 * data you see is decided by the zone you are in, never by your role.
 */
async function sessionUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function fetchAccounts(): Promise<AdAccount[]> {
  const userId = await sessionUserId();
  if (!userId) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("client_id", userId)
    .order("created_at", { ascending: true });
  return (data as AdAccount[] | null) ?? [];
}

/** One OWN account; someone else's id (even for an admin) comes back null → 404. */
export async function fetchAccount(accountId: string): Promise<AdAccount | null> {
  const userId = await sessionUserId();
  if (!userId) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("ad_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("client_id", userId)
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

export async function fetchCampaigns(account: AdAccount, range: RangeSelection): Promise<Campaign[]> {
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

export async function fetchAccountMetrics(account: AdAccount, range: RangeSelection): Promise<MetricSet> {
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

/**
 * Live creatives for a connected account.
 *
 * Returns null when Google Ads isn't configured at all — the caller then falls
 * back to the demo deliveries grid. Configured-but-not-connected (or a failed
 * query) returns an empty list: honest nothing, never fake creatives.
 */
export async function fetchCreativeAssets(account: AdAccount): Promise<CreativeAsset[] | null> {
  if (!hasGoogleAdsEnv()) return null;

  if (!isGoogleAdsConnected(account)) return [];

  try {
    const token = await accountRefreshToken(account.id);
    if (!token) return [];
    return await fetchLiveCreatives(account.google_ads_customer_id!, token);
  } catch (error) {
    console.error(`Google Ads creatives failed for ${account.id}:`, error);
    return [];
  }
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
