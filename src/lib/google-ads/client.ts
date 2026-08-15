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

/**
 * The client's Google authorisation is gone for good — Google answered
 * `invalid_grant`, which it returns for a refresh token that was revoked, that
 * expired (an OAuth app still in "Testing" expires them after 7 days), or that
 * was issued by a different OAuth client.
 *
 * Worth its own type because it is the one Google failure that RETRYING CANNOT
 * FIX: a human has to re-authorise. Callers use it to mark the account
 * disconnected so the portal asks for a reconnect, instead of showing an
 * unexplained "query failed" until someone reads the logs.
 */
export class GoogleAuthRevokedError extends Error {
  constructor(detail: string) {
    super(`Google authorisation revoked or expired: ${detail}`);
    this.name = "GoogleAuthRevokedError";
  }
}

/** A Google Ads query that came back non-2xx, with the status kept. */
export class GoogleAdsQueryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleAdsQueryError";
  }
}

/** A redacted write failure. Raw Google response bodies never leave this module. */
export class GoogleAdsMutationError extends Error {
  constructor(
    readonly status: number | null,
    readonly providerCode: string,
    readonly requestId: string | null,
    /** The request may have reached Google and must be reconciled, never retried blindly. */
    readonly indeterminate: boolean,
  ) {
    super("Google Ads could not confirm the campaign mutation.");
    this.name = "GoogleAdsMutationError";
  }
}

// Cached per isolate, keyed by refresh token (one per client account). Access
// tokens live ~1h; refreshing on every query would add a round-trip and burn
// OAuth quota. A cold isolate just mints new ones.
const tokenCache = new Map<string, { value: string; expiresAt: number }>();
const accessibleCustomerCache = new Map<string, string[]>();

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
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const detail = await res.text();

    // A dead token must never sit in the cache: without this, one revoked
    // account would keep re-hitting Google on every render.
    tokenCache.delete(refreshToken);

    // Google says `invalid_grant` only when re-authorisation is the only fix.
    // Everything else (5xx, quota, network) is transient and stays a plain
    // Error so the caller retries it next time.
    if (detail.includes("invalid_grant")) {
      throw new GoogleAuthRevokedError(detail);
    }
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

export type GoogleAdsMutateService = "campaigns" | "campaignBudgets";

export type GoogleAdsMutateResponse = {
  /** Google request id, useful for a redacted provider receipt. */
  requestId: string | null;
  /** Mutable resources returned when responseContentType=MUTABLE_RESOURCE. */
  results: Record<string, unknown>[];
};

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
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!res.ok) {
      const detail = await res.text();
      // Status is carried so the per-client caller can tell "this credential is
      // not accepted at all" (401) from a query that merely failed.
      throw new GoogleAdsQueryError(
        `Google Ads query failed for ${cid} (${res.status}): ${detail}`,
        res.status,
      );
    }

    const json = (await res.json()) as { results?: GaqlRow[]; nextPageToken?: string };
    if (json.results) rows.push(...json.results);
    pageToken = json.nextPageToken;
  } while (pageToken);

  return rows;
}

async function accessibleCustomerIds(
  token: string,
  refreshToken: string,
): Promise<string[]> {
  const cached = accessibleCustomerCache.get(refreshToken);
  if (cached) return cached;

  const { developerToken, apiVersion } = googleAdsApiBasics();
  const res = await fetch(
    `https://googleads.googleapis.com/${apiVersion}/customers:listAccessibleCustomers`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": developerToken,
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    throw new GoogleAdsQueryError(
      `Google Ads accessible-customer lookup failed (${res.status}).`,
      res.status,
    );
  }
  const json = (await res.json()) as { resourceNames?: unknown };
  const ids = Array.isArray(json.resourceNames)
    ? json.resourceNames
        .map((name) => /^customers\/(\d{10})$/.exec(String(name))?.[1] ?? null)
        .filter((id): id is string => Boolean(id))
        .slice(0, 25)
    : [];
  accessibleCustomerCache.set(refreshToken, ids);
  return ids;
}

/**
 * GAQL as one CLIENT, with that client's own refresh token. Direct account
 * grants need no login-customer-id. Manager grants are retried only through
 * customer ids that Google itself reports as directly accessible to the same
 * OAuth token.
 */
export async function searchGoogleAds(
  customerId: string,
  refreshToken: string,
  query: string,
): Promise<GaqlRow[]> {
  const token = await accessToken(refreshToken);
  try {
    return await gaqlSearch(customerId, token, query, null);
  } catch (directError) {
    let error = directError;
    // Some clients authorise Google Ads through their manager account rather
    // than directly on the child customer. Retry a permission failure through
    // the configured MCC; Google still validates the same OAuth grant and the
    // exact requested customer identity.
    if (directError instanceof GoogleAdsQueryError && directError.status === 403) {
      const configured = googleAdsEnv().loginCustomerId;
      const discovered = await accessibleCustomerIds(token, refreshToken).catch(
        () => [],
      );
      const candidates = [...new Set([configured, ...discovered].filter(Boolean))] as string[];
      for (const loginCustomerId of candidates) {
        try {
          return await gaqlSearch(customerId, token, query, loginCustomerId);
        } catch (managerError) {
          error = managerError;
        }
      }
    }
    /**
     * 401 UNAUTHENTICATED here means the refresh SUCCEEDED but the Ads API
     * refuses the access token it produced. In practice that is a grant made
     * without the `.../auth/adwords` scope: Google mints a token for the
     * scopes it was actually given, and this API is not one of them.
     *
     * Retrying cannot fix it — the client has to consent again, granting the
     * Google Ads permission. So it is reported as the same "reconnect needed"
     * condition as a revoked token, and the readers above mark the account
     * disconnected instead of failing every render forever.
     *
     * Only on this per-client path: a 401 on the AGENCY path means the service
     * account key is wrong, which is the agency's problem, not a client's.
     */
    if (error instanceof GoogleAdsQueryError && error.status === 401) {
      // A cached access token is useless once the API has rejected it.
      tokenCache.delete(refreshToken);
      throw new GoogleAuthRevokedError(error.message);
    }
    throw error;
  }
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

/**
 * One purpose-built agency mutate call.
 *
 * The caller owns the resource-specific operation shape; this helper owns the
 * service-account token, exact customer URL and Google headers. Only the two
 * services used by the Campaigns controls are accepted so a future browser
 * payload can never select an arbitrary Google Ads endpoint.
 */
export async function mutateGoogleAdsAsAgency(
  customerId: string,
  service: GoogleAdsMutateService,
  operations: Record<string, unknown>[],
  options: { validateOnly: boolean },
): Promise<GoogleAdsMutateResponse> {
  if (!/^[0-9\s-]+$/.test(customerId)) {
    throw new Error("Invalid Google Ads mutate request.");
  }
  const cid = customerId.replace(/\D/g, "");
  if (!/^\d{10}$/.test(cid) || operations.length !== 1) {
    throw new Error("Invalid Google Ads mutate request.");
  }

  const { developerToken, apiVersion } = googleAdsApiBasics();
  const agency = await agencyToken();
  let res: Response;
  try {
    res = await fetch(
      `https://googleads.googleapis.com/${apiVersion}/customers/${cid}/${service}:mutate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agency.token}`,
          "developer-token": developerToken,
          ...(agency.loginCustomerId
            ? { "login-customer-id": agency.loginCustomerId }
            : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operations,
          partialFailure: false,
          validateOnly: options.validateOnly,
          responseContentType: "MUTABLE_RESOURCE",
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw new GoogleAdsMutationError(
      null,
      "NETWORK_OR_TIMEOUT",
      null,
      !options.validateOnly,
    );
  }

  if (!res.ok) {
    const requestId = res.headers.get("request-id");
    const detail = (await res.text()).slice(0, 32_768);
    let providerCode = "HTTP_ERROR";
    try {
      const parsed = JSON.parse(detail) as { error?: { status?: unknown } };
      const candidate = parsed.error?.status;
      if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(candidate)) {
        providerCode = candidate;
      }
    } catch {
      // The raw response remains deliberately discarded.
    }
    throw new GoogleAdsMutationError(
      res.status,
      providerCode,
      requestId,
      !options.validateOnly && (res.status === 408 || res.status === 429 || res.status >= 500),
    );
  }

  let json: { results?: unknown };
  try {
    json = (await res.json()) as { results?: unknown };
  } catch {
    throw new GoogleAdsMutationError(
      res.status,
      "INVALID_RESPONSE",
      res.headers.get("request-id"),
      !options.validateOnly,
    );
  }
  const results = Array.isArray(json.results)
    ? json.results.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  return {
    requestId: res.headers.get("request-id"),
    results,
  };
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
