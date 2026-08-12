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
const MAX_JSON_CHARS = 1_000_000;
const MAX_SECRET_CHARS = 4_096;

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
  const rows = arrayPayload(value, keys);
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
  options: WindsorRequestOptions = {},
): Promise<unknown> {
  const apiKey = requireApiKey();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
      redirect: "error",
      signal: timeout.signal,
    });
    if (!response.ok) throw upstreamError(response);

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_CHARS) {
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
    if (text.length > MAX_JSON_CHARS) {
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
  const payload = asRecord(await requestJson(url, options));
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
