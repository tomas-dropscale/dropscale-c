/**
 * Google Ads API credentials — the agency's OAuth *app*, shared by every
 * client connection.
 *
 * Connection model: per-client OAuth. Each client authorises their own Google
 * Ads account in the portal, so the refresh token is stored per ad_account
 * (encrypted), NOT here. These env vars are only the app-level credentials
 * plus the developer token and the encryption key.
 *
 * All server-only: none are NEXT_PUBLIC, so they never reach the browser
 * bundle. On Cloudflare they must be set as Worker secrets.
 */

import {
  parseServiceAccountKey,
  type ServiceAccountKey,
} from "@/lib/google-ads/service-account";

export type GoogleAdsEnv = {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  /** Optional: only needed when reading through a manager account. */
  loginCustomerId: string | null;
  /** Google deprecates API versions ~yearly; bump when one sunsets. */
  apiVersion: string;
};

function digits(value: string | undefined) {
  return value ? value.replace(/\D/g, "") : "";
}

/** True when the app-level credentials needed for ANY connection are present. */
export function hasGoogleAdsEnv(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
      process.env.GOOGLE_ADS_CLIENT_ID &&
      process.env.GOOGLE_ADS_CLIENT_SECRET &&
      process.env.GOOGLE_ADS_TOKEN_ENC_KEY,
  );
}

/** Throws with an actionable message rather than failing deep inside a fetch. */
export function googleAdsEnv(): GoogleAdsEnv {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;

  if (!developerToken || !clientId || !clientSecret || !process.env.GOOGLE_ADS_TOKEN_ENC_KEY) {
    throw new Error(
      "Google Ads is not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, " +
        "GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_TOKEN_ENC_KEY.",
    );
  }

  const loginCustomerId = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

  return {
    developerToken,
    clientId,
    clientSecret,
    loginCustomerId: loginCustomerId || null,
    apiVersion: process.env.GOOGLE_ADS_API_VERSION?.trim() || "v21",
  };
}

/**
 * Developer token + API version WITHOUT demanding the OAuth app credentials —
 * the agency service-account path (service-account.ts) authenticates with its
 * key alone and must not fail because clientId/clientSecret are absent.
 */
export function googleAdsApiBasics() {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    throw new Error("Google Ads is not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN.");
  }
  return {
    developerToken,
    apiVersion: process.env.GOOGLE_ADS_API_VERSION?.trim() || "v21",
  };
}

/**
 * The AGENCY's own connection: a service-account key in the environment
 * (single-line JSON, or base64 of it). GOOGLE_ADS_LOGIN_CUSTOMER_ID is the
 * agency's MCC and belongs to THIS path — per-client OAuth queries authorise
 * each client's account directly and never send it.
 */
export function agencyServiceAccount(): {
  key: ServiceAccountKey;
  loginCustomerId: string | null;
} | null {
  const raw = process.env.GOOGLE_ADS_SA_KEY_JSON?.trim();
  if (!raw) return null;

  let json = raw;
  if (!raw.startsWith("{")) {
    try {
      json = atob(raw);
    } catch {
      return null;
    }
  }
  const key = parseServiceAccountKey(json);
  if (!key) return null;

  const mcc = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  return { key, loginCustomerId: mcc || null };
}

export function hasAgencyServiceAccount(): boolean {
  return agencyServiceAccount() !== null;
}
