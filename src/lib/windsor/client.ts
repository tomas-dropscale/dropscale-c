import "server-only";

import { decryptToken, encryptToken } from "../google-ads/crypto";

/**
 * Server-only Windsor adapter for Client Onboarding V2.
 *
 * Windsor is deliberately used for Google Ads only. Shopify reporting has a
 * separate Dropscale-owned connection and must never be routed through this
 * module. The upstream API currently authenticates with `api_key` in the
 * query string, so every request is built and consumed here: callers never
 * receive an authenticated upstream URL, and errors never include a URL or an
 * upstream response body.
 */

const WINDSOR_DATASOURCE = "google_ads" as const;
const ONBOARD_ORIGIN = "https://onboard.windsor.ai";
const CONNECTORS_ORIGIN = "https://connectors.windsor.ai";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const AUTHORIZATION_REQUEST_TIMEOUT_MS = 25_000;
const MAX_JSON_CHARS = 1_000_000;
const MAX_PRODUCT_JSON_CHARS = 8_000_000;
const MAX_SECRET_CHARS = 4_096;
const MAX_REPORTING_RANGE_DAYS = 366;

export type WindsorErrorCode =
  | "server_not_configured"
  | "invalid_request"
  | "authentication_failed"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_response"
  | "aborted";

export class WindsorError extends Error {
  constructor(
    public readonly code: WindsorErrorCode,
    message: string,
    public readonly status: number,
    public readonly upstreamStatus: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "WindsorError";
  }
}

export type WindsorGoogleAdsAccount = {
  datasource: typeof WINDSOR_DATASOURCE;
  /** Canonical Windsor/Google display form, e.g. 123-456-7890. */
  accountId: string;
  /** Digits-only Google Ads customer id, useful for stable comparisons. */
  customerId: string;
  accountName: string | null;
  status: string | null;
  currency: string | null;
  timeZone: string | null;
};

export type WindsorGoogleAdsAuthorization = {
  /** One-time/time-limited Windsor page that is safe to send to the client. */
  authorizationUrl: string;
  /** Secret correlation token. Encrypt it before persistence; never send it separately. */
  accessToken: string;
};

export type WindsorGoogleAdsCapabilities = {
  datasource: typeof WINDSOR_DATASOURCE;
  actionIds: string[];
  canCreateCampaign: boolean;
  canPauseCampaign: boolean;
  canEnableCampaign: boolean;
};

/** One exact Google Ads account/day returned by Windsor's reporting API. */
export type WindsorGoogleAdsDailyRow = {
  /** ISO calendar day in the Google Ads account's reporting time zone. */
  date: string;
  /** Canonical Windsor/Google display form, e.g. 123-456-7890. */
  accountId: string;
  /** Digits-only Google Ads customer id. */
  customerId: string;
  currency: string;
  timeZone: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

/** One range-aggregated campaign returned for an exact Google Ads account. */
export type WindsorGoogleAdsCampaignRow = {
  accountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
  campaignId: string;
  name: string;
  status: "ENABLED" | "PAUSED" | "REMOVED";
  advertisingChannelType: string;
  /** True only when Windsor reports Google's Merchant Center id. */
  shoppingFeed: boolean;
  biddingStrategyType: string | null;
  startDate: string | null;
  dailyBudget: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  /** Exact ad final URLs reported by Windsor for this campaign. */
  finalUrls?: string[];
};

export type WindsorGoogleAdsCampaignTimelineRow = {
  date: string;
  bucket: string;
  granularity: "hour" | "day";
  accountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
  campaignId: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

/** One range-aggregated Demand Gen asset for an exact Windsor account. */
export type WindsorGoogleAdsDemandGenAdRow = {
  accountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
  campaignId: string;
  adId: string;
  name: string | null;
  type: string;
  status?: "ENABLED" | "PAUSED" | "REMOVED";
  thumbnailUrl?: string | null;
  assetKind?: "image" | "video" | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

/** One range-aggregated PMax product row, retaining the full Merchant tuple. */
export type WindsorGoogleAdsPmaxProductRow = {
  accountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
  campaignId: string;
  merchantId: string;
  feedLabel: string;
  language: string;
  country: string;
  channel: string;
  itemId: string;
  title: string;
  brand: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

export type WindsorGoogleAdsHealth =
  | {
      ok: true;
      code: "healthy";
      account: WindsorGoogleAdsAccount;
      /** False is still healthy: the account may simply have no recent rows. */
      recentDataAvailable: boolean;
      checkedAt: string;
    }
  | {
      ok: false;
      code: "not_connected";
      account: null;
      recentDataAvailable: false;
      checkedAt: string;
    };

export type WindsorRequestOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type WindsorInternalRequestOptions = WindsorRequestOptions & {
  maxJsonChars?: number;
};

export type WindsorPollOptions = WindsorRequestOptions & {
  accessToken: string;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type WindsorPollResult =
  | {
      status: "connected";
      accounts: WindsorGoogleAdsAccount[];
      attempts: number;
    }
  | {
      status: "pending";
      accounts: [];
      attempts: number;
    };

function requireApiKey(): string {
  const apiKey = process.env.WINDSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new WindsorError(
      "server_not_configured",
      "Windsor is not configured on the server.",
      503,
    );
  }
  return apiKey;
}

export function hasWindsorEnv(): boolean {
  return Boolean(process.env.WINDSOR_API_KEY?.trim());
}

function requireSecret(value: string, label: string): string {
  const secret = value.trim();
  if (!secret || secret.length > MAX_SECRET_CHARS || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new WindsorError(
      "invalid_request",
      `${label} is missing or invalid.`,
      400,
    );
  }
  return secret;
}

/** Store only the returned ciphertext in client_onboarding_secrets. */
export async function encryptWindsorAccessToken(accessToken: string): Promise<string> {
  return encryptToken(requireSecret(accessToken, "Windsor access token"));
}

/** Decrypt only immediately before a server-to-server Windsor request. */
export async function decryptWindsorAccessToken(ciphertext: string): Promise<string> {
  const packed = requireSecret(ciphertext, "Encrypted Windsor access token");
  try {
    return requireSecret(await decryptToken(packed), "Windsor access token");
  } catch (error) {
    if (error instanceof WindsorError) throw error;
    throw new WindsorError(
      "server_not_configured",
      "The stored Windsor authorization cannot be read by this server.",
      503,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown, maxLength = 240): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, maxLength) : null;
}

function arrayPayload(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record) {
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key];
    }
  }
  throw new WindsorError(
    "invalid_response",
    "Windsor returned an unexpected response.",
    502,
  );
}

export function normalizeGoogleAdsCustomerId(value: string): {
  accountId: string;
  customerId: string;
} {
  const candidate = value.trim().replace(/^customers\//i, "");
  if (!/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(candidate)) {
    throw new WindsorError(
      "invalid_request",
      "Google Ads account id is invalid.",
      400,
    );
  }
  const customerId = candidate.replaceAll("-", "");
  return {
    customerId,
    accountId: `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}`,
  };
}

function normalizeAccount(value: unknown): WindsorGoogleAdsAccount | null {
  const row = asRecord(value);
  if (!row) return null;

  const datasource = optionalText(row.datasource ?? row.ds_id, 80);
  if (datasource && datasource !== WINDSOR_DATASOURCE) return null;
  if (typeof row.account_id !== "string") return null;

  let ids: { accountId: string; customerId: string };
  try {
    ids = normalizeGoogleAdsCustomerId(row.account_id);
  } catch {
    return null;
  }

  return {
    datasource: WINDSOR_DATASOURCE,
    ...ids,
    accountName: optionalText(row.account_name ?? row.name),
    status: optionalText(row.status, 80),
    currency: optionalText(row.account_currency_code ?? row.currency, 12),
    timeZone: optionalText(row.account_time_zone ?? row.time_zone, 100),
  };
}

function mergeAccount(
  current: WindsorGoogleAdsAccount,
  incoming: WindsorGoogleAdsAccount,
): WindsorGoogleAdsAccount {
  return {
    ...current,
    accountName: incoming.accountName ?? current.accountName,
    status: incoming.status ?? current.status,
    currency: incoming.currency ?? current.currency,
    timeZone: incoming.timeZone ?? current.timeZone,
  };
}

function normalizeAccounts(value: unknown, keys: string[]): WindsorGoogleAdsAccount[] {
  const rows = arrayPayload(value, keys)
    .flatMap((value) => {
      const row = asRecord(value);
      return row && Array.isArray(row.accounts) ? row.accounts : [value];
    })
    .filter((value) => asRecord(value)?.is_deactivated !== true);
  const accounts = new Map<string, WindsorGoogleAdsAccount>();
  let googleRows = 0;

  for (const value of rows) {
    const row = asRecord(value);
    const datasource = row ? optionalText(row.datasource ?? row.ds_id, 80) : null;
    if (!datasource || datasource === WINDSOR_DATASOURCE) googleRows += 1;
    const account = normalizeAccount(value);
    if (!account) continue;
    const previous = accounts.get(account.customerId);
    accounts.set(account.customerId, previous ? mergeAccount(previous, account) : account);
  }

  if (rows.length > 0 && googleRows > 0 && accounts.size === 0) {
    throw new WindsorError(
      "invalid_response",
      "Windsor returned Google Ads accounts without valid identifiers.",
      502,
    );
  }

  return [...accounts.values()].sort((left, right) =>
    left.accountId.localeCompare(right.accountId),
  );
}

function isoDayTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

function reportingRange(from: string, to: string): {
  fromTimestamp: number;
  toTimestamp: number;
  days: number;
} {
  const fromTimestamp = isoDayTimestamp(from);
  const toTimestamp = isoDayTimestamp(to);
  if (fromTimestamp === null || toTimestamp === null || fromTimestamp > toTimestamp) {
    throw new WindsorError(
      "invalid_request",
      "Windsor reporting dates are invalid.",
      400,
    );
  }

  const days = Math.floor((toTimestamp - fromTimestamp) / 86_400_000) + 1;
  if (days > MAX_REPORTING_RANGE_DAYS) {
    throw new WindsorError(
      "invalid_request",
      "Windsor reporting range is too large.",
      400,
    );
  }
  return { fromTimestamp, toTimestamp, days };
}

function invalidDailyResponse(): WindsorError {
  return new WindsorError(
    "invalid_response",
    "Windsor returned invalid Google Ads daily metrics.",
    502,
  );
}

function invalidCampaignResponse(): WindsorError {
  return new WindsorError(
    "invalid_response",
    "Windsor returned invalid Google Ads campaigns.",
    502,
  );
}

function invalidDemandGenResponse(): WindsorError {
  return new WindsorError(
    "invalid_response",
    "Windsor returned invalid Google Ads Demand Gen ads.",
    502,
  );
}

function invalidPmaxProductResponse(): WindsorError {
  return new WindsorError(
    "invalid_response",
    "Windsor returned invalid Google Ads PMax products.",
    502,
  );
}

type ReportingIdentity = {
  accountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
};

function exactReportingIdentity(
  raw: Record<string, unknown>,
  expectedCustomerId: string,
  invalid: () => WindsorError,
): ReportingIdentity {
  if (typeof raw.account_id !== "string") throw invalid();
  let reported: { accountId: string; customerId: string };
  try {
    reported = normalizeGoogleAdsCustomerId(raw.account_id);
  } catch {
    throw invalid();
  }
  const currency = typeof raw.account_currency_code === "string"
    ? raw.account_currency_code.trim().toUpperCase()
    : "";
  const timeZone = typeof raw.account_time_zone === "string"
    ? raw.account_time_zone.trim()
    : "";
  if (
    reported.customerId !== expectedCustomerId ||
    !/^[A-Z]{3}$/.test(currency) ||
    !timeZone ||
    timeZone.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(timeZone)
  ) {
    throw invalid();
  }
  return { ...reported, currency, timeZone };
}

function breakdownNumber(
  value: unknown,
  invalid: () => WindsorError,
  integer = false,
): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw invalid();
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isSafeInteger(parsed))) {
    throw invalid();
  }
  return parsed === 0 ? 0 : parsed;
}

function breakdownText(
  value: unknown,
  invalid: () => WindsorError,
  maxLength: number,
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw invalid();
  }
  return text;
}

function optionalBreakdownText(
  value: unknown,
  invalid: () => WindsorError,
  maxLength: number,
): string | null {
  if (value == null || value === "") return null;
  return breakdownText(value, invalid, maxLength);
}

function breakdownIntegerId(
  value: unknown,
  invalid: () => WindsorError,
  maxLength = 30,
): string {
  const text = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : "";
  if (!new RegExp(`^\\d{1,${maxLength}}$`).test(text)) throw invalid();
  return text;
}

function dailyNumber(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw invalidDailyResponse();
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw invalidDailyResponse();
  return number === 0 ? 0 : number;
}

function dailyText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw invalidDailyResponse();
  const text = value.trim();
  if (
    !text ||
    text.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw invalidDailyResponse();
  }
  return text;
}

function sameDailyRow(
  left: WindsorGoogleAdsDailyRow,
  right: WindsorGoogleAdsDailyRow,
): boolean {
  return (
    left.date === right.date &&
    left.customerId === right.customerId &&
    left.currency === right.currency &&
    left.timeZone === right.timeZone &&
    left.spend === right.spend &&
    left.impressions === right.impressions &&
    left.clicks === right.clicks &&
    left.conversions === right.conversions &&
    left.conversionValue === right.conversionValue
  );
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 60_000);
  }

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(at - Date.now(), 60_000));
}

function upstreamError(response: Response): WindsorError {
  const upstreamStatus = response.status;
  if (upstreamStatus === 401) {
    return new WindsorError(
      "authentication_failed",
      "Windsor rejected the server authentication.",
      502,
      upstreamStatus,
    );
  }
  if (upstreamStatus === 403) {
    return new WindsorError(
      "forbidden",
      "The Windsor workspace does not allow this read-only operation.",
      502,
      upstreamStatus,
    );
  }
  if (upstreamStatus === 404) {
    return new WindsorError(
      "not_found",
      "The requested Windsor resource was not found.",
      404,
      upstreamStatus,
    );
  }
  if (upstreamStatus === 429) {
    return new WindsorError(
      "rate_limited",
      "Windsor is rate limiting requests. Try again shortly.",
      429,
      upstreamStatus,
      retryAfterMs(response),
    );
  }
  if (upstreamStatus === 400 || upstreamStatus === 422) {
    return new WindsorError(
      "invalid_request",
      "Windsor rejected the server request.",
      502,
      upstreamStatus,
    );
  }
  return new WindsorError(
    "upstream_unavailable",
    "Windsor is temporarily unavailable.",
    502,
    upstreamStatus,
  );
}

function timedSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", abortFromExternal, { once: true });

  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      external?.removeEventListener("abort", abortFromExternal);
    },
  };
}

async function requestJson(
  url: URL,
  options: WindsorInternalRequestOptions = {},
): Promise<unknown> {
  const apiKey = requireApiKey();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxJsonChars = options.maxJsonChars ?? MAX_JSON_CHARS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new WindsorError("invalid_request", "Windsor request timeout is invalid.", 400);
  }

  url.searchParams.set("api_key", apiKey);
  const timeout = timedSignal(options.signal, timeoutMs);
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      // workerd does not implement `redirect: "error"`. Manual mode keeps
      // authenticated requests on the exact Windsor endpoint; any 3xx is
      // rejected below without following it or forwarding the API key.
      redirect: "manual",
      signal: timeout.signal,
    });
    if (!response.ok) throw upstreamError(response);

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxJsonChars) {
      throw new WindsorError(
        "invalid_response",
        "Windsor returned a response that is too large.",
        502,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new WindsorError(
        "invalid_response",
        "Windsor returned an unreadable response.",
        502,
      );
    }
    if (text.length > maxJsonChars) {
      throw new WindsorError(
        "invalid_response",
        "Windsor returned a response that is too large.",
        502,
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new WindsorError(
        "invalid_response",
        "Windsor returned invalid JSON.",
        502,
      );
    }
  } catch (error) {
    if (error instanceof WindsorError) throw error;
    if (options.signal?.aborted) {
      throw new WindsorError("aborted", "The Windsor request was cancelled.", 499);
    }
    throw new WindsorError(
      "upstream_unavailable",
      "Windsor could not be reached before the request timeout.",
      502,
    );
  } finally {
    timeout.dispose();
  }
}

/**
 * Generates a Windsor co-user link restricted to Google Ads. The API key is
 * attached only to the server-to-server request; the returned URL contains a
 * separate, temporary co-user token.
 */
export async function createGoogleAdsAuthorization(
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsAuthorization> {
  const url = new URL("/api/team/generate-co-user-url/", ONBOARD_ORIGIN);
  url.searchParams.set("allowed_sources", WINDSOR_DATASOURCE);
  const payload = asRecord(
    await requestJson(url, {
      ...options,
      timeoutMs: options.timeoutMs ?? AUTHORIZATION_REQUEST_TIMEOUT_MS,
    }),
  );
  if (!payload || typeof payload.url !== "string") {
    throw new WindsorError(
      "invalid_response",
      "Windsor did not return an authorization link.",
      502,
    );
  }

  let authorizationUrl: URL;
  try {
    authorizationUrl = new URL(payload.url);
  } catch {
    throw new WindsorError(
      "invalid_response",
      "Windsor returned an invalid authorization link.",
      502,
    );
  }

  const accessToken = authorizationUrl.searchParams.get("access_token") ?? "";
  if (
    authorizationUrl.origin !== ONBOARD_ORIGIN ||
    authorizationUrl.username ||
    authorizationUrl.password ||
    authorizationUrl.searchParams.get("allowed_sources") !== WINDSOR_DATASOURCE ||
    authorizationUrl.searchParams.has("api_key")
  ) {
    throw new WindsorError(
      "invalid_response",
      "Windsor returned an unsafe authorization link.",
      502,
    );
  }

  return {
    authorizationUrl: authorizationUrl.toString(),
    accessToken: requireSecret(accessToken, "Windsor access token"),
  };
}

/** List only the accounts completed through one V2 co-user link. */
export async function listLinkedGoogleAdsAccounts(
  accessToken: string,
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsAccount[]> {
  const url = new URL("/api/team/co-user-linked-accounts/", ONBOARD_ORIGIN);
  url.searchParams.set("ds_id", WINDSOR_DATASOURCE);
  url.searchParams.set("access_token", requireSecret(accessToken, "Windsor access token"));
  return normalizeAccounts(await requestJson(url, options), ["data", "accounts", "results"]);
}

/** Read-only workspace inventory used by health checks and admin diagnostics. */
export async function listConnectedGoogleAdsAccounts(
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsAccount[]> {
  const url = new URL("/api/common/ds-accounts", ONBOARD_ORIGIN);
  url.searchParams.set("datasource", WINDSOR_DATASOURCE);
  return normalizeAccounts(await requestJson(url, options), ["data", "accounts", "results"]);
}

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > max) {
    throw new WindsorError("invalid_request", "Windsor polling options are invalid.", 400);
  }
  return selected;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 0 || selected > max) {
    throw new WindsorError("invalid_request", "Windsor polling options are invalid.", 400);
  }
  return selected;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new WindsorError("aborted", "The Windsor poll was cancelled.", 499);
  }
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new WindsorError("aborted", "The Windsor poll was cancelled.", 499));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (!signal) return;
    void Promise.resolve().then(() => {
      if (!signal.aborted) return;
      abort();
    });
  });
}

/**
 * Bounded server-side polling. It checks immediately, backs off between empty
 * results, respects a short Retry-After, and always stops after maxAttempts.
 */
export async function pollLinkedGoogleAdsAccounts(
  options: WindsorPollOptions,
): Promise<WindsorPollResult> {
  const accessToken = requireSecret(options.accessToken, "Windsor access token");
  const maxAttempts = positiveInteger(options.maxAttempts, 4, 8);
  const initialDelayMs = nonNegativeInteger(options.initialDelayMs, 750, 10_000);
  const maxDelayMs = nonNegativeInteger(options.maxDelayMs, 4_000, 15_000);
  if (maxDelayMs < initialDelayMs) {
    throw new WindsorError("invalid_request", "Windsor polling options are invalid.", 400);
  }

  const sleep = options.sleep ?? defaultSleep;
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new WindsorError("aborted", "The Windsor poll was cancelled.", 499);
    }

    try {
      const accounts = await listLinkedGoogleAdsAccounts(accessToken, options);
      if (accounts.length > 0) {
        return { status: "connected", accounts, attempts: attempt };
      }
    } catch (error) {
      if (!(error instanceof WindsorError) || error.code !== "rate_limited") throw error;
      if (attempt === maxAttempts) throw error;
      delay = Math.min(Math.max(delay, error.retryAfterMs ?? 0), maxDelayMs);
    }

    if (attempt < maxAttempts) {
      await sleep(delay, options.signal);
      delay = Math.min(Math.max(delay * 2, 1), maxDelayMs);
    }
  }

  return { status: "pending", accounts: [], attempts: maxAttempts };
}

/** Read-only discovery; this module intentionally contains no action executor. */
export async function probeGoogleAdsCapabilities(
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsCapabilities> {
  const url = new URL(`/${WINDSOR_DATASOURCE}/actions`, CONNECTORS_ORIGIN);
  const rows = arrayPayload(await requestJson(url, options), ["actions", "data", "results"]);
  const actionIds = [
    ...new Set(
      rows.flatMap((value) => {
        const row = asRecord(value);
        const id = row ? optionalText(row.id, 120) : null;
        return id && /^[a-z0-9_]+$/.test(id) ? [id] : [];
      }),
    ),
  ].sort();

  return {
    datasource: WINDSOR_DATASOURCE,
    actionIds,
    canCreateCampaign: actionIds.includes("create_campaign"),
    canPauseCampaign: actionIds.includes("pause_campaign"),
    canEnableCampaign: actionIds.includes("enable_campaign"),
  };
}

/**
 * Reads daily metrics for one exact Google Ads account and inclusive date
 * range. The caller remains responsible for comparing the returned currency
 * and time zone with its own reporting identity.
 */
export async function fetchGoogleAdsDailyBreakdown(
  accountId: string,
  from: string,
  to: string,
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsDailyRow[]> {
  if (from === to) {
    const hourly = await fetchGoogleAdsCampaignTimeline(accountId, from, to, options);
    const first = hourly[0];
    if (!first) return [];
    if (
      hourly.some(
        (row) =>
          row.date !== from ||
          row.accountId !== first.accountId ||
          row.customerId !== first.customerId ||
          row.currency !== first.currency ||
          row.timeZone !== first.timeZone,
      )
    ) {
      throw invalidDailyResponse();
    }
    return [{
      date: from,
      accountId: first.accountId,
      customerId: first.customerId,
      currency: first.currency,
      timeZone: first.timeZone,
      spend: hourly.reduce((sum, row) => sum + row.spend, 0),
      impressions: hourly.reduce((sum, row) => sum + row.impressions, 0),
      clicks: hourly.reduce((sum, row) => sum + row.clicks, 0),
      conversions: hourly.reduce((sum, row) => sum + row.conversions, 0),
      conversionValue: hourly.reduce((sum, row) => sum + row.conversionValue, 0),
    }];
  }
  const ids = normalizeGoogleAdsCustomerId(accountId);
  const range = reportingRange(from, to);
  const maxRows = range.days + 1;
  const url = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  url.searchParams.set(
    "fields",
    "date,account_id,account_currency_code,account_time_zone,spend," +
      "impressions,clicks,conversions,conversion_value",
  );
  url.searchParams.set("date_from", from);
  url.searchParams.set("date_to", to);
  url.searchParams.set("filter", JSON.stringify([["account_id", "eq", ids.accountId]]));
  url.searchParams.set("_max_rows", String(maxRows));
  url.searchParams.set("_renderer", "json");

  const rawRows = arrayPayload(
    await requestJson(url, options),
    ["data", "results", "rows"],
  );
  if (rawRows.length >= maxRows) throw invalidDailyResponse();

  const byDay = new Map<string, WindsorGoogleAdsDailyRow>();
  let currency: string | null = null;
  let timeZone: string | null = null;

  for (const value of rawRows) {
    const raw = asRecord(value);
    if (!raw || typeof raw.account_id !== "string") throw invalidDailyResponse();

    let reportedIds: { accountId: string; customerId: string };
    try {
      reportedIds = normalizeGoogleAdsCustomerId(raw.account_id);
    } catch {
      throw invalidDailyResponse();
    }
    if (reportedIds.customerId !== ids.customerId) throw invalidDailyResponse();

    const date = typeof raw.date === "string" ? raw.date.trim() : "";
    const timestamp = isoDayTimestamp(date);
    if (
      timestamp === null ||
      timestamp < range.fromTimestamp ||
      timestamp > range.toTimestamp
    ) {
      throw invalidDailyResponse();
    }

    const rowCurrency = dailyText(raw.account_currency_code, 12).toUpperCase();
    if (!/^[A-Z]{3}$/.test(rowCurrency)) throw invalidDailyResponse();
    const rowTimeZone = dailyText(raw.account_time_zone, 100);
    if (
      (currency !== null && rowCurrency !== currency) ||
      (timeZone !== null && rowTimeZone !== timeZone)
    ) {
      throw invalidDailyResponse();
    }
    currency = rowCurrency;
    timeZone = rowTimeZone;

    const row: WindsorGoogleAdsDailyRow = {
      date,
      ...reportedIds,
      currency: rowCurrency,
      timeZone: rowTimeZone,
      spend: dailyNumber(raw.spend),
      impressions: dailyNumber(raw.impressions),
      clicks: dailyNumber(raw.clicks),
      conversions: dailyNumber(raw.conversions),
      conversionValue: dailyNumber(raw.conversion_value),
    };
    const previous = byDay.get(date);
    if (previous && !sameDailyRow(previous, row)) throw invalidDailyResponse();
    byDay.set(date, previous ?? row);
  }

  return [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Reads one aggregated row per campaign for an exact account and date range.
 * Omitting the date dimension keeps this bounded even for year-long ranges.
 */
export async function fetchGoogleAdsCampaignBreakdown(
  accountId: string,
  from: string,
  to: string,
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsCampaignRow[]> {
  const ids = normalizeGoogleAdsCustomerId(accountId);
  reportingRange(from, to);
  const maxRows = 1_001;
  const url = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  url.searchParams.set(
    "fields",
    "account_id,account_currency_code,account_time_zone,campaign_id,campaign," +
      "campaign_status,advertising_channel_type,campaign_shopping_setting_merchant_id," +
      "campaign_budget,bidding_strategy_type," +
      "start_date,spend,impressions,clicks,conversions,conversion_value",
  );
  url.searchParams.set("date_from", from);
  url.searchParams.set("date_to", to);
  url.searchParams.set("filter", JSON.stringify([["account_id", "eq", ids.accountId]]));
  url.searchParams.set("_max_rows", String(maxRows));
  url.searchParams.set("_renderer", "json");

  // `final_url` is an ad-level dimension and Windsor rejects it when mixed
  // with the campaign metrics above, so read the exact campaign/url pairs in
  // one separate bounded request for the same account and reporting range.
  const finalUrlRequest = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  finalUrlRequest.searchParams.set("fields", "account_id,campaign_id,final_url");
  finalUrlRequest.searchParams.set("date_from", from);
  finalUrlRequest.searchParams.set("date_to", to);
  finalUrlRequest.searchParams.set(
    "filter",
    JSON.stringify([["account_id", "eq", ids.accountId]]),
  );
  finalUrlRequest.searchParams.set("_max_rows", String(maxRows));
  finalUrlRequest.searchParams.set("_renderer", "json");

  const [campaignPayload, finalUrlPayload] = await Promise.all([
    requestJson(url, options),
    requestJson(finalUrlRequest, options),
  ]);
  const rawRows = arrayPayload(campaignPayload, ["data", "results", "rows"]);
  const rawFinalUrlRows = arrayPayload(finalUrlPayload, ["data", "results", "rows"]);
  // Asking for one sentinel row lets a silently truncated response fail closed.
  if (rawRows.length >= maxRows || rawFinalUrlRows.length >= maxRows) {
    throw invalidCampaignResponse();
  }

  const finalUrlsByCampaign = new Map<string, Set<string>>();
  for (const value of rawFinalUrlRows) {
    const raw = asRecord(value);
    if (!raw || typeof raw.account_id !== "string") throw invalidCampaignResponse();
    let reportedIds: { accountId: string; customerId: string };
    try {
      reportedIds = normalizeGoogleAdsCustomerId(raw.account_id);
    } catch {
      throw invalidCampaignResponse();
    }
    const campaignId = typeof raw.campaign_id === "string"
      ? raw.campaign_id.trim()
      : "";
    if (reportedIds.customerId !== ids.customerId || !/^\d{1,30}$/.test(campaignId)) {
      throw invalidCampaignResponse();
    }
    if (raw.final_url == null || raw.final_url === "") continue;
    // An unusable final URL (unparseable, non-https, credentialed, oversized)
    // only loses that ad's attribution: the ad is treated as having no URL
    // instead of failing the whole account read. Structural malformations of
    // the row itself (shape, account, campaign id) still fail closed above.
    const text = typeof raw.final_url === "string" ? raw.final_url.trim() : "";
    if (!text || text.length > 4_096) continue;
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      continue;
    }
    const urls = finalUrlsByCampaign.get(campaignId) ?? new Set<string>();
    urls.add(parsed.toString());
    finalUrlsByCampaign.set(campaignId, urls);
  }

  const campaigns = new Map<string, WindsorGoogleAdsCampaignRow>();
  for (const value of rawRows) {
    const raw = asRecord(value);
    if (!raw || typeof raw.account_id !== "string") throw invalidCampaignResponse();

    let reportedIds: { accountId: string; customerId: string };
    try {
      reportedIds = normalizeGoogleAdsCustomerId(raw.account_id);
    } catch {
      throw invalidCampaignResponse();
    }
    if (reportedIds.customerId !== ids.customerId) throw invalidCampaignResponse();

    const currency = typeof raw.account_currency_code === "string"
      ? raw.account_currency_code.trim().toUpperCase()
      : "";
    const timeZone = typeof raw.account_time_zone === "string"
      ? raw.account_time_zone.trim()
      : "";
    const campaignId = typeof raw.campaign_id === "string"
      ? raw.campaign_id.trim()
      : "";
    const name = typeof raw.campaign === "string" ? raw.campaign.trim() : "";
    const status = typeof raw.campaign_status === "string"
      ? raw.campaign_status.trim().toUpperCase()
      : "";
    const advertisingChannelType = typeof raw.advertising_channel_type === "string"
      ? raw.advertising_channel_type.trim().toUpperCase()
      : "";
    let shoppingFeed = false;
    if (raw.campaign_shopping_setting_merchant_id != null) {
      const merchantId =
        typeof raw.campaign_shopping_setting_merchant_id === "string"
          ? raw.campaign_shopping_setting_merchant_id.trim()
          : typeof raw.campaign_shopping_setting_merchant_id === "number" &&
              Number.isSafeInteger(raw.campaign_shopping_setting_merchant_id)
            ? String(raw.campaign_shopping_setting_merchant_id)
            : null;
      if (merchantId === null || (merchantId !== "" && !/^\d{1,30}$/.test(merchantId))) {
        throw invalidCampaignResponse();
      }
      shoppingFeed = merchantId !== "" && !/^0+$/.test(merchantId);
    }
    const biddingStrategyType = raw.bidding_strategy_type == null
      ? null
      : typeof raw.bidding_strategy_type === "string"
        ? raw.bidding_strategy_type.trim().toUpperCase()
        : "";
    const startDate = raw.start_date == null
      ? null
      : typeof raw.start_date === "string"
        ? raw.start_date.trim()
        : "";
    const dailyBudget = raw.campaign_budget == null ? null : Number(raw.campaign_budget);

    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !timeZone ||
      !/^\d{1,30}$/.test(campaignId) ||
      !name ||
      name.length > 500 ||
      !["ENABLED", "PAUSED", "REMOVED"].includes(status) ||
      !/^[A-Z][A-Z0-9_]{1,79}$/.test(advertisingChannelType) ||
      (biddingStrategyType !== null && !/^[A-Z][A-Z0-9_]{1,119}$/.test(biddingStrategyType)) ||
      (startDate !== null && isoDayTimestamp(startDate) === null) ||
      (dailyBudget !== null && (!Number.isFinite(dailyBudget) || dailyBudget < 0))
    ) {
      throw invalidCampaignResponse();
    }

    const number = (candidate: unknown) => {
      if (
        (typeof candidate !== "number" && typeof candidate !== "string") ||
        (typeof candidate === "string" && candidate.trim() === "")
      ) {
        throw invalidCampaignResponse();
      }
      const parsed = Number(candidate);
      if (!Number.isFinite(parsed) || parsed < 0) throw invalidCampaignResponse();
      return parsed === 0 ? 0 : parsed;
    };
    const row: WindsorGoogleAdsCampaignRow = {
      ...reportedIds,
      currency,
      timeZone,
      campaignId,
      name,
      status: status as WindsorGoogleAdsCampaignRow["status"],
      advertisingChannelType,
      shoppingFeed,
      biddingStrategyType,
      startDate,
      dailyBudget,
      spend: number(raw.spend),
      impressions: number(raw.impressions),
      clicks: number(raw.clicks),
      conversions: number(raw.conversions),
      conversionValue: number(raw.conversion_value),
      finalUrls: [...(finalUrlsByCampaign.get(campaignId) ?? [])].sort(),
    };
    if (campaigns.has(campaignId)) throw invalidCampaignResponse();
    campaigns.set(campaignId, row);
  }

  return [...campaigns.values()].sort(
    (left, right) => right.spend - left.spend || left.campaignId.localeCompare(right.campaignId),
  );
}

/** Campaign facts in one bounded Windsor read; hourly for one day, daily otherwise. */
export async function fetchGoogleAdsCampaignTimeline(
  accountId: string,
  from: string,
  to: string,
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsCampaignTimelineRow[]> {
  const ids = normalizeGoogleAdsCustomerId(accountId);
  const range = reportingRange(from, to);
  const hourly = from === to;
  const maxRows = Math.min(range.days * (hourly ? 24_000 : 1_000) + 1, 25_001);
  const url = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  url.searchParams.set(
    "fields",
    `date,${hourly ? "hour_of_day," : ""}` +
      "account_id,account_currency_code,account_time_zone,campaign_id," +
      "spend,impressions,clicks,conversions,conversion_value",
  );
  url.searchParams.set("date_from", from);
  url.searchParams.set("date_to", to);
  url.searchParams.set("filter", JSON.stringify([["account_id", "eq", ids.accountId]]));
  url.searchParams.set("_max_rows", String(maxRows));
  url.searchParams.set("_renderer", "json");

  const rawRows = arrayPayload(
    await requestJson(url, options),
    ["data", "results", "rows"],
  );
  if (rawRows.length >= maxRows) throw invalidCampaignResponse();

  const rows = new Map<string, WindsorGoogleAdsCampaignTimelineRow>();
  for (const value of rawRows) {
    const raw = asRecord(value);
    if (!raw) throw invalidCampaignResponse();
    const identity = exactReportingIdentity(raw, ids.customerId, invalidCampaignResponse);
    const date = typeof raw.date === "string" ? raw.date.trim() : "";
    const timestamp = isoDayTimestamp(date);
    if (
      timestamp === null ||
      timestamp < range.fromTimestamp ||
      timestamp > range.toTimestamp
    ) {
      throw invalidCampaignResponse();
    }
    const campaignId = breakdownIntegerId(raw.campaign_id, invalidCampaignResponse);
    let bucket = date;
    if (hourly) {
      const hour = breakdownNumber(raw.hour_of_day, invalidCampaignResponse, true);
      if (hour > 23) throw invalidCampaignResponse();
      bucket = `${date}T${String(hour).padStart(2, "0")}:00:00`;
    }
    const key = `${campaignId}\u0000${bucket}`;
    if (rows.has(key)) throw invalidCampaignResponse();
    rows.set(key, {
      date,
      bucket,
      granularity: hourly ? "hour" : "day",
      ...identity,
      campaignId,
      spend: breakdownNumber(raw.spend, invalidCampaignResponse),
      impressions: breakdownNumber(raw.impressions, invalidCampaignResponse, true),
      clicks: breakdownNumber(raw.clicks, invalidCampaignResponse, true),
      conversions: breakdownNumber(raw.conversions, invalidCampaignResponse),
      conversionValue: breakdownNumber(raw.conversion_value, invalidCampaignResponse),
    });
  }
  return [...rows.values()].sort(
    (left, right) =>
      left.bucket.localeCompare(right.bucket) || left.campaignId.localeCompare(right.campaignId),
  );
}

/**
 * Reads one aggregate row per Demand Gen asset. Windsor exposes the asset-view
 * metrics and asset metadata separately, joined here only by Google's asset id.
 */
export async function fetchGoogleAdsDemandGenAdBreakdown(
  accountId: string,
  from: string,
  to: string,
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsDemandGenAdRow[]> {
  const ids = normalizeGoogleAdsCustomerId(accountId);
  reportingRange(from, to);
  const maxRows = 10_001;
  const metricsUrl = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  metricsUrl.searchParams.set(
    "fields",
    "account_id,account_currency_code,account_time_zone,campaign_id," +
      "advertising_channel_type,asset_id,ad_group_ad_asset_view_field_type," +
      "spend,impressions,clicks,conversions,conversion_value",
  );
  metricsUrl.searchParams.set("date_from", from);
  metricsUrl.searchParams.set("date_to", to);
  metricsUrl.searchParams.set(
    "filter",
    JSON.stringify([
      ["account_id", "eq", ids.accountId],
      "and",
      ["advertising_channel_type", "eq", "DEMAND_GEN"],
    ]),
  );
  metricsUrl.searchParams.set("_max_rows", String(maxRows));
  metricsUrl.searchParams.set("_renderer", "json");

  const rawRows = arrayPayload(
    await requestJson(metricsUrl, { ...options, maxJsonChars: MAX_PRODUCT_JSON_CHARS }),
    ["data", "results", "rows"],
  );
  if (rawRows.length >= maxRows) throw invalidDemandGenResponse();

  const rows = new Map<string, WindsorGoogleAdsDemandGenAdRow>();
  for (const value of rawRows) {
    const raw = asRecord(value);
    if (!raw) throw invalidDemandGenResponse();
    const invalid = invalidDemandGenResponse;
    const identity = exactReportingIdentity(raw, ids.customerId, invalid);
    const campaignId = breakdownIntegerId(raw.campaign_id, invalid);
    const adId = breakdownIntegerId(raw.asset_id, invalid);
    const channel = breakdownText(raw.advertising_channel_type, invalid, 80).toUpperCase();
    const type = breakdownText(raw.ad_group_ad_asset_view_field_type, invalid, 100)
      .toUpperCase();
    if (channel !== "DEMAND_GEN") throw invalid();
    if (!["SQUARE_MARKETING_IMAGE", "MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "VIDEO"]
      .includes(type)) continue;
    const metrics = {
      spend: breakdownNumber(raw.spend, invalid),
      impressions: breakdownNumber(raw.impressions, invalid, true),
      clicks: breakdownNumber(raw.clicks, invalid, true),
      conversions: breakdownNumber(raw.conversions, invalid),
      conversionValue: breakdownNumber(raw.conversion_value, invalid),
    };
    const key = `${campaignId}\u0000${adId}`;
    const current = rows.get(key);
    if (current) {
      if (
        current.accountId !== identity.accountId ||
        current.customerId !== identity.customerId ||
        current.currency !== identity.currency ||
        current.timeZone !== identity.timeZone
      ) throw invalid();
      current.spend += metrics.spend;
      current.impressions += metrics.impressions;
      current.clicks += metrics.clicks;
      current.conversions += metrics.conversions;
      current.conversionValue += metrics.conversionValue;
      if (!current.type.split(" · ").includes(type)) current.type += ` · ${type}`;
      continue;
    }
    const row: WindsorGoogleAdsDemandGenAdRow = {
      ...identity,
      campaignId,
      adId,
      name: null,
      type,
      thumbnailUrl: null,
      assetKind: null,
      ...metrics,
    };
    rows.set(key, row);
  }
  if (rows.size === 0) return [];

  const metadataUrl = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  metadataUrl.searchParams.set(
    "fields",
    "account_id,account_currency_code,account_time_zone,asset_id,asset_name," +
      "asset_type,asset_image_asset_full_size_url," +
      "asset_youtube_video_asset_youtube_video_title",
  );
  metadataUrl.searchParams.set("date_from", from);
  metadataUrl.searchParams.set("date_to", to);
  metadataUrl.searchParams.set(
    "filter",
    JSON.stringify([["account_id", "eq", ids.accountId]]),
  );
  metadataUrl.searchParams.set("_max_rows", String(maxRows));
  metadataUrl.searchParams.set("_renderer", "json");
  const rawMetadata = arrayPayload(
    await requestJson(metadataUrl, { ...options, maxJsonChars: MAX_PRODUCT_JSON_CHARS }),
    ["data", "results", "rows"],
  );
  if (rawMetadata.length >= maxRows) throw invalidDemandGenResponse();
  const byAsset = new Map<string, {
    name: string | null;
    thumbnailUrl: string | null;
    assetKind: "image" | "video";
  }>();
  for (const value of rawMetadata) {
    const raw = asRecord(value);
    if (!raw) throw invalidDemandGenResponse();
    const invalid = invalidDemandGenResponse;
    const identity = exactReportingIdentity(raw, ids.customerId, invalid);
    const assetId = breakdownIntegerId(raw.asset_id, invalid);
    const relevant = [...rows.values()].find((row) => row.adId === assetId);
    if (!relevant) continue;
    if (
      relevant.accountId !== identity.accountId ||
      relevant.currency !== identity.currency ||
      relevant.timeZone !== identity.timeZone ||
      byAsset.has(assetId)
    ) throw invalid();
    const assetType = breakdownText(raw.asset_type, invalid, 40).toUpperCase();
    if (assetType !== "IMAGE" && assetType !== "YOUTUBE_VIDEO") continue;
    const rawUrl = optionalBreakdownText(
      raw.asset_image_asset_full_size_url,
      invalid,
      4_096,
    );
    let thumbnailUrl: string | null = null;
    if (rawUrl) {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw invalid();
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw invalid();
      thumbnailUrl = parsed.toString();
    }
    byAsset.set(assetId, {
      name: optionalBreakdownText(
        assetType === "YOUTUBE_VIDEO"
          ? raw.asset_youtube_video_asset_youtube_video_title ?? raw.asset_name
          : raw.asset_name,
        invalid,
        500,
      ),
      thumbnailUrl: assetType === "IMAGE" ? thumbnailUrl : null,
      assetKind: assetType === "IMAGE" ? "image" : "video",
    });
  }
  for (const row of rows.values()) {
    const meta = byAsset.get(row.adId);
    if (!meta) continue;
    row.name = meta.name;
    row.thumbnailUrl = meta.thumbnailUrl;
    row.assetKind = meta.assetKind;
  }
  return [...rows.values()].sort(
    (left, right) =>
      right.spend - left.spend ||
      left.campaignId.localeCompare(right.campaignId) ||
      left.adId.localeCompare(right.adId),
  );
}

/** Exact PMax shopping-product performance, retaining every Merchant key dimension. */
export async function fetchGoogleAdsPmaxProductBreakdown(
  accountId: string,
  from: string,
  to: string,
  options: WindsorRequestOptions = {},
): Promise<WindsorGoogleAdsPmaxProductRow[]> {
  const ids = normalizeGoogleAdsCustomerId(accountId);
  reportingRange(from, to);
  const maxRows = 10_001;
  const url = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  url.searchParams.set(
    "fields",
    "account_id,account_currency_code,account_time_zone,campaign_id," +
      "advertising_channel_type,product_merchant_id,product_feed_label," +
      "product_language,product_country,product_channel,product_item_id," +
      "product_title,product_brand,spend,impressions,clicks,conversions," +
      "conversion_value",
  );
  url.searchParams.set("date_from", from);
  url.searchParams.set("date_to", to);
  url.searchParams.set(
    "filter",
    JSON.stringify([
      ["account_id", "eq", ids.accountId],
      "and",
      ["advertising_channel_type", "eq", "PERFORMANCE_MAX"],
      "and",
      ["spend", "gt", 0],
    ]),
  );
  url.searchParams.set("_max_rows", String(maxRows));
  url.searchParams.set("_renderer", "json");

  const rawRows = arrayPayload(
    await requestJson(url, { ...options, maxJsonChars: MAX_PRODUCT_JSON_CHARS }),
    ["data", "results", "rows"],
  );
  if (rawRows.length >= maxRows) throw invalidPmaxProductResponse();

  const rows = new Map<string, WindsorGoogleAdsPmaxProductRow>();
  for (const value of rawRows) {
    const raw = asRecord(value);
    if (!raw) throw invalidPmaxProductResponse();
    const invalid = invalidPmaxProductResponse;
    const identity = exactReportingIdentity(raw, ids.customerId, invalid);
    const campaignId = breakdownIntegerId(raw.campaign_id, invalid);
    if (
      breakdownText(raw.advertising_channel_type, invalid, 80).toUpperCase() !==
      "PERFORMANCE_MAX"
    ) {
      throw invalid();
    }
    const merchantId = breakdownIntegerId(raw.product_merchant_id, invalid);
    const feedLabel = breakdownText(raw.product_feed_label, invalid, 100);
    const language = breakdownText(raw.product_language, invalid, 120);
    const country = breakdownText(raw.product_country, invalid, 120);
    const channel = breakdownText(raw.product_channel, invalid, 40).toUpperCase();
    const itemId = breakdownText(raw.product_item_id, invalid, 500);
    const title = breakdownText(raw.product_title, invalid, 1_000);
    const brand = optionalBreakdownText(raw.product_brand, invalid, 500);
    const key = [
      campaignId,
      merchantId,
      feedLabel,
      language,
      country,
      channel,
      itemId,
    ].join("\u0000");
    if (rows.has(key)) throw invalid();
    const spend = breakdownNumber(raw.spend, invalid);
    if (spend <= 0) throw invalid();
    rows.set(key, {
      ...identity,
      campaignId,
      merchantId,
      feedLabel,
      language,
      country,
      channel,
      itemId,
      title,
      brand,
      spend,
      impressions: breakdownNumber(raw.impressions, invalid, true),
      clicks: breakdownNumber(raw.clicks, invalid, true),
      conversions: breakdownNumber(raw.conversions, invalid),
      conversionValue: breakdownNumber(raw.conversion_value, invalid),
    });
  }
  return [...rows.values()].sort(
    (left, right) =>
      right.spend - left.spend ||
      left.campaignId.localeCompare(right.campaignId) ||
      left.itemId.localeCompare(right.itemId),
  );
}

/**
 * Proves that an exact connected account is visible and performs the smallest
 * useful reporting read. No forced refresh parameters and no write actions.
 */
export async function checkGoogleAdsAccountHealth(
  accountId: string,
  options: WindsorRequestOptions & { now?: () => Date } = {},
): Promise<WindsorGoogleAdsHealth> {
  const ids = normalizeGoogleAdsCustomerId(accountId);
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const url = new URL(`/${WINDSOR_DATASOURCE}`, CONNECTORS_ORIGIN);
  url.searchParams.set(
    "fields",
    "account_id,account_name,account_currency_code,account_time_zone,datasource",
  );
  url.searchParams.set("date_preset", "last_30dT");
  url.searchParams.set("filter", JSON.stringify([["account_id", "eq", ids.accountId]]));
  url.searchParams.set("_max_rows", "1");
  url.searchParams.set("_renderer", "json");

  const rows = normalizeAccounts(await requestJson(url, options), ["data", "results", "rows"]);
  const reported = rows.find((account) => account.customerId === ids.customerId) ?? null;
  if (rows.length > 0 && !reported) {
    throw new WindsorError(
      "invalid_response",
      "Windsor returned data for a different Google Ads account.",
      502,
    );
  }

  // The workspace inventory endpoint currently returns an empty list for both
  // "not connected" and some unauthenticated requests. Querying the connector
  // first proves server authentication, so a bad API key can never be
  // mislabeled as a client who needs to reconnect.
  const connected = (await listConnectedGoogleAdsAccounts(options)).find(
    (account) => account.customerId === ids.customerId,
  );
  if (!connected && !reported) {
    return {
      ok: false,
      code: "not_connected",
      account: null,
      recentDataAvailable: false,
      checkedAt,
    };
  }

  const account =
    connected && reported
      ? mergeAccount(connected, reported)
      : (connected ?? reported);
  if (!account) {
    throw new WindsorError(
      "invalid_response",
      "Windsor did not return the requested Google Ads account.",
      502,
    );
  }

  return {
    ok: true,
    code: "healthy",
    account,
    recentDataAvailable: Boolean(reported),
    checkedAt,
  };
}
