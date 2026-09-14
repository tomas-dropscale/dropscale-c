import "server-only";

import {
  checkReportingShopifyScopes,
  type ReportingScopeCheck,
} from "./shopify-scopes";

export const REPORTING_SHOPIFY_API_VERSION = "2026-07" as const;

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Shopify meters the Admin GraphQL API per store. At the top of every hour
 * about fifteen stores refresh at once and each one issues several reads in
 * parallel, so a throttle is routine rather than exceptional, and without a
 * pause every throttle blanked a whole sheet. Two short waits clear almost
 * all of them; anything slower is the caller's decision, not this module's.
 */
const THROTTLE_RETRY_DELAYS_MS = [1_000, 2_500] as const;
/** A Retry-After hint above this would hold a request slot for too long. */
const MAX_RETRY_AFTER_MS = 5_000;
/** Enough of a GraphQL error to explain a blank sheet in a log or snapshot. */
const GRAPHQL_ERROR_MESSAGE_MAX_CHARS = 200;
const GRAPHQL_DENIED_MESSAGE =
  "Shopify did not allow this read-only reporting check.";

export type ShopifyReportingErrorCode =
  | "invalid_domain"
  | "invalid_credentials"
  | "shopify_unavailable"
  | "shopify_rate_limited"
  | "unsupported_api_version"
  | "invalid_shop_response"
  | "domain_mismatch"
  | "insufficient_scopes";

export class ShopifyReportingError extends Error {
  constructor(
    public readonly code: ShopifyReportingErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ShopifyReportingError";
  }
}

/**
 * A throttle is the one failure the read itself may retry, and the HTTP form
 * of it can carry a Retry-After hint. Keeping the hint on a private subclass
 * lets the retry loop honour it without widening the public error shape that
 * callers already match on by code.
 */
class ShopifyThrottledError extends ShopifyReportingError {
  constructor(public readonly retryAfterMs: number | null = null) {
    super(
      "shopify_rate_limited",
      "Shopify is rate limiting this store. Wait a moment and try again.",
      true,
    );
  }
}

/** Only the wait between throttled attempts; tests replace it to run instantly. */
export type ReportingGraphqlRetryOptions = {
  sleep?: (ms: number) => Promise<void>;
};

export type VerifiedReportingShop = {
  shopId: string;
  name: string;
  myshopifyDomain: string;
  primaryDomain: string | null;
  currencyCode: string;
  /** Optional for backwards-compatible test fixtures; fresh verification always returns it. */
  ianaTimezone?: string;
  scopes: ReportingScopeCheck;
};

export type ReportingHealthCapability =
  | "orders"
  | "reports"
  | "products"
  | "inventory"
  | "locations"
  | "payouts";

export type ReportingCapabilityResult = {
  capability: ReportingHealthCapability;
  status: "ok" | "not_applicable" | "missing_scope" | "failed";
  code: string | null;
};

export type ReportingShopHealth = {
  ok: boolean;
  limited: boolean;
  testedAt: string;
  capabilities: ReportingCapabilityResult[];
};

type TokenResponse = {
  access_token?: unknown;
};

type GraphqlError = {
  message?: unknown;
  extensions?: { code?: unknown };
};

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: GraphqlError[];
};

type VerifyResponse = {
  shop?: {
    id?: unknown;
    name?: unknown;
    myshopifyDomain?: unknown;
    currencyCode?: unknown;
    ianaTimezone?: unknown;
    primaryDomain?: { host?: unknown } | null;
  };
  currentAppInstallation?: {
    accessScopes?: { handle?: unknown }[];
  } | null;
};

const VERIFY_QUERY = `#graphql
  query VerifyDropscaleReportingConnection {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
      primaryDomain { host }
    }
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

const ORDERS_PROBE = `#graphql
  query TestDropscaleOrderReporting {
    orders(first: 1, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        sourceName
        registeredSourceUrl
        shippingAddress {
          city
          provinceCode
          countryCodeV2
        }
        customerJourneySummary {
          firstVisit {
            landingPage
            source
            referrerUrl
            utmParameters { source medium campaign }
          }
        }
        returns(first: 1) {
          nodes { id status }
        }
      }
    }
  }
`;

const REPORTS_PROBE = `#graphql
  query TestDropscaleShopifyReports($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData { rows }
      parseErrors
    }
  }
`;

const PRODUCTS_PROBE = `#graphql
  query TestDropscaleProductReporting {
    products(first: 1) { nodes { id } }
  }
`;

const INVENTORY_PROBE = `#graphql
  query TestDropscaleInventoryReporting {
    inventoryItems(first: 1) { nodes { id } }
  }
`;

const LOCATIONS_PROBE = `#graphql
  query TestDropscaleLocationReporting {
    locations(first: 1) { nodes { id } }
  }
`;

const PAYOUTS_PROBE = `#graphql
  query TestDropscalePayoutReporting {
    shopifyPaymentsAccount {
      activated
      payouts(first: 1, reverse: true) {
        nodes {
          issuedAt
          status
          net { amount currencyCode }
        }
      }
    }
  }
`;

/**
 * Accept the canonical host, or an HTTPS URL resolving to that exact host.
 * This is the sole value interpolated into Shopify URLs, so it closes the SSRF
 * boundary before any request can be sent.
 */
export function normalizeReportingShopDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255) {
    throw new ShopifyReportingError(
      "invalid_domain",
      "Enter a valid .myshopify.com domain.",
    );
  }

  let host = trimmed;
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new ShopifyReportingError(
        "invalid_domain",
        "Enter a valid .myshopify.com domain.",
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash
    ) {
      throw new ShopifyReportingError(
        "invalid_domain",
        "Enter a valid .myshopify.com domain.",
      );
    }
    host = parsed.hostname.toLowerCase();
  } else if (
    trimmed.includes("/") ||
    trimmed.includes("@") ||
    trimmed.includes(":")
  ) {
    throw new ShopifyReportingError(
      "invalid_domain",
      "Enter only the .myshopify.com domain.",
    );
  }

  if (!SHOP_DOMAIN.test(host) || host.length > 255) {
    throw new ShopifyReportingError(
      "invalid_domain",
      "Enter a valid .myshopify.com domain.",
    );
  }
  return host;
}

function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timeout),
  );
}

function unavailable(error?: unknown): ShopifyReportingError {
  return new ShopifyReportingError(
    "shopify_unavailable",
    error instanceof DOMException && error.name === "AbortError"
      ? "Shopify took too long to answer. Try again."
      : "Shopify could not be reached. Try again.",
    true,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shopify sends Retry-After in seconds, sometimes fractional. The HTTP-date
 * form is ignored rather than parsed because the ladder is a good enough
 * fallback and a clock skew could otherwise turn into a very long wait.
 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after")?.trim();
  if (!header || !/^\d+(\.\d+)?$/.test(header)) return null;
  return Math.min(Math.round(Number(header) * 1_000), MAX_RETRY_AFTER_MS);
}

/**
 * Shopify delivers its cost throttle inside an HTTP 200 envelope, so a
 * throttled read looks exactly like a scope refusal unless the error code or
 * message is inspected. The message match covers the rare envelope that
 * carries "Throttled" without an extensions block.
 */
function isThrottleError(error: GraphqlError): boolean {
  const code = error.extensions?.code;
  if (code === "THROTTLED" || code === "MAX_COST_EXCEEDED") return true;
  return typeof error.message === "string" && /throttl/i.test(error.message);
}

/**
 * A blank sheet used to say only "did not allow"; the first Shopify message
 * is what actually tells an operator whether it was a scope, a field, or a
 * malformed ShopifyQL string. It is trimmed and capped so a snapshot row
 * cannot grow without bound.
 */
function describeGraphqlErrors(errors: GraphqlError[]): string {
  const first = errors.find(
    (error) => typeof error.message === "string" && error.message.trim(),
  );
  if (!first) return GRAPHQL_DENIED_MESSAGE;
  const message = String(first.message)
    .trim()
    .slice(0, GRAPHQL_ERROR_MESSAGE_MAX_CHARS);
  return `${GRAPHQL_DENIED_MESSAGE} Shopify said: ${message}`;
}

function classifyResponseStatus(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    throw new ShopifyReportingError(
      "invalid_shop_response",
      "Shopify returned an unexpected redirect.",
    );
  }
  if (response.status === 429) {
    throw new ShopifyThrottledError(retryAfterMs(response));
  }
  if (response.status === 401 || response.status === 403) {
    throw new ShopifyReportingError(
      "invalid_credentials",
      "The Shopify reporting app is not authorised for this store.",
    );
  }
  if (!response.ok) {
    throw new ShopifyReportingError(
      "shopify_unavailable",
      "Shopify could not verify the store right now. Try again.",
      response.status >= 500,
    );
  }
}

function assertServedVersion(response: Response): void {
  const servedVersion = response.headers.get("x-shopify-api-version");
  if (servedVersion && servedVersion !== REPORTING_SHOPIFY_API_VERSION) {
    throw new ShopifyReportingError(
      "unsupported_api_version",
      "Shopify served an unexpected API version. Contact Dropscale before connecting.",
    );
  }
}

/** Always performs a fresh exchange so a rotated or revoked secret is visible. */
export async function exchangeReportingClientCredentials({
  shopDomain,
  clientId,
  clientSecret,
}: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const domain = normalizeReportingShopDomain(shopDomain);
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (
    id.length < 8 ||
    id.length > 256 ||
    secret.length < 16 ||
    secret.length > 512
  ) {
    throw new ShopifyReportingError(
      "invalid_credentials",
      "The Shopify Client ID or Client Secret is invalid.",
    );
  }

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
  });

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://${domain}/admin/oauth/access_token`,
      {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    );
  } catch (error) {
    throw unavailable(error);
  }

  if (response.status === 429) {
    throw new ShopifyReportingError(
      "shopify_rate_limited",
      "Shopify is rate limiting this store. Wait a moment and try again.",
      true,
    );
  }
  if (!response.ok) {
    throw new ShopifyReportingError(
      response.status >= 500 ? "shopify_unavailable" : "invalid_credentials",
      response.status >= 500
        ? "Shopify could not verify the app right now. Try again."
        : "Shopify rejected the Client ID or Client Secret. Confirm that the reporting app is installed on this store.",
      response.status >= 500,
    );
  }

  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    throw new ShopifyReportingError(
      "invalid_shop_response",
      "Shopify returned an invalid authentication response.",
      true,
    );
  }
  if (
    typeof payload.access_token !== "string" ||
    payload.access_token.length < 16
  ) {
    throw new ShopifyReportingError(
      "invalid_shop_response",
      "Shopify did not return a usable access token.",
      true,
    );
  }
  return payload.access_token;
}

/** One attempt: its own timeout, its own classification, no waiting. */
async function requestReportingGraphql<T>({
  domain,
  accessToken,
  query,
  variables,
}: {
  domain: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://${domain}/admin/api/${REPORTING_SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
  } catch (error) {
    throw unavailable(error);
  }

  classifyResponseStatus(response);
  assertServedVersion(response);

  let payload: GraphqlEnvelope<T>;
  try {
    payload = (await response.json()) as GraphqlEnvelope<T>;
  } catch {
    throw new ShopifyReportingError(
      "invalid_shop_response",
      "Shopify returned an invalid reporting response.",
      true,
    );
  }
  if (payload.errors?.length) {
    if (payload.errors.some(isThrottleError)) {
      throw new ShopifyThrottledError();
    }
    throw new ShopifyReportingError(
      "insufficient_scopes",
      describeGraphqlErrors(payload.errors),
    );
  }
  if (!payload.data) {
    throw new ShopifyReportingError(
      "insufficient_scopes",
      GRAPHQL_DENIED_MESSAGE,
    );
  }
  return payload.data;
}

/**
 * Every reporting read goes through here, so this is where a throttle is
 * absorbed: an HTTP 429 or a THROTTLED envelope waits and tries again, at
 * most twice, honouring a numeric Retry-After hint when Shopify sends one.
 * Nothing else is retried, because a refused scope or a bad token will not
 * change by waiting, and a retried timeout would only pile onto the queue.
 */
export async function reportingShopifyGraphql<T>(
  {
    shopDomain,
    accessToken,
    query,
    variables,
  }: {
    shopDomain: string;
    accessToken: string;
    query: string;
    variables?: Record<string, unknown>;
  },
  { sleep = defaultSleep }: ReportingGraphqlRetryOptions = {},
): Promise<T> {
  const domain = normalizeReportingShopDomain(shopDomain);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestReportingGraphql<T>({
        domain,
        accessToken,
        query,
        variables,
      });
    } catch (error) {
      if (
        !(error instanceof ShopifyReportingError) ||
        error.code !== "shopify_rate_limited" ||
        !error.retryable ||
        attempt >= THROTTLE_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      const hinted =
        error instanceof ShopifyThrottledError ? error.retryAfterMs : null;
      await sleep(hinted ?? THROTTLE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function verifyReportingShop({
  shopDomain,
  accessToken,
}: {
  shopDomain: string;
  accessToken: string;
}): Promise<VerifiedReportingShop> {
  const domain = normalizeReportingShopDomain(shopDomain);
  const data = await reportingShopifyGraphql<VerifyResponse>({
    shopDomain: domain,
    accessToken,
    query: VERIFY_QUERY,
  });
  const shop = data.shop;
  const installation = data.currentAppInstallation;
  if (
    typeof shop?.id !== "string" ||
    typeof shop.name !== "string" ||
    typeof shop.myshopifyDomain !== "string" ||
    typeof shop.currencyCode !== "string" ||
    !Array.isArray(installation?.accessScopes)
  ) {
    throw new ShopifyReportingError(
      "invalid_shop_response",
      "Shopify could not return the store identity and granted scopes.",
    );
  }

  const returnedDomain = normalizeReportingShopDomain(shop.myshopifyDomain);
  if (returnedDomain !== domain) {
    throw new ShopifyReportingError(
      "domain_mismatch",
      "The credentials belong to a different Shopify store.",
    );
  }

  return {
    shopId: shop.id,
    name: shop.name.trim(),
    myshopifyDomain: returnedDomain,
    primaryDomain:
      typeof shop.primaryDomain?.host === "string"
        ? shop.primaryDomain.host.trim().toLowerCase()
        : null,
    currencyCode: shop.currencyCode.trim().toUpperCase(),
    ...(typeof shop.ianaTimezone === "string" && shop.ianaTimezone.trim()
      ? { ianaTimezone: shop.ianaTimezone.trim() }
      : {}),
    scopes: checkReportingShopifyScopes(
      installation.accessScopes.flatMap((scope) =>
        typeof scope.handle === "string" ? [scope.handle] : [],
      ),
    ),
  };
}

export async function verifyReportingClientCredentials(input: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; shop: VerifiedReportingShop }> {
  const shopDomain = normalizeReportingShopDomain(input.shopDomain);
  const accessToken = await exchangeReportingClientCredentials({
    ...input,
    shopDomain,
  });
  const shop = await verifyReportingShop({ shopDomain, accessToken });
  return { accessToken, shop };
}

function missingScope(
  capability: ReportingHealthCapability,
): ReportingCapabilityResult {
  return { capability, status: "missing_scope", code: "missing_scope" };
}

async function runProbe({
  capability,
  shopDomain,
  accessToken,
  query,
  variables,
  isNotApplicable,
  isInvalid,
}: {
  capability: ReportingHealthCapability;
  shopDomain: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
  isNotApplicable?: (data: unknown) => boolean;
  isInvalid?: (data: unknown) => boolean;
}): Promise<ReportingCapabilityResult> {
  try {
    const data = await reportingShopifyGraphql<unknown>({
      shopDomain,
      accessToken,
      query,
      variables,
    });
    if (isNotApplicable?.(data)) {
      return { capability, status: "not_applicable", code: null };
    }
    if (isInvalid?.(data)) {
      return {
        capability,
        status: "failed",
        code: "invalid_shop_response",
      };
    }
    return { capability, status: "ok", code: null };
  } catch (error) {
    const code =
      error instanceof ShopifyReportingError
        ? error.code
        : "health_check_failed";
    return { capability, status: "failed", code };
  }
}

/**
 * Fresh, read-only health test. It deliberately returns no merchant rows or
 * credential material: only capability status suitable for the admin UI.
 */
export async function testReportingShopConnection({
  shop,
  accessToken,
  now = new Date(),
}: {
  shop: VerifiedReportingShop;
  accessToken: string;
  now?: Date;
}): Promise<ReportingShopHealth> {
  const granted = new Set(shop.scopes.granted);
  const probes: Array<Promise<ReportingCapabilityResult>> = [];

  probes.push(
    granted.has("read_orders")
      ? runProbe({
          capability: "orders",
          shopDomain: shop.myshopifyDomain,
          accessToken,
          query: ORDERS_PROBE,
        })
      : Promise.resolve(missingScope("orders")),
  );
  probes.push(
    granted.has("read_reports") && granted.has("read_analytics")
      ? runProbe({
          capability: "reports",
          shopDomain: shop.myshopifyDomain,
          accessToken,
          query: REPORTS_PROBE,
          variables: {
            query: "FROM sales SHOW total_sales SINCE -1d",
          },
          isInvalid: (data) => {
            const report = data as {
              shopifyqlQuery?: { parseErrors?: unknown[] } | null;
            };
            return (
              !report.shopifyqlQuery ||
              Boolean(report.shopifyqlQuery.parseErrors?.length)
            );
          },
        })
      : Promise.resolve(missingScope("reports")),
  );
  probes.push(
    granted.has("read_products")
      ? runProbe({
          capability: "products",
          shopDomain: shop.myshopifyDomain,
          accessToken,
          query: PRODUCTS_PROBE,
        })
      : Promise.resolve(missingScope("products")),
  );
  probes.push(
    granted.has("read_inventory")
      ? runProbe({
          capability: "inventory",
          shopDomain: shop.myshopifyDomain,
          accessToken,
          query: INVENTORY_PROBE,
        })
      : Promise.resolve(missingScope("inventory")),
  );
  probes.push(
    granted.has("read_locations")
      ? runProbe({
          capability: "locations",
          shopDomain: shop.myshopifyDomain,
          accessToken,
          query: LOCATIONS_PROBE,
        })
      : Promise.resolve(missingScope("locations")),
  );
  probes.push(
    granted.has("read_shopify_payments_accounts") &&
      granted.has("read_shopify_payments_payouts")
      ? runProbe({
          capability: "payouts",
          shopDomain: shop.myshopifyDomain,
          accessToken,
          query: PAYOUTS_PROBE,
          isNotApplicable: (data) =>
            (data as { shopifyPaymentsAccount?: unknown })
              .shopifyPaymentsAccount == null,
        })
      : Promise.resolve(missingScope("payouts")),
  );

  const capabilities = await Promise.all(probes);
  const coreCapabilities = new Set<ReportingHealthCapability>([
    "orders",
    "reports",
    "products",
    "inventory",
    "locations",
  ]);
  const ok =
    shop.scopes.valid &&
    capabilities.every(
      (result) =>
        !coreCapabilities.has(result.capability) || result.status === "ok",
    );

  return {
    ok,
    limited:
      !shop.scopes.valid ||
      capabilities.some((result) => result.status !== "ok"),
    testedAt: now.toISOString(),
    capabilities,
  };
}
