import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  searchGoogleAds,
  type GaqlRow,
} from "@/lib/google-ads/client";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import type { Database } from "@/lib/supabase/types";

export type GoogleLedgerSearch = (
  customerId: string,
  query: string,
) => Promise<GaqlRow[]>;

type LedgerAccountCredential = {
  id: string;
  google_ads_connected: boolean;
};

type Supabase = SupabaseClient<Database>;

/**
 * Execute one complete recurring-ledger read through the account's established
 * client OAuth connection. The callback receives one bound search function so
 * metadata and spend cannot accidentally use different credentials. The
 * ciphertext is loaded server-side and separately from ordinary account data.
 */
export async function withClientGoogleAds<T>(
  supabase: Supabase,
  account: LedgerAccountCredential,
  read: (search: GoogleLedgerSearch) => Promise<T>,
): Promise<T> {
  if (!hasGoogleAdsEnv()) {
    throw new Error(
      "Client Google Ads OAuth is not configured on this server.",
    );
  }
  if (!account.google_ads_connected) {
    throw new Error("The client Google Ads authorisation is disconnected.");
  }

  const { data, error } = await supabase
    .from("ad_accounts")
    .select("google_ads_refresh_token")
    .eq("id", account.id)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load the client Google Ads credential: ${error.message}`);
  }
  if (!data?.google_ads_refresh_token) {
    throw new Error("The connected Google Ads account has no OAuth credential.");
  }

  const refreshToken = await decryptToken(data.google_ads_refresh_token);
  const search: GoogleLedgerSearch = (customerId, query) =>
    searchGoogleAds(customerId, refreshToken, query);

  try {
    return await read(search);
  } catch (error) {
    await markIfAuthRevoked(supabase, account.id, error);
    throw error;
  }
}
