import { googleAdsEnv } from "@/lib/google-ads/env";

/**
 * Minimal Google Ads REST client.
 *
 * REST over fetch on purpose: the app deploys to Cloudflare Workers, and the
 * `google-ads-api` npm package speaks gRPC (google-gax), which does not run
 * there. Everything here is fetch + URLSearchParams — Workers-safe.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Cached per isolate, keyed by refresh token (one per client account). Access
// tokens live ~1h; refreshing on every query would add a round-trip and burn
// OAuth quota. A cold isolate just mints new ones.
const tokenCache = new Map<string, { value: string; expiresAt: number }>();

async function accessToken(refreshToken: string): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.value;
  }

  const env = googleAdsEnv();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google OAuth token refresh failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(refreshToken, {
    value: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  });
  return json.access_token;
}

/** One row of a GAQL result — a nested object keyed by resource name. */
export type GaqlRow = Record<string, Record<string, unknown>>;

/**
 * Runs a GAQL query against one customer using that client's own refresh
 * token, and returns every row, following pagination. `:search` returns plain
 * JSON (unlike `:searchStream`, which streams and is awkward over fetch).
 */
export async function searchGoogleAds(
  customerId: string,
  refreshToken: string,
  query: string,
): Promise<GaqlRow[]> {
  const env = googleAdsEnv();
  const cid = customerId.replace(/\D/g, "");
  const token = await accessToken(refreshToken);

  const rows: GaqlRow[] = [];
  let pageToken: string | undefined;

  do {
    const res = await fetch(
      `https://googleads.googleapis.com/${env.apiVersion}/customers/${cid}/googleAds:search`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": env.developerToken,
          // Only relevant when reading via a manager account; harmless otherwise.
          ...(env.loginCustomerId ? { "login-customer-id": env.loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
      },
    );

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Google Ads query failed for ${cid} (${res.status}): ${detail}`);
    }

    const json = (await res.json()) as { results?: GaqlRow[]; nextPageToken?: string };
    if (json.results) rows.push(...json.results);
    pageToken = json.nextPageToken;
  } while (pageToken);

  return rows;
}
