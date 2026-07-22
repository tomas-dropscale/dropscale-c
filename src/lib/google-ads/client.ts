import { agencyServiceAccount, googleAdsApiBasics, googleAdsEnv } from "@/lib/google-ads/env";
import { serviceAccountAccessToken } from "@/lib/google-ads/service-account";

/**
 * Minimal Google Ads REST client.
 *
 * REST over fetch on purpose: the app deploys to Cloudflare Workers, and the
 * `google-ads-api` npm package speaks gRPC (google-gax), which does not run
 * there. Everything here is fetch + URLSearchParams — Workers-safe.
 *
 * Two identities can call it:
 *   · per-client OAuth refresh tokens (searchGoogleAds) — the portal model;
 *   · the agency's service account (…AsAgency) — key in the environment,
 *     reads whatever accounts the agency was granted in Google Ads.
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

/** Token for the agency service account, or throws with Google's wording. */
async function agencyToken(): Promise<{ token: string; loginCustomerId: string | null }> {
  const agency = agencyServiceAccount();
  if (!agency) {
    throw new Error("Agency Google Ads is not configured. Set GOOGLE_ADS_SA_KEY_JSON.");
  }
  const minted = await serviceAccountAccessToken(agency.key);
  if (!minted.ok) {
    throw new Error(`Google rejected the service-account key: ${minted.detail}`);
  }
  return { token: minted.token, loginCustomerId: agency.loginCustomerId };
}

/** One row of a GAQL result — a nested object keyed by resource name. */
export type GaqlRow = Record<string, Record<string, unknown>>;

/**
 * Runs a GAQL query and returns every row, following pagination. `:search`
 * returns plain JSON (unlike `:searchStream`, which streams and is awkward
 * over fetch).
 */
async function gaqlSearch(
  customerId: string,
  token: string,
  query: string,
  loginCustomerId: string | null,
): Promise<GaqlRow[]> {
  const { developerToken, apiVersion } = googleAdsApiBasics();
  const cid = customerId.replace(/\D/g, "");

  const rows: GaqlRow[] = [];
  let pageToken: string | undefined;

  do {
    const res = await fetch(
      `https://googleads.googleapis.com/${apiVersion}/customers/${cid}/googleAds:search`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
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

/**
 * GAQL as one CLIENT, with that client's own refresh token. No
 * login-customer-id: the token authorises the client's account directly, and
 * the env MCC is the agency's — Google rejects it for accounts outside that
 * manager tree.
 */
export async function searchGoogleAds(
  customerId: string,
  refreshToken: string,
  query: string,
): Promise<GaqlRow[]> {
  return gaqlSearch(customerId, await accessToken(refreshToken), query, null);
}

/**
 * GAQL as the AGENCY. login-customer-id defaults to the env MCC (reads that
 * go through the agency's manager tree); pass one explicitly — or null — for
 * accounts the service account was granted directly.
 */
export async function searchGoogleAdsAsAgency(
  customerId: string,
  query: string,
  opts?: { loginCustomerId?: string | null },
): Promise<GaqlRow[]> {
  const agency = await agencyToken();
  const login =
    opts && "loginCustomerId" in opts ? (opts.loginCustomerId ?? null) : agency.loginCustomerId;
  return gaqlSearch(customerId, agency.token, query, login);
}

export type AgencyAccount = {
  id: string;
  name: string | null;
  currency: string | null;
  manager: boolean;
};

/**
 * The accounts the service account can access DIRECTLY, named. Live smoke
 * test for the whole agency chain: env key → JWT → token → developer token.
 */
export async function listAgencyAccounts(limit = 25): Promise<{
  accounts: AgencyAccount[];
  total: number;
  truncated: boolean;
}> {
  const { developerToken, apiVersion } = googleAdsApiBasics();
  const agency = await agencyToken();

  const res = await fetch(
    `https://googleads.googleapis.com/${apiVersion}/customers:listAccessibleCustomers`,
    {
      headers: {
        Authorization: `Bearer ${agency.token}`,
        "developer-token": developerToken,
      },
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google Ads listAccessibleCustomers failed (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { resourceNames?: string[] };
  const ids = (body.resourceNames ?? []).map((name) => name.replace("customers/", ""));

  const described = await Promise.all(
    ids.slice(0, limit).map(async (id): Promise<AgencyAccount | null> => {
      try {
        // Direct access ⇒ the account itself is the login customer. One
        // cancelled or unreadable account must not sink the listing.
        const rows = await gaqlSearch(
          id,
          agency.token,
          "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer",
          id,
        );
        const customer = rows[0]?.customer as
          | { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean }
          | undefined;
        if (!customer?.id) return null;
        return {
          id: String(customer.id),
          name: customer.descriptiveName ?? null,
          currency: customer.currencyCode ?? null,
          manager: customer.manager ?? false,
        };
      } catch {
        return null;
      }
    }),
  );

  const accounts = described
    .filter((account): account is AgencyAccount => account !== null)
    .sort(
      (a, b) => Number(b.manager) - Number(a.manager) || (a.name ?? "").localeCompare(b.name ?? ""),
    );

  return { accounts, total: ids.length, truncated: ids.length > limit };
}
