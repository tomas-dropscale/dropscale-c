import "server-only";

import { checkAuditShopifyScopes, type AuditScopeCheck } from "./shopify-scopes";

export const AUDIT_SHOPIFY_API_VERSION = "2026-07" as const;

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const REQUEST_TIMEOUT_MS = 15_000;

export type ShopifyAuditErrorCode =
  | "invalid_domain"
  | "invalid_credentials"
  | "shopify_unavailable"
  | "shopify_rate_limited"
  | "unsupported_api_version"
  | "invalid_shop_response"
  | "domain_mismatch";

export class ShopifyAuditError extends Error {
  constructor(
    public readonly code: ShopifyAuditErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ShopifyAuditError";
  }
}

export type VerifiedAuditShop = {
  shopId: string;
  name: string;
  myshopifyDomain: string;
  primaryDomain: string | null;
  currencyCode: string;
  scopes: AuditScopeCheck;
};

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
};

type VerifyResponse = {
  data?: {
    shop?: {
      id?: unknown;
      name?: unknown;
      myshopifyDomain?: unknown;
      currencyCode?: unknown;
      primaryDomain?: { host?: unknown } | null;
    };
    currentAppInstallation?: {
      accessScopes?: { handle?: unknown }[];
    };
  };
  errors?: unknown;
};

const VERIFY_QUERY = `#graphql
  query VerifyDropscaleAuditConnection {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      primaryDomain {
        host
      }
    }
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

/**
 * Accept either the canonical host or an https URL that resolves to exactly
 * that host. The returned value is the only value ever interpolated into a
 * network URL, closing the SSRF boundary before fetch.
 */
export function normalizeAuditShopDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255) {
    throw new ShopifyAuditError("invalid_domain", "Enter a valid .myshopify.com domain.");
  }

  let host = trimmed;
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new ShopifyAuditError("invalid_domain", "Enter a valid .myshopify.com domain.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash
    ) {
      throw new ShopifyAuditError("invalid_domain", "Enter a valid .myshopify.com domain.");
    }
    host = parsed.hostname.toLowerCase();
  } else if (trimmed.includes("/") || trimmed.includes("@") || trimmed.includes(":")) {
    throw new ShopifyAuditError("invalid_domain", "Enter only the .myshopify.com domain.");
  }

  if (!SHOP_DOMAIN.test(host) || host.length > 255) {
    throw new ShopifyAuditError("invalid_domain", "Enter a valid .myshopify.com domain.");
  }
  return host;
}

function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function unavailable(error?: unknown): ShopifyAuditError {
  return new ShopifyAuditError(
    "shopify_unavailable",
    error instanceof DOMException && error.name === "AbortError"
      ? "Shopify took too long to answer. Try again."
      : "Shopify could not be reached. Try again.",
    true,
  );
}

/** Always performs a fresh exchange. There is no cache that can mask a rotated secret. */
export async function exchangeAuditClientCredentials({
  shopDomain,
  clientId,
  clientSecret,
}: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const domain = normalizeAuditShopDomain(shopDomain);
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (id.length < 8 || id.length > 256 || secret.length < 16 || secret.length > 512) {
    throw new ShopifyAuditError(
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
    response = await fetchWithTimeout(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      // Do not follow redirects carrying the merchant secret. `manual` keeps
      // the response classifiable as a credentials/install problem instead of
      // turning Shopify's redirect into a generic network exception.
      redirect: "manual",
      cache: "no-store",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (error) {
    throw unavailable(error);
  }

  if (response.status === 429) {
    throw new ShopifyAuditError(
      "shopify_rate_limited",
      "Shopify is rate limiting this store. Wait a moment and try again.",
      true,
    );
  }
  if (!response.ok) {
    throw new ShopifyAuditError(
      response.status >= 500 ? "shopify_unavailable" : "invalid_credentials",
      response.status >= 500
        ? "Shopify could not verify the app right now. Try again."
        : "Shopify rejected the Client ID or Client Secret. Confirm that the app is installed on this store.",
      response.status >= 500,
    );
  }

  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    throw new ShopifyAuditError(
      "invalid_shop_response",
      "Shopify returned an invalid authentication response.",
      true,
    );
  }

  if (typeof payload.access_token !== "string" || payload.access_token.length < 16) {
    throw new ShopifyAuditError(
      "invalid_shop_response",
      "Shopify did not return a usable access token.",
      true,
    );
  }
  return payload.access_token;
}

export async function verifyAuditShop({
  shopDomain,
  accessToken,
}: {
  shopDomain: string;
  accessToken: string;
}): Promise<VerifiedAuditShop> {
  const domain = normalizeAuditShopDomain(shopDomain);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://${domain}/admin/api/${AUDIT_SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": accessToken,
        },
        body: JSON.stringify({ query: VERIFY_QUERY }),
      },
    );
  } catch (error) {
    throw unavailable(error);
  }

  if (response.status === 429) {
    throw new ShopifyAuditError(
      "shopify_rate_limited",
      "Shopify is rate limiting this store. Wait a moment and try again.",
      true,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ShopifyAuditError(
      "invalid_credentials",
      "The Shopify app is not authorised for this store.",
    );
  }
  if (!response.ok) {
    throw new ShopifyAuditError(
      "shopify_unavailable",
      "Shopify could not verify the store right now. Try again.",
      response.status >= 500,
    );
  }

  const servedVersion = response.headers.get("x-shopify-api-version");
  if (servedVersion && servedVersion !== AUDIT_SHOPIFY_API_VERSION) {
    throw new ShopifyAuditError(
      "unsupported_api_version",
      "Shopify served an unexpected API version. Contact Dropscale before connecting.",
    );
  }

  let payload: VerifyResponse;
  try {
    payload = (await response.json()) as VerifyResponse;
  } catch {
    throw new ShopifyAuditError(
      "invalid_shop_response",
      "Shopify returned an invalid store response.",
      true,
    );
  }

  const shop = payload.data?.shop;
  const installation = payload.data?.currentAppInstallation;
  if (
    payload.errors ||
    typeof shop?.id !== "string" ||
    typeof shop.name !== "string" ||
    typeof shop.myshopifyDomain !== "string" ||
    typeof shop.currencyCode !== "string" ||
    !Array.isArray(installation?.accessScopes)
  ) {
    throw new ShopifyAuditError(
      "invalid_shop_response",
      "Shopify could not return the store identity and granted scopes.",
    );
  }

  const returnedDomain = normalizeAuditShopDomain(shop.myshopifyDomain);
  if (returnedDomain !== domain) {
    throw new ShopifyAuditError(
      "domain_mismatch",
      "The credentials belong to a different Shopify store.",
    );
  }

  const grantedScopes = installation.accessScopes.flatMap((scope) =>
    typeof scope.handle === "string" ? [scope.handle] : [],
  );

  return {
    shopId: shop.id,
    name: shop.name.trim(),
    myshopifyDomain: returnedDomain,
    primaryDomain:
      typeof shop.primaryDomain?.host === "string"
        ? shop.primaryDomain.host.trim().toLowerCase()
        : null,
    currencyCode: shop.currencyCode.trim().toUpperCase(),
    scopes: checkAuditShopifyScopes(grantedScopes),
  };
}

export async function verifyAuditClientCredentials(input: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}): Promise<VerifiedAuditShop> {
  const shopDomain = normalizeAuditShopDomain(input.shopDomain);
  const accessToken = await exchangeAuditClientCredentials({ ...input, shopDomain });
  return verifyAuditShop({ shopDomain, accessToken });
}
